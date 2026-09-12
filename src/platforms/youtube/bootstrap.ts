/**
 * YouTube Bootstrap — ScrapeSuite Engine
 *
 * Fetches REAL session bootstrap data from YouTube's public endpoints:
 *   - visitorData (the base64 protobuf blob in ytcfg VISITOR_DATA)
 *   - current InnerTube client version
 *   - InnerTube API key
 *
 * Why this matters: the API signer previously fabricated visitorData from a
 * synthetic protobuf. Live probing (2026-09) showed fabricated visitorData is
 * not itself the blocker, but requests carrying a real visitorData issued to
 * the requesting IP fare strictly better than requests carrying garbage —
 * and a real visitorData can only be obtained from a YouTube endpoint that
 * serves ytcfg to this client (directly, or through a residential proxy).
 *
 * Extraction paths, in order:
 *   1. Homepage HTML → `ytcfg.set({...})` → INNERTUBE_CONTEXT /
 *      VISITOR_DATA / INNERTUBE_CLIENT_VERSION / INNERTUBE_API_KEY
 *   2. https://www.youtube.com/sw.js_data → regex the VISITOR_DATA /
 *      INNERTUBE_CLIENT_VERSION fields out of the JSON payload
 *
 * All requests go through `proxyFetch` so a residential proxy can be used
 * on IPs where Google serves "Sorry" pages (e.g. datacenter ranges).
 */

import { createChildLogger } from '../../utils/logger';
import { cacheGet, cacheSet } from '../../utils/redis';
import { proxyFetch, resolveProxyUrl } from '../../utils/proxy-fetch';

const logger = createChildLogger('youtube-bootstrap');

// ===============================================================================
// TYPES
// ===============================================================================

export interface YouTubeBootstrapResult {
  /** Real visitorData protobuf blob (ytcfg VISITOR_DATA) */
  visitorData: string | null;
  /** Current InnerTube client version reported by YouTube */
  clientVersion: string | null;
  /** InnerTube API key reported by YouTube */
  apiKey: string | null;
  /** Which extraction path succeeded */
  source: 'homepage_ytcfg' | 'sw_js_data' | 'none';
  /** Whether the fetch went through a proxy */
  proxyUsed: boolean;
  /** Epoch ms of the successful bootstrap */
  fetchedAt: number;
  /** Human-readable failure reason when nothing was extracted */
  error?: string;
}

// ===============================================================================
// CONSTANTS
// ===============================================================================

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.70 Safari/537.36';

const CACHE_KEY = 'youtube:bootstrap:ytcfg';
const CACHE_TTL_SECONDS = 30 * 60; // 30 minutes — visitorData lives much longer, but stay fresh

// ===============================================================================
// EXTRACTION HELPERS
// ===============================================================================

/**
 * Extract the first `ytcfg.set({...});` JSON object from HTML using
 * brace matching (the object contains nested braces and strings, so a
 * regex alone is not safe).
 */
function extractYtcfgObject(html: string): Record<string, unknown> | null {
  const marker = 'ytcfg.set(';
  const start = html.indexOf(marker);
  if (start === -1) return null;

  let i = start + marker.length;
  // Skip whitespace to the opening brace
  while (i < html.length && html[i] !== '{') {
    if (html[i] !== ' ' && html[i] !== '\n' && html[i] !== '\t') return null;
    i++;
  }
  if (i >= html.length) return null;

  const objStart = i;
  let depth = 0;
  let inString = false;
  let escaped = false;

  while (i < html.length) {
    const ch = html[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const raw = html.slice(objStart, i + 1);
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
    }
    i++;
  }

  return null;
}

/**
 * Pull bootstrap fields out of a parsed ytcfg object.
 */
function fieldsFromYtcfg(ytcfg: Record<string, unknown>): Partial<YouTubeBootstrapResult> {
  const result: Partial<YouTubeBootstrapResult> = {};

  const visitorData =
    (typeof ytcfg.VISITOR_DATA === 'string' && ytcfg.VISITOR_DATA) ||
    (() => {
      const ctx = ytcfg.INNERTUBE_CONTEXT as Record<string, unknown> | undefined;
      const client = ctx?.client as Record<string, unknown> | undefined;
      return typeof client?.visitorData === 'string' ? client.visitorData : null;
    })();
  if (visitorData) result.visitorData = visitorData;

  if (typeof ytcfg.INNERTUBE_CLIENT_VERSION === 'string') {
    result.clientVersion = ytcfg.INNERTUBE_CLIENT_VERSION;
  }
  if (typeof ytcfg.INNERTUBE_API_KEY === 'string') {
    result.apiKey = ytcfg.INNERTUBE_API_KEY;
  }

  return result;
}

/**
 * Regex the bootstrap fields out of the sw.js_data payload (a JSON array
 * with embedded strings, safe for targeted field regexes).
 */
function fieldsFromSwJsData(payload: string): Partial<YouTubeBootstrapResult> {
  const result: Partial<YouTubeBootstrapResult> = {};

  const visitorMatch = payload.match(/"VISITOR_DATA":"([^"]+)"/);
  if (visitorMatch?.[1]) {
    try {
      result.visitorData = JSON.parse(`"${visitorMatch[1]}"`);
    } catch {
      result.visitorData = visitorMatch[1];
    }
  }

  const versionMatch = payload.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
  if (versionMatch?.[1]) result.clientVersion = versionMatch[1];

  const keyMatch = payload.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  if (keyMatch?.[1]) result.apiKey = keyMatch[1];

  return result;
}

// ===============================================================================
// BOOTSTRAP FETCHER
// ===============================================================================

/**
 * Fetch real YouTube bootstrap data (visitorData, client version, API key).
 *
 * @param options - proxyUrl overrides platform env resolution; skipCache
 *   forces a fresh network fetch.
 */
export async function fetchYouTubeBootstrap(options?: {
  proxyUrl?: string;
  skipCache?: boolean;
  timeoutMs?: number;
}): Promise<YouTubeBootstrapResult> {
  const proxyUrl = resolveProxyUrl(options?.proxyUrl, 'youtube');

  // Cache lookup (only cache successful bootstraps)
  if (!options?.skipCache) {
    try {
      const cached = await cacheGet<YouTubeBootstrapResult>(CACHE_KEY);
      if (cached?.visitorData) {
        logger.debug('YouTube bootstrap served from cache');
        return { ...cached, proxyUsed: !!proxyUrl };
      }
    } catch {
      // Cache unavailable — proceed to network
    }
  }

  const headers: Record<string, string> = {
    'User-Agent': DESKTOP_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const timeoutMs = options?.timeoutMs ?? 20_000;
  const result: YouTubeBootstrapResult = {
    visitorData: null,
    clientVersion: null,
    apiKey: null,
    source: 'none',
    proxyUsed: !!proxyUrl,
    fetchedAt: 0,
  };

  // ---- Path 1: homepage ytcfg -------------------------------------------------
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const home = await proxyFetch('https://www.youtube.com/', proxyUrl, {
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);

    if (home.status === 200) {
      const ytcfg = extractYtcfgObject(home.text);
      if (ytcfg) {
        const fields = fieldsFromYtcfg(ytcfg);
        Object.assign(result, fields);
        if (result.visitorData) result.source = 'homepage_ytcfg';
      }
    } else {
      logger.warn(
        { status: home.status, proxied: !!proxyUrl },
        'Homepage not 200 during bootstrap',
      );
    }
  } catch (err: any) {
    logger.warn({ error: err?.message }, 'Homepage bootstrap fetch failed');
  }

  // ---- Path 2: sw.js_data -----------------------------------------------------
  if (!result.visitorData) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const sw = await proxyFetch('https://www.youtube.com/sw.js_data', proxyUrl, {
        headers: { ...headers, Accept: '*/*' },
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);

      if (sw.status === 200) {
        const fields = fieldsFromSwJsData(sw.text);
        Object.assign(result, fields);
        if (result.visitorData) result.source = 'sw_js_data';
      } else {
        logger.warn(
          { status: sw.status, proxied: !!proxyUrl },
          'sw.js_data not 200 during bootstrap',
        );
      }
    } catch (err: any) {
      logger.warn({ error: err?.message }, 'sw.js_data bootstrap fetch failed');
    }
  }

  if (result.visitorData) {
    result.fetchedAt = Date.now();
    try {
      await cacheSet(CACHE_KEY, result, CACHE_TTL_SECONDS);
    } catch {
      // Non-critical
    }
    logger.info(
      {
        source: result.source,
        clientVersion: result.clientVersion,
        hasApiKey: !!result.apiKey,
        proxied: !!proxyUrl,
        visitorDataPrefix: result.visitorData.slice(0, 12) + '...',
      },
      'YouTube bootstrap succeeded',
    );
    return result;
  }

  result.error = 'Could not extract visitorData from any bootstrap endpoint';
  logger.warn(
    { proxied: !!proxyUrl },
    'YouTube bootstrap failed — visitorData unavailable',
  );
  return result;
}
