/**
 * Recurring Job Scheduler API Routes -- Create, manage, and monitor
 * cron-based recurring scrape jobs with pause/resume/trigger support.
 *
 * Endpoints
 * ---------
 *   POST   /v1/recurring                    -- Create recurring job (auth required)
 *   GET    /v1/recurring                    -- List user's recurring jobs
 *   GET    /v1/recurring/:id                -- Get job details
 *   PUT    /v1/recurring/:id                -- Update job (auth required)
 *   DELETE /v1/recurring/:id                -- Delete job (auth required)
 *   POST   /v1/recurring/:id/pause          -- Pause job
 *   POST   /v1/recurring/:id/resume         -- Resume job
 *   POST   /v1/recurring/:id/trigger        -- Manually trigger
 *   GET    /v1/recurring/:id/history        -- Get execution history
 *   GET    /v1/recurring/stats/health        -- System health check
 */

import { FastifyInstance } from 'fastify';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import {
  recurringJobScheduler,
  recurringJobRunner,
  getRecurringSystemHealth,
} from '../../scheduler/recurring';
import { createChildLogger } from '../../utils/logger';
import { z } from 'zod';

const logger = createChildLogger('api:recurring');

// --- Request Validation Schemas ------------------------------------------------

const CreateRecurringJobSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.string().url({ message: 'Invalid URL format' }),
  domain: z.string().min(1),
  cronSchedule: z.string().min(1),
  timezone: z.string().optional().default('UTC'),
  strategy: z.enum(['auto', 'cache', 'http', 'browser', 'stealth-browser']).optional(),
  proxyTier: z.enum(['residential', 'mobile', 'datacenter', 'isp']).optional(),
  proxyCountry: z.string().min(2).max(2).optional(),
  templateId: z.string().optional(),
  outputFormat: z.enum(['raw', 'markdown', 'cleaned', 'text', 'parsed']).optional(),
  webhookUrl: z.string().url().optional(),
  maxRetries: z.number().int().min(0).max(10).optional().default(3),
});

const UpdateRecurringJobSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  url: z.string().url().optional(),
  domain: z.string().min(1).optional(),
  cronSchedule: z.string().min(1).optional(),
  timezone: z.string().optional(),
  strategy: z.enum(['auto', 'cache', 'http', 'browser', 'stealth-browser']).nullable().optional(),
  proxyTier: z.enum(['residential', 'mobile', 'datacenter', 'isp']).nullable().optional(),
  proxyCountry: z.string().min(2).max(2).nullable().optional(),
  templateId: z.string().nullable().optional(),
  outputFormat: z.enum(['raw', 'markdown', 'cleaned', 'text', 'parsed']).nullable().optional(),
  webhookUrl: z.string().url().nullable().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  active: z.boolean().optional(),
});

// --- Route Registration --------------------------------------------------------

export async function recurringRoutes(app: FastifyInstance) {
  // -- POST /v1/recurring -- Create recurring job (auth required) ---------------

  app.post('/v1/recurring', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = CreateRecurringJobSchema.safeParse(request.body);
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
      const job = await recurringJobScheduler.createJob({
        userId: apiKey.userId,
        apiKeyId: apiKey.id,
        name: body.data.name,
        url: body.data.url,
        domain: body.data.domain,
        cronSchedule: body.data.cronSchedule,
        timezone: body.data.timezone,
        strategy: body.data.strategy,
        proxyTier: body.data.proxyTier,
        proxyCountry: body.data.proxyCountry,
        templateId: body.data.templateId,
        outputFormat: body.data.outputFormat,
        webhookUrl: body.data.webhookUrl,
        maxRetries: body.data.maxRetries,
      });

      return reply.status(201).send({
        success: true,
        data: job,
      });
    } catch (error: any) {
      logger.error({ error: error.message, userId: apiKey.userId }, 'Failed to create recurring job');

      if (error.message.includes('Invalid cron')) {
        return reply.status(400).send({
          success: false,
          error: error.message,
        });
      }

      if (error.message.includes('Invalid timezone')) {
        return reply.status(400).send({
          success: false,
          error: error.message,
        });
      }

      return reply.status(500).send({
        success: false,
        error: 'Failed to create recurring job. Please try again.',
      });
    }
  });

  // -- GET /v1/recurring -- List user's recurring jobs ---------------------------

  app.get('/v1/recurring', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const query = request.query as {
      page?: string;
      limit?: string;
      active?: string;
      domain?: string;
    };

    try {
      const result = await recurringJobScheduler.listJobs(apiKey.userId, {
        page: parseInt(query.page || '1', 10),
        pageSize: Math.min(parseInt(query.limit || '25', 10), 100),
        active: query.active !== undefined ? query.active === 'true' : undefined,
        domain: query.domain,
      });

      return reply.send({
        success: true,
        data: result.jobs,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages,
      });
    } catch (error: any) {
      logger.error({ error: error.message, userId: apiKey.userId }, 'Failed to list recurring jobs');
      return reply.status(500).send({
        success: false,
        error: 'Failed to list recurring jobs.',
      });
    }
  });

  // -- GET /v1/recurring/:id -- Get job details ---------------------------------

  app.get('/v1/recurring/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    try {
      const job = await recurringJobScheduler.getJob(id);

      if (!job) {
        return reply.status(404).send({
          success: false,
          error: 'Recurring job not found.',
        });
      }

      // Verify ownership
      if (job.userId !== apiKey.userId) {
        return reply.status(403).send({
          success: false,
          error: 'You do not have access to this recurring job.',
        });
      }

      return reply.send({
        success: true,
        data: job,
      });
    } catch (error: any) {
      logger.error({ error: error.message, jobId: id }, 'Failed to get recurring job');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get recurring job details.',
      });
    }
  });

  // -- PUT /v1/recurring/:id -- Update job (auth required) ----------------------

  app.put('/v1/recurring/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;
    const body = UpdateRecurringJobSchema.safeParse(request.body);
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

    try {
      // Verify ownership first
      const existing = await recurringJobScheduler.getJob(id);
      if (!existing) {
        return reply.status(404).send({
          success: false,
          error: 'Recurring job not found.',
        });
      }
      if (existing.userId !== apiKey.userId) {
        return reply.status(403).send({
          success: false,
          error: 'You do not have access to this recurring job.',
        });
      }

      const updated = await recurringJobScheduler.updateJob(id, body.data);

      return reply.send({
        success: true,
        data: updated,
      });
    } catch (error: any) {
      logger.error({ error: error.message, jobId: id }, 'Failed to update recurring job');

      if (error.message.includes('not found') || error.message.includes('Invalid cron') || error.message.includes('Invalid timezone')) {
        return reply.status(400).send({
          success: false,
          error: error.message,
        });
      }

      return reply.status(500).send({
        success: false,
        error: 'Failed to update recurring job.',
      });
    }
  });

  // -- DELETE /v1/recurring/:id -- Delete job (auth required) -------------------

  app.delete('/v1/recurring/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    try {
      // Verify ownership first
      const existing = await recurringJobScheduler.getJob(id);
      if (!existing) {
        return reply.status(404).send({
          success: false,
          error: 'Recurring job not found.',
        });
      }
      if (existing.userId !== apiKey.userId) {
        return reply.status(403).send({
          success: false,
          error: 'You do not have access to this recurring job.',
        });
      }

      await recurringJobScheduler.deleteJob(id);

      return reply.send({
        success: true,
        data: { id, deleted: true },
      });
    } catch (error: any) {
      logger.error({ error: error.message, jobId: id }, 'Failed to delete recurring job');
      return reply.status(500).send({
        success: false,
        error: 'Failed to delete recurring job.',
      });
    }
  });

  // -- POST /v1/recurring/:id/pause -- Pause job --------------------------------

  app.post('/v1/recurring/:id/pause', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    try {
      const existing = await recurringJobScheduler.getJob(id);
      if (!existing) {
        return reply.status(404).send({ success: false, error: 'Recurring job not found.' });
      }
      if (existing.userId !== apiKey.userId) {
        return reply.status(403).send({ success: false, error: 'Access denied.' });
      }

      const updated = await recurringJobScheduler.pauseJob(id);

      return reply.send({
        success: true,
        data: { id, paused: true, active: updated.active },
      });
    } catch (error: any) {
      if (error.message.includes('already inactive')) {
        return reply.status(400).send({ success: false, error: error.message });
      }
      logger.error({ error: error.message, jobId: id }, 'Failed to pause recurring job');
      return reply.status(500).send({ success: false, error: 'Failed to pause recurring job.' });
    }
  });

  // -- POST /v1/recurring/:id/resume -- Resume job ------------------------------

  app.post('/v1/recurring/:id/resume', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    try {
      const existing = await recurringJobScheduler.getJob(id);
      if (!existing) {
        return reply.status(404).send({ success: false, error: 'Recurring job not found.' });
      }
      if (existing.userId !== apiKey.userId) {
        return reply.status(403).send({ success: false, error: 'Access denied.' });
      }

      const updated = await recurringJobScheduler.resumeJob(id);

      return reply.send({
        success: true,
        data: { id, resumed: true, active: updated.active, nextRunAt: updated.nextRunAt },
      });
    } catch (error: any) {
      if (error.message.includes('already active')) {
        return reply.status(400).send({ success: false, error: error.message });
      }
      logger.error({ error: error.message, jobId: id }, 'Failed to resume recurring job');
      return reply.status(500).send({ success: false, error: 'Failed to resume recurring job.' });
    }
  });

  // -- POST /v1/recurring/:id/trigger -- Manually trigger ----------------------

  app.post('/v1/recurring/:id/trigger', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    try {
      const existing = await recurringJobScheduler.getJob(id);
      if (!existing) {
        return reply.status(404).send({ success: false, error: 'Recurring job not found.' });
      }
      if (existing.userId !== apiKey.userId) {
        return reply.status(403).send({ success: false, error: 'Access denied.' });
      }

      const bullJobId = await recurringJobScheduler.triggerJob(id);

      return reply.send({
        success: true,
        data: { id, triggered: true, bullJobId },
      });
    } catch (error: any) {
      if (error.message.includes('inactive') || error.message.includes('already being triggered')) {
        return reply.status(400).send({ success: false, error: error.message });
      }
      logger.error({ error: error.message, jobId: id }, 'Failed to trigger recurring job');
      return reply.status(500).send({ success: false, error: 'Failed to trigger recurring job.' });
    }
  });

  // -- GET /v1/recurring/:id/history -- Get execution history -------------------

  app.get('/v1/recurring/:id/history', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;
    const query = request.query as { page?: string; pageSize?: string };

    try {
      const existing = await recurringJobScheduler.getJob(id);
      if (!existing) {
        return reply.status(404).send({ success: false, error: 'Recurring job not found.' });
      }
      if (existing.userId !== apiKey.userId) {
        return reply.status(403).send({ success: false, error: 'Access denied.' });
      }

      const result = await recurringJobScheduler.getJobHistory(
        id,
        parseInt(query.page || '1', 10),
        parseInt(query.pageSize || '25', 10),
      );

      return reply.send({
        success: true,
        data: result.entries,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      });
    } catch (error: any) {
      logger.error({ error: error.message, jobId: id }, 'Failed to get job history');
      return reply.status(500).send({ success: false, error: 'Failed to get execution history.' });
    }
  });

  // -- GET /v1/recurring/stats/health -- System health check --------------------

  app.get('/v1/recurring/stats/health', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      const health = await getRecurringSystemHealth();

      return reply.send({
        success: true,
        data: health,
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to get recurring system health');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get system health.',
      });
    }
  });
}
