import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';
import { db } from '../utils/db';
import { logger } from '../utils/logger';
import type { ExtractRequest, ExtractResult, LearnedSchema } from '../types';

// --- Constants -----------------------------------------------------------------

const MODEL = 'claude-sonnet-4-20250514';
const MAX_CONTENT_CHARS = 8000;
const RATE_LIMIT_RPS = 8;                  // Max Claude API calls per second
const RATE_LIMIT_INTERVAL_MS = 1000 / RATE_LIMIT_RPS;
const CLAUDE_MAX_TOKENS = 4096;
const CLAUDE_TEMPERATURE = 0;

const CONFIDENCE_SCHEMA_MATCH = 0.97;
const CONFIDENCE_NO_SCHEMA = 0.85;
const CONFIDENCE_SCHEMA_MISMATCH = 0.72;

const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': '\u2014',
  '&ndash;': '\u2013',
  '&hellip;': '\u2026',
  '&laquo;': '\u00AB',
  '&raquo;': '\u00BB',
  '&copy;': '\u00A9',
  '&reg;': '\u00AE',
  '&trade;': '\u2122',
  '&euro;': '\u20AC',
  '&pound;': '\u00A3',
  '&yen;': '\u00A5',
  '&cent;': '\u00A2',
  '&rarr;': '\u2192',
  '&larr;': '\u2190',
};

// --- Rate Limiter --------------------------------------------------------------

class RateLimiter {
  private lastCallMs = 0;

  async acquire(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCallMs;
    const wait = RATE_LIMIT_INTERVAL_MS - elapsed;
    if (wait > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
    this.lastCallMs = Date.now();
  }
}

// --- NL Extractor Class --------------------------------------------------------

class NLExtractor {
  private client: Anthropic;
  private rateLimiter: RateLimiter;
  private log = logger.child({ module: 'nl-extractor' });

  constructor() {
    this.client = new Anthropic();
    this.rateLimiter = new RateLimiter();
  }

  // -- Public API ---------------------------------------------------------------

  /**
   * Extract structured data from HTML using a natural language instruction.
   * Leverages learned schemas for consistency and confidence scoring.
   */
  async extract(request: ExtractRequest): Promise<ExtractResult> {
    const { html, url, instruction } = request;
    const domain = this.extractDomain(url);

    // 1. Clean & convert HTML to semantic text
    const content = this.htmlToSemanticText(html);

    // 2. Look up any learned schema for this (domain, instruction)
    const instructionHash = this.hashInstruction(instruction);
    const learnedSchema = domain
      ? await this.loadLearnedSchema(domain, instructionHash)
      : null;

    // 3. Build the prompt
    const prompt = this.buildPrompt(instruction, content, learnedSchema);

    // 4. Call Claude with rate limiting & fallback
    let rawData: Record<string, any> | null = null;
    let tokensUsed = 0;

    try {
      await this.rateLimiter.acquire();

      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: CLAUDE_MAX_TOKENS,
        temperature: CLAUDE_TEMPERATURE,
        messages: [{ role: 'user', content: prompt }],
      });

      tokensUsed = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

      const textBlock = response.content.find((block) => block.type === 'text');
      if (textBlock && textBlock.type === 'text') {
        rawData = this.parseJsonResponse(textBlock.text);
      }
    } catch (err: any) {
      this.log.error({ err, url, domain, instructionHash }, 'Claude API call failed');
      return {
        data: null,
        confidence: 0,
        schemaMatch: false,
        tokensUsed: 0,
        error: `Claude API failure: ${err.message ?? String(err)}`,
      };
    }

    // 5. Handle null parsed result
    if (rawData === null) {
      this.log.warn({ url, domain, instructionHash }, 'Failed to parse Claude JSON response');
      return {
        data: null,
        confidence: 0,
        schemaMatch: false,
        tokensUsed,
        error: 'Failed to parse extraction response as JSON',
      };
    }

    // 6. Schema matching, drift detection & confidence scoring
    const { confidence, schemaMatch, driftDetected } = this.evaluateSchemaMatch(
      rawData,
      learnedSchema,
    );

    // 7. Persist schema learning (async -- don't block the result)
    if (domain) {
      this.persistSchema(domain, instructionHash, rawData, learnedSchema, driftDetected).catch(
        (err) => {
          this.log.error({ err, domain, instructionHash }, 'Failed to persist schema learning');
        },
      );
    }

    this.log.info(
      { domain, instructionHash, schemaMatch, driftDetected, confidence, tokensUsed },
      'Extraction complete',
    );

    return {
      data: rawData,
      confidence,
      schemaMatch,
      tokensUsed,
    };
  }

  /**
   * Batch extraction with bounded concurrency.
   * Uses a simple semaphore-based approach to limit parallel Claude calls.
   */
  async extractBatch(
    requests: ExtractRequest[],
    concurrency: number = 3,
  ): Promise<ExtractResult[]> {
    const results: ExtractResult[] = new Array(requests.length);

    // Semaphore for concurrency control
    let running = 0;
    let nextIndex = 0;
    const waitQueue: ((value: number) => void)[] = [];

    const acquire = async (): Promise<number> => {
      if (running < concurrency && nextIndex < requests.length) {
        running++;
        return nextIndex++;
      }
      return new Promise<number>((resolve) => {
        waitQueue.push(resolve);
      });
    };

    const release = (): void => {
      running--;
      if (waitQueue.length > 0 && nextIndex < requests.length) {
        running++;
        const resolve = waitQueue.shift()!;
        resolve(nextIndex++);
      }
    };

    const worker = async (): Promise<void> => {
      while (nextIndex < requests.length || waitQueue.length > 0) {
        const idx = await acquire();
        if (idx >= requests.length) break;
        try {
          results[idx] = await this.extract(requests[idx]);
        } catch (err: any) {
          this.log.error({ err, idx }, 'Batch extraction item failed unexpectedly');
          results[idx] = {
            data: null,
            confidence: 0,
            schemaMatch: false,
            tokensUsed: 0,
            error: `Unexpected failure: ${err.message ?? String(err)}`,
          };
        }
        release();
      }
    };

    // Launch initial workers up to concurrency
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(concurrency, requests.length); i++) {
      workers.push(worker());
    }

    await Promise.all(workers);

    return results;
  }

  // -- HTML Cleaning Pipeline ---------------------------------------------------

  /**
   * Full pipeline: clean HTML → semantic markdown-like text → truncate.
   */
  private htmlToSemanticText(html: string): string {
    let text = html;

    // Step 1: Remove script, style, nav, footer, aside tags and their content
    text = this.removeTagAndContent(text, 'script');
    text = this.removeTagAndContent(text, 'style');
    text = this.removeTagAndContent(text, 'nav');
    text = this.removeTagAndContent(text, 'footer');
    text = this.removeTagAndContent(text, 'aside');

    // Step 2: Remove <header> but keep content if it contains headings
    text = this.stripHeaderIfNoHeadings(text);

    // Step 3: Remove HTML comments
    text = text.replace(/<!--[\s\S]*?-->/g, '');

    // Step 4: Remove elements with ad/cookie/banner/popup/sidebar/social classes
    text = this.removeAdAndBannerElements(text);

    // Step 5: Remove elements with data-ad, data-ad-slot, data-ad-client attributes
    text = text.replace(/<[^>]+data-ad(?:-slot|-client)?[^>]*>[\s\S]*?<\/[^>]+>/gi, '');
    text = text.replace(/<[^>]+data-ad(?:-slot|-client)?[^>]*\/?>/gi, '');

    // Step 6-9: Semantic conversions (order matters -- do before stripping all tags)
    text = this.convertHeadings(text);
    text = this.convertListItems(text);
    text = this.convertLinks(text);
    text = this.convertParagraphs(text);

    // Step 10: Strip remaining HTML tags
    text = text.replace(/<[^>]+>/g, '');

    // Step 11: Decode HTML entities
    text = this.decodeHtmlEntities(text);

    // Step 12: Collapse whitespace
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.trim();

    // Step 13: Truncate to token budget
    text = this.truncateToBudget(text, MAX_CONTENT_CHARS);

    return text;
  }

  /**
   * Remove a specific tag and everything between its opening and closing tags.
   */
  private removeTagAndContent(html: string, tag: string): string {
    const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    return html.replace(re, '');
  }

  /**
   * Strip <header> tags but only remove their *content* if there are no headings inside.
   * If the header contains h1-h6, we keep the inner content (the headings conversion will
   * handle them later).
   */
  private stripHeaderIfNoHeadings(html: string): string {
    return html.replace(/<header[^>]*>([\s\S]*?)<\/header>/gi, (_match, inner: string) => {
      const hasHeading = /<h[1-6][\s>]/i.test(inner);
      return hasHeading ? inner : '';
    });
  }

  /**
   * Remove elements whose class attribute matches common ad / banner / cookie patterns.
   */
  private removeAdAndBannerElements(html: string): string {
    const adClassPattern =
      /class\s*=\s*["'][^"']*(?:cookie|banner|popup|modal|overlay|sidebar|ad(?:vertisement)?|social|share)[^"']*["']/i;

    // Self-closing or void elements
    html = html.replace(/<\w+[^>]*class\s*=\s*["'][^"']*(?:cookie|banner|popup|modal|overlay|sidebar|ad(?:vertisement)?|social|share)[^"']*["'][^>]*\/?>/gi, '');

    // Elements with closing tags -- need to match the full element including content
    // We iterate because nested matches can be tricky; do a multi-pass approach
    for (let pass = 0; pass < 3; pass++) {
      const before = html;
      html = html.replace(
        /<(\w+)([^>]*)class\s*=\s*["'][^"']*(?:cookie|banner|popup|modal|overlay|sidebar|ad(?:vertisement)?|social|share)[^"']*["']([^>]*)>([\s\S]*?)<\/\1>/gi,
        '',
      );
      if (html === before) break; // No more changes
    }

    return html;
  }

  /**
   * Convert <h1>-<h6> to ## markdown-style headings.
   * Preserves heading level with additional # characters.
   */
  private convertHeadings(html: string): string {
    return html.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_match, level: string, content: string) => {
      const n = parseInt(level, 10);
      const hashes = '#'.repeat(n + 1); // h1 → ##, h2 → ###, etc.
      const text = content.replace(/<[^>]+>/g, '').trim();
      return `\n${hashes} ${text}\n`;
    });
  }

  /**
   * Convert <li> items to - bullet points.
   */
  private convertListItems(html: string): string {
    return html.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, content: string) => {
      const text = content.replace(/<[^>]+>/g, '').trim();
      return `\n- ${text}`;
    });
  }

  /**
   * Convert <a href="url">text</a> to [text](url).
   */
  private convertLinks(html: string): string {
    return html.replace(
      /<a[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_match, href: string, text: string) => {
        const cleanText = text.replace(/<[^>]+>/g, '').trim();
        return `[${cleanText}](${href})`;
      },
    );
  }

  /**
   * Convert <p> tags to double-newline paragraph breaks.
   */
  private convertParagraphs(html: string): string {
    return html.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_match, content: string) => {
      return `\n\n${content}\n\n`;
    });
  }

  /**
   * Decode common HTML entities to their character equivalents.
   */
  private decodeHtmlEntities(text: string): string {
    // Named entities
    for (const [entity, char] of Object.entries(HTML_ENTITY_MAP)) {
      text = text.split(entity).join(char);
    }
    // Decimal numeric entities: &#123;
    text = text.replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCharCode(parseInt(code, 10)),
    );
    // Hexadecimal numeric entities: &#x1F;
    text = text.replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
    return text;
  }

  /**
   * Truncate text to a maximum character count, preferring to break at
   * sentence or word boundaries.
   */
  private truncateToBudget(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;

    // Try to break at the last sentence boundary within budget
    const sentenceBreak = text.lastIndexOf('.', maxChars);
    if (sentenceBreak > maxChars * 0.5) {
      return text.slice(0, sentenceBreak + 1);
    }

    // Try to break at the last word boundary within budget
    const wordBreak = text.lastIndexOf(' ', maxChars);
    if (wordBreak > maxChars * 0.5) {
      return text.slice(0, wordBreak);
    }

    // Hard truncate
    return text.slice(0, maxChars);
  }

  // -- Prompt Construction ------------------------------------------------------

  private buildPrompt(
    instruction: string,
    content: string,
    learnedSchema: LearnedSchema | null,
  ): string {
    const schemaGuidance = learnedSchema
      ? this.buildSchemaGuidance(learnedSchema)
      : '';

    return `You are a data extraction specialist. Extract structured data from the following web page content based on the user's instruction.

INSTRUCTION: ${instruction}

WEB CONTENT:
${content}
${schemaGuidance}
Return ONLY a valid JSON object with the extracted data. Do not include any explanation or markdown formatting.`;
  }

  private buildSchemaGuidance(schema: LearnedSchema): string {
    const schemaStr = JSON.stringify(schema.schema, null, 2);
    const exampleStr = schema.exampleOutput
      ? JSON.stringify(schema.exampleOutput, null, 2)
      : '(no example available)';

    return `
PREVIOUS EXTRACTION SCHEMA (use this as a template):
${schemaStr}
EXAMPLE OUTPUT:
${exampleStr}
Try to match this schema structure. If the data has fundamentally changed, extract what's available.`;
  }

  // -- JSON Parsing -------------------------------------------------------------

  /**
   * Parse Claude's text response as JSON.
   * Handles cases where the model wraps output in ```json ... ``` blocks.
   */
  private parseJsonResponse(text: string): Record<string, any> | null {
    // Strip leading/trailing whitespace
    let cleaned = text.trim();

    // Remove markdown code fences if present
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    try {
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
      // If the model returned an array, wrap it
      if (Array.isArray(parsed)) {
        return { items: parsed };
      }
      return null;
    } catch {
      // Attempt a more lenient extraction: find the first { ... } block
      const braceStart = cleaned.indexOf('{');
      const braceEnd = cleaned.lastIndexOf('}');
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          const extracted = JSON.parse(cleaned.slice(braceStart, braceEnd + 1));
          if (extracted && typeof extracted === 'object') {
            return extracted as Record<string, any>;
          }
        } catch {
          // Give up
        }
      }
      return null;
    }
  }

  // -- Schema Learning & Drift Detection ----------------------------------------

  /**
   * Hash an instruction string to a fixed-length key for schema lookup.
   */
  private hashInstruction(instruction: string): string {
    return crypto.createHash('sha256').update(instruction.trim().toLowerCase()).digest('hex').slice(0, 16);
  }

  /**
   * Extract the domain from a URL string.
   */
  private extractDomain(url?: string): string | null {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return null;
    }
  }

  /**
   * Load a previously learned schema for the given (domain, instructionHash) pair.
   */
  private async loadLearnedSchema(
    domain: string,
    instructionHash: string,
  ): Promise<LearnedSchema | null> {
    try {
      const row = await db.learnedSchema.findUnique({
        where: {
          domain_instructionHash: {
            domain,
            instructionHash,
          },
        },
      });

      if (!row) return null;

      return {
        id: row.id,
        domain: row.domain,
        instructionHash: row.instructionHash,
        schema: row.schema as Record<string, any>,
        exampleOutput: row.exampleOutput as Record<string, any> | null,
        uses: row.uses,
        lastSuccess: row.lastSuccess?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      };
    } catch (err) {
      this.log.error({ err, domain, instructionHash }, 'Failed to load learned schema');
      return null;
    }
  }

  /**
   * Evaluate how well the extracted data matches a learned schema.
   * Returns confidence score, match flag, and drift indicator.
   */
  private evaluateSchemaMatch(
    extractedData: Record<string, any>,
    learnedSchema: LearnedSchema | null,
  ): { confidence: number; schemaMatch: boolean; driftDetected: boolean } {
    // No learned schema -- baseline confidence
    if (!learnedSchema) {
      return { confidence: CONFIDENCE_NO_SCHEMA, schemaMatch: false, driftDetected: false };
    }

    const schemaKeys = Object.keys(learnedSchema.schema);
    const extractedKeys = Object.keys(extractedData);

    // No schema keys to compare (edge case) -- treat as match
    if (schemaKeys.length === 0) {
      return { confidence: CONFIDENCE_SCHEMA_MATCH, schemaMatch: true, driftDetected: false };
    }

    // Calculate key overlap
    const matchedKeys = extractedKeys.filter((k) => schemaKeys.includes(k));
    const matchRatio = matchedKeys.length / schemaKeys.length;

    // Schema match: at least 60% of schema keys appear in extracted data
    if (matchRatio >= 0.6) {
      return { confidence: CONFIDENCE_SCHEMA_MATCH, schemaMatch: true, driftDetected: false };
    }

    // Schema mismatch / drift
    return { confidence: CONFIDENCE_SCHEMA_MISMATCH, schemaMatch: false, driftDetected: true };
  }

  /**
   * Persist extraction results as schema learning.
   * - If no schema exists: create one.
   * - If schema exists & matched: update usage count.
   * - If schema exists & drifted: log drift, then update the schema.
   */
  private async persistSchema(
    domain: string,
    instructionHash: string,
    extractedData: Record<string, any>,
    learnedSchema: LearnedSchema | null,
    driftDetected: boolean,
  ): Promise<void> {
    try {
      // Ensure the domain profile exists (required by FK constraint)
      await db.domainProfile.upsert({
        where: { domain },
        update: { lastUpdated: new Date() },
        create: { domain },
      });

      if (!learnedSchema) {
        // First extraction for this (domain, instruction) -- create schema
        await db.learnedSchema.create({
          data: {
            domain,
            instructionHash,
            schema: Object.keys(extractedData).reduce<Record<string, string>>(
              (acc, key) => {
                acc[key] = typeof extractedData[key] === 'object' && extractedData[key] !== null
                  ? 'object'
                  : typeof extractedData[key];
                return acc;
              },
              {},
            ),
            exampleOutput: extractedData,
            uses: 1,
            lastSuccess: new Date(),
          },
        });
        this.log.info({ domain, instructionHash }, 'Created new learned schema');
        return;
      }

      if (driftDetected) {
        // Log the drift
        await db.schemaDriftLog.create({
          data: {
            domain,
            instructionHash,
            newSample: extractedData,
          },
        });
        this.log.warn({ domain, instructionHash }, 'Schema drift detected and logged');

        // Update the schema to reflect the new structure
        const newSchemaKeys = Object.keys(extractedData).reduce<Record<string, string>>(
          (acc, key) => {
            acc[key] = typeof extractedData[key] === 'object' && extractedData[key] !== null
              ? 'object'
              : typeof extractedData[key];
            return acc;
          },
          {},
        );

        await db.learnedSchema.update({
          where: {
            domain_instructionHash: { domain, instructionHash },
          },
          data: {
            schema: newSchemaKeys,
            exampleOutput: extractedData,
            uses: { increment: 1 },
            lastSuccess: new Date(),
          },
        });
        return;
      }

      // Schema matched -- just increment usage
      await db.learnedSchema.update({
        where: {
          domain_instructionHash: { domain, instructionHash },
        },
        data: {
          uses: { increment: 1 },
          lastSuccess: new Date(),
        },
      });
    } catch (err) {
      this.log.error({ err, domain, instructionHash, driftDetected }, 'Schema persistence error');
    }
  }
}

// --- Singleton Export ----------------------------------------------------------

export const nlExtractor = new NLExtractor();
