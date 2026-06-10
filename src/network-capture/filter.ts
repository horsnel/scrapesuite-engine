/**
 * Network Capture Filter Engine -- ScrapeSuite Engine
 *
 * Determines which network responses should be captured based on configurable
 * filters. Supports URL patterns, HTTP methods, content types, status codes,
 * required headers, exclude patterns, XHR-only mode, and body size limits.
 */

import { createHash } from 'crypto';
import { createChildLogger } from '../utils/logger';
import type { CaptureFilter } from './types';

const logger = createChildLogger('network-capture:filter');

/** Compile URL pattern strings into RegExp objects. */
export function compileUrlPatterns(patterns: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) { try { compiled.push(new RegExp(pattern, 'i')); } catch { logger.warn({ pattern }, 'Invalid URL pattern — skipping'); } }
  return compiled;
}

/** Parse status code specs ('2xx' → [200-299]) into flat number array. */
export function parseStatusCodes(codes: Array<number | string>): number[] {
  const result: number[] = [];
  for (const code of codes) {
    if (typeof code === 'number') { result.push(code); }
    else {
      const match = code.match(/^(\d)xx$/i);
      if (match) { const prefix = parseInt(match[1], 10); for (let i = 0; i < 100; i++) result.push(prefix * 100 + i); }
      else { const num = parseInt(code, 10); if (!isNaN(num)) result.push(num); }
    }
  }
  return result;
}

/** Compute SHA-256 hash of a response body for deduplication. */
export function computeBodyHash(body: string): string { return createHash('sha256').update(body).digest('hex'); }

/** Check if a capture is a duplicate based on URL + body hash. */
export function isDuplicate(url: string, bodyHash: string, seen: Set<string>): boolean { return seen.has(`${url}::${bodyHash}`); }

/** Record a capture's hash for future deduplication. */
export function recordHash(url: string, bodyHash: string, seen: Set<string>): void { seen.add(`${url}::${bodyHash}`); }

export interface ResponseMeta { url: string; method: string; statusCode: number; contentType: string; headers: Record<string, string>; resourceType: string; bodySize: number; }

/** Check if a response matches the capture filter (AND logic). */
export function matchFilter(meta: ResponseMeta, filter: CaptureFilter): boolean {
  if (filter.urlPatterns && filter.urlPatterns.length > 0) { if (!compileUrlPatterns(filter.urlPatterns).some((re) => re.test(meta.url))) return false; }
  if (filter.excludeUrlPatterns && filter.excludeUrlPatterns.length > 0) { if (compileUrlPatterns(filter.excludeUrlPatterns).some((re) => re.test(meta.url))) return false; }
  if (filter.methods && filter.methods.length > 0) { if (!filter.methods.map((m) => m.toUpperCase()).includes(meta.method.toUpperCase())) return false; }
  if (filter.contentTypes && filter.contentTypes.length > 0) { if (!filter.contentTypes.some((ct) => meta.contentType.toLowerCase().includes(ct.toLowerCase()))) return false; }
  if (filter.statusCodes && filter.statusCodes.length > 0) { if (!parseStatusCodes(filter.statusCodes).includes(meta.statusCode)) return false; }
  if (filter.requiredHeaders && filter.requiredHeaders.length > 0) { const headerKeys = Object.keys(meta.headers).map((k) => k.toLowerCase()); for (const req of filter.requiredHeaders) { if (!headerKeys.includes(req.toLowerCase())) return false; } }
  if (filter.xhrOnly) { if (!['xhr', 'fetch'].includes(meta.resourceType.toLowerCase())) return false; }
  if (filter.minBodySize && meta.bodySize < filter.minBodySize) return false;
  if (filter.maxBodySize && filter.maxBodySize > 0 && meta.bodySize > filter.maxBodySize) return false;
  return true;
}

/** Default filter — captures XHR/fetch JSON responses. */
export const DEFAULT_FILTER: CaptureFilter = { contentTypes: ['application/json'], xhrOnly: true, captureHeaders: true, deduplicate: true, maxBodySize: 5 * 1024 * 1024 };
