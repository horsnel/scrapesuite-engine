/**
 * Scroll Handler Manager -- ScrapeSuite Engine
 *
 * Handles infinite scroll pages by automatically scrolling, waiting for new
 * content to load, detecting when loading is complete, and extracting data.
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import type { Page } from 'playwright';
import type { ScrollConfig, ExtractionConfig, ExtractionField, ScrollSession, ScrollResult, ScrollSessionInfo, ScrollHandlerStats } from './types';
import { generateScrollAmount, generateWaitTime, shouldScrollUp, generateUpScrollAmount } from './behavior';

const logger = createChildLogger('scroll-handler');
const DEFAULTS: Required<Pick<ScrollConfig, 'strategy' | 'maxScrolls' | 'maxDurationMs' | 'stabilizationWaitMs' | 'stabilizationThreshold' | 'terminationCondition' | 'behaviorProfile' | 'scrollJitterPercent'>> = { strategy: 'human-like', maxScrolls: 100, maxDurationMs: 300000, stabilizationWaitMs: 2000, stabilizationThreshold: 3, terminationCondition: 'no-new-content', behaviorProfile: 'normal', scrollJitterPercent: 20 };

export class ScrollHandlerManager {
  private sessions = new Map<string, ScrollSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  async executeScroll(page: Page, scrollConfig: ScrollConfig = {}, extractionConfig?: ExtractionConfig, userId?: string): Promise<ScrollResult> {
    const session = this.createSession(scrollConfig, extractionConfig, userId);
    session.status = 'scrolling';
    try { await this.runScrollLoop(session, page); } catch (err) { session.status = 'error'; session.error = (err as Error).message; session.terminationReason = 'error'; }
    session.completedAt = Date.now(); session.status = session.status === 'error' ? 'error' : 'completed';
    try { await cacheSet(`scroll-result:${session.id}`, this.toResult(session), 3600); } catch {}
    return this.toResult(session);
  }

  async startScrollSession(page: Page, scrollConfig: ScrollConfig = {}, extractionConfig?: ExtractionConfig, userId?: string): Promise<ScrollSessionInfo> {
    const session = this.createSession(scrollConfig, extractionConfig, userId);
    session.abortController = new AbortController();
    this.runScrollLoop(session, page).catch((err) => { session.status = 'error'; session.error = (err as Error).message; session.terminationReason = 'error'; session.completedAt = Date.now(); });
    return this.toSessionInfo(session);
  }

  async stopSession(sessionId: string): Promise<ScrollResult | null> {
    const s = this.sessions.get(sessionId); if (!s) return null;
    if (s.abortController) s.abortController.abort();
    s.status = 'completed'; s.terminationReason = 'manual-stop'; s.completedAt = Date.now();
    return this.toResult(s);
  }

  getSessionInfo(sessionId: string): ScrollSessionInfo | null { const s = this.sessions.get(sessionId); return s ? this.toSessionInfo(s) : null; }

  async getResult(sessionId: string): Promise<ScrollResult | null> {
    const s = this.sessions.get(sessionId);
    if (s) return this.toResult(s);
    try { return await cacheGet<ScrollResult>(`scroll-result:${sessionId}`); } catch { return null; }
  }

  getStats(): ScrollHandlerStats {
    let ts = 0, ti = 0, active = 0;
    for (const s of this.sessions.values()) { ts += s.scrollCount; ti += s.totalExtracted; if (s.status === 'scrolling') active++; }
    return { totalSessions: this.sessions.size, activeSessions: active, totalScrolls: ts, totalItemsExtracted: ti, avgScrollsPerSession: this.sessions.size ? Math.round(ts / this.sessions.size) : 0, avgItemsPerSession: this.sessions.size ? Math.round(ti / this.sessions.size) : 0 };
  }

  startCleanup(intervalMs = 300000): void { if (this.cleanupTimer) return; this.cleanupTimer = setInterval(() => this.cleanup(), intervalMs); }
  stopCleanup(): void { if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; } }

  private async runScrollLoop(session: ScrollSession, page: Page): Promise<void> {
    const config = { ...DEFAULTS, ...session.config };
    const containerSel = config.scrollContainerSelector;
    session.domHeightStart = await this.getDomHeight(page, containerSel); session.lastKnownHeight = session.domHeightStart; session.domHeightHistory.push(session.domHeightStart);
    const startTime = Date.now();
    while (true) {
      if (session.abortController?.signal.aborted) { session.terminationReason = 'manual-stop'; break; }
      if (config.maxScrolls > 0 && session.scrollCount >= config.maxScrolls) { session.terminationReason = 'max-scrolls'; break; }
      if (config.maxDurationMs > 0 && Date.now() - startTime > config.maxDurationMs) { session.terminationReason = 'max-duration'; break; }
      if (config.terminationCondition === 'selector-appears' && config.targetSelector) { try { if (await page.$(config.targetSelector)) { session.terminationReason = 'selector-appears'; break; } } catch {} }
      const scrollAmount = generateScrollAmount(session.config);
      if (shouldScrollUp(session.config) && session.scrollCount > 2) { try { await page.mouse.wheel(0, -generateUpScrollAmount(session.config)); await this.wait(300 + Math.random() * 500); } catch {} }
      try {
        if (containerSel) await page.evaluate(({ sel, amount }: { sel: string; amount: number }) => { const el = document.querySelector(sel); if (el) el.scrollTop += amount; }, { sel: containerSel, amount: scrollAmount });
        else await page.mouse.wheel(0, scrollAmount);
      } catch { session.terminationReason = 'scroll-error'; break; }
      session.scrollCount++; session.totalScrollDistance += scrollAmount;
      await this.wait(generateWaitTime(session.config));
      try { await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {}); } catch {}
      await this.wait(config.stabilizationWaitMs);
      const currentHeight = await this.getDomHeight(page, containerSel); session.domHeightHistory.push(currentHeight);
      if (session.extractionConfig) { try { const r = await this.extractFromPage(page, session.extractionConfig, session.seenItemKeys); session.extractedItems.push(...r.items); session.totalExtracted += r.items.length; session.duplicateCount += r.duplicates; } catch {} }
      if (currentHeight === session.lastKnownHeight) { session.stabilizationCount++; if (config.terminationCondition === 'no-new-content' && session.stabilizationCount >= config.stabilizationThreshold) { session.terminationReason = 'no-new-content'; break; } } else session.stabilizationCount = 0;
      session.lastKnownHeight = currentHeight;
    }
    session.domHeightEnd = await this.getDomHeight(page, containerSel).catch(() => session.lastKnownHeight);
  }

  private async extractFromPage(page: Page, config: ExtractionConfig, seenKeys: Set<string>): Promise<{ items: unknown[]; duplicates: number }> {
    const items: unknown[] = []; let duplicates = 0;
    const elements = config.strategy === 'xpath' ? await page.$$('xpath=' + (config.xpath || '')) : await page.$$(config.selector || 'body');
    for (const el of elements) {
      const item: Record<string, unknown> = {};
      for (const field of (config.fields || [])) {
        try { const sub = field.selector ? await el.$(field.selector) : el; item[field.name] = sub ? this.applyTransform(await this.extractField(sub, field), field.transform, field.regexPattern) : field.defaultValue ?? null; }
        catch { item[field.name] = field.defaultValue ?? null; }
      }
      if (config.deduplicate && config.deduplicateKey) { const key = String(item[config.deduplicateKey] || ''); if (key && seenKeys.has(key)) { duplicates++; continue; } if (key) seenKeys.add(key); }
      if (config.maxItems && config.maxItems > 0 && items.length >= config.maxItems) break;
      items.push(item);
    }
    return { items, duplicates };
  }

  private async extractField(el: import('playwright').ElementHandle, field: ExtractionField): Promise<unknown> {
    switch (field.extractType) {
      case 'html': return await el.innerHTML();
      case 'attribute': return field.attribute ? await el.getAttribute(field.attribute) : null;
      case 'href': return await el.getAttribute('href');
      case 'src': return await el.getAttribute('src');
      default: return await el.textContent();
    }
  }

  private applyTransform(value: unknown, transform?: string, regexPattern?: string): unknown {
    if (value === null || value === undefined) return value;
    const s = String(value);
    switch (transform) { case 'trim': return s.trim(); case 'number': return s.replace(/[^0-9.-]/g, ''); case 'url': return s.startsWith('http') ? s : `https://example.com${s}`; case 'lowercase': return s.toLowerCase(); case 'uppercase': return s.toUpperCase(); case 'regex': { if (!regexPattern) return s; try { const m = s.match(new RegExp(regexPattern)); return m ? m[1] || m[0] : s; } catch { return s; } } default: return s; }
  }

  private async getDomHeight(page: Page, containerSelector?: string): Promise<number> {
    try { return await page.evaluate((sel) => { if (sel) { const el = document.querySelector(sel); return el ? el.scrollHeight : document.body.scrollHeight; } return Math.max(document.body.scrollHeight, document.documentElement.scrollHeight); }, containerSelector || null); } catch { return 0; }
  }

  private wait(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

  private createSession(scrollConfig: ScrollConfig, extractionConfig?: ExtractionConfig, userId?: string): ScrollSession {
    const id = `scrl-${randomUUID()}`;
    const session: ScrollSession = { id, userId: userId || 'anonymous', status: 'starting', config: { ...DEFAULTS, ...scrollConfig }, extractionConfig, startedAt: Date.now(), completedAt: null, scrollCount: 0, totalScrollDistance: 0, domHeightStart: 0, domHeightEnd: 0, domHeightHistory: [], extractedItems: [], totalExtracted: 0, duplicateCount: 0, terminationReason: '', lastKnownHeight: 0, stabilizationCount: 0, seenItemKeys: new Set() };
    this.sessions.set(id, session); return session;
  }

  private toResult(s: ScrollSession): ScrollResult {
    const start = s.domHeightStart, end = s.domHeightEnd, change = end - start;
    return { sessionId: s.id, status: s.status, scrollCount: s.scrollCount, totalScrollDistance: s.totalScrollDistance, totalExtracted: s.totalExtracted, duplicateCount: s.duplicateCount, durationMs: s.completedAt ? s.completedAt - s.startedAt : Date.now() - s.startedAt, domHeightChange: { start, end, change, changePercent: start > 0 ? Math.round(change / start * 10000) / 100 : 0 }, extractedItems: s.extractedItems, terminationReason: s.terminationReason, domHeightHistory: s.domHeightHistory.map((h, i) => ({ scrollNumber: i, height: h })) };
  }

  private toSessionInfo(s: ScrollSession): ScrollSessionInfo { return { id: s.id, status: s.status, scrollCount: s.scrollCount, totalExtracted: s.totalExtracted, startedAt: new Date(s.startedAt).toISOString(), completedAt: s.completedAt ? new Date(s.completedAt).toISOString() : null, terminationReason: s.terminationReason }; }
  private cleanup(): void { const now = Date.now(); for (const [id, s] of this.sessions) { if (s.completedAt && now - s.completedAt > 3600000) this.sessions.delete(id); } }
}
