import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('robots');

// --- Types --------------------------------------------------------------------

interface RobotsRule {
  path: string;
  allow: boolean;
}

interface ParsedRobotsTxt {
  userAgent: string;
  rules: RobotsRule[];
  sitemaps: string[];
  crawlDelay: number | null;
  raw: string;
}

// --- Robots.txt Parser & Checker ---------------------------------------------

export class RobotsParser {
  private cache: Map<string, { rules: ParsedRobotsTxt; expires: number }> = new Map();
  private readonly CACHE_TTL = 3600; // 1 hour in Redis
  private readonly MEMORY_TTL = 300_000; // 5 minutes in memory

  /**
   * Check if a URL is allowed by the site's robots.txt.
   * Returns true if allowed, false if disallowed.
   * If robots.txt cannot be fetched, returns the defaultAllow value.
   */
  async isAllowed(
    url: string,
    userAgent: string = 'ScrapeSuite',
    defaultAllow: boolean = true,
  ): Promise<{ allowed: boolean; crawlDelay: number | null; source: string }> {
    try {
      const parsedUrl = new URL(url);
      const robotsUrl = `${parsedUrl.origin}/robots.txt`;

      const rules = await this.fetchAndParse(robotsUrl);
      if (!rules) {
        return { allowed: defaultAllow, crawlDelay: null, source: 'no-robots-txt' };
      }

      const path = parsedUrl.pathname + parsedUrl.search;
      const allowed = this.checkPath(path, rules, userAgent);

      return {
        allowed,
        crawlDelay: rules.crawlDelay,
        source: 'robots-txt',
      };
    } catch (error: any) {
      logger.warn({ url, error: error.message }, 'Failed to check robots.txt');
      return { allowed: defaultAllow, crawlDelay: null, source: 'error' };
    }
  }

  /**
   * Fetch and parse robots.txt from a URL.
   * Uses 3-tier caching: memory → Redis → HTTP fetch.
   */
  async fetchAndParse(robotsUrl: string): Promise<ParsedRobotsTxt | null> {
    const domain = new URL(robotsUrl).hostname;

    // Tier 1: Memory cache
    const memEntry = this.cache.get(domain);
    if (memEntry && memEntry.expires > Date.now()) {
      return memEntry.rules;
    }

    // Tier 2: Redis cache
    const redisKey = `robots:${domain}`;
    const cached = await cacheGet<ParsedRobotsTxt>(redisKey);
    if (cached) {
      this.cache.set(domain, { rules: cached, expires: Date.now() + this.MEMORY_TTL });
      return cached;
    }

    // Tier 3: HTTP fetch
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(robotsUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'ScrapeSuite-Bot (+https://scrapesuite.dev)',
          'Accept': 'text/plain',
        },
        redirect: 'follow',
      });

      clearTimeout(timeout);

      if (!response.ok) {
        logger.debug({ robotsUrl, status: response.status }, 'robots.txt not found or inaccessible');
        return null;
      }

      const text = await response.text();
      const parsed = this.parse(text, '*');

      // Cache in Redis
      await cacheSet(redisKey, parsed, this.CACHE_TTL);
      // Cache in memory
      this.cache.set(domain, { rules: parsed, expires: Date.now() + this.MEMORY_TTL });

      logger.debug({ domain, rules: parsed.rules.length }, 'robots.txt fetched and parsed');
      return parsed;
    } catch (error: any) {
      logger.warn({ robotsUrl, error: error.message }, 'Failed to fetch robots.txt');
      return null;
    }
  }

  /**
   * Parse a robots.txt text into structured rules.
   * Supports User-agent, Allow, Disallow, Crawl-delay, and Sitemap directives.
   */
  parse(text: string, targetUserAgent: string = '*'): ParsedRobotsTxt {
    const lines = text.split('\n').map((l) => l.trim());
    const rules: RobotsRule[] = [];
    const sitemaps: string[] = [];
    let crawlDelay: number | null = null;
    let currentUserAgent = '';
    let isRelevantSection = false;

    // Normalize target user agent for matching
    const normalizeAgent = (agent: string) => agent.toLowerCase().trim();

    const targetNormalized = normalizeAgent(targetUserAgent);

    for (const line of lines) {
      // Skip comments and empty lines
      if (!line || line.startsWith('#')) continue;

      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const directive = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();

      switch (directive) {
        case 'user-agent': {
          const agent = normalizeAgent(value);
          currentUserAgent = agent;
          // Match if it's the target agent or wildcard
          isRelevantSection = agent === targetNormalized
            || agent === '*'
            || (targetNormalized.includes(agent) && agent !== '*');
          break;
        }

        case 'allow': {
          if (isRelevantSection && value) {
            rules.push({ path: value, allow: true });
          }
          break;
        }

        case 'disallow': {
          if (isRelevantSection && value) {
            rules.push({ path: value, allow: false });
          }
          break;
        }

        case 'crawl-delay': {
          if (isRelevantSection) {
            const delay = parseFloat(value);
            if (!isNaN(delay) && delay > 0) {
              crawlDelay = delay;
            }
          }
          break;
        }

        case 'sitemap': {
          if (value) sitemaps.push(value);
          break;
        }
      }
    }

    // Sort rules: longer paths take priority (more specific rules first)
    rules.sort((a, b) => {
      // Allow rules take precedence over disallow for same length
      if (a.path.length === b.path.length) {
        return a.allow ? -1 : 1;
      }
      return b.path.length - a.path.length;
    });

    return {
      userAgent: targetUserAgent,
      rules,
      sitemaps,
      crawlDelay,
      raw: text,
    };
  }

  /**
   * Check if a specific path is allowed based on parsed robots.txt rules.
   * Uses the longest-match-wins strategy per RFC 9309.
   */
  private checkPath(path: string, rules: ParsedRobotsTxt, userAgent: string): boolean {
    if (rules.rules.length === 0) return true; // No rules = allowed

    let bestMatch: RobotsRule | null = null;
    let bestMatchLength = -1;

    for (const rule of rules.rules) {
      if (this.pathMatches(path, rule.path)) {
        if (rule.path.length > bestMatchLength) {
          bestMatch = rule;
          bestMatchLength = rule.path.length;
        }
      }
    }

    // Default: allowed if no rule matches
    if (!bestMatch) return true;

    return bestMatch.allow;
  }

  /**
   * Check if a URL path matches a robots.txt pattern.
   * Supports wildcards (*) and end-of-path markers ($).
   */
  private pathMatches(path: string, pattern: string): boolean {
    // Convert robots.txt pattern to regex
    let regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars (except *)
      .replace(/\*/g, '.*')                  // * matches any string
      .replace(/\\\$/g, '$');                 // $ is end-of-path marker

    // If pattern ends with $, match exactly
    if (regexPattern.endsWith('$')) {
      regexPattern = regexPattern.slice(0, -1) + '$';
    } else {
      // Otherwise, pattern matches any path that starts with it
      regexPattern = '^' + regexPattern;
    }

    try {
      const regex = new RegExp(regexPattern, 'i');
      return regex.test(path);
    } catch {
      // Fallback: simple startsWith
      return path.toLowerCase().startsWith(pattern.toLowerCase());
    }
  }

  /**
   * Get sitemaps from robots.txt.
   */
  async getSitemaps(domain: string): Promise<string[]> {
    const robotsUrl = `https://${domain}/robots.txt`;
    const parsed = await this.fetchAndParse(robotsUrl);
    return parsed?.sitemaps || [];
  }
}

export const robotsParser = new RobotsParser();
