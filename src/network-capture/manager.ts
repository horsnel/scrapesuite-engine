/**
 * Network Capture Manager -- ScrapeSuite Engine
 *
 * Captures XHR/fetch network responses from browser sessions by attaching
 * Playwright response listeners. Enables API interception scraping.
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheSet, redis } from '../utils/redis';
import type { Page, Response } from 'playwright';
import type { CaptureFilter, CapturedResponse, CaptureSession, CaptureSessionInfo, StartCaptureOptions, CaptureQueryOptions, CaptureStats } from './types';
import { matchFilter, computeBodyHash, isDuplicate, recordHash, DEFAULT_FILTER } from './filter';

const logger = createChildLogger('network-capture');
const CAPTURE_PREFIX = 'capture:';
const MAX_BODY_SIZE = 10 * 1024 * 1024;
const DEFAULT_MAX_CAPTURES = 1000;
const DEFAULT_MAX_DURATION_MS = 30 * 60 * 1000;

export class NetworkCaptureManager {
  private sessions = new Map<string, CaptureSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  async startCapture(options: StartCaptureOptions = {}): Promise<CaptureSessionInfo> {
    const id = `cap-${randomUUID()}`;
    const filters = { ...DEFAULT_FILTER, ...options.filters };
    const session: CaptureSession = { id, userId: options.userId || 'anonymous', config: { ...options, filters }, status: 'starting', captures: [], startedAt: Date.now(), stoppedAt: null, totalRequests: 0, totalCaptured: 0, totalFiltered: 0, totalDeduplicated: 0, totalBytes: 0, seenHashes: new Set() };
    this.sessions.set(id, session);
    try { await cacheSet(`${CAPTURE_PREFIX}${id}:meta`, { id, userId: session.userId, status: session.status, startedAt: session.startedAt, config: session.config }, 1800); } catch {}
    logger.info({ captureSessionId: id }, 'Capture session created');
    return this.toSessionInfo(session);
  }

  async attachToPage(captureSessionId: string, page: Page): Promise<void> {
    const session = this.sessions.get(captureSessionId);
    if (!session) throw new Error(`Capture session "${captureSessionId}" not found`);
    session.status = 'active';
    const responseHandler = async (response: Response) => {
      try { if (session.status !== 'active') return; await this.processResponse(session, response); } catch {}
      const config = session.config;
      if (config.stopOnPattern) { try { if (new RegExp(config.stopOnPattern, 'i').test(response.url())) await this.stopCapture(captureSessionId); } catch {} }
      if (config.stopAfterN && session.totalCaptured >= config.stopAfterN) await this.stopCapture(captureSessionId);
    };
    page.on('response', responseHandler);
    session.detachListener = () => { try { page.off('response', responseHandler); } catch {} };
  }

  async stopCapture(captureSessionId: string): Promise<void> {
    const session = this.sessions.get(captureSessionId);
    if (!session) return;
    session.status = 'stopped'; session.stoppedAt = Date.now();
    if (session.detachListener) { try { session.detachListener(); } catch {} session.detachListener = undefined; }
  }

  async pauseCapture(captureSessionId: string): Promise<void> { const s = this.sessions.get(captureSessionId); if (s) s.status = 'paused'; }
  async resumeCapture(captureSessionId: string): Promise<void> { const s = this.sessions.get(captureSessionId); if (s) s.status = 'active'; }

  private async processResponse(session: CaptureSession, response: Response): Promise<void> {
    const filter = session.config.filters || DEFAULT_FILTER;
    const url = response.url(), method = response.request().method(), statusCode = response.status(), contentType = response.headers()['content-type'] || '', resourceType = response.request().resourceType();
    session.totalRequests++;
    const headers: Record<string, string> = {}; for (const [k, v] of Object.entries(response.headers())) headers[k.toLowerCase()] = v;
    const meta = { url, method, statusCode, contentType, headers, resourceType, bodySize: parseInt(headers['content-length'] || '0', 10) };
    if (!matchFilter(meta, filter)) { session.totalFiltered++; return; }
    if ((session.config.maxCaptures || DEFAULT_MAX_CAPTURES) > 0 && session.captures.length >= (session.config.maxCaptures || DEFAULT_MAX_CAPTURES)) return;
    let body: string | null = null, bodyJson: unknown | null = null, bodyTruncated = false, bodySizeBytes = 0, bodyHash = '';
    try {
      body = await response.text(); bodySizeBytes = Buffer.byteLength(body || '', 'utf-8');
      const maxBody = filter.maxBodySize || MAX_BODY_SIZE;
      if (maxBody > 0 && bodySizeBytes > maxBody) { body = body!.substring(0, maxBody); bodyTruncated = true; }
      bodyHash = computeBodyHash(body || '');
      if (contentType.includes('json')) try { bodyJson = JSON.parse(body!); } catch {}
    } catch {}
    let isDup = false;
    if (filter.deduplicate && bodyHash) { if (isDuplicate(url, bodyHash, session.seenHashes)) { isDup = true; session.totalDeduplicated++; } else { recordHash(url, bodyHash, session.seenHashes); } }
    let requestBody: string | null = null, requestHeaders: Record<string, string> | undefined;
    if (filter.captureRequestBodies) try { requestBody = response.request().postData() || null; } catch {}
    if (filter.captureHeaders) { requestHeaders = {}; try { for (const [k, v] of Object.entries(response.request().headers())) requestHeaders[k.toLowerCase()] = v; } catch {} }
    const captured: CapturedResponse = { id: `cr-${randomUUID()}`, captureSessionId: session.id, url, method, statusCode, statusText: response.statusText(), headers: filter.captureHeaders ? headers : {}, contentType, body, bodyJson, bodyTruncated, bodySizeBytes, requestHeaders, requestBody, requestBodyJson: null, resourceType, requestTimestamp: Date.now() - 100, responseTimestamp: Date.now(), durationMs: 100, bodyHash, isDuplicate: isDup };
    session.captures.push(captured); session.totalCaptured++; session.totalBytes += bodySizeBytes;
    if (session.config.persistToRedis) try { await cacheSet(`${CAPTURE_PREFIX}${session.id}:data:${captured.id}`, captured, 1800); } catch {}
  }

  async getCaptures(captureSessionId: string, query: CaptureQueryOptions = {}): Promise<{ responses: CapturedResponse[]; total: number; hasMore: boolean }> {
    const session = this.sessions.get(captureSessionId);
    if (!session) return { responses: [], total: 0, hasMore: false };
    let filtered = [...session.captures];
    if (query.urlPattern) try { const re = new RegExp(query.urlPattern, 'i'); filtered = filtered.filter((c) => re.test(c.url)); } catch {}
    if (query.method) filtered = filtered.filter((c) => c.method.toUpperCase() === query.method!.toUpperCase());
    if (query.statusCode) filtered = filtered.filter((c) => c.statusCode === query.statusCode);
    if (query.jsonOnly) filtered = filtered.filter((c) => c.bodyJson !== null);
    if (query.uniqueOnly) filtered = filtered.filter((c) => !c.isDuplicate);
    const sortBy = query.sortBy || 'timestamp', sortOrder = query.sortOrder || 'desc';
    filtered.sort((a, b) => { let cmp = sortBy === 'size' ? a.bodySizeBytes - b.bodySizeBytes : a.responseTimestamp - b.responseTimestamp; return sortOrder === 'asc' ? cmp : -cmp; });
    const total = filtered.length, offset = query.offset || 0, limit = query.limit || 100;
    return { responses: filtered.slice(offset, offset + limit), total, hasMore: offset + limit < total };
  }

  getSession(captureSessionId: string): CaptureSessionInfo | null { const s = this.sessions.get(captureSessionId); return s ? this.toSessionInfo(s) : null; }
  listSessions(userId: string): CaptureSessionInfo[] { return Array.from(this.sessions.values()).filter((s) => s.userId === userId).map(this.toSessionInfo); }

  async exportCaptures(captureSessionId: string, format: 'json' | 'csv' | 'ndjson'): Promise<string> {
    const session = this.sessions.get(captureSessionId);
    if (!session) return '[]';
    if (format === 'csv') { if (!session.captures.length) return ''; const h = ['id','url','method','statusCode','contentType','bodySizeBytes','durationMs']; return [h.join(','), ...session.captures.map((c) => [c.id,c.url,c.method,c.statusCode,c.contentType,c.bodySizeBytes,c.durationMs].map((v) => `"${String(v).replace(/"/g,'""')}"`).join(','))].join('\n'); }
    if (format === 'ndjson') return session.captures.map((c) => JSON.stringify(c)).join('\n');
    return JSON.stringify(session.captures, null, 2);
  }

  getStats(): CaptureStats {
    let totalCaptures = 0, totalBytes = 0, active = 0;
    for (const s of this.sessions.values()) { totalCaptures += s.totalCaptured; totalBytes += s.totalBytes; if (s.status === 'active') active++; }
    return { totalSessions: this.sessions.size, activeSessions: active, totalCaptures, totalBytes, avgCapturesPerSession: this.sessions.size > 0 ? Math.round(totalCaptures / this.sessions.size) : 0 };
  }

  startCleanup(intervalMs = 300000): void { if (this.cleanupTimer) return; this.cleanupTimer = setInterval(() => this.cleanup(), intervalMs); }
  stopCleanup(): void { if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; } }

  private toSessionInfo(s: CaptureSession): CaptureSessionInfo { return { captureSessionId: s.id, status: s.status, startedAt: new Date(s.startedAt).toISOString(), filters: s.config.filters || DEFAULT_FILTER, totalCaptured: s.totalCaptured, totalFiltered: s.totalFiltered, totalDeduplicated: s.totalDeduplicated, maxCaptures: s.config.maxCaptures || 0, maxDurationMs: s.config.maxDurationMs || 0 }; }
  private cleanup(): void { const now = Date.now(); for (const [id, s] of this.sessions) { if (s.status === 'stopped' && s.stoppedAt && now - s.stoppedAt > 3600000) { if (s.detachListener) try { s.detachListener(); } catch {} this.sessions.delete(id); } } }
}
