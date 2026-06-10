/**
 * Cookie Injector Types -- ScrapeSuite Engine
 *
 * Type definitions for the Cookie Injection module that enables
 * authenticated scraping by injecting user-provided cookies into
 * browser sessions.
 */

/** Cookie formats users might provide. */
export type CookieFormat = 'netscape' | 'json' | 'header-string' | 'playwright';

/** A single cookie in Playwright's addCookies() format. */
export interface PlaywrightCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** A stored set of cookies with metadata. */
export interface CookieSet {
  id: string;
  userId: string;
  name: string;
  description?: string;
  domain: string;
  cookies: PlaywrightCookie[];
  sourceFormat: CookieFormat;
  importedAt: number;
  lastUsedAt: number;
  useCount: number;
  expiresAt?: number;
  tags: string[];
  validationStatus: 'pending' | 'validated' | 'invalid' | 'expired';
  validationError?: string;
}

/** Options for cookie injection. */
export interface InjectOptions {
  sessionId?: string;
  cookieSetId?: string;
  cookies?: PlaywrightCookie[];
  rawCookies?: string;
  format?: CookieFormat;
  domain?: string;
  validateAfter?: boolean;
  validateUrl?: string;
  validateSelector?: string;
  clearExisting?: boolean;
}

/** Result of validating a cookie set. */
export interface ValidationResult {
  valid: boolean;
  totalCookies: number;
  validCookies: number;
  expiredCookies: number[];
  invalidCookies: number[];
  domainMismatch: number[];
  errors: string[];
  warnings: string[];
  authenticatedDetected?: boolean;
}

/** Result of a cookie injection operation. */
export interface InjectionResult {
  success: boolean;
  cookieSetId?: string;
  cookiesInjected: number;
  cookiesSkipped: number;
  validation?: ValidationResult;
  durationMs: number;
  errors: string[];
}

/** Public info about a cookie set. */
export interface CookieSetInfo {
  id: string;
  name: string;
  domain: string;
  cookieCount: number;
  sourceFormat: CookieFormat;
  importedAt: string;
  lastUsedAt: string;
  useCount: number;
  validationStatus: string;
  tags: string[];
}
