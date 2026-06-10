export { CookieInjector } from './manager';
export { autoParseCookies, detectFormat, parseNetscapeCookies, parseJsonCookies, parseHeaderString, normalizeCookie, validateCookieSet } from './parser';
export type { CookieFormat, PlaywrightCookie, CookieSet, CookieSetInfo, InjectOptions, InjectionResult, ValidationResult } from './types';
import { CookieInjector } from './manager';
export const cookieInjector = new CookieInjector();
