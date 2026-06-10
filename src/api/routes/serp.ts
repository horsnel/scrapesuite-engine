import { FastifyInstance } from 'fastify';
import { db } from '../../utils/db';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { checkCredits } from '../middleware/credits';
import { serpApi } from '../../serp';
import { createChildLogger } from '../../utils/logger';
import { z } from 'zod';

const logger = createChildLogger('api:serp');

// --- Request Validation Schema ------------------------------------------------

const SerpRequestSchema = z.object({
  query: z.string().min(1, { message: 'Search query is required' }).max(500),
  engine: z.enum(['google', 'bing', 'yahoo', 'duckduckgo']).optional().default('google'),
  country: z.string().min(2).max(2).optional().default('us'),
  language: z.string().min(2).max(5).optional().default('en'),
  page: z.number().int().min(1).max(10).optional().default(1),
  numResults: z.number().int().min(1).max(100).optional().default(10),
  proxyTier: z.enum(['residential', 'mobile', 'datacenter', 'isp']).optional(),
  proxyCountry: z.string().min(2).max(2).optional(),
  parse: z.boolean().optional().default(true),
});

// --- Route Registration --------------------------------------------------------

export async function serpRoutes(app: FastifyInstance) {
  // -- POST /v1/serp -- Execute a SERP query -----------------------------------

  app.post('/v1/serp', {
    preHandler: [authMiddleware, checkCredits],
  }, async (request, reply) => {
    const body = SerpRequestSchema.safeParse(request.body);
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

    const { apiKey } = request as AuthenticatedRequest;
    const data = body.data;

    const cost = 5; // SERP_API credits

    if (apiKey.creditsRemaining < cost) {
      return reply.status(402).send({
        success: false,
        error: `Insufficient credits. Need ${cost}, have ${apiKey.creditsRemaining}`,
      });
    }

    try {
      const result = await serpApi.search(
        {
          query: data.query,
          engine: data.engine,
          country: data.country,
          language: data.language,
          page: data.page,
          numResults: data.numResults,
          proxyTier: data.proxyTier as any,
          proxyCountry: data.proxyCountry,
          parse: data.parse,
        },
        apiKey.userId,
        apiKey.id,
      );

      // Deduct credits for successful requests only
      if (!result.cached) {
        const { deductCredits } = await import('../middleware/credits');
        await deductCredits(apiKey.userId, apiKey.id, cost);
      }

      return reply.send({
        success: true,
        data: result,
        creditsUsed: result.cached ? 0 : cost,
        creditsRemaining: apiKey.creditsRemaining - (result.cached ? 0 : cost),
      });
    } catch (error: any) {
      logger.error({ error: error.message, query: data.query }, 'SERP query failed');
      return reply.status(500).send({
        success: false,
        error: 'SERP query failed. Please try again.',
        creditsUsed: 0,
      });
    }
  });

  // -- GET /v1/serp/engines -- List available search engines -------------------

  app.get('/v1/serp/engines', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    return reply.send({
      success: true,
      data: [
        {
          id: 'google',
          name: 'Google',
          countries: 200,
          costPerRequest: 5,
          features: ['organic', 'ads', 'knowledge_panel', 'people_also_ask', 'related_searches'],
        },
        {
          id: 'bing',
          name: 'Bing',
          countries: 200,
          costPerRequest: 5,
          features: ['organic', 'ads', 'related_searches'],
        },
        {
          id: 'yahoo',
          name: 'Yahoo',
          countries: 50,
          costPerRequest: 5,
          features: ['organic', 'related_searches'],
        },
        {
          id: 'duckduckgo',
          name: 'DuckDuckGo',
          countries: 50,
          costPerRequest: 4,
          features: ['organic', 'related_searches'],
        },
      ],
    });
  });
}
