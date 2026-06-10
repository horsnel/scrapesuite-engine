import { FastifyInstance } from 'fastify';
import { db } from '../../utils/db';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { proxyManager } from '../../proxy/manager';
import { captchaSolver } from '../../captcha';
import { testProxy } from '../../utils/proxy-fetch';
import { createChildLogger } from '../../utils/logger';
import { z } from 'zod';

const logger = createChildLogger('api:proxy-stats');

// --- Route Registration --------------------------------------------------------

export async function proxyStatsRoutes(app: FastifyInstance) {
  // -- GET /v1/proxy/stats -- Get proxy pool statistics ------------------------

  app.get('/v1/proxy/stats', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;

    // Only business users can see full proxy stats
    if (apiKey.plan !== 'business') {
      const basicStats = await proxyManager.getPoolStats();
      return reply.send({
        success: true,
        data: {
          totalProxies: basicStats.total,
          activeProxies: basicStats.active,
          countries: Object.keys(basicStats.byCountry).length,
          avgSuccessRate: basicStats.avgSuccessRate,
        },
      });
    }

    const stats = await proxyManager.getPoolStats();
    return reply.send({
      success: true,
      data: stats,
    });
  });

  // -- GET /v1/proxy/countries -- List available proxy countries ---------------

  app.get('/v1/proxy/countries', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const stats = await proxyManager.getPoolStats();

    const countries = Object.entries(stats.byCountry).map(([code, count]) => ({
      code,
      proxyCount: count,
    }));

    return reply.send({
      success: true,
      data: countries,
    });
  });

  // -- POST /v1/proxy/test -- Test a proxy with a URL -------------------------
  // Now actually routes through the proxy using the proxyFetch utility.

  app.post('/v1/proxy/test', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = z.object({
      url: z.string().url(),
      proxyTier: z.enum(['residential', 'mobile', 'datacenter', 'isp']).optional().default('residential'),
      proxyCountry: z.string().min(2).max(2).optional(),
      proxyCity: z.string().optional(),
      proxyAsn: z.string().optional(),
    }).safeParse(request.body);

    if (!body.success) {
      return reply.status(400).send({
        success: false,
        error: 'Validation error',
        details: body.error.issues.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      });
    }

    const data = body.data;

    try {
      const proxy = await proxyManager.getProxy(
        new URL(data.url).hostname,
        data.proxyTier,
        data.proxyCountry,
        'least-failures',
        { city: data.proxyCity, asn: data.proxyAsn },
      );

      if (!proxy) {
        return reply.status(404).send({
          success: false,
          error: 'No proxy available for the specified criteria',
        });
      }

      // Actually test the proxy by routing a request through it
      const result = await testProxy(proxy.proxyUrl, data.url, 15_000);

      // Record outcome
      await proxyManager.recordOutcome({
        proxyId: proxy.proxyId,
        domain: new URL(data.url).hostname,
        success: result.working,
        statusCode: result.working ? 200 : 502,
        latencyMs: result.latencyMs,
      });

      return reply.send({
        success: true,
        data: {
          proxyId: proxy.proxyId,
          proxyCountry: proxy.country,
          proxyCity: proxy.city,
          proxyAsn: proxy.asn,
          proxyTier: proxy.tier,
          targetUrl: data.url,
          working: result.working,
          latencyMs: result.latencyMs,
          exitIp: result.ip,
          error: result.error,
        },
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: `Proxy test failed: ${error.message}`,
      });
    }
  });

  // -- GET /v1/captcha/balance -- Get CAPTCHA solver balances -----------------

  app.get('/v1/captcha/balance', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    if (!captchaSolver.isConfigured) {
      return reply.send({
        success: true,
        data: { configured: false, providers: [] },
      });
    }

    const balances = await captchaSolver.getBalances();

    return reply.send({
      success: true,
      data: {
        configured: true,
        providers: Object.entries(balances).map(([name, balance]) => ({
          name,
          balance,
        })),
      },
    });
  });

  // -- GET /v1/cost-estimate -- Estimate cost for a request -------------------

  app.get('/v1/cost-estimate', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const query = request.query as {
      strategy?: string;
      extraction?: string;
      structured?: string;
      serp?: string;
      captcha?: string;
    };

    const costs: Record<string, { operation: string; cost: number }[]> = {
      scraping: [
        { operation: 'HTTP Scrape', cost: 1 },
        { operation: 'Browser Render', cost: 5 },
        { operation: 'Stealth Browser', cost: 8 },
        { operation: 'Cache Hit', cost: 0 },
      ],
      extraction: [
        { operation: 'NL Extraction (Claude)', cost: 3 },
        { operation: 'Structured Parse', cost: 2 },
        { operation: 'Lead Enrichment', cost: 10 },
      ],
      serp: [
        { operation: 'SERP API', cost: 5 },
      ],
      captcha: [
        { operation: 'CAPTCHA Solve', cost: 3 },
      ],
      billing: [
        { operation: 'Failed requests', cost: 0 },
        { operation: 'Cached results', cost: 0 },
      ],
    };

    // Calculate estimated total based on query params
    let estimatedTotal = 0;
    if (query.strategy === 'http') estimatedTotal += 1;
    else if (query.strategy === 'browser') estimatedTotal += 5;
    else if (query.strategy === 'stealth-browser') estimatedTotal += 8;
    else estimatedTotal += 1; // default HTTP

    if (query.extraction === 'true') estimatedTotal += 3;
    if (query.structured === 'true') estimatedTotal += 2;
    if (query.serp === 'true') estimatedTotal += 5;
    if (query.captcha === 'true') estimatedTotal += 3;

    return reply.send({
      success: true,
      data: {
        costs,
        estimatedTotal,
        note: 'Failed requests are free. Only successful requests are charged.',
      },
    });
  });
}
