import crypto from 'crypto';
import { createChildLogger } from '../utils/logger';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { SCHEMAS, detectSchemaForUrl, getSchemaByName } from './schema-definitions';
import type { ExtractionSchema, SchemaField } from './schema-definitions';
import { aiExtractor } from './ai-extractor';

const log = createChildLogger('structured-extractor');

// --- Types --------------------------------------------------------------------

export type ExtractionMethod = 'schema' | 'ai' | 'fallback';

export interface ExtractionResult {
  success: boolean; data: Record<string, unknown>; schema: string | null;
  method: ExtractionMethod; confidence: number; errors: string[]; duration: number;
}

export interface ExtractOptions {
  url: string; html: string; schemaName?: string; useCache?: boolean;
  cacheTtl?: number; fallbackToAi?: boolean;
}

// --- Simplified CSS Selector Engine -------------------------------------------

function applySelectors(html: string, fields: SchemaField[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    try {
      const value = extractField(html, field);
      if (value !== null && value !== undefined && value !== '') result[field.name] = value;
      else if (field.defaultValue !== undefined) result[field.name] = field.defaultValue;
    } catch (err) { log.debug({ field: field.name, err }, 'Selector failed'); }
  }
  return result;
}

function extractField(html: string, field: SchemaField): unknown {
  const { selector, attribute, type } = field;
  if (selector.startsWith('xpath:')) return null; // XPath not supported in regex mode

  const classes: string[] = [];
  const ids: string[] = [];
  const classMatches = selector.match(/\.([a-zA-Z0-9_-]+)/g);
  if (classMatches) classes.push(...classMatches.map((c) => c.slice(1)));
  const idMatches = selector.match(/#([a-zA-Z0-9_-]+)/g);
  if (idMatches) ids.push(...idMatches.map((i) => i.slice(1)));

  let pattern: RegExp;
  if (ids.length > 0) {
    pattern = new RegExp(`<[^>]+id\\s*=\\s*["']${ids[0]}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i');
  } else if (classes.length > 0) {
    const cp = classes.map((c) => `class\\s*=\\s*["'][^"']*\\b${c}\\b[^"']*["']`).join('|');
    pattern = new RegExp(`<[^>]+(?:${cp})[^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i');
  } else {
    const tag = selector.replace(/[.#\[\]>+~:].*$/, '').trim();
    if (tag && tag !== '*') pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    else return null;
  }

  const match = html.match(pattern);
  if (!match) return null;

  if (attribute === 'text') return castValue(match[1].replace(/<[^>]+>/g, '').trim(), type);
  if (attribute === 'html') return match[1].trim();
  if (attribute === 'href' || attribute === 'src') {
    const a = match[0].match(new RegExp(`${attribute}\\s*=\\s*["']([^"']+)["']`, 'i'));
    return a ? a[1] : null;
  }
  if (attribute === 'content') {
    const a = match[0].match(/content\s*=\s*["']([^"']+)["']/i);
    return a ? castValue(a[1], type) : castValue(match[1].replace(/<[^>]+>/g, '').trim(), type);
  }
  if (attribute.startsWith('data-')) {
    const a = match[0].match(new RegExp(`${attribute}\\s*=\\s*["']([^"']+)["']`, 'i'));
    return a ? a[1] : null;
  }
  return castValue(match[1].replace(/<[^>]+>/g, '').trim(), type);
}

function castValue(raw: string, type: SchemaField['type']): unknown {
  switch (type) {
    case 'number': { const n = parseFloat(raw.replace(/[^0-9.\-]/g, '')); return isNaN(n) ? raw : n; }
    case 'boolean': { const l = raw.toLowerCase(); return l === 'true' || l === 'yes' || l === '1'; }
    case 'date': { const d = new Date(raw); return isNaN(d.getTime()) ? raw : d.toISOString(); }
    case 'url': return raw.startsWith('http') ? raw : null;
    default: return raw;
  }
}

// --- Structured Extractor Engine ----------------------------------------------

export class StructuredExtractorEngine {
  private customSchemas = new Map<string, ExtractionSchema>();
  private stats = { totalExtractions: 0, schemaExtractions: 0, aiExtractions: 0, fallbackExtractions: 0, cacheHits: 0, errors: 0 };

  /**
   * Main extraction method: URL + HTML + optional schema name →
   * detect schema if not provided → apply selectors → fall back to AI
   * if selectors fail → validate → normalize → return structured result.
   */
  async extract(options: ExtractOptions): Promise<ExtractionResult> {
    const { url, html, schemaName, useCache = true, cacheTtl = 3600, fallbackToAi = true } = options;
    const start = Date.now();
    const errors: string[] = [];

    // Cache lookup
    if (useCache) {
      const cacheKey = `extract:${crypto.createHash('sha256').update(`${url}:${schemaName ?? 'auto'}`).digest('hex').slice(0, 24)}`;
      const cached = await cacheGet<ExtractionResult>(cacheKey);
      if (cached) { this.stats.cacheHits++; return { ...cached, duration: Date.now() - start }; }
    }

    // Resolve schema
    let schema: ExtractionSchema | undefined;
    if (schemaName) {
      schema = getSchemaByName(schemaName) ?? this.customSchemas.get(schemaName);
      if (!schema) errors.push(`Schema "${schemaName}" not found`);
    } else {
      schema = this.detectSchema(url);
    }

    // Schema-based extraction
    let data: Record<string, unknown> = {};
    let method: ExtractionMethod = 'fallback';
    let confidence = 0;

    if (schema) {
      const schemaResult = applySelectors(html, schema.fields);
      const requiredFields = schema.fields.filter((f) => f.required);
      const requiredFilled = requiredFields.filter((f) => schemaResult[f.name] != null && schemaResult[f.name] !== '').length;

      if (requiredFilled > 0) {
        data = schemaResult;
        method = 'schema';
        confidence = requiredFields.length > 0 ? requiredFilled / requiredFields.length : 0.5;
        this.stats.schemaExtractions++;

        const validation = this.validateResult(data, schema);
        if (validation.errors.length > 0) { errors.push(...validation.errors); confidence *= 0.8; }
      }
    }

    // AI fallback
    if ((method === 'fallback' || confidence < 0.3) && fallbackToAi) {
      try {
        const aiResult = await aiExtractor.extract({
          html, description: schema ? `Extract data for ${schema.name}` : `Extract structured data from this page at ${url}`,
          url, schema,
        });
        if (aiResult.confidence > confidence) {
          data = { ...aiResult.data, ...data };
          for (const [k, v] of Object.entries(data)) { if (v == null || v === '') delete data[k]; }
          method = method === 'fallback' ? 'ai' : 'fallback';
          confidence = Math.max(confidence, aiResult.confidence);
          this.stats.aiExtractions++;
        }
      } catch (err: any) { errors.push(`AI fallback failed: ${err.message ?? String(err)}`); }
    }

    if (Object.keys(data).length === 0) { this.stats.fallbackExtractions++; errors.push('No data extracted by any method'); }
    this.stats.totalExtractions++;

    const result: ExtractionResult = {
      success: Object.keys(data).length > 0, data, schema: schema?.name ?? null,
      method, confidence: Math.round(confidence * 100) / 100, errors, duration: Date.now() - start,
    };

    if (useCache) {
      const cacheKey = `extract:${crypto.createHash('sha256').update(`${url}:${schemaName ?? 'auto'}`).digest('hex').slice(0, 24)}`;
      await cacheSet(cacheKey, result, cacheTtl).catch((err) => log.warn({ err }, 'Cache write failed'));
    }

    log.info({ url, method, confidence, duration: result.duration }, 'Structured extraction complete');
    return result;
  }

  /** Auto-detect domain, find matching schema, extract, fall back to AI. */
  async autoExtract(url: string, html: string): Promise<ExtractionResult> { return this.extract({ url, html }); }

  /** Process array of {url, html} pairs through same schema in parallel. */
  async batchExtract(items: Array<{ url: string; html: string }>, schemaName?: string, concurrency = 3): Promise<ExtractionResult[]> {
    const results: ExtractionResult[] = new Array(items.length);
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
        try { results[idx] = await this.extract({ url: items[idx].url, html: items[idx].html, schemaName }); }
        catch (err: any) { results[idx] = { success: false, data: {}, schema: schemaName ?? null, method: 'fallback', confidence: 0, errors: [`Failure: ${err.message ?? String(err)}`], duration: 0 }; }
        release();
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return results;
  }

  /** Register a custom schema at runtime. */
  registerSchema(schema: ExtractionSchema): void {
    this.customSchemas.set(schema.name, schema);
    log.info({ name: schema.name, domain: schema.domain, fieldCount: schema.fields.length }, 'Custom schema registered');
  }

  /** Detect the best matching schema for a given URL. */
  detectSchema(url: string): ExtractionSchema | undefined {
    for (const schema of this.customSchemas.values()) { try { if (new RegExp(schema.domain, 'i').test(url)) return schema; } catch {} }
    return detectSchemaForUrl(url);
  }

  /** Validate extracted data against a schema. */
  validateResult(data: Record<string, unknown>, schema: ExtractionSchema): { valid: boolean; errors: string[]; coverage: number } {
    const errors: string[] = [];
    let matched = 0;
    for (const field of schema.fields) {
      const value = data[field.name];
      if (value == null || value === '') { if (field.required) errors.push(`Required field "${field.name}" is missing`); continue; }
      matched++;
      if (field.type === 'array' && !Array.isArray(value)) errors.push(`Field "${field.name}" should be an array`);
      if (field.validation) {
        for (const rule of field.validation) {
          if (rule.type === 'regex' && typeof rule.value === 'string' && !new RegExp(rule.value).test(String(value)))
            errors.push(rule.message || `Field "${field.name}" failed regex validation`);
          if (rule.type === 'enum' && Array.isArray(rule.value) && !rule.value.includes(String(value)))
            errors.push(rule.message || `Field "${field.name}" value not in allowed set`);
        }
      }
    }
    const coverage = schema.fields.length > 0 ? matched / schema.fields.length : 1;
    return { valid: errors.filter((e) => e.includes('Required')).length === 0, errors, coverage: Math.round(coverage * 100) / 100 };
  }

  getStats() { return { ...this.stats, customSchemaCount: this.customSchemas.size, builtInSchemaCount: SCHEMAS.length }; }
}

export const structuredExtractor = new StructuredExtractorEngine();
