/**
 * Cookie Parser -- ScrapeSuite Engine
 *
 * Robust multi-format cookie parser that handles Netscape/Mozilla cookie files,
 * JSON exports (EditThisCookie, browser extensions), Cookie/Set-Cookie header
 * strings, and Playwright's native format.
 */

import { createChildLogger } from '../utils/logger';
import type { CookieFormat, PlaywrightCookie, ValidationResult } from './types';

const logger = createChildLogger('cookie-parser');

// ===============================================================================
// FORMAT DETECTION
// ===============================================================================

/** Auto-detect the format of a cookie input string. */
export function detectFormat(input: string): CookieFormat {
  const trimmed = input.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try { JSON.parse(trimmed); return 'json'; } catch { /* fall through */ }
  }
  const lines = trimmed.split('\n').filter((l) => l.trim().length > 0);
  const nonCommentLines = lines.filter((l) => !l.trim().startsWith('#'));
  if (nonCommentLines.length > 0) {
    const tabCount = (nonCommentLines[0].match(/\t/g) || []).length;
    if (tabCount >= 6) return 'netscape';
  }
  if (trimmed.toLowerCase().startsWith('cookie:') || trimmed.includes('=')) return 'header-string';
  return 'header-string';
}

// ===============================================================================
// NETSCAPE PARSER
// ===============================================================================

/** Parse Netscape/Mozilla cookie file format (tab-separated, 7 fields). */
export function parseNetscapeCookies(text: string, defaultDomain?: string): PlaywrightCookie[] {
  const cookies: PlaywrightCookie[] = [];
  const lines = text.split('\n').filter((l) => l.trim().length > 0 && !l.trim().startsWith('#'));
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].trim().split('\t');
    if (fields.length < 7) continue;
    const [domain, , path, secure, expires, name, value] = fields;
    const isHttpOnly = domain.startsWith('#HttpOnly_');
    const cookie: PlaywrightCookie = {
      name: name || '',
      value: value || '',
      domain: isHttpOnly ? domain.replace('#HttpOnly_', '') : domain || defaultDomain || '',
      path: path || '/',
      expires: parseInt(expires, 10) > 0 ? parseInt(expires, 10) : -1,
      httpOnly: isHttpOnly,
      secure: secure === 'TRUE' || secure === 'true',
      sameSite: 'Lax',
    };
    if (cookie.name) cookies.push(cookie);
  }
  return cookies;
}

// ===============================================================================
// JSON PARSER
// ===============================================================================

/** Parse JSON format cookies (arrays, objects, key-value maps). */
export function parseJsonCookies(json: string | object, defaultDomain?: string): PlaywrightCookie[] {
  const cookies: PlaywrightCookie[] = [];
  let parsed: any;
  try { parsed = typeof json === 'string' ? JSON.parse(json) : json; } catch { return cookies; }
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const c = normalizeCookie(item, defaultDomain);
      if (c.name) cookies.push(c);
    }
  } else if (typeof parsed === 'object' && parsed !== null) {
    if (parsed.name !== undefined && parsed.value !== undefined) {
      const c = normalizeCookie(parsed, defaultDomain);
      if (c.name) cookies.push(c);
    } else {
      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value === 'string') {
          cookies.push({ name, value, domain: defaultDomain || '', path: '/', sameSite: 'Lax' });
        } else if (typeof value === 'object' && value !== null) {
          const c = normalizeCookie({ name, ...value as object }, defaultDomain);
          if (c.name) cookies.push(c);
        }
      }
    }
  }
  return cookies;
}

// ===============================================================================
// HEADER STRING PARSER
// ===============================================================================

/** Parse "Cookie: name=value; name2=value2" or Set-Cookie headers. */
export function parseHeaderString(headerStr: string, defaultDomain?: string): PlaywrightCookie[] {
  const cookies: PlaywrightCookie[] = [];
  const cleaned = headerStr.trim().replace(/^Cookie:\s*/i, '');
  const pairs = cleaned.split(';');
  for (const pair of pairs) {
    const trimmedPair = pair.trim();
    if (!trimmedPair) continue;
    const eqIndex = trimmedPair.indexOf('=');
    if (eqIndex === -1) continue;
    const name = trimmedPair.substring(0, eqIndex).trim();
    let value = trimmedPair.substring(eqIndex + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (name) cookies.push({ name, value, domain: defaultDomain || '', path: '/', sameSite: 'Lax' });
  }
  return cookies;
}

// ===============================================================================
// NORMALIZE & VALIDATE
// ===============================================================================

const FIELD_ALIASES: Record<string, keyof PlaywrightCookie> = {
  name: 'name', key: 'name', cookieName: 'name',
  value: 'value', cookieValue: 'value',
  domain: 'domain', host: 'domain', hostName: 'domain',
  path: 'path', urlPath: 'path',
  expires: 'expires', expiry: 'expires', expirationDate: 'expires', expiryDate: 'expires', expirationtime: 'expires',
  httponly: 'httpOnly', ishttponly: 'httpOnly', is_http_only: 'httpOnly',
  secure: 'secure', issecure: 'secure', is_secure: 'secure',
  samesite: 'sameSite', same_site: 'sameSite',
};

/** Normalize any cookie object to Playwright's format. */
export function normalizeCookie(cookie: any, defaultDomain?: string): PlaywrightCookie {
  const normalized: PlaywrightCookie = {
    name: '', value: '', domain: defaultDomain || '', path: '/',
    expires: -1, httpOnly: false, secure: false, sameSite: 'Lax',
  };
  for (const [key, value] of Object.entries(cookie)) {
    const mappedKey = FIELD_ALIASES[key.toLowerCase()];
    if (mappedKey) (normalized as any)[mappedKey] = value;
  }
  if (normalized.expires === undefined || normalized.expires === null || normalized.expires === 0) normalized.expires = -1;
  if (normalized.domain && normalized.domain.startsWith('.')) normalized.domain = normalized.domain.substring(1);
  if (!normalized.path) normalized.path = '/';
  if (!['Strict', 'Lax', 'None'].includes(normalized.sameSite as string)) normalized.sameSite = 'Lax';
  return normalized;
}

/** Validate a set of cookies and return a detailed report. */
export function validateCookieSet(cookies: PlaywrightCookie[], targetDomain?: string): ValidationResult {
  const result: ValidationResult = { valid: true, totalCookies: cookies.length, validCookies: 0, expiredCookies: [], invalidCookies: [], domainMismatch: [], errors: [], warnings: [] };
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < cookies.length; i++) {
    const c = cookies[i];
    let ok = true;
    if (!c.name) { result.invalidCookies.push(i); result.errors.push(`Cookie index ${i}: missing name`); ok = false; }
    if (c.value === undefined || c.value === null) { result.invalidCookies.push(i); result.errors.push(`Cookie index ${i} (${c.name}): missing value`); ok = false; }
    if (c.expires && c.expires > 0 && c.expires < now) { result.expiredCookies.push(i); result.warnings.push(`Cookie "${c.name}" expired`); ok = false; }
    if (targetDomain && c.domain) {
      const cd = c.domain.replace(/^\./, '').toLowerCase();
      const td = targetDomain.replace(/^\./, '').toLowerCase();
      if (!cd.endsWith(td) && !td.endsWith(cd)) { result.domainMismatch.push(i); result.warnings.push(`Cookie "${c.name}" domain mismatch`); }
    }
    if (ok) result.validCookies++;
  }
  result.valid = result.validCookies > 0 && result.errors.length === 0;
  return result;
}

/** Auto-detect format and parse cookies from raw input. */
export function autoParseCookies(rawInput: string, formatHint?: CookieFormat, defaultDomain?: string): { cookies: PlaywrightCookie[]; detectedFormat: CookieFormat; validation: ValidationResult } {
  const detectedFormat = formatHint || detectFormat(rawInput);
  let cookies: PlaywrightCookie[];
  switch (detectedFormat) {
    case 'netscape': cookies = parseNetscapeCookies(rawInput, defaultDomain); break;
    case 'json': cookies = parseJsonCookies(rawInput, defaultDomain); break;
    case 'playwright': cookies = parseJsonCookies(rawInput, defaultDomain); break;
    default: cookies = parseHeaderString(rawInput, defaultDomain); break;
  }
  const validation = validateCookieSet(cookies, defaultDomain);
  return { cookies, detectedFormat, validation };
}
