import { FastifyInstance } from 'fastify';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { checkCredits } from '../middleware/credits';
import { genericParser } from '../../structured/generic';
import { amazonParser } from '../../structured/amazon';
import { googleSerpParser } from '../../structured/google';
import { createChildLogger } from '../../utils/logger';
import { z } from 'zod';

const logger = createChildLogger('api:structured');

// --- Request Validation Schema ------------------------------------------------

const StructuredParseSchema = z.object({
  html: z.string().min(1, { message: 'HTML content is required' }),
  url: z.string().url().optional(),
  parser: z.enum(['auto', 'article', 'product', 'amazon', 'google', 'generic']).optional().default('auto'),
});

// --- Route Registration --------------------------------------------------------

export async function structuredRoutes(app: FastifyInstance) {
  // -- POST /v1/structured -- Parse structured data from HTML -------------------

  app.post('/v1/structured', {
    preHandler: [authMiddleware, checkCredits],
  }, async (request, reply) => {
    const body = StructuredParseSchema.safeParse(request.body);
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

    const cost = 2; // STRUCTURED_PARSE credits

    if (apiKey.creditsRemaining < cost) {
      return reply.status(402).send({
        success: false,
        error: `Insufficient credits. Need ${cost}, have ${apiKey.creditsRemaining}`,
      });
    }

    try {
      let result: Record<string, any> = {};
      const domain = data.url ? (() => { try { return new URL(data.url).hostname.replace(/^www\./, ''); } catch { return ''; } })() : '';

      // Determine which parser to use
      if (data.parser === 'auto') {
        // Auto-detect based on domain and content
        if (domain.includes('amazon.')) {
          result.amazon = amazonParser.parse(data.html);
        } else if (domain.includes('google.') && (data.url?.includes('/search') || data.url?.includes('search?q='))) {
          result.google = googleSerpParser.parse(data.html);
        }

        // Always run generic parser for schema.org / OG data
        result.generic = genericParser.parse(data.html, data.url);
      } else {
        switch (data.parser) {
          case 'amazon':
            result.amazon = amazonParser.parse(data.html);
            break;
          case 'google':
            result.google = googleSerpParser.parse(data.html);
            break;
          case 'article':
          case 'product':
          case 'generic':
            result.generic = genericParser.parse(data.html, data.url);
            break;
        }
      }

      // Deduct credits
      const { deductCredits } = await import('../middleware/credits');
      await deductCredits(apiKey.userId, apiKey.id, cost);

      return reply.send({
        success: true,
        data: result,
        creditsUsed: cost,
        creditsRemaining: apiKey.creditsRemaining - cost,
      });
    } catch (error: any) {
      logger.error({ error: error.message, url: data.url }, 'Structured parsing failed');
      return reply.status(500).send({
        success: false,
        error: 'Structured data parsing failed. Please try again.',
        creditsUsed: 0,
      });
    }
  });

  // -- GET /v1/structured/parsers -- List available parsers ---------------------

  app.get('/v1/structured/parsers', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    return reply.send({
      success: true,
      data: [
        {
          id: 'auto',
          name: 'Auto-detect',
          description: 'Automatically selects the best parser based on URL and content',
          cost: 2,
        },
        {
          id: 'generic',
          name: 'Generic (Schema.org + Open Graph)',
          description: 'Parses JSON-LD, Open Graph, Twitter Cards, and HTML meta tags from any page',
          cost: 2,
          outputTypes: ['article', 'product', 'unknown'],
        },
        {
          id: 'amazon',
          name: 'Amazon Product',
          description: 'Parses Amazon product detail pages into structured data (title, price, rating, features, ASIN)',
          cost: 2,
          domains: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.co.jp'],
        },
        {
          id: 'google',
          name: 'Google SERP',
          description: 'Parses Google search results pages (organic results, ads, related searches, People Also Ask)',
          cost: 2,
          domains: ['google.com', 'google.co.uk', 'google.de'],
        },
      ],
    });
  });
}
