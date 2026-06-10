import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { proxyManager } from '../proxy/manager';
import { stealthEngine } from '../anti-bot/stealth';
import { browserPool, type BrowserLease } from '../browser-pool';
import { proxyFetch } from '../utils/proxy-fetch';
import { createChildLogger } from '../utils/logger';
import { randomUUID } from 'crypto';

const logger = createChildLogger('serp');

// --- Types --------------------------------------------------------------------

export interface SerpRequest {
  query: string;
  engine?: 'google' | 'bing' | 'yahoo' | 'duckduckgo' | 'yandex' | 'baidu';
  country?: string;
  language?: string;
  page?: number;
  numResults?: number;
  proxyTier?: 'residential' | 'datacenter' | 'mobile' | 'isp';
  proxyCountry?: string;
  parse?: boolean;
}

export interface SerpOrganicResult {
  position: number;
  title: string;
  url: string;
  displayedUrl: string;
  snippet: string;
  date?: string;
  sitelinks?: { title: string; url: string }[];
  richSnippet?: Record<string, any>;
}

export interface SerpAdResult {
  position: number;
  title: string;
  url: string;
  displayedUrl: string;
  snippet: string;
  adBadge: boolean;
}

export interface SerpKnowledgePanel {
  title: string;
  type: string;
  description?: string;
  imageUrl?: string;
  facts?: { label: string; value: string }[];
}

export interface SerpPeopleAlsoAsk {
  question: string;
  snippet?: string;
  url?: string;
}

export interface SerpResponse {
  query: string;
  engine: string;
  country: string;
  language: string;
  page: number;
  organicResults: SerpOrganicResult[];
  adResults: SerpAdResult[];
  knowledgePanel?: SerpKnowledgePanel;
  peopleAlsoAsk: SerpPeopleAlsoAsk[];
  relatedSearches: string[];
  totalResults?: number;
  searchTimeMs: number;
  creditsUsed: number;
  cached: boolean;
}

// --- Engine URL Builders ------------------------------------------------------

function buildGoogleUrl(req: SerpRequest): string {
  const params = new URLSearchParams({
    q: req.query,
    num: String(req.numResults || 10),
    start: String(((req.page || 1) - 1) * (req.numResults || 10)),
    hl: req.language || 'en',
    gl: req.country || 'us',
  });
  return `https://www.google.com/search?${params}`;
}

function buildBingUrl(req: SerpRequest): string {
  const params = new URLSearchParams({
    q: req.query,
    count: String(req.numResults || 10),
    first: String(((req.page || 1) - 1) * (req.numResults || 10) + 1),
    setlang: req.language || 'en',
    cc: (req.country || 'us').toUpperCase(),
  });
  return `https://www.bing.com/search?${params}`;
}

function buildYahooUrl(req: SerpRequest): string {
  const params = new URLSearchParams({
    p: req.query,
    n: String(req.numResults || 10),
    b: String(((req.page || 1) - 1) * (req.numResults || 10) + 1),
  });
  return `https://search.yahoo.com/search?${params}`;
}

function buildDuckDuckGoUrl(req: SerpRequest): string {
  const params = new URLSearchParams({
    q: req.query,
    kl: req.country ? `${req.country}-${req.country}` : 'us-en',
  });
  return `https://html.duckduckgo.com/html/?${params}`;
}

// --- SERP HTML Parsers -------------------------------------------------------

function parseGoogleSerp(html: string): Pick<SerpResponse, 'organicResults' | 'adResults' | 'knowledgePanel' | 'peopleAlsoAsk' | 'relatedSearches' | 'totalResults'> {
  const organicResults: SerpOrganicResult[] = [];
  const adResults: SerpAdResult[] = [];
  const peopleAlsoAsk: SerpPeopleAlsoAsk[] = [];
  const relatedSearches: string[] = [];
  let totalResults: number | undefined;
  let knowledgePanel: SerpKnowledgePanel | undefined;

  try {
    const seenUrls = new Set<string>();

    // Extract all hrefs that look like search results
    const hrefMatches = [...html.matchAll(/<a[^>]*href="(?:\/url\?q=)?(https?:\/\/[^"&\s]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)];

    let position = 1;
    for (const m of hrefMatches) {
      const url = m[1];
      if (!url || seenUrls.has(url)) continue;
      if (url.includes('google.com') || url.includes('gstatic.com') || url.includes('googleapis.com')) continue;

      seenUrls.add(url);
      const title = m[2].replace(/<[^>]*>/g, '').trim();
      if (!title || title.length < 3) continue;

      organicResults.push({
        position: position++,
        title,
        url,
        displayedUrl: new URL(url).hostname,
        snippet: '',
      });

      if (organicResults.length >= 20) break;
    }

    // Extract People Also Ask
    const paaMatches = [...html.matchAll(/class="[^"]*(?:related-question-pair|jftXiW|JlZRe)[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/gi)];
    for (const m of paaMatches) {
      const question = m[1].replace(/<[^>]*>/g, '').trim();
      if (question) peopleAlsoAsk.push({ question });
    }

    // Extract Related Searches
    const relatedMatches = [...html.matchAll(/class="[^"]*(?:s75CSd|ORleQ)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)];
    for (const m of relatedMatches) {
      const term = m[1].replace(/<[^>]*>/g, '').trim();
      if (term) relatedSearches.push(term);
    }

    // Extract total results count
    const totalMatch = html.match(/id="result-stats"[^>]*>([\s\S]*?)<\/div>/i);
    if (totalMatch) {
      const nums = totalMatch[1].replace(/[^\d]/g, '');
      if (nums) totalResults = parseInt(nums, 10);
    }

    // Extract knowledge panel
    const kpMatch = html.match(/class="[^"]*kp-blk[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
    if (kpMatch) {
      knowledgePanel = { title: kpMatch[1].replace(/<[^>]*>/g, '').trim(), type: 'entity' };
    }
  } catch (err: any) {
    logger.error({ error: err.message }, 'Failed to parse Google SERP');
  }

  return { organicResults, adResults, knowledgePanel, peopleAlsoAsk, relatedSearches, totalResults };
}

function parseBingSerp(html: string): Pick<SerpResponse, 'organicResults' | 'adResults' | 'peopleAlsoAsk' | 'relatedSearches'> {
  const organicResults: SerpOrganicResult[] = [];
  const adResults: SerpAdResult[] = [];
  const peopleAlsoAsk: SerpPeopleAlsoAsk[] = [];
  const relatedSearches: string[] = [];

  try {
    const matches = [...html.matchAll(/<li class="b_algo">[\s\S]*?<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
    let position = 1;
    for (const m of matches) {
      const url = m[1];
      const title = m[2].replace(/<[^>]*>/g, '').trim();
      if (url && title) {
        organicResults.push({ position: position++, title, url, displayedUrl: new URL(url).hostname, snippet: '' });
      }
    }

    const paaMatches = [...html.matchAll(/class="[^"]*b_qs[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)];
    for (const m of paaMatches) {
      const question = m[1].replace(/<[^>]*>/g, '').trim();
      if (question) peopleAlsoAsk.push({ question });
    }

    const relatedMatches = [...html.matchAll(/class="[^"]*b_listdata[^"]*"[^>]*><a[^>]*>([\s\S]*?)<\/a>/gi)];
    for (const m of relatedMatches) {
      const term = m[1].replace(/<[^>]*>/g, '').trim();
      if (term) relatedSearches.push(term);
    }
  } catch (err: any) {
    logger.error({ error: err.message }, 'Failed to parse Bing SERP');
  }

  return { organicResults, adResults, peopleAlsoAsk, relatedSearches };
}

/**
 * Yahoo SERP Parser
 * Yahoo search results use different HTML structure from Google/Bing.
 * Results are typically in <div class="dd algo"> or <li class="sr"> containers.
 */
function parseYahooSerp(html: string): Pick<SerpResponse, 'organicResults' | 'adResults' | 'peopleAlsoAsk' | 'relatedSearches' | 'totalResults'> {
  const organicResults: SerpOrganicResult[] = [];
  const adResults: SerpAdResult[] = [];
  const peopleAlsoAsk: SerpPeopleAlsoAsk[] = [];
  const relatedSearches: string[] = [];
  let totalResults: number | undefined;

  try {
    const seenUrls = new Set<string>();

    // Parse organic results from Yahoo's algo div containers
    const algoMatches = [...html.matchAll(/<div[^>]*class="[^"]*(?:dd\s+algo|compTitle)[^"]*"[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];

    let position = 1;
    for (const m of algoMatches) {
      const url = m[1];
      if (!url || seenUrls.has(url)) continue;
      if (url.includes('yahoo.com') || url.includes('r.search.yahoo.com')) continue;

      seenUrls.add(url);
      const title = m[2].replace(/<[^>]*>/g, '').trim();
      if (!title || title.length < 3) continue;

      organicResults.push({
        position: position++,
        title,
        url,
        displayedUrl: new URL(url).hostname,
        snippet: '',
      });

      if (organicResults.length >= 20) break;
    }

    // Fallback: try extracting from all anchor tags if no algo divs found
    if (organicResults.length === 0) {
      const anchorMatches = [...html.matchAll(/<a[^>]*href="(https?:\/\/(?:r\.search\.)?yahoo\.com\/[^"]*[?&]RU=(https?:\/\/[^&"]+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
      for (const m of anchorMatches) {
        const actualUrl = decodeURIComponent(m[2]);
        if (!actualUrl || seenUrls.has(actualUrl)) continue;

        seenUrls.add(actualUrl);
        const title = m[3].replace(/<[^>]*>/g, '').trim();
        if (!title || title.length < 3) continue;

        try {
          organicResults.push({
            position: position++,
            title,
            url: actualUrl,
            displayedUrl: new URL(actualUrl).hostname,
            snippet: '',
          });
        } catch {}

        if (organicResults.length >= 20) break;
      }
    }

    // Extract snippets from nearby elements
    for (let i = 0; i < organicResults.length; i++) {
      const resultUrl = organicResults[i].url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const snippetMatch = html.match(new RegExp(`<span[^>]*class="[^"]*fc-falcon[^"]*"[^>]*>([\\s\\S]*?)<\\/span>`, 'i'));
      if (snippetMatch) {
        organicResults[i].snippet = snippetMatch[1].replace(/<[^>]*>/g, '').trim().substring(0, 300);
      }
    }

    // Extract "People Also Ask" / "Also Try"
    const paaMatches = [...html.matchAll(/class="[^"]*(?:compList|AlsoTry)[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/gi)];
    for (const m of paaMatches) {
      const question = m[1].replace(/<[^>]*>/g, '').trim();
      if (question && question.length > 5 && question.length < 200) {
        peopleAlsoAsk.push({ question });
      }
      if (peopleAlsoAsk.length >= 5) break;
    }

    // Extract related searches
    const relatedMatches = [...html.matchAll(/class="[^"]*compPagination[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/gi)];
    for (const m of relatedMatches) {
      const term = m[1].replace(/<[^>]*>/g, '').trim();
      if (term) relatedSearches.push(term);
    }

    // Extract total results count
    const totalMatch = html.match(/([\d,]+)\s*results/i);
    if (totalMatch) {
      const nums = totalMatch[1].replace(/,/g, '');
      if (nums) totalResults = parseInt(nums, 10);
    }
  } catch (err: any) {
    logger.error({ error: err.message }, 'Failed to parse Yahoo SERP');
  }

  return { organicResults, adResults, peopleAlsoAsk, relatedSearches, totalResults };
}

/**
 * DuckDuckGo SERP Parser
 * DDG HTML version has a distinct structure with result__a class for links.
 */
function parseDuckDuckGoSerp(html: string): Pick<SerpResponse, 'organicResults' | 'adResults' | 'peopleAlsoAsk' | 'relatedSearches'> {
  const organicResults: SerpOrganicResult[] = [];
  const adResults: SerpAdResult[] = [];
  const peopleAlsoAsk: SerpPeopleAlsoAsk[] = [];
  const relatedSearches: string[] = [];

  try {
    const seenUrls = new Set<string>();

    // DDG HTML uses class="result__a" for result links
    const resultMatches = [...html.matchAll(/class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];

    let position = 1;
    for (const m of resultMatches) {
      let url = m[1];
      const title = m[2].replace(/<[^>]*>/g, '').trim();

      // DDG uses redirect URLs: //duckduckgo.com/l/?uddg=<encoded-url>&...
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        try { url = decodeURIComponent(uddgMatch[1]); } catch {}
      }

      // Remove DDG redirect prefix
      if (url.startsWith('//')) url = 'https:' + url;
      if (url.includes('duckduckgo.com') && !uddgMatch) continue;

      if (!url || seenUrls.has(url) || !title) continue;

      seenUrls.add(url);

      try {
        organicResults.push({
          position: position++,
          title,
          url,
          displayedUrl: new URL(url).hostname,
          snippet: '',
        });
      } catch {}

      if (organicResults.length >= 20) break;
    }

    // Extract snippets from result__snippet class
    const snippetMatches = [...html.matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/gi)];
    for (let i = 0; i < Math.min(snippetMatches.length, organicResults.length); i++) {
      organicResults[i].snippet = snippetMatches[i][1].replace(/<[^>]*>/g, '').trim().substring(0, 300);
    }

    // Extract related searches from DDG's related searches section
    const relatedMatches = [...html.matchAll(/class="[^"]*related-searches[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/gi)];
    for (const m of relatedMatches) {
      const term = m[1].replace(/<[^>]*>/g, '').trim();
      if (term) relatedSearches.push(term);
    }

    // Fallback: try extracting from the "deep results" area
    if (relatedSearches.length === 0) {
      const deepMatches = [...html.matchAll(/class="[^"]*result__a[^"]*"[^>]*>[\s\S]*?<\/a>/gi)];
    }
  } catch (err: any) {
    logger.error({ error: err.message }, 'Failed to parse DuckDuckGo SERP');
  }

  return { organicResults, adResults, peopleAlsoAsk, relatedSearches };
}

// --- SERP API -----------------------------------------------------------------

export class SerpApi {
  async search(
    request: SerpRequest,
    userId: string,
    apiKeyId: string,
  ): Promise<SerpResponse> {
    const engine = request.engine || 'google';
    const country = request.country || 'us';
    const language = request.language || 'en';
    const page = request.page || 1;
    const startTime = Date.now();

    const url = this.buildUrl(request);

    // Check cache
    const cacheKey = `serp:${engine}:${request.query}:${country}:${language}:${page}`;
    const cached = await cacheGet<SerpResponse>(cacheKey);
    if (cached) {
      logger.info({ engine, query: request.query, cached: true }, 'SERP cache hit');
      return { ...cached, cached: true };
    }

    // Get proxy
    const proxySelection = await proxyManager.getProxy(
      engine,
      (request.proxyTier as any) || 'residential',
      request.proxyCountry || country,
    );
    const proxyUrl = proxySelection?.proxyUrl;

    // Fetch SERP -- try browser first, fall back to proxy-aware HTTP
    let html = '';
    let lease: BrowserLease | undefined;

    try {
      lease = await browserPool.acquire(proxyUrl, engine === 'google');

      const response = await lease.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });

      try {
        await lease.page.waitForSelector('body', { timeout: 10_000 });
        await lease.page.waitForFunction(
          () => document.body?.innerText?.length > 50,
          { timeout: 8_000 },
        );
      } catch {}

      html = await lease.page.content();
    } catch (err: any) {
      logger.error({ engine, query: request.query, error: err.message }, 'SERP browser fetch failed');
      try {
        html = await this.fetchViaHttp(url, proxyUrl);
      } catch (httpErr: any) {
        throw new Error(`SERP fetch failed: ${err.message}`);
      }
    } finally {
      if (lease) await browserPool.release(lease);
    }

    // Parse results based on engine
    const searchTimeMs = Date.now() - startTime;
    let parsed: Pick<SerpResponse, 'organicResults' | 'adResults' | 'knowledgePanel' | 'peopleAlsoAsk' | 'relatedSearches' | 'totalResults'>;

    switch (engine) {
      case 'bing':
        parsed = parseBingSerp(html);
        break;
      case 'yahoo':
        parsed = parseYahooSerp(html);
        break;
      case 'duckduckgo':
        parsed = parseDuckDuckGoSerp(html);
        break;
      default:
        parsed = parseGoogleSerp(html);
    }

    const creditsUsed = engine === 'duckduckgo' ? 4 : 5; // DDG is cheaper
    const response: SerpResponse = {
      query: request.query,
      engine,
      country,
      language,
      page,
      ...parsed,
      peopleAlsoAsk: parsed.peopleAlsoAsk,
      relatedSearches: parsed.relatedSearches,
      searchTimeMs,
      creditsUsed,
      cached: false,
    };

    // Cache (15 min)
    await cacheSet(cacheKey, response, 900);

    // Save to DB
    try {
      await db.serpResult.create({
        data: {
          id: randomUUID(),
          userId,
          apiKeyId,
          engine: engine as any,
          query: request.query,
          country,
          language,
          page,
          results: JSON.parse(JSON.stringify({
            organicResults: response.organicResults,
            adResults: response.adResults,
            knowledgePanel: response.knowledgePanel,
            peopleAlsoAsk: response.peopleAlsoAsk,
            relatedSearches: response.relatedSearches,
          })),
          totalResults: response.totalResults,
          searchTimeMs,
          creditsUsed,
          creditsCharged: creditsUsed,
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to save SERP result');
    }

    logger.info(
      { engine, query: request.query, results: response.organicResults.length, searchTimeMs },
      'SERP query completed',
    );

    return response;
  }

  private buildUrl(request: SerpRequest): string {
    switch (request.engine || 'google') {
      case 'google': return buildGoogleUrl(request);
      case 'bing': return buildBingUrl(request);
      case 'yahoo': return buildYahooUrl(request);
      case 'duckduckgo': return buildDuckDuckGoUrl(request);
      default: return buildGoogleUrl(request);
    }
  }

  /**
   * HTTP fallback using proxyFetch for actual proxy routing.
   */
  private async fetchViaHttp(url: string, proxyUrl?: string): Promise<string> {
    const profile = stealthEngine.getRandomProfile();
    const headers: Record<string, string> = {
      'User-Agent': profile.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };

    const response = await proxyFetch(url, proxyUrl, {
      headers,
      redirect: 'follow',
      timeout: 15_000,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text;
  }
}

export const serpApi = new SerpApi();
