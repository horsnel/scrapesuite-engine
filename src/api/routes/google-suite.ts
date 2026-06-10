/**
 * Google Suite API Routes — ScrapeSuite Engine
 *
 * REST API endpoints for Google scraping including Search,
 * Shopping, Maps, and CAPTCHA handling.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { googleSuiteManager, serpEngine, captchaHandler } from '../../google-suite';
import type { SearchType, SearchLanguage } from '../../google-suite/types';

interface SearchBody {
  query: string;
  type?: SearchType;
  language?: SearchLanguage;
  country?: string;
  page?: number;
  results_per_page?: number;
  safe_search?: boolean;
  site_filter?: string;
  exact_match?: string;
  exclude_terms?: string[];
  proxy_country?: string;
}

interface BatchSearchBody {
  queries: string[];
  type?: SearchType;
  language?: SearchLanguage;
  country?: string;
  delay_ms?: number;
}

interface ShoppingBody {
  query: string;
  country?: string;
  min_price?: number;
  max_price?: number;
  sort_by?: 'relevance' | 'price_low' | 'price_high' | 'rating';
}

interface MapsBody {
  query: string;
  type?: 'restaurant' | 'hotel' | 'gas_station' | 'grocery' | 'hospital' | 'pharmacy';
  country?: string;
  min_rating?: number;
  open_now?: boolean;
}

interface SolveCaptchaBody {
  type: 'recaptcha_v2' | 'recaptcha_v3' | 'recaptcha_enterprise';
  site_key: string;
  page_url: string;
  action?: string;
  min_score?: number;
}

export async function googleSuiteRoutes(app: FastifyInstance): Promise<void> {

  // Google Search
  app.post('/v1/google/search', async (req: FastifyRequest<{ Body: SearchBody }>, reply) => {
    const { query, type, language, country, page, results_per_page, safe_search, site_filter, exact_match, exclude_terms, proxy_country } = req.body;
    if (!query) return reply.status(400).send({ error: 'query is required' });

    const result = await googleSuiteManager.search({
      query,
      type: type || 'web',
      language,
      country,
      page,
      resultsPerPage: results_per_page,
      safeSearch: safe_search,
      siteFilter: site_filter,
      exactMatch: exact_match,
      excludeTerms: exclude_terms,
      proxyCountry: proxy_country,
    });
    return reply.send(result);
  });

  // Batch search
  app.post('/v1/google/search/batch', async (req: FastifyRequest<{ Body: BatchSearchBody }>, reply) => {
    const { queries, type, language, country, delay_ms } = req.body;
    if (!queries?.length) return reply.status(400).send({ error: 'queries array is required' });

    const requests = queries.map(query => ({
      query,
      type: type || 'web' as SearchType,
      language,
      country,
    }));

    const results = await googleSuiteManager.batchSearch(requests);
    return reply.send({ results });
  });

  // Google Shopping
  app.post('/v1/google/shopping', async (req: FastifyRequest<{ Body: ShoppingBody }>, reply) => {
    const { query, country, min_price, max_price, sort_by } = req.body;
    if (!query) return reply.status(400).send({ error: 'query is required' });

    const result = await googleSuiteManager.shopping({
      query,
      country,
      minPrice: min_price,
      maxPrice: max_price,
      sortBy: sort_by,
    });
    return reply.send(result);
  });

  // Google Maps
  app.post('/v1/google/maps', async (req: FastifyRequest<{ Body: MapsBody }>, reply) => {
    const { query, type, country, min_rating, open_now } = req.body;
    if (!query) return reply.status(400).send({ error: 'query is required' });

    const result = await googleSuiteManager.maps({
      query,
      type,
      country,
      minRating: min_rating,
      openNow: open_now,
    });
    return reply.send(result);
  });

  // Solve Google CAPTCHA
  app.post('/v1/google/captcha/solve', async (req: FastifyRequest<{ Body: SolveCaptchaBody }>, reply) => {
    const { type, site_key, page_url, action, min_score } = req.body;
    if (!type || !site_key || !page_url) {
      return reply.status(400).send({ error: 'type, site_key, and page_url are required' });
    }

    const solution = await googleSuiteManager.solveCaptcha({
      type,
      siteKey: site_key,
      pageUrl: page_url,
      action,
      minScore: min_score,
    });
    return reply.send(solution);
  });

  // CAPTCHA handler stats
  app.get('/v1/google/captcha/stats', async (_req, reply) => {
    return reply.send(captchaHandler.getStats());
  });

  // Google Suite overall stats
  app.get('/v1/google/stats', async (_req, reply) => {
    return reply.send(googleSuiteManager.getStats());
  });
}
