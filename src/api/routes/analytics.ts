import { FastifyInstance } from 'fastify';
import { db } from '../../utils/db';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { createChildLogger } from '../../utils/logger';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { UsageSummary } from '../../types';

const logger = createChildLogger('api:analytics');

// --- Route Registration --------------------------------------------------------

export async function analyticsRoutes(app: FastifyInstance) {
  // -- GET /v1/analytics/usage -- Get usage statistics --------------------------

  app.get('/v1/analytics/usage', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const query = request.query as {
      period?: string;  // '24h', '7d', '30d', '90d'
    };

    const period = query.period || '30d';
    const daysMap: Record<string, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };
    const days = daysMap[period] || 30;

    const since = new Date();
    since.setDate(since.getDate() - days);

    try {
      // Get job statistics
      const [
        totalJobs,
        successfulJobs,
        failedJobs,
        avgResponseTime,
        uniqueDomains,
        strategyBreakdown,
        topDomains,
      ] = await Promise.all([
        // Total jobs
        db.scrapeJob.count({
          where: { userId: apiKey.userId, createdAt: { gte: since } },
        }),

        // Successful jobs
        db.scrapeJob.count({
          where: { userId: apiKey.userId, status: 'done', createdAt: { gte: since } },
        }),

        // Failed jobs
        db.scrapeJob.count({
          where: { userId: apiKey.userId, status: 'failed', createdAt: { gte: since } },
        }),

        // Average response time
        db.scrapeJob.aggregate({
          _avg: { responseMs: true },
          where: { userId: apiKey.userId, status: 'done', createdAt: { gte: since } },
        }),

        // Unique domains
        db.scrapeJob.groupBy({
          by: ['domain'],
          where: { userId: apiKey.userId, createdAt: { gte: since } },
          _count: { domain: true },
        }),

        // Strategy breakdown
        db.scrapeJob.groupBy({
          by: ['strategy'],
          where: { userId: apiKey.userId, createdAt: { gte: since } },
          _count: { strategy: true },
        }),

        // Top domains (limited)
        db.scrapeJob.groupBy({
          by: ['domain'],
          where: { userId: apiKey.userId, createdAt: { gte: since } },
          _count: { domain: true },
          _avg: { responseMs: true },
          orderBy: { _count: { domain: 'desc' } },
          take: 10,
        }),
      ]);

      const successRate = totalJobs > 0 ? successfulJobs / totalJobs : 0;

      // Calculate credit usage by operation type
      const creditsUsed = await db.scrapeJob.aggregate({
        _sum: { creditsUsed: true, creditsCharged: true },
        where: { userId: apiKey.userId, createdAt: { gte: since } },
      });

      const summary: UsageSummary = {
        period,
        httpRequests: strategyBreakdown.find((s) => s.strategy === 'http')?._count.strategy || 0,
        browserRequests: (strategyBreakdown.find((s) => s.strategy === 'browser')?._count.strategy || 0)
          + (strategyBreakdown.find((s) => s.strategy === 'stealth-browser')?._count.strategy || 0),
        cacheHits: strategyBreakdown.find((s) => s.strategy === 'cache')?._count.strategy || 0,
        nlExtractions: 0,
        structuredRequests: 0,
        monitorChecks: 0,
        serpRequests: 0,
        captchaSolves: 0,
        creditsUsed: creditsUsed._sum.creditsUsed ?? 0,
        creditsCharged: creditsUsed._sum.creditsCharged ?? 0,
        successRate: Math.round(successRate * 1000) / 1000,
        avgResponseMs: Math.round(avgResponseTime._avg.responseMs || 0),
        uniqueDomains: uniqueDomains.length,
        topDomains: topDomains.map((d) => ({
          domain: d.domain,
          requests: d._count.domain,
          successRate: 0,
        })),
      };

      return reply.send({
        success: true,
        data: {
          summary,
          totalJobs,
          successfulJobs,
          failedJobs,
          creditsRemaining: apiKey.creditsRemaining,
          strategyBreakdown: strategyBreakdown.map((s) => ({
            strategy: s.strategy,
            count: s._count.strategy,
          })),
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message, userId: apiKey.userId }, 'Failed to get usage analytics');
      return reply.status(500).send({
        success: false,
        error: 'Failed to retrieve usage analytics',
      });
    }
  });

  // -- GET /v1/analytics/domains -- Get domain intelligence data ----------------

  app.get('/v1/analytics/domains', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const query = request.query as {
      limit?: string;
      offset?: string;
    };

    const limit = Math.min(parseInt(query.limit || '50', 10), 200);
    const offset = parseInt(query.offset || '0', 10);

    // Get domains that the user has scraped
    const userDomains = await db.scrapeJob.groupBy({
      by: ['domain'],
      where: { userId: apiKey.userId },
      _count: { domain: true },
      _avg: { responseMs: true },
      orderBy: { _count: { domain: 'desc' } },
      take: limit,
      skip: offset,
    });

    // Enrich with domain profiles
    const enrichedDomains = await Promise.all(
      userDomains.map(async (d) => {
        const profile = await db.domainProfile.findUnique({ where: { domain: d.domain } });
        return {
          domain: d.domain,
          requestCount: d._count.domain,
          avgResponseMs: Math.round(d._avg.responseMs || 0),
          requiresBrowser: profile?.requiresBrowser || false,
          hasCloudflare: profile?.hasCloudflare || false,
          hasDatadome: profile?.hasDatadome || false,
          hasAkamai: profile?.hasAkamai || false,
          successRate: profile?.successRate || 0,
          optimalProxyTier: profile?.optimalProxyTier || 'residential',
        };
      }),
    );

    return reply.send({
      success: true,
      data: enrichedDomains,
      limit,
      offset,
    });
  });
}
