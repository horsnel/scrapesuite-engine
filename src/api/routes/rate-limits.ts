/**
 * Rate Limit Status API Routes -- Query the current rate-limiting state for
 * domains, including throttle status, cooldowns, and protection flags.
 *
 * Endpoints
 * ---------
 *   GET    /v1/rate-limits/:domain  -- Get current rate limit status for a domain
 *   GET    /v1/rate-limits          -- Get all currently throttled domains
 *
 * All endpoints require authentication via authMiddleware.
 */

import { FastifyInstance } from 'fastify';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { adaptiveRateLimiter } from '../../rate-limiter';
import { createChildLogger } from '../../utils/logger';
import { z } from 'zod';

const logger = createChildLogger('api:rate-limits');

// --- Route Registration --------------------------------------------------------

export async function rateLimitRoutes(app: FastifyInstance) {
  // -- GET /v1/rate-limits/:domain -- Get rate limit status for a domain -------

  app.get('/v1/rate-limits/:domain', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const { domain } = request.params as { domain: string };

    // Basic domain validation
    if (!domain || domain.length < 2 || domain.length > 253) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid domain. Must be between 2 and 253 characters.',
      });
    }

    // Only business plan users can see detailed rate limit data
    if (apiKey.plan !== 'business') {
      return reply.status(403).send({
        success: false,
        error: 'Rate limit status is available on the Business plan only. Upgrade at https://scrapesuite.dev/dashboard',
      });
    }

    try {
      const status = await adaptiveRateLimiter.getDomainStatus(domain);

      return reply.send({
        success: true,
        data: status,
      });
    } catch (error: any) {
      logger.error({ error: error.message, domain }, 'Failed to get rate limit status');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get rate limit status for the specified domain.',
      });
    }
  });

  // -- GET /v1/rate-limits -- Get all currently throttled domains --------------

  app.get('/v1/rate-limits', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;

    // Only business plan users can see throttled domain list
    if (apiKey.plan !== 'business') {
      return reply.status(403).send({
        success: false,
        error: 'Rate limit status is available on the Business plan only. Upgrade at https://scrapesuite.dev/dashboard',
      });
    }

    try {
      const throttledDomains = await adaptiveRateLimiter.getAllThrottledDomains();

      return reply.send({
        success: true,
        data: throttledDomains,
        total: throttledDomains.length,
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to get throttled domains');
      return reply.status(500).send({
        success: false,
        error: 'Failed to retrieve throttled domain list.',
      });
    }
  });
}
