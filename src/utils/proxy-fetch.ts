/**
 * Proxy-aware HTTP fetch utility.
 *
 * Node.js `fetch` does not natively support HTTP(S) proxies.
 * This module uses `undici` ProxyAgent for proper proxy routing.
 *
 * This is the critical fix that makes ScrapeSuite's HTTP proxy support actually work.
 */

import { ProxyAgent as UndiciProxyAgent } from 'undici';
import { createChildLogger } from './logger';
import { pickProxy, reportResult, type PoolOutcome } from './proxy-pool';

const logger = createChildLogger('proxy-fetch');

// Cache proxy agents to avoid creating new ones per request
const agentCache = new Map<string, { agent: any; created: number }>();
const AGENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch a URL through an HTTP/HTTPS/SOCKS proxy.
 * Returns the response text, status, and headers.
 *
 * @param url - Target URL to fetch
 * @param proxyUrl - Proxy URL (e.g., http://user:pass@proxy.example.com:8080)
 * @param options - Fetch options (headers, signal, etc.)
 * @returns Response data with text content
 */
export async function proxyFetch(
  url: string,
  proxyUrl: string | undefined,
  options: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    method?: string;
    body?: string;
    redirect?: RequestRedirect;
    timeout?: number;
  } = {},
): Promise<{ text: string; status: number; headers: Record<string, string>; url: string; ok: boolean }> {
  if (!proxyUrl) {
    // No proxy -- use direct fetch
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      signal: options.signal,
      body: options.body,
      redirect: options.redirect || 'follow',
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      text: await response.text(),
      status: response.status,
      headers: responseHeaders,
      url: response.url || url,
      ok: response.ok,
    };
  }

  const agent = getOrCreateAgent(proxyUrl);

  // Use undici's fetch with ProxyAgent for proper proxy support
  const { fetch: undiciFetch } = await import('undici');

  let response;
  try {
    response = await undiciFetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      signal: options.signal,
      body: options.body as any,
      redirect: options.redirect || 'follow',
      dispatcher: agent,
    });
  } catch (err: any) {
    // Proxy burn accounting: network failures through the proxy count against it.
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.code === 'UND_ERR_ABORTED';
    reportResult(proxyUrl, isTimeout ? 'timeout' : 'network_error', err?.message?.slice(0, 120));
    throw err;
  }

  const responseHeaders: Record<string, string> = {};
  try {
    (response.headers as any).forEach?.((value: string, key: string) => {
      responseHeaders[key] = value;
    });
  } catch {
    try {
      Object.entries(response.headers as unknown as Record<string, string>).forEach(([key, value]) => {
        responseHeaders[key] = value;
      });
    } catch {}
  }

  // Proxy burn accounting: classify the status for the health pool. Only
  // pool-managed proxies are affected; one-off explicit proxies are ignored
  // by the pool's id matching.
  const status = response.status;
  if (status >= 200 && status < 400) reportResult(proxyUrl, 'success');
  else if (status === 429) reportResult(proxyUrl, 'rate_limited');
  else if (status === 403 || status === 401) reportResult(proxyUrl, 'bot_wall');
  else if (status >= 500) reportResult(proxyUrl, 'network_error');
  else reportResult(proxyUrl, 'shape_rejected');

  return {
    text: await response.text() as string,
    status: response.status,
    headers: responseHeaders,
    url: (response as any).url || url,
    ok: response.ok,
  };
}

/**
 * Get or create a cached proxy agent.
 */
function getOrCreateAgent(proxyUrl: string): UndiciProxyAgent {
  const cached = agentCache.get(proxyUrl);
  if (cached && Date.now() - cached.created < AGENT_CACHE_TTL) {
    return cached.agent;
  }

  // Clean up old entries
  for (const [key, entry] of agentCache) {
    if (Date.now() - entry.created > AGENT_CACHE_TTL) {
      agentCache.delete(key);
    }
  }

  const agent = new UndiciProxyAgent(proxyUrl);
  agentCache.set(proxyUrl, { agent, created: Date.now() });

  logger.debug({ proxyUrl: maskProxyUrl(proxyUrl) }, 'Created new proxy agent');

  return agent;
}

/**
 * Resolve the proxy URL to use for a request.
 *
 * Priority order:
 *   1. Explicit `proxyUrl` argument (per-request override)
 *   2. Platform-specific env var (SCRAPESUITE_YOUTUBE_PROXY / SCRAPESUITE_TIKTOK_PROXY)
 *   3. Engine-wide SCRAPESUITE_PROXY_URL
 *   4. Standard HTTPS_PROXY / HTTP_PROXY environment variables
 *
 * Returns undefined when no proxy is configured (direct connection).
 */
export function resolveProxyUrl(
  explicit?: string,
  platform?: 'youtube' | 'tiktok',
): string | undefined {
  if (explicit) return explicit;

  // Health-aware pool rotation (when configured and not disabled). The pool
  // never overrides an explicit proxy, but it does outrank static env vars —
  // that's the whole point of rotation.
  if (process.env.SCRAPESUITE_PROXY_POOL_ROTATE !== '0') {
    try {
      const picked = pickProxy();
      if (picked) return picked.url;
    } catch {
      // Pool module unavailable — fall through to static envs.
    }
  }

  const candidates: Array<string | undefined> = [];
  if (platform === 'youtube') candidates.push(process.env.SCRAPESUITE_YOUTUBE_PROXY);
  if (platform === 'tiktok') candidates.push(process.env.SCRAPESUITE_TIKTOK_PROXY);
  candidates.push(process.env.SCRAPESUITE_PROXY_URL);
  candidates.push(process.env.HTTPS_PROXY);
  candidates.push(process.env.https_proxy);
  candidates.push(process.env.HTTP_PROXY);
  candidates.push(process.env.http_proxy);

  const resolved = candidates.find((c) => typeof c === 'string' && c.length > 0);
  return resolved || undefined;
}

/**
 * Mask credentials in a proxy URL for safe logging.
 */
function maskProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

/**
 * Test if a proxy is working by making a request through it.
 */
export async function testProxy(
  proxyUrl: string,
  testUrl: string = 'https://httpbin.org/ip',
  timeoutMs: number = 15_000,
): Promise<{ working: boolean; ip?: string; latencyMs: number; error?: string }> {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await proxyFetch(testUrl, proxyUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });

    clearTimeout(timeout);
    const latencyMs = Date.now() - startTime;

    if (response.ok) {
      let ip: string | undefined;
      try {
        const json = JSON.parse(response.text);
        ip = json.origin || json.ip;
      } catch {}

      return { working: true, ip, latencyMs };
    }

    return { working: false, latencyMs, error: `HTTP ${response.status}` };
  } catch (err: any) {
    clearTimeout(timeout);
    return { working: false, latencyMs: Date.now() - startTime, error: err.message };
  }
}

/**
 * Clear cached proxy agents (useful on shutdown or proxy rotation).
 */
export function clearAgentCache(): void {
  agentCache.clear();
}
