/**
 * Cookie Injector Manager -- ScrapeSuite Engine
 *
 * Manages the lifecycle of user-provided cookie sets and injection into
 * browser sessions. Users export cookies from their personal browser,
 * store them here, and inject them into scraper sessions to bypass login.
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet, cacheDelete, redis } from '../utils/redis';
import type { CookieSet, CookieSetInfo, CookieFormat, InjectOptions, InjectionResult, PlaywrightCookie } from './types';
import { autoParseCookies, validateCookieSet } from './parser';

const logger = createChildLogger('cookie-injector');
const COOKIE_SET_PREFIX = 'cookie-set:';
const USER_SETS_PREFIX = 'cookie-set:user:';
const DEFAULT_SET_TTL_HOURS = 168;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export class CookieInjector {
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  async storeCookieSet(userId: string, name: string, cookies: PlaywrightCookie[], options: { domain: string; description?: string; tags?: string[]; sourceFormat: CookieFormat; ttlHours?: number }): Promise<CookieSet> {
    const id = `cs-${randomUUID()}`;
    const now = Date.now();
    const ttlHours = options.ttlHours || DEFAULT_SET_TTL_HOURS;
    const cookieSet: CookieSet = { id, userId, name, description: options.description, domain: options.domain, cookies, sourceFormat: options.sourceFormat, importedAt: now, lastUsedAt: now, useCount: 0, expiresAt: now + ttlHours * 3600 * 1000, tags: options.tags || [], validationStatus: 'pending' };
    const validation = validateCookieSet(cookies, options.domain);
    cookieSet.validationStatus = validation.valid ? 'validated' : 'invalid';
    if (!validation.valid) cookieSet.validationError = validation.errors.join('; ');
    await cacheSet(`${COOKIE_SET_PREFIX}${id}`, cookieSet, ttlHours * 3600);
    try { await redis.sadd(`${USER_SETS_PREFIX}${userId}`, id); await redis.expire(`${USER_SETS_PREFIX}${userId}`, ttlHours * 3600 + 300); } catch {}
    logger.info({ id, userId, name, domain: options.domain, cookieCount: cookies.length }, 'Cookie set stored');
    return cookieSet;
  }

  async getCookieSet(cookieSetId: string): Promise<CookieSet | null> {
    try {
      const set = await cacheGet<CookieSet>(`${COOKIE_SET_PREFIX}${cookieSetId}`);
      if (!set) return null;
      if (set.expiresAt && Date.now() > set.expiresAt) { await this.deleteCookieSet(cookieSetId); return null; }
      return set;
    } catch { return null; }
  }

  async listCookieSets(userId: string): Promise<CookieSetInfo[]> {
    const results: CookieSetInfo[] = [];
    try {
      const ids = await redis.smembers(`${USER_SETS_PREFIX}${userId}`);
      for (const id of ids) {
        const set = await this.getCookieSet(id);
        if (!set) { await redis.srem(`${USER_SETS_PREFIX}${userId}`, id).catch(() => {}); continue; }
        results.push({ id: set.id, name: set.name, domain: set.domain, cookieCount: set.cookies.length, sourceFormat: set.sourceFormat, importedAt: new Date(set.importedAt).toISOString(), lastUsedAt: new Date(set.lastUsedAt).toISOString(), useCount: set.useCount, validationStatus: set.validationStatus, tags: set.tags });
      }
    } catch {}
    return results;
  }

  async deleteCookieSet(cookieSetId: string): Promise<boolean> {
    try {
      const set = await cacheGet<CookieSet>(`${COOKIE_SET_PREFIX}${cookieSetId}`);
      if (set) { await Promise.allSettled([cacheDelete(`${COOKIE_SET_PREFIX}${cookieSetId}`), redis.srem(`${USER_SETS_PREFIX}${set.userId}`, cookieSetId)]); }
      else { await cacheDelete(`${COOKIE_SET_PREFIX}${cookieSetId}`); }
      return true;
    } catch { return false; }
  }

  async prepareInjection(options: InjectOptions): Promise<{ cookies: PlaywrightCookie[]; result: InjectionResult; cookieSetId?: string }> {
    const startTime = Date.now();
    const errors: string[] = [];
    let cookies: PlaywrightCookie[] = [];
    let cookieSetId: string | undefined;
    try {
      if (options.cookieSetId) {
        const set = await this.getCookieSet(options.cookieSetId);
        if (!set) return { cookies: [], result: { success: false, cookiesInjected: 0, cookiesSkipped: 0, durationMs: Date.now() - startTime, errors: [`Cookie set "${options.cookieSetId}" not found`] } };
        cookies = [...set.cookies]; cookieSetId = set.id;
        set.useCount++; set.lastUsedAt = Date.now();
        await cacheSet(`${COOKIE_SET_PREFIX}${set.id}`, set, DEFAULT_SET_TTL_HOURS * 3600);
      } else if (options.rawCookies) {
        const parsed = autoParseCookies(options.rawCookies, options.format, options.domain);
        cookies = parsed.cookies;
      } else if (options.cookies) { cookies = [...options.cookies]; }
      else { return { cookies: [], result: { success: false, cookiesInjected: 0, cookiesSkipped: 0, durationMs: Date.now() - startTime, errors: ['No cookies provided'] } }; }
      if (options.domain) cookies = cookies.map((c) => ({ ...c, domain: options.domain || c.domain }));
      const validation = validateCookieSet(cookies, options.domain);
      const validCookies: PlaywrightCookie[] = [];
      const skipped = new Set([...validation.expiredCookies, ...validation.invalidCookies]);
      for (let i = 0; i < cookies.length; i++) { if (!skipped.has(i)) validCookies.push(cookies[i]); }
      if (validCookies.length === 0) errors.push('No valid cookies to inject');
      return { cookies: validCookies, result: { success: validCookies.length > 0, cookieSetId, cookiesInjected: validCookies.length, cookiesSkipped: cookies.length - validCookies.length, validation: options.validateAfter ? validation : undefined, durationMs: Date.now() - startTime, errors }, cookieSetId };
    } catch (err) {
      return { cookies: [], result: { success: false, cookiesInjected: 0, cookiesSkipped: 0, durationMs: Date.now() - startTime, errors: [`${(err as Error).message}`] } };
    }
  }

  async parseCookieInput(rawInput: string, format?: CookieFormat, defaultDomain?: string) { return autoParseCookies(rawInput, format, defaultDomain); }

  async exportCookies(cookies: PlaywrightCookie[], format: CookieFormat): Promise<string> {
    switch (format) {
      case 'netscape': return cookies.map((c) => [c.domain || '', c.domain?.startsWith('.') ? 'TRUE' : 'FALSE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', c.expires && c.expires > 0 ? String(c.expires) : '0', c.name, c.value].join('\t')).join('\n');
      case 'header-string': return 'Cookie: ' + cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      default: return JSON.stringify(cookies, null, 2);
    }
  }

  async getStats() {
    const byDomain: Record<string, number> = {}; let totalSets = 0, totalCookies = 0;
    try {
      const keys = await redis.keys(`cache:${COOKIE_SET_PREFIX}*`);
      for (const key of keys) { try { const raw = await redis.get(key); if (!raw) continue; const s: CookieSet = JSON.parse(raw); totalSets++; totalCookies += s.cookies.length; byDomain[s.domain || 'unknown'] = (byDomain[s.domain || 'unknown'] || 0) + 1; } catch {} }
    } catch {}
    return { totalSets, totalCookies, byDomain };
  }

  startCleanup(intervalMs: number = CLEANUP_INTERVAL_MS): void { if (this.cleanupTimer) return; this.cleanupTimer = setInterval(() => this.cleanup(), intervalMs); }
  stopCleanup(): void { if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; } }

  private async cleanup(): Promise<void> {
    try {
      const keys = await redis.keys(`cache:${COOKIE_SET_PREFIX}*`);
      for (const key of keys) { try { const raw = await redis.get(key); if (!raw) continue; const s: CookieSet = JSON.parse(raw); if (s.expiresAt && Date.now() > s.expiresAt) await this.deleteCookieSet(s.id); } catch {} }
    } catch {}
  }
}
