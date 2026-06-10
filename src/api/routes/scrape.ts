import { FastifyInstance } from 'fastify';
import { db } from '../../utils/db';
import { addScrapeJob } from '../../workers/queue';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { checkCredits } from '../middleware/credits';
import { extractDomain, calculateScrapeCredits, getJobPriority } from '../../utils/credits';
import { orchestrator } from '../../orchestrator';
import { proxyManager } from '../../proxy/manager';
import { createChildLogger } from '../../utils/logger';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { PlanTier } from '../../types';

const logger = createChildLogger('api:scrape');

// --- Per-User Concurrency Tracking ---------------------------------------------

const userActiveRequests = new Map<string, number>();

const PLAN_CONCURRENCY_LIMITS: Record<string, number> = {
  starter: 5,
  pro: 20,
  business: 50,
};

function getUserConcurrency(userId: string): number {
  return userActiveRequests.get(userId) || 0;
}

function incrementUserConcurrency(userId: string): void {
  userActiveRequests.set(userId, getUserConcurrency(userId) + 1);
}

function decrementUserConcurrency(userId: string): void {
  const current = getUserConcurrency(userId);
  if (current <= 1) {
    userActiveRequests.delete(userId);
  } else {
    userActiveRequests.set(userId, current - 1);
  }
}

// --- Request Validation Schemas ------------------------------------------------

const ScrapeRequestSchema = z.object({
  url: z.string().url({ message: 'Invalid URL format' }),
  extract: z.string().optional(),
  strategy: z.enum(['auto', 'cache', 'http', 'browser', 'stealth-browser']).optional().default('auto'),
  cacheTtl: z.number().int().min(0).max(86400).optional(),
  proxyTier: z.enum(['residential', 'mobile', 'datacenter', 'isp']).optional(),
  proxyCountry: z.string().min(2).max(2).optional(),
  proxyCity: z.string().optional(),
  proxyAsn: z.string().optional(),
  sessionId: z.string().optional(),
  waitForSelector: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeout: z.number().int().min(1000).max(120000).optional().default(30000),
  respectRobotsTxt: z.boolean().optional().default(true),
  structured: z.boolean().optional().default(false),
  renderJs: z.boolean().optional().default(false),
  solveCaptcha: z.boolean().optional().default(false),
  templateId: z.string().optional(),
  outputFormat: z.enum(['raw', 'markdown', 'cleaned', 'text', 'parsed']).optional(),
});

const ScreenshotRequestSchema = z.object({
  url: z.string().url({ message: 'Invalid URL format' }),
  fullPage: z.boolean().optional().default(false),
  proxyTier: z.enum(['residential', 'mobile', 'datacenter', 'isp']).optional(),
  proxyCountry: z.string().min(2).max(2).optional(),
  waitForSelector: z.string().optional(),
  timeout: z.number().int().min(5000).max(60000).optional().default(30000),
});

// --- Route Registration --------------------------------------------------------

export async function scrapeRoutes(app: FastifyInstance) {
  // -- POST /v1/scrape -- Submit a scrape job ----------------------------------

  app.post('/v1/scrape', {
    preHandler: [authMiddleware, checkCredits],
  }, async (request, reply) => {
    const body = ScrapeRequestSchema.safeParse(request.body);
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
    const domain = extractDomain(data.url);
    const jobId = randomUUID();

    // -- Per-User Concurrency Check ------------------------------------------
    const plan = (apiKey.plan as string) || 'starter';
    const concurrencyLimit = PLAN_CONCURRENCY_LIMITS[plan] || 5;
    const activeRequests = getUserConcurrency(apiKey.userId);

    if (activeRequests >= concurrencyLimit) {
      return reply.status(429).send({
        success: false,
        error: `Concurrent request limit reached (${concurrencyLimit} for ${plan} plan). Please wait for pending jobs to complete.`,
        activeRequests,
        concurrencyLimit,
      });
    }

    // Estimate credits for the requested strategy + extraction
    const effectiveStrategy = data.strategy === 'auto' ? 'http' : data.strategy;
    const estimatedCredits = calculateScrapeCredits(
      effectiveStrategy as 'cache' | 'http' | 'browser' | 'stealth-browser',
      !!data.extract,
    );

    // Add structured parsing + CAPTCHA costs
    const totalEstimated = estimatedCredits
      + (data.structured ? 2 : 0)
      + (data.solveCaptcha ? 3 : 0);

    if (apiKey.creditsRemaining < totalEstimated) {
      return reply.status(402).send({
        success: false,
        error: `Insufficient credits. Need at least ${totalEstimated}, have ${apiKey.creditsRemaining}`,
        creditsRequired: totalEstimated,
        creditsRemaining: apiKey.creditsRemaining,
      });
    }

    // Track concurrent requests
    incrementUserConcurrency(apiKey.userId);

    try {
      await db.scrapeJob.create({
        data: {
          id: jobId,
          apiKeyId: apiKey.id,
          userId: apiKey.userId,
          url: data.url,
          domain,
          status: 'queued',
          strategy: data.strategy,
          proxyTier: data.proxyTier,
          proxyCountry: data.proxyCountry,
          creditsUsed: 0,
        },
      });

      await addScrapeJob(
        {
          jobId,
          url: data.url,
          domain,
          userId: apiKey.userId,
          apiKeyId: apiKey.id,
          extract: data.extract,
          strategy: data.strategy,
          proxyTier: data.proxyTier,
          proxyCountry: data.proxyCountry,
          proxyCity: data.proxyCity,
          proxyAsn: data.proxyAsn,
          sessionId: data.sessionId,
          waitForSelector: data.waitForSelector,
          headers: data.headers,
          timeout: data.timeout,
          cacheTtl: data.cacheTtl,
          respectRobotsTxt: data.respectRobotsTxt,
          structured: data.structured,
          renderJs: data.renderJs,
          solveCaptcha: data.solveCaptcha,
          templateId: data.templateId,
          outputFormat: data.outputFormat,
          priority: getJobPriority(apiKey.plan as PlanTier),
        },
        apiKey.plan as PlanTier,
      );

      logger.info({ jobId, url: data.url, domain, strategy: data.strategy, proxyTier: data.proxyTier, proxyCountry: data.proxyCountry }, 'Scrape job submitted');

      return reply.status(202).send({
        success: true,
        data: {
          id: jobId,
          status: 'queued',
          url: data.url,
          domain,
          strategy: data.strategy,
          creditsEstimated: totalEstimated,
          proxyTier: data.proxyTier,
          proxyCountry: data.proxyCountry,
          note: 'Only successful requests are charged. Failed requests are free.',
        },
      });
    } catch (error: any) {
      decrementUserConcurrency(apiKey.userId);
      logger.error({ error: error.message, jobId, url: data.url }, 'Failed to submit scrape job');

      try { await db.scrapeJob.delete({ where: { id: jobId } }); } catch {}

      return reply.status(500).send({
        success: false,
        error: 'Failed to submit scrape job. Please try again.',
      });
    }
  });

  // -- GET /v1/jobs/:id -- Check job status -------------------------------------

  app.get('/v1/jobs/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    const job = await db.scrapeJob.findFirst({
      where: { id, userId: apiKey.userId },
    });

    if (!job) {
      return reply.status(404).send({ success: false, error: 'Job not found' });
    }

    let queueProgress: number | undefined;
    if (job.status === 'queued' || job.status === 'running') {
      const queueState = await getJobStatus(id);
      if (queueState) {
        queueProgress = queueState.progress;
      }
    }

    return reply.send({
      success: true,
      data: {
        id: job.id,
        url: job.url,
        domain: job.domain,
        status: job.status,
        strategy: job.strategy,
        creditsUsed: job.creditsUsed,
        creditsCharged: job.creditsCharged,
        statusCode: job.statusCode,
        responseMs: job.responseMs,
        extractedData: job.extractedData,
        structuredData: job.structuredData,
        error: job.error,
        captchaSolved: job.captchaSolved,
        retryCount: job.retryCount,
        proxyId: job.proxyId,
        proxyCountry: job.proxyCountry,
        bandwidthBytes: job.bandwidthBytes,
        progress: queueProgress,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
      },
    });
  });

  // -- GET /v1/results/:id -- Get completed results -----------------------------

  app.get('/v1/results/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    const job = await db.scrapeJob.findFirst({
      where: { id, userId: apiKey.userId, status: 'done' },
    });

    if (!job) {
      const existingJob = await db.scrapeJob.findFirst({
        where: { id, userId: apiKey.userId },
      });

      if (!existingJob) {
        return reply.status(404).send({ success: false, error: 'Result not found' });
      }

      return reply.status(202).send({
        success: false,
        error: `Job is still ${existingJob.status}. Results are only available for completed jobs.`,
        data: { id: existingJob.id, status: existingJob.status },
      });
    }

    return reply.send({
      success: true,
      data: {
        id: job.id,
        url: job.url,
        domain: job.domain,
        status: job.status,
        strategy: job.strategy,
        creditsUsed: job.creditsUsed,
        creditsCharged: job.creditsCharged,
        statusCode: job.statusCode,
        responseMs: job.responseMs,
        result: job.result,
        extractedData: job.extractedData,
        structuredData: job.structuredData,
        captchaSolved: job.captchaSolved,
        proxyId: job.proxyId,
        proxyCountry: job.proxyCountry,
        bandwidthBytes: job.bandwidthBytes,
        cached: job.strategy === 'cache',
        completedAt: job.completedAt,
      },
      creditsUsed: job.creditsCharged,
      creditsRemaining: apiKey.creditsRemaining - job.creditsCharged,
    });
  });

  // -- GET /v1/jobs -- List recent jobs -----------------------------------------

  app.get('/v1/jobs', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const query = request.query as {
      status?: string;
      limit?: string;
      offset?: string;
    };

    const limit = Math.min(parseInt(query.limit || '50', 10), 100);
    const offset = parseInt(query.offset || '0', 10);

    const where: any = { userId: apiKey.userId };
    if (query.status) where.status = query.status;

    const [jobs, total] = await Promise.all([
      db.scrapeJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true, url: true, domain: true, status: true,
          strategy: true, creditsUsed: true, creditsCharged: true,
          statusCode: true, responseMs: true, captchaSolved: true,
          proxyId: true, proxyCountry: true, bandwidthBytes: true,
          createdAt: true, completedAt: true,
        },
      }),
      db.scrapeJob.count({ where }),
    ]);

    return reply.send({
      success: true,
      data: jobs,
      total,
      limit,
      offset,
    });
  });

  // -- POST /v1/screenshot -- Take a screenshot of a URL ------------------------

  app.post('/v1/screenshot', {
    preHandler: [authMiddleware, checkCredits],
  }, async (request, reply) => {
    const body = ScreenshotRequestSchema.safeParse(request.body);
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
    const domain = extractDomain(data.url);
    const cost = 6; // Screenshot cost

    if (apiKey.creditsRemaining < cost) {
      return reply.status(402).send({
        success: false,
        error: `Insufficient credits. Need ${cost}, have ${apiKey.creditsRemaining}`,
      });
    }

    try {
      // Get proxy
      const proxySelection = await proxyManager.getProxy(
        domain,
        (data.proxyTier as any) || 'residential',
        data.proxyCountry,
      );

      const result = await orchestrator.takeScreenshot(data.url, domain, {
        proxyUrl: proxySelection?.proxyUrl,
        stealth: true,
        fullPage: data.fullPage,
        waitForSelector: data.waitForSelector,
        timeout: data.timeout,
      });

      if (result.statusCode >= 200 && result.statusCode < 400) {
        // Deduct credits on success only
        const { deductCredits } = await import('../middleware/credits');
        await deductCredits(apiKey.userId, apiKey.id, cost);
      }

      // Return screenshot as base64
      const base64 = result.screenshot.toString('base64');

      return reply.send({
        success: true,
        data: {
          url: data.url,
          statusCode: result.statusCode,
          responseMs: result.responseMs,
          screenshot: base64,
          format: 'png',
          fullPage: data.fullPage,
          creditsUsed: result.statusCode >= 200 && result.statusCode < 400 ? cost : 0,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message, url: data.url }, 'Screenshot failed');
      return reply.status(500).send({
        success: false,
        error: `Screenshot failed: ${error.message}`,
      });
    }
  });
}

// Helper import
import { getJobStatus } from '../../workers/queue';
