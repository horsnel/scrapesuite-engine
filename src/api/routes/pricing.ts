/**
 * Pricing API Routes -- Plan information, cost estimation, bandwidth reporting,
 * usage tracking, and credit balance queries.
 *
 * Endpoints
 * ---------
 *   GET    /v1/pricing/plans                 -- Get available pricing plans
 *   GET    /v1/pricing/estimate              -- Estimate cost for a scrape job
 *   POST   /v1/pricing/bandwidth/report     -- Report bandwidth usage
 *   GET    /v1/pricing/usage/:userId         -- Get user's usage and billing info
 *   GET    /v1/pricing/credits/balance       -- Get credit balance
 */

import { FastifyInstance } from 'fastify';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { pricingEngine, PRICING_TIERS, CREDIT_COST_MAP, PROXY_TIER_PRICING } from '../../pricing';
import { createChildLogger } from '../../utils/logger';
import { z } from 'zod';

const logger = createChildLogger('api:pricing');

// --- Request Validation Schemas ------------------------------------------------

const BandwidthReportSchema = z.object({
  bytesUsed: z.number().int().min(0),
  proxyTier: z.enum(['residential', 'mobile', 'datacenter', 'isp']).optional(),
  jobId: z.string().optional(),
});

// --- Route Registration --------------------------------------------------------

export async function pricingRoutes(app: FastifyInstance) {
  // -- GET /v1/pricing/plans -- Get available pricing plans ----------------------

  app.get('/v1/pricing/plans', async (request, reply) => {
    try {
      const plans = Object.entries(PRICING_TIERS).map(([key, tier]) => ({
        id: key,
        name: tier.name,
        monthlyPrice: tier.monthlyPrice < 0 ? 'Custom' : tier.monthlyPrice,
        includedCredits: tier.includedCredits < 0 ? 'Unlimited' : tier.includedCredits,
        overagePerCredit: tier.overagePerCredit < 0 ? 'Custom' : tier.overagePerCredit,
        bandwidthOveragePerGB: tier.bandwidthOveragePerGB < 0 ? 'Custom' : tier.bandwidthOveragePerGB,
        maxConcurrent: tier.maxConcurrent < 0 ? 'Unlimited' : tier.maxConcurrent,
        supportLevel: tier.supportLevel,
      }));

      return reply.send({
        success: true,
        data: {
          plans,
          creditCosts: CREDIT_COST_MAP,
          proxyTierPricing: PROXY_TIER_PRICING,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to get pricing plans');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get pricing plans.',
      });
    }
  });

  // -- GET /v1/pricing/estimate -- Estimate cost for a scrape job ---------------

  app.get('/v1/pricing/estimate', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const query = request.query as {
      url?: string;
      strategy?: string;
      proxyTier?: string;
      outputFormat?: string;
    };

    try {
      // Determine base credit cost from strategy
      const strategy = query.strategy || 'http';
      let baseCredits: number = CREDIT_COST_MAP.HTTP_SCRAPE;

      if (strategy === 'browser' || strategy === 'stealth-browser') {
        baseCredits = CREDIT_COST_MAP.BROWSER_SCRAPE as number;
      } else if (strategy === 'cache') {
        baseCredits = 0; // Cache hits are free
      }

      // Add proxy cost estimate
      let proxyCostPerGB = 0;
      if (query.proxyTier && query.proxyTier in PROXY_TIER_PRICING) {
        proxyCostPerGB = PROXY_TIER_PRICING[query.proxyTier as keyof typeof PROXY_TIER_PRICING];
      }

      // Estimate based on the user's plan
      const { apiKey } = request as AuthenticatedRequest;
      const balance = await pricingEngine.getUserBalance(apiKey.userId);
      const plan = balance?.plan || 'starter';
      const planTier = PRICING_TIERS[plan as keyof typeof PRICING_TIERS];

      const estimate = pricingEngine.estimateMonthlyCost({
        plan: plan as any,
        expectedCredits: baseCredits,
        expectedBandwidthGB: 0,
        proxyTier: query.proxyTier as any,
        expectedProxyBandwidthGB: 0,
      });

      return reply.send({
        success: true,
        data: {
          url: query.url,
          strategy,
          credits: baseCredits,
          proxyTier: query.proxyTier || 'none',
          proxyCostPerGB,
          outputFormat: query.outputFormat || 'raw',
          plan,
          creditsRemaining: balance?.creditsRemaining ?? 0,
          monthlyEstimate: estimate,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Cost estimation failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to estimate cost.',
      });
    }
  });

  // -- POST /v1/pricing/bandwidth/report -- Report bandwidth usage ---------------

  app.post('/v1/pricing/bandwidth/report', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = BandwidthReportSchema.safeParse(request.body);
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

    try {
      const { bytesUsed, proxyTier, jobId } = body.data;

      // Calculate bandwidth cost if proxy tier is specified
      let costUsd = 0;
      if (proxyTier) {
        costUsd = pricingEngine.calculateProxyBandwidthCost(proxyTier, bytesUsed);
      }

      // Invalidate balance cache since bandwidth usage affects billing
      await pricingEngine.invalidateBalanceCache(apiKey.userId);

      logger.info({
        userId: apiKey.userId,
        bytesUsed,
        proxyTier,
        jobId,
        costUsd,
      }, 'Bandwidth usage reported');

      return reply.send({
        success: true,
        data: {
          bytesUsed,
          gbUsed: Number((bytesUsed / 1073741824).toFixed(4)),
          proxyTier: proxyTier || 'none',
          costUsd: Math.round(costUsd * 100) / 100,
          jobId,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message, userId: apiKey.userId }, 'Bandwidth report failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to report bandwidth usage.',
      });
    }
  });

  // -- GET /v1/pricing/usage/:userId -- Get user's usage and billing info -------

  app.get('/v1/pricing/usage/:userId', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const { apiKey } = request as AuthenticatedRequest;

    // Users can only view their own usage unless they have special permissions
    if (userId !== apiKey.userId) {
      return reply.status(403).send({
        success: false,
        error: 'You can only view your own usage data.',
      });
    }

    const query = request.query as { period?: string };

    try {
      const [balance, usage] = await Promise.all([
        pricingEngine.getUserBalance(userId),
        pricingEngine.aggregateUsage(userId, (query.period as any) || 'monthly'),
      ]);

      if (!balance) {
        return reply.status(404).send({
          success: false,
          error: 'User not found.',
        });
      }

      // Calculate overage
      const overage = pricingEngine.calculateOverage(
        balance.plan,
        balance.creditsUsed,
        balance.bandwidthBytes,
      );

      return reply.send({
        success: true,
        data: {
          balance,
          usage,
          overage,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message, userId }, 'Usage lookup failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get usage data.',
      });
    }
  });

  // -- GET /v1/pricing/credits/balance -- Get credit balance --------------------

  app.get('/v1/pricing/credits/balance', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;

    try {
      const balance = await pricingEngine.getUserBalance(apiKey.userId);

      if (!balance) {
        return reply.status(404).send({
          success: false,
          error: 'User balance not found.',
        });
      }

      return reply.send({
        success: true,
        data: {
          creditsRemaining: balance.creditsRemaining,
          creditsUsed: balance.creditsUsed,
          totalCredits: balance.totalCredits,
          plan: balance.plan,
          overageCredits: balance.overageCredits,
          alertLevel: balance.alertLevel,
          bandwidthBytes: balance.bandwidthBytes,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message, userId: apiKey.userId }, 'Balance check failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get credit balance.',
      });
    }
  });
}
