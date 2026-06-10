/**
 * PDF Capture Module -- ScrapeSuite
 *
 * Captures web pages as PDF documents using Playwright's page.pdf() method.
 * Supports multiple paper formats, custom CSS injection, watermarks,
 * metadata embedding, streaming output, and credit tracking.
 *
 * Usage
 * -----
 *   import { pdfCapture } from '../pdf';
 *   const result = await pdfCapture.capture({
 *     url: 'https://example.com',
 *     format: 'A4',
 *     watermark: { text: 'CONFIDENTIAL' },
 *   }, page);
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { db } from '../utils/db';
import type { Page, BrowserContext, Browser } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const logger = createChildLogger('pdf-capture');

// --- Constants ----------------------------------------------------------------

const DEFAULT_FORMAT: PDFFormat = 'A4';
const DEFAULT_ORIENTATION: PageOrientation = 'portrait';
const DEFAULT_MARGIN_MM = 10;
const DEFAULT_NAVIGATION_TIMEOUT = 30_000;
const DEFAULT_WAIT_STRATEGY: WaitStrategy = 'networkidle';
const DEFAULT_MAX_CONCURRENCY = 5;
const CREDITS_PER_PAGE = 2;
const RATE_LIMIT_PREFIX = 'pdf-capture:rate:';
const PDF_CACHE_PREFIX = 'pdf:cache:';
const PDF_CACHE_TTL_SECONDS = 3600;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_CAPTURES = 30;
const MAX_PDF_SIZE_BYTES = 50 * 1024 * 1024;

// --- Types --------------------------------------------------------------------

/** Supported PDF paper formats. */
export type PDFFormat = 'Letter' | 'Legal' | 'Tabloid' | 'Ledger' | 'A0' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6';

/** Page orientation. */
export type PageOrientation = 'portrait' | 'landscape';

/** Wait strategy applied before capturing. */
export type WaitStrategy = 'networkidle' | 'domcontentloaded' | 'load' | 'selector';

/** Capture mode: fullpage scrolls the whole document, viewport captures only the visible area. */
export type CaptureMode = 'fullpage' | 'viewport';

/** Margin configuration in millimeters. */
export interface PDFMargins {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

/** Header/footer template using Playwright template syntax (date, title, url, pageNumber, totalPages). */
export interface PDFFooterHeader {
  template?: string;
  enabled?: boolean;
}

/** PDF metadata to embed in the document. */
export interface PDFMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
}

/** Watermark configuration applied to each page. */
export interface WatermarkConfig {
  text: string;
  fontSize?: number;
  color?: string;
  rotation?: number;
  fontFamily?: string;
}

/** Custom page size when format is not one of the standard sizes. */
export interface CustomPageSize {
  width: number;
  height: number;
}

/** Full configuration for a PDF capture request. */
export interface PDFCaptureOptions {
  url: string;
  format?: PDFFormat;
  customSize?: CustomPageSize;
  orientation?: PageOrientation;
  margins?: PDFMargins;
  captureMode?: CaptureMode;
  printBackground?: boolean;
  preferCSSPageSize?: boolean;
  pageRanges?: string;
  scale?: number;
  header?: PDFFooterHeader;
  footer?: PDFFooterHeader;
  customCSS?: string;
  waitStrategy?: WaitStrategy;
  waitForSelector?: string;
  timeout?: number;
  metadata?: PDFMetadata;
  watermark?: WatermarkConfig;
  outputPath?: string;
  useCache?: boolean;
  cacheTtl?: number;
  userId?: string;
  apiKeyId?: string;
  headers?: Record<string, string>;
  proxyUrl?: string;
  screenMedia?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
}

/** Result of a PDF capture operation. */
export interface PDFCaptureResult {
  captureId: string;
  url: string;
  finalUrl?: string;
  buffer: Buffer;
  sizeBytes: number;
  format: PDFFormat | 'custom';
  orientation: PageOrientation;
  pageCount: number;
  cached: boolean;
  captureMs: number;
  creditsUsed: number;
  creditsCharged: number;
  outputPath?: string;
  contentHash: string;
  timestamp: string;
}

// --- Internal: Concurrency Semaphore ------------------------------------------

/** Simple counting semaphore for limiting concurrent PDF captures. */
class ConcurrencySemaphore {
  private running = 0;
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(private maxConcurrency: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) { this.running++; return; }
    return new Promise<void>((resolve, reject) => { this.queue.push({ resolve, reject }); });
  }

  release(): void {
    this.running--;
    if (this.queue.length > 0) { this.running++; this.queue.shift()!.resolve(); }
  }

  get activeCount(): number { return this.running; }
  get waitingCount(): number { return this.queue.length; }
}

// --- Internal Helpers ---------------------------------------------------------

/** Build JS snippet that renders a fixed-position watermark overlay. */
function buildWatermarkScript(config: WatermarkConfig): string {
  const { text, fontSize = 48, color = 'rgba(200, 200, 200, 0.4)', rotation = -45, fontFamily = 'sans-serif' } = config;
  return `(function(){
    var c=document.createElement('div');c.setAttribute('data-ss-watermark','true');
    c.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:999999;overflow:hidden;display:flex;align-items:center;justify-content:center;';
    var s=document.createElement('span');s.textContent=${JSON.stringify(text)};
    s.style.cssText='font-size:${fontSize}px;color:${color};font-family:${fontFamily};transform:rotate(${rotation}deg);user-select:none;white-space:nowrap;font-weight:bold;letter-spacing:4px;';
    c.appendChild(s);document.documentElement.appendChild(c);
  })();`;
}

/** Build JS snippet that injects a <style> element with custom CSS. */
function buildCSSInjectionScript(css: string): string {
  return `(function(){
    var s=document.createElement('style');s.setAttribute('data-ss-custom-css','true');
    s.textContent=${JSON.stringify(css)};document.head.appendChild(s);
  })();`;
}

/** Count /Type /Page entries in the PDF buffer (not /Pages containers). */
function extractPageCount(pdfBuffer: Buffer): number {
  try {
    const text = pdfBuffer.toString('latin1');
    const matches = text.match(/\/Type\s*\/Page[^s]/g);
    return matches ? matches.length : 1;
  } catch { return 1; }
}

/** Generate a deterministic cache key from the capture options. */
function generateCacheKey(options: PDFCaptureOptions): string {
  const parts = [
    options.url, options.format || DEFAULT_FORMAT, options.orientation || DEFAULT_ORIENTATION,
    options.captureMode || 'fullpage', options.printBackground !== false ? 'bg' : 'nobg',
    options.scale || 1, options.customSize ? `${options.customSize.width}x${options.customSize.height}` : '',
    options.customCSS ? crypto.createHash('md5').update(options.customCSS).digest('hex') : '',
    options.watermark ? crypto.createHash('md5').update(options.watermark.text).digest('hex') : '',
    options.pageRanges || '', options.screenMedia ? 'screen' : 'print',
  ];
  return `${PDF_CACHE_PREFIX}${crypto.createHash('sha256').update(parts.join('|')).digest('hex')}`;
}

/** Build the options object for Playwright's page.pdf() from PDFCaptureOptions. */
function buildPlaywrightPDFOptions(options: PDFCaptureOptions): Record<string, any> {
  const m = options.margins || {};
  const d = DEFAULT_MARGIN_MM;
  const opts: Record<string, any> = {
    landscape: (options.orientation || DEFAULT_ORIENTATION) === 'landscape',
    printBackground: options.printBackground !== false,
    preferCSSPageSize: options.preferCSSPageSize !== false,
    margin: { top: `${m.top ?? d}mm`, right: `${m.right ?? d}mm`, bottom: `${m.bottom ?? d}mm`, left: `${m.left ?? d}mm` },
    fullPage: (options.captureMode || 'fullpage') === 'fullpage',
  };

  if (options.customSize) { opts.width = `${options.customSize.width}mm`; opts.height = `${options.customSize.height}mm`; }
  else { opts.format = options.format || DEFAULT_FORMAT; }

  if (options.pageRanges) opts.pageRanges = options.pageRanges;
  if (options.scale !== undefined) opts.scale = options.scale;
  if (options.header?.enabled && options.header.template) { opts.displayHeaderFooter = true; opts.headerTemplate = options.header.template; }
  if (options.footer?.enabled && options.footer.template) { opts.displayHeaderFooter = true; opts.footerTemplate = options.footer.template; }

  return opts;
}

// --- PDFCapture Class ---------------------------------------------------------

/**
 * Core PDF capture engine for ScrapeSuite.
 *
 * Architecture:
 *  1. Check Redis cache for a matching prior capture
 *  2. Check rate limits for the requesting user
 *  3. Acquire concurrency slot
 *  4. Navigate to the URL with the specified wait strategy
 *  5. Inject custom CSS and/or watermark scripts
 *  6. Call page.pdf() with the computed options
 *  7. Stream to file if outputPath is specified
 *  8. Track credits and persist capture metadata
 *
 * The class does not manage its own browser pool -- callers supply
 * a Page instance from BrowserPool.acquire() so that browser lifecycle,
 * proxy rotation, and anti-bot evasion are handled upstream.
 */
export class PDFCapture {
  private semaphore: ConcurrencySemaphore;
  private stats = {
    totalCaptures: 0, totalCached: 0, totalFailed: 0,
    totalCreditsCharged: 0, avgCaptureMs: 0, peakConcurrency: 0,
  };

  constructor(maxConcurrency: number = DEFAULT_MAX_CONCURRENCY) {
    this.semaphore = new ConcurrencySemaphore(maxConcurrency);
  }

  /**
   * Capture a web page as a PDF document.
   *
   * @param options - Capture configuration
   * @param page - A Playwright Page (from browser pool) to use for rendering
   * @returns PDFCaptureResult with buffer, metadata, and credit info
   */
  async capture(options: PDFCaptureOptions, page: Page): Promise<PDFCaptureResult> {
    const captureId = `pdf-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const startTime = Date.now();

    if (!options.url) throw new Error('PDF capture requires a URL');
    try { new URL(options.url); } catch { throw new Error(`Invalid URL: ${options.url}`); }

    // -- Check cache ---------------------------------------------------------
    const useCache = options.useCache !== false;
    if (useCache) {
      const cacheKey = generateCacheKey(options);
      const cached = await cacheGet<PDFCaptureResult>(cacheKey);
      if (cached) {
        logger.info({ captureId, url: options.url }, 'PDF served from cache');
        this.stats.totalCaptures++; this.stats.totalCached++;
        return { ...cached, cached: true };
      }
    }

    // -- Check rate limit ----------------------------------------------------
    if (options.userId) {
      const allowed = await this.checkRateLimit(options.userId);
      if (!allowed) throw new Error('PDF capture rate limit exceeded -- try again later');
    }

    // -- Acquire concurrency slot --------------------------------------------
    await this.semaphore.acquire();
    this.stats.peakConcurrency = Math.max(this.stats.peakConcurrency, this.semaphore.activeCount);

    try {
      // -- Configure page ----------------------------------------------------
      const timeout = options.timeout || DEFAULT_NAVIGATION_TIMEOUT;
      page.setDefaultTimeout(timeout);
      page.setDefaultNavigationTimeout(timeout);

      if (options.viewportWidth || options.viewportHeight) {
        await page.setViewportSize({ width: options.viewportWidth || 1280, height: options.viewportHeight || 720 });
      }

      // -- Navigate ----------------------------------------------------------
      logger.info({ captureId, url: options.url, waitStrategy: options.waitStrategy || DEFAULT_WAIT_STRATEGY }, 'Navigating for PDF capture');

      if (options.headers && Object.keys(options.headers).length > 0) {
        await page.setExtraHTTPHeaders(options.headers);
      }

      const waitUntil = options.waitStrategy === 'selector'
        ? 'domcontentloaded' as const
        : ((options.waitStrategy || DEFAULT_WAIT_STRATEGY) as 'load' | 'domcontentloaded' | 'networkidle');
      await page.goto(options.url, { timeout, waitUntil });
      const finalUrl = page.url();

      // -- Wait for selector if needed ---------------------------------------
      if (options.waitStrategy === 'selector' && options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, { timeout });
      }

      // -- Inject custom CSS -------------------------------------------------
      if (options.customCSS) {
        await page.evaluate(buildCSSInjectionScript(options.customCSS));
      }

      // -- Inject watermark --------------------------------------------------
      if (options.watermark) {
        logger.debug({ captureId, text: options.watermark.text }, 'Injecting watermark');
        await page.evaluate(buildWatermarkScript(options.watermark));
      }

      // -- Emulate media type ------------------------------------------------
      await page.emulateMedia({ media: options.screenMedia ? 'screen' : 'print' });

      // -- Generate PDF ------------------------------------------------------
      const pdfBuffer = await page.pdf(buildPlaywrightPDFOptions(options));

      if (pdfBuffer.length > MAX_PDF_SIZE_BYTES) {
        throw new Error(`PDF exceeds max size (${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB)`);
      }

      const pageCount = extractPageCount(pdfBuffer);
      const contentHash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');

      // -- Stream to file if requested ---------------------------------------
      if (options.outputPath) {
        const resolvedPath = path.resolve(options.outputPath);
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolvedPath, pdfBuffer);
        logger.info({ captureId, outputPath: resolvedPath }, 'PDF written to file');
      }

      // -- Calculate credits -------------------------------------------------
      const creditsUsed = pageCount * CREDITS_PER_PAGE;
      const captureMs = Date.now() - startTime;

      if (options.userId && options.apiKeyId) {
        await this.trackCredits(options.userId, options.apiKeyId, creditsUsed, captureId, options.url);
      }

      // -- Build result ------------------------------------------------------
      const result: PDFCaptureResult = {
        captureId, url: options.url, finalUrl, buffer: pdfBuffer,
        sizeBytes: pdfBuffer.length,
        format: options.customSize ? 'custom' : (options.format || DEFAULT_FORMAT),
        orientation: options.orientation || DEFAULT_ORIENTATION,
        pageCount, cached: false, captureMs, creditsUsed, creditsCharged: creditsUsed,
        outputPath: options.outputPath ? path.resolve(options.outputPath) : undefined,
        contentHash, timestamp: new Date().toISOString(),
      };

      // -- Cache result ------------------------------------------------------
      if (useCache) {
        const cacheKey = generateCacheKey(options);
        await cacheSet(cacheKey, result, options.cacheTtl || PDF_CACHE_TTL_SECONDS).catch((err: any) => {
          logger.warn({ captureId, error: err.message }, 'Failed to cache PDF result');
        });
      }

      this.stats.totalCaptures++;
      this.stats.totalCreditsCharged += creditsUsed;
      this.updateAvgCaptureMs(captureMs);

      logger.info({ captureId, url: options.url, pageCount, sizeBytes: pdfBuffer.length, captureMs, creditsUsed }, 'PDF capture completed');
      return result;

    } catch (err: any) {
      this.stats.totalFailed++;
      logger.error({ captureId, url: options.url, error: err.message }, 'PDF capture failed');
      throw err;
    } finally {
      this.semaphore.release();
      try {
        await page.evaluate(() => {
          document.querySelectorAll('[data-ss-watermark]').forEach((el) => el.remove());
          document.querySelectorAll('[data-ss-custom-css]').forEach((el) => el.remove());
        });
      } catch { /* page may be closed */ }
    }
  }

  /**
   * Capture multiple URLs as individual PDFs.
   * Respects concurrency limits; each URL is captured in sequence on the same page.
   *
   * @param urls - Array of URLs (max 50)
   * @param page - Playwright Page to reuse
   * @param baseOptions - Base options applied to every capture
   */
  async captureMultiple(
    urls: string[], page: Page, baseOptions?: Omit<PDFCaptureOptions, 'url'>,
  ): Promise<PDFCaptureResult[]> {
    if (urls.length === 0) return [];
    if (urls.length > 50) throw new Error('Batch PDF capture limited to 50 URLs');
    logger.info({ urlCount: urls.length }, 'Starting batch PDF capture');
    const results: PDFCaptureResult[] = [];
    for (const url of urls) {
      results.push(await this.capture({ ...baseOptions, url }, page));
    }
    logger.info({ urlCount: urls.length }, 'Batch PDF capture completed');
    return results;
  }

  /**
   * Stream a PDF capture directly to a file on disk.
   * Convenience wrapper that requires outputPath and verifies the file was written.
   */
  async captureToFile(options: PDFCaptureOptions, page: Page): Promise<PDFCaptureResult> {
    if (!options.outputPath) throw new Error('captureToFile requires outputPath');
    const result = await this.capture(options, page);
    if (!fs.existsSync(options.outputPath)) throw new Error(`PDF file not written to ${options.outputPath}`);
    return result;
  }

  /** Get operational statistics for the PDF capture module. */
  getStats() {
    return { ...this.stats, activeConcurrency: this.semaphore.activeCount, waitingRequests: this.semaphore.waitingCount };
  }

  // --- Private Methods --------------------------------------------------------

  /** Per-user rate limiter backed by Redis. */
  private async checkRateLimit(userId: string): Promise<boolean> {
    try {
      const key = `${RATE_LIMIT_PREFIX}${userId}`;
      const cached = await cacheGet<{ count: number; windowStart: number }>(key);
      const now = Date.now();
      const windowMs = RATE_LIMIT_WINDOW_SECONDS * 1000;

      if (cached && now - cached.windowStart < windowMs) {
        if (cached.count >= RATE_LIMIT_MAX_CAPTURES) {
          logger.warn({ userId, count: cached.count }, 'PDF capture rate limit exceeded');
          return false;
        }
        await cacheSet(key, { count: cached.count + 1, windowStart: cached.windowStart }, RATE_LIMIT_WINDOW_SECONDS);
      } else {
        await cacheSet(key, { count: 1, windowStart: now }, RATE_LIMIT_WINDOW_SECONDS);
      }
      return true;
    } catch (err: any) {
      logger.warn({ userId, error: err.message }, 'Rate limit check failed -- allowing request');
      return true;
    }
  }

  /** Record a credit transaction in the database. */
  private async trackCredits(userId: string, apiKeyId: string, credits: number, captureId: string, url: string): Promise<void> {
    try {
      // Use raw query to avoid coupling to a specific Prisma model name
      await db.$executeRaw`
        INSERT INTO credit_transactions (id, user_id, api_key_id, credits, operation, reference_id, metadata, created_at)
        VALUES (${crypto.randomUUID()}, ${userId}, ${apiKeyId}, ${credits}, 'PDF_CAPTURE', ${captureId}, ${JSON.stringify({ url, operation: 'pdf_capture' })}, NOW())
      `;
    } catch (err: any) {
      logger.error({ userId, credits, captureId, error: err.message }, 'Failed to record credit transaction');
    }
  }

  /** Update the rolling average capture duration. */
  private updateAvgCaptureMs(captureMs: number): void {
    if (this.stats.totalCaptures === 1) {
      this.stats.avgCaptureMs = captureMs;
    } else {
      const prev = this.stats.avgCaptureMs;
      this.stats.avgCaptureMs = Math.round(prev + (captureMs - prev) / this.stats.totalCaptures);
    }
  }
}

// --- Singleton Export ---------------------------------------------------------

/** Default PDFCapture instance with standard concurrency. */
export const pdfCapture = new PDFCapture();
