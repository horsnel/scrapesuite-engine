import crypto from 'crypto';
import { createChildLogger } from '../utils/logger';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import type { ExtractionSchema, SchemaField } from './schema-definitions';

const log = createChildLogger('ai-extractor');

// --- Types --------------------------------------------------------------------

export interface AiExtractOptions {
  html: string; description: string; url?: string; schema?: ExtractionSchema; cacheTtl?: number;
}

export interface AiExtractResult {
  data: Record<string, unknown>; confidence: number; method: 'ai';
  tokensUsed: number; cached: boolean; errors: string[];
}

export interface NormalizedData {
  original: Record<string, unknown>; normalized: Record<string, unknown>; transformations: string[];
}

// --- Normalization Helpers ----------------------------------------------------

const CURRENCY_SYMBOLS: Record<string, string> = {
  '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', '₽': 'RUB',
};

export function normalizePrice(value: unknown): { amount: number; currency: string; raw: string } | null {
  if (value == null) return null;
  const raw = String(value).trim();
  const match = raw.match(/([\$€£¥₹₩₽])\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*([A-Z]{3})/);
  if (!match) {
    const numOnly = raw.replace(/[^0-9.]/g, '');
    return numOnly && !isNaN(Number(numOnly)) ? { amount: parseFloat(numOnly), currency: 'USD', raw } : null;
  }
  const symbol = match[1] || '';
  const amountStr = match[2] || match[3] || '0';
  const currencyCode = match[4] || CURRENCY_SYMBOLS[symbol] || 'USD';
  return { amount: parseFloat(amountStr.replace(/,/g, '')), currency: currencyCode, raw };
}

export function normalizeDate(value: unknown): string | null {
  if (value == null) return null;
  const raw = String(value).trim();
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString();
  const relMatch = raw.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i);
  if (relMatch) {
    const ms: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000, year: 31_536_000_000 };
    return new Date(Date.now() - parseInt(relMatch[1], 10) * (ms[relMatch[2].toLowerCase()] || 0)).toISOString();
  }
  return null;
}

export function normalizePhone(value: unknown): string | null {
  if (value == null) return null;
  const digits = String(value).trim().replace(/[^\d+]/g, '');
  if (digits.length < 7) return null;
  if (digits.startsWith('1') && digits.length === 11) return `+${digits}`;
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

export function normalizeAddress(value: unknown): { street: string; city: string; state: string; zip: string; country: string; raw: string } | null {
  if (value == null) return null;
  const raw = String(value).trim();
  const usMatch = raw.match(/^(.+?),\s*(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (usMatch) return { street: usMatch[1].trim(), city: usMatch[2].trim(), state: usMatch[3], zip: usMatch[4], country: 'US', raw };
  return { street: raw, city: '', state: '', zip: '', country: '', raw };
}

export function normalizeRating(value: unknown): number | null {
  if (value == null) return null;
  const raw = String(value).trim();
  const outOf = raw.match(/([\d.]+)\s*(?:out of|\/)\s*([\d.]+)/i);
  if (outOf) return Math.round((parseFloat(outOf[1]) / parseFloat(outOf[2])) * 50) / 10;
  const pct = raw.match(/([\d.]+)\s*%/);
  if (pct) return Math.round((parseFloat(pct[1]) / 20) * 10) / 10;
  const num = parseFloat(raw);
  if (isNaN(num)) return null;
  if (num > 5 && num <= 10) return Math.round(num * 5) / 10;
  if (num > 10) return Math.round((num / 20) * 10) / 10;
  return Math.round(num * 10) / 10;
}

// --- AI Extractor Engine ------------------------------------------------------

export class AiExtractorEngine {
  private stats = { totalExtractions: 0, cacheHits: 0, aiCalls: 0, errors: 0, totalTokens: 0 };

  /**
   * Call the LLM with a prompt and HTML content.
   * Ready for real z-ai-web-dev-sdk integration in the API route layer.
   * Currently returns a simulated structured response.
   */
  async callLLM(prompt: string, html: string): Promise<{ text: string; tokensUsed: number }> {
    // In production, replace with: const response = await chatCompletion({ model, messages });
    const simulatedData: Record<string, unknown> = {
      _simulated: true, _promptHint: prompt.slice(0, 120), extractedAt: new Date().toISOString(), contentLength: html.length,
    };
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    if (titleMatch) simulatedData.title = titleMatch[1].trim();
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["'](.*?)["']/i);
    if (descMatch) simulatedData.description = descMatch[1].trim();
    const imgMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["'](.*?)["']/i);
    if (imgMatch) simulatedData.image = imgMatch[1].trim();
    return { text: JSON.stringify(simulatedData, null, 2), tokensUsed: Math.ceil((prompt.length + html.length) / 4) };
  }

  /** Extract structured data from HTML using a natural language description. */
  async extract(options: AiExtractOptions): Promise<AiExtractResult> {
    const { html, description, url, schema, cacheTtl = 3600 } = options;
    const start = Date.now();
    const errors: string[] = [];

    const cacheKey = `ai:${crypto.createHash('sha256').update(`${description}:${html.slice(0, 500)}`).digest('hex').slice(0, 24)}`;
    const cached = await cacheGet<AiExtractResult>(cacheKey);
    if (cached) { this.stats.cacheHits++; return { ...cached, cached: true }; }

    const prompt = this.buildExtractionPrompt(description, schema);
    let data: Record<string, unknown> = {};
    let tokensUsed = 0;
    try {
      const result = await this.callLLM(prompt, html);
      tokensUsed = result.tokensUsed;
      this.stats.aiCalls++;
      this.stats.totalTokens += tokensUsed;
      const parsed = this.parseJsonResponse(result.text);
      if (parsed) data = parsed; else errors.push('Failed to parse LLM response as JSON');
    } catch (err: any) {
      this.stats.errors++;
      errors.push(`LLM call failed: ${err.message ?? String(err)}`);
    }

    if (schema) data = this.applySchemaDefaults(data, schema);
    data = this.normalizeData(data).normalized;
    const confidence = this.computeConfidence(data, errors);

    const result: AiExtractResult = { data, confidence, method: 'ai', tokensUsed, cached: false, errors };
    await cacheSet(cacheKey, result, cacheTtl).catch((err) => log.warn({ err }, 'Cache write failed'));
    this.stats.totalExtractions++;
    log.info({ url, confidence, tokensUsed, durationMs: Date.now() - start }, 'AI extraction complete');
    return result;
  }

  /** Extract data using a predefined schema to guide the LLM output. */
  async extractWithSchema(html: string, schema: ExtractionSchema, url?: string): Promise<AiExtractResult> {
    return this.extract({ html, description: `Extract data for ${schema.name}`, url, schema });
  }

  /** Analyze HTML and generate an ExtractionSchema definition. */
  async generateSchema(html: string, url?: string): Promise<ExtractionSchema> {
    const prompt = `Analyze this HTML page and generate a CSS-selector-based extraction schema.
Return JSON: { name, domain (regex), fields: [{name, type, selector, attribute, required}] }
Types: string|number|boolean|date|url|array|object. Attributes: text|html|href|src|content. URL: ${url ?? 'unknown'}`;
    const { text } = await this.callLLM(prompt, html);
    const parsed = this.parseJsonResponse(text);
    if (parsed && Array.isArray(parsed.fields)) {
      return {
        name: String(parsed.name ?? 'generated-schema'), domain: String(parsed.domain ?? '.*'),
        fields: parsed.fields.map((f: any) => ({
          name: f.name ?? 'unknown', type: f.type ?? 'string', selector: f.selector ?? 'body',
          attribute: f.attribute ?? 'text', required: f.required ?? false,
        })),
        version: '0.1.0', lastUpdated: new Date().toISOString(),
      };
    }
    return {
      name: 'generated-schema', domain: url ? new URL(url).hostname.replace(/\./g, '\\.') : '.*',
      fields: [
        { name: 'title', type: 'string', selector: 'h1', attribute: 'text', required: true },
        { name: 'content', type: 'string', selector: 'main, article, body', attribute: 'html', required: false },
      ],
      version: '0.1.0', lastUpdated: new Date().toISOString(),
    };
  }

  /** Validate extracted data against a schema's field definitions. */
  validateExtraction(data: Record<string, unknown>, schema: ExtractionSchema): { valid: boolean; errors: string[]; coverage: number } {
    const errors: string[] = [];
    let matched = 0;
    for (const field of schema.fields) {
      const value = data[field.name];
      if (value == null || value === '') { if (field.required) errors.push(`Required field "${field.name}" is missing`); continue; }
      matched++;
      if (!this.checkFieldType(value, field.type)) errors.push(`Field "${field.name}" expected type ${field.type}`);
      if (field.validation) { for (const rule of field.validation) { if (!this.applyValidationRule(value, rule)) errors.push(rule.message || `Validation failed for "${field.name}"`); } }
    }
    const coverage = schema.fields.length > 0 ? matched / schema.fields.length : 1;
    return { valid: errors.filter((e) => e.includes('Required')).length === 0, errors, coverage };
  }

  /** Normalize all fields in the extracted data using domain-specific normalizers. */
  normalizeData(data: Record<string, unknown>): NormalizedData {
    const normalized: Record<string, unknown> = {};
    const transformations: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      const k = key.toLowerCase();
      if (k.includes('price') || k.includes('cost') || k.includes('salary')) {
        const n = normalizePrice(value); if (n) { normalized[key] = n; normalized[`${key}_normalized`] = n.amount; transformations.push(`price:${key}`); continue; }
      }
      if (k.includes('date') || k.includes('time') || k.includes('published') || k.includes('updated')) {
        const n = normalizeDate(value); if (n) { normalized[key] = n; normalized[`${key}_iso`] = n; transformations.push(`date:${key}`); continue; }
      }
      if (k.includes('phone') || k.includes('tel') || k.includes('fax')) {
        const n = normalizePhone(value); if (n) { normalized[key] = n; transformations.push(`phone:${key}`); continue; }
      }
      if (k.includes('address') || k.includes('location')) {
        const n = normalizeAddress(value); if (n && n.city) { normalized[key] = n; transformations.push(`address:${key}`); continue; }
      }
      if (k.includes('rating') || k.includes('score')) {
        const n = normalizeRating(value); if (n !== null) { normalized[key] = n; normalized[`${key}_out_of_5`] = n; transformations.push(`rating:${key}`); continue; }
      }
      normalized[key] = value;
    }
    return { original: data, normalized, transformations };
  }

  /** Process multiple extraction requests in parallel with concurrency limit. */
  async batchExtract(items: AiExtractOptions[], concurrency = 3): Promise<AiExtractResult[]> {
    const results: AiExtractResult[] = new Array(items.length);
    let next = 0, running = 0;
    const queue: ((idx: number) => void)[] = [];
    const acquire = (): Promise<number> => {
      if (running < concurrency && next < items.length) { running++; return Promise.resolve(next++); }
      return new Promise((resolve) => queue.push(resolve));
    };
    const release = (): void => { running--; if (queue.length > 0 && next < items.length) { running++; queue.shift()!(next++); } };
    const worker = async (): Promise<void> => {
      while (next < items.length || queue.length > 0) {
        const idx = await acquire(); if (idx >= items.length) break;
        try { results[idx] = await this.extract(items[idx]); }
        catch (err: any) { results[idx] = { data: {}, confidence: 0, method: 'ai', tokensUsed: 0, cached: false, errors: [`Failure: ${err.message ?? String(err)}`] }; }
        release();
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return results;
  }

  getStats() { return { ...this.stats, avgTokensPerCall: this.stats.aiCalls > 0 ? Math.round(this.stats.totalTokens / this.stats.aiCalls) : 0 }; }

  // -- Private ----------------------------------------------------------------

  private buildExtractionPrompt(description: string, schema?: ExtractionSchema): string {
    let prompt = `You are a data extraction specialist. Extract structured data from the following web page.\n\nDESCRIPTION: ${description}`;
    if (schema) {
      const defs = schema.fields.map((f) => `  - ${f.name} (${f.type}, ${f.required ? 'required' : 'optional'}): "${f.selector}"`).join('\n');
      prompt += `\n\nSCHEMA: ${schema.name}\nFields:\n${defs}`;
    }
    return prompt + '\n\nReturn ONLY a valid JSON object. No explanation or markdown.';
  }

  private parseJsonResponse(text: string): Record<string, unknown> | null {
    let c = text.trim();
    if (c.startsWith('```json')) c = c.slice(7); else if (c.startsWith('```')) c = c.slice(3);
    if (c.endsWith('```')) c = c.slice(0, -3);
    c = c.trim();
    try { const p = JSON.parse(c); return p && typeof p === 'object' && !Array.isArray(p) ? p : Array.isArray(p) ? { items: p } : null; }
    catch { const s = c.indexOf('{'), e = c.lastIndexOf('}'); if (s !== -1 && e > s) { try { const x = JSON.parse(c.slice(s, e + 1)); if (x && typeof x === 'object') return x; } catch {} } return null; }
  }

  private applySchemaDefaults(data: Record<string, unknown>, schema: ExtractionSchema): Record<string, unknown> {
    const result = { ...data };
    for (const field of schema.fields) { if (result[field.name] == null && field.defaultValue !== undefined) result[field.name] = field.defaultValue; }
    return result;
  }

  private checkFieldType(value: unknown, type: string): boolean {
    switch (type) {
      case 'string': return typeof value === 'string'; case 'number': return typeof value === 'number';
      case 'boolean': return typeof value === 'boolean'; case 'array': return Array.isArray(value);
      case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'date': return typeof value === 'string' && !isNaN(Date.parse(value));
      case 'url': return typeof value === 'string' && /^https?:\/\//i.test(value);
      default: return true;
    }
  }

  private applyValidationRule(value: unknown, rule: import('./schema-definitions').ValidationRule): boolean {
    if (rule.type === 'regex' && typeof rule.value === 'string') return new RegExp(rule.value).test(String(value));
    if (rule.type === 'enum' && Array.isArray(rule.value)) return rule.value.includes(String(value));
    if (rule.type === 'range' && typeof rule.value === 'number') return Number(value) <= rule.value;
    if (rule.type === 'length' && typeof rule.value === 'number') return String(value).length <= rule.value;
    if (rule.type === 'custom' && typeof rule.value === 'function') return rule.value(value);
    return true;
  }

  private computeConfidence(data: Record<string, unknown>, errors: string[]): number {
    if (errors.length > 0) return Math.max(0.1, 0.7 - errors.length * 0.15);
    const keys = Object.keys(data).filter((k) => !k.startsWith('_'));
    return keys.length === 0 ? 0.1 : keys.length >= 5 ? 0.9 : 0.5 + keys.length * 0.08;
  }
}

export const aiExtractor = new AiExtractorEngine();
