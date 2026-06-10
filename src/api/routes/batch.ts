import { FastifyInstance } from 'fastify';
import { db } from '../../utils/db';
import { addScrapeJob } from '../../workers/queue';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { checkCredits } from '../middleware/credits';
import { extractDomain, calculateScrapeCredits, getJobPriority } from '../../utils/credits';
import { createChildLogger } from '../../utils/logger';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { PlanTier } from '../../types';

const logger = createChildLogger('api:batch');

// --- Request Validation Schema ------------------------------------------------

const BatchScrapeSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(100),
  extract: z.string().optional(),
  strategy: z.enum(['auto', 'cache', 'http', 'browser', 'stealth-browser']).optional().default('auto'),
  cacheTtl: z.number().int().min(0).max(86400).optional(),
  proxyTier: z.enum(['residential', 'mobile', 'datacenter', 'isp']).optional(),
  proxyCountry: z.string().min(2).max(2).optional(),
  waitForSelector: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeout: z.number().int().min(1000).max(120000).optional().default(30000),
  respectRobotsTxt: z.boolean().optional().default(true),
  structured: z.boolean().optional().default(false),
  concurrency: z.number().int().min(1).max(10).optional().default(3),
  templateId: z.string().optional(),
  outputFormat: z.enum(['raw', 'markdown', 'cleaned', 'text', 'parsed']).optional(),
});

// --- Route Registration --------------------------------------------------------

export async function batchRoutes(app: FastifyInstance) {
  // -- POST /v1/scrape/batch -- Submit multiple URLs to scrape ------------------

  app.post('/v1/scrape/batch', {
    preHandler: [authMiddleware, checkCredits],
  }, async (request, reply) => {
    const body = BatchScrapeSchema.safeParse(request.body);
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
    const batchId = randomUUID();

    // Estimate credits for all URLs
    const effectiveStrategy = data.strategy === 'auto' ? 'http' : data.strategy;
    const creditsPerUrl = calculateScrapeCredits(
      effectiveStrategy as 'cache' | 'http' | 'browser',
      !!data.extract,
    );
    const totalEstimatedCredits = creditsPerUrl * data.urls.length;

    // Check if enough credits
    if (apiKey.creditsRemaining < totalEstimatedCredits) {
      return reply.status(402).send({
        success: false,
        error: `Insufficient credits for batch. Need at least ${totalEstimatedCredits} (${data.urls.length} URLs × ${creditsPerUrl}), have ${apiKey.creditsRemaining}`,
        creditsRequired: totalEstimatedCredits,
        creditsRemaining: apiKey.creditsRemaining,
      });
    }

    try {
      // Create batch record
      await db.batch.create({
        data: {
          id: batchId,
          userId: apiKey.userId,
          apiKeyId: apiKey.id,
          totalJobs: data.urls.length,
        },
      });

      // Create individual scrape jobs
      const jobIds: string[] = [];
      const errors: { url: string; error: string }[] = [];

      for (const url of data.urls) {
        const jobId = randomUUID();
        const domain = extractDomain(url);

        try {
          await db.scrapeJob.create({
            data: {
              id: jobId,
              apiKeyId: apiKey.id,
              userId: apiKey.userId,
              url,
              domain,
              status: 'queued',
              strategy: data.strategy,
              proxyTier: data.proxyTier,
              creditsUsed: 0,
              batchId,
            },
          });

          await addScrapeJob(
            {
              jobId,
              url,
              domain,
              userId: apiKey.userId,
              apiKeyId: apiKey.id,
              extract: data.extract,
              strategy: data.strategy,
              proxyTier: data.proxyTier,
              proxyCountry: data.proxyCountry,
              waitForSelector: data.waitForSelector,
              headers: data.headers,
              timeout: data.timeout,
              cacheTtl: data.cacheTtl,
              respectRobotsTxt: data.respectRobotsTxt,
              structured: data.structured,
              templateId: data.templateId,
              outputFormat: data.outputFormat,
              batchId,
              priority: getJobPriority(apiKey.plan as PlanTier),
            },
            apiKey.plan as PlanTier,
          );

          jobIds.push(jobId);
        } catch (err: any) {
          errors.push({ url, error: err.message });
        }
      }

      logger.info({ batchId, totalJobs: data.urls.length, enqueued: jobIds.length }, 'Batch scrape submitted');

      return reply.status(202).send({
        success: true,
        data: {
          id: batchId,
          totalJobs: data.urls.length,
          enqueued: jobIds.length,
          failed: errors.length,
          jobs: jobIds.map((id) => ({ id, status: 'queued' })),
          creditsEstimated: totalEstimatedCredits,
        },
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (error: any) {
      logger.error({ error: error.message, batchId }, 'Failed to submit batch scrape');
      return reply.status(500).send({
        success: false,
        error: 'Failed to submit batch scrape. Please try again.',
      });
    }
  });

  // -- GET /v1/batch/:id -- Get batch status ------------------------------------

  app.get('/v1/batch/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    const batch = await db.batch.findFirst({
      where: { id, userId: apiKey.userId },
    });

    if (!batch) {
      return reply.status(404).send({ success: false, error: 'Batch not found' });
    }

    const jobs = await db.scrapeJob.findMany({
      where: { batchId: id },
      select: {
        id: true, url: true, status: true, strategy: true,
        creditsUsed: true, statusCode: true, responseMs: true,
        error: true, completedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return reply.send({
      success: true,
      data: {
        id: batch.id,
        totalJobs: batch.totalJobs,
        completedJobs: batch.completedJobs,
        failedJobs: batch.failedJobs,
        status: batch.status,
        creditsUsed: batch.creditsUsed,
        jobs,
        createdAt: batch.createdAt,
        completedAt: batch.completedAt,
      },
    });
  });
}
