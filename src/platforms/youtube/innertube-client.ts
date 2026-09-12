/**
 * InnerTube Client — ScrapeSuite Engine
 *
 * Executes InnerTube API requests end-to-end:
 *   signing (canonical context) → proxy resolution → proxyFetch →
 *   response classification → bounded retries.
 *
 * The engine previously stopped at signing: callers had to execute requests
 * themselves with no proxy story, which on a datacenter IP means InnerTube's
 * abuse layer answers with "Sorry" pages or 400s. This module closes the loop:
 *
 *   - Proxy resolution order: explicit option → SCRAPESUITE_YOUTUBE_PROXY →
 *     SCRAPESUITE_PROXY_URL → standard HTTPS_PROXY/HTTP_PROXY env vars
 *   - Real visitorData: pass `bootstrapData` (from fetchYouTubeBootstrap) or
 *     set `autoBootstrap: true` to fetch it first
 *   - Response classification distinguishes JSON API answers (including
 *     InnerTube error reasons like "Precondition check failed") from HTML
 *     block pages, so callers can act on the actual failure mode
 *   - Retries 429/network errors with linear backoff; never retries 403
 *     "Sorry" pages (a different IP, not another attempt, is the fix)
 */

import { createChildLogger } from '../../utils/logger';
import { youtubeApiSigner } from './api-signer';
import { fetchYouTubeBootstrap, type YouTubeBootstrapResult } from './bootstrap';
import { proxyFetch, resolveProxyUrl } from '../../utils/proxy-fetch';

const logger = createChildLogger('youtube-innertube-client');

// ===============================================================================
// TYPES
// ===============================================================================

export type InnertubeResponseKind =
  | 'json'
  | 'innertube_error'
  | 'sorry_page'
  | 'rate_limited'
  | 'other_html'
  | 'network_error';

export interface InnertubeRequestOptions {
  /** InnerTube endpoint, e.g. 'browse', 'search', 'player', 'next' */
  endpoint: string;
  /** Endpoint-specific params (the context is added automatically) */
  body?: Record<string, unknown>;
  /** InnerTube client name (default WEB) */
  clientName?: string;
  /** InnerTube client version (default engine config) */
  clientVersion?: string;
  /** Real visitorData (preferred). Fabricated one is not used. */
  visitorData?: string;
  /** Auto-fetch real visitorData via bootstrap when none supplied */
  autoBootstrap?: boolean;
  /** Bootstrap result computed by a prior fetchYouTubeBootstrap call */
  bootstrapData?: YouTubeBootstrapResult;
  /** SAPISID cookie for authenticated SAPISIDHASH authorization */
  sapisid?: string;
  /** Explicit proxy URL — overrides env-based resolution */
  proxyUrl?: string;
  /** Extra cookies merged into the Cookie header */
  cookies?: Record<string, string>;
  /** Total attempts (default 2: initial + 1 retry on 429/network) */
  maxAttempts?: number;
  /** Per-attempt timeout in ms (default 15000) */
  timeoutMs?: number;
  /**
   * Post-signing context overrides, merged into body.context (one level
   * deep for object values). Use for page-bound endpoints whose tokens
   * must match the originating page, e.g. get_transcript:
   *   { client: { originalUrl: 'https://www.youtube.com/watch?v=ID' } }
   */
  contextPatch?: Record<string, unknown>;
}

export interface InnertubeResponse {
  ok: boolean;
  status: number;
  /** Classified failure/success mode */
  kind: InnertubeResponseKind;
  /** InnerTube error reason (e.g. "Precondition check failed") when present */
  error?: string;
  /** Parsed JSON body when the response was JSON */
  json?: Record<string, unknown>;
  /** Raw body snippet (HTML pages) or full body when JSON parsing is skipped */
  textSnippet?: string;
  headers: Record<string, string>;
  latencyMs: number;
  attempts: number;
  /** Masked proxy URL actually used, if any */
  proxyUsed?: string;
  /** Whether the request carried real bootstrapped visitorData */
  usedBootstrappedVisitorData: boolean;
}

// ===============================================================================
// CONSTANTS
// ===============================================================================

const RETRY_BASE_DELAY_MS = 1_500;

// ===============================================================================
// CLASSIFICATION
// ===============================================================================

function classifyResponse(
  status: number,
  contentType: string,
  text: string,
): { kind: InnertubeResponseKind; error?: string; json?: Record<string, unknown> } {
  const isJson = contentType.includes('application/json') || text.trimStart().startsWith('{');

  if (isJson) {
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const errObj = json.error as Record<string, unknown> | undefined;
      if (errObj) {
        const reason =
          (typeof errObj.message === 'string' && errObj.message) ||
          (typeof errObj.status === 'string' && errObj.status) ||
          'unknown innertube error';
        return { kind: 'innertube_error', error: reason, json };
      }
      return { kind: 'json', json };
    } catch {
      // JSON content-type but unparseable — fall through to HTML checks
    }
  }

  const looksLikeSorry =
    text.includes('Our systems have detected unusual traffic') ||
    text.includes('/sorry/') ||
    text.includes('g-recaptcha');
  if (looksLikeSorry) return { kind: 'sorry_page' };

  if (status === 429) return { kind: 'rate_limited' };

  return { kind: 'other_html' };
}

function maskProxy(proxyUrl: string | undefined): string | undefined {
  if (!proxyUrl) return undefined;
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

// ===============================================================================
// INNERTUBE CLIENT
// ===============================================================================

export class InnertubeClient {
  private lastBootstrap: YouTubeBootstrapResult | null = null;

  /**
   * Execute a signed InnerTube request end-to-end.
   */
  async execute(options: InnertubeRequestOptions): Promise<InnertubeResponse> {
    const startTime = Date.now();
    const proxyUrl = resolveProxyUrl(options.proxyUrl, 'youtube');
    const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    const timeoutMs = options.timeoutMs ?? 15_000;

    // ---- Visitor data resolution ------------------------------------------------
    let visitorData = options.visitorData;
    let usedBootstrappedVisitorData = false;

    if (!visitorData && options.autoBootstrap) {
      const bootstrap =
        options.bootstrapData ||
        this.lastBootstrap ||
        (await fetchYouTubeBootstrap({ proxyUrl }));
      this.lastBootstrap = bootstrap;
      if (bootstrap.visitorData) {
        visitorData = bootstrap.visitorData;
        usedBootstrappedVisitorData = true;
      }
    } else if (options.bootstrapData?.visitorData && !options.visitorData) {
      visitorData = options.bootstrapData.visitorData;
      usedBootstrappedVisitorData = true;
    }

    // ---- Attempt loop -----------------------------------------------------------
    let lastResponse: InnertubeResponse | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptStart = Date.now();

      // Sign per-attempt (fresh SAPISIDHASH timestamp and session IDs)
      const signed = await youtubeApiSigner.signInnertubeRequest({
        endpoint: options.endpoint,
        method: 'POST',
        clientName: options.clientName,
        clientVersion:
          options.clientVersion || this.lastBootstrap?.clientVersion || undefined,
        visitorData,
        sapisid: options.sapisid,
      });

      // Canonical body: endpoint params + canonical context.
      // NOTE: for `player` requests, cpn (playback nonce) belongs at the TOP
      // LEVEL of the body — never inside context.client (see api-signer docs).
      const body: Record<string, unknown> = { ...options.body };
      if (options.endpoint === 'player' && signed.sessionIds.cpn) {
        body.cpn = signed.sessionIds.cpn;
      }
      body.context = signed.context;

      // Page-bound tokens (get_transcript etc.) can require the context to
      // reference the page the token was issued on — apply caller overrides
      if (options.contextPatch) {
        for (const [key, value] of Object.entries(options.contextPatch)) {
          const existing = (body.context as Record<string, unknown>)[key];
          const bothPlain =
            typeof value === 'object' && value !== null && !Array.isArray(value) &&
            typeof existing === 'object' && existing !== null && !Array.isArray(existing);
          (body.context as Record<string, unknown>)[key] = bothPlain
            ? { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) }
            : value;
        }
      }

      const cookieHeader = Object.entries({ ...signed.cookies, ...options.cookies })
        .filter(([, v]) => !!v)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');

      const headers: Record<string, string> = { ...signed.headers };
      if (cookieHeader) headers['Cookie'] = cookieHeader;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const raw = await proxyFetch(signed.signedUrl, proxyUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: 'follow',
        });
        clearTimeout(timer);

        const contentType = raw.headers['content-type'] || '';
        const { kind, error, json } = classifyResponse(raw.status, contentType, raw.text);

        const response: InnertubeResponse = {
          ok: kind === 'json',
          status: raw.status,
          kind,
          error,
          json,
          textSnippet: raw.text.slice(0, 400),
          headers: raw.headers,
          latencyMs: Date.now() - attemptStart,
          attempts: attempt,
          proxyUsed: maskProxy(proxyUrl),
          usedBootstrappedVisitorData,
        };

        // No retry for terminal failure modes
        if (kind === 'json' || kind === 'innertube_error' || kind === 'sorry_page') {
          this.logOutcome(options, response, Date.now() - startTime);
          return response;
        }

        lastResponse = response;

        if (attempt < maxAttempts) {
          const delay = RETRY_BASE_DELAY_MS * attempt;
          logger.warn(
            { attempt, kind, status: raw.status, delayMs: delay },
            'InnerTube attempt failed — retrying',
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      } catch (err: any) {
        lastResponse = {
          ok: false,
          status: 0,
          kind: 'network_error',
          error: err?.message || String(err),
          headers: {},
          latencyMs: Date.now() - attemptStart,
          attempts: attempt,
          proxyUsed: maskProxy(proxyUrl),
          usedBootstrappedVisitorData,
        };

        if (attempt >= maxAttempts) break;
        await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * attempt));
      }
    }

    this.logOutcome(options, lastResponse!, Date.now() - startTime);
    return lastResponse!;
  }

  /**
   * Reuse a bootstrap result across calls without re-fetching.
   */
  setBootstrap(bootstrap: YouTubeBootstrapResult): void {
    this.lastBootstrap = bootstrap;
  }

  // ---------------------------------------------------------------------------
  // PRIVATE
  // ---------------------------------------------------------------------------

  private logOutcome(
    options: InnertubeRequestOptions,
    response: InnertubeResponse,
    totalMs: number,
  ): void {
    const logPayload = {
      endpoint: options.endpoint,
      status: response.status,
      kind: response.kind,
      error: response.error,
      attempts: response.attempts,
      latencyMs: response.latencyMs,
      totalMs,
      proxied: !!response.proxyUsed,
      bootstrappedVisitor: response.usedBootstrappedVisitorData,
    };

    if (response.ok) {
      logger.info(logPayload, 'InnerTube request succeeded');
    } else {
      logger.warn(logPayload, 'InnerTube request failed');
    }
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const innertubeClient = new InnertubeClient();
