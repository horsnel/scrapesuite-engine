import { FastifyInstance } from 'fastify';
import { db } from '../../utils/db';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { createChildLogger } from '../../utils/logger';
import { webhookDispatcher } from '../../scheduler/webhooks';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import crypto from 'crypto';

const logger = createChildLogger('api:webhooks');

// --- Request Validation Schemas ------------------------------------------------

const CreateWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum([
    'job_completed', 'job_failed', 'monitor_change', 'alert_triggered', 'credits_low',
  ])).min(1),
  secret: z.string().optional(),
  batch: z.object({
    enabled: z.boolean().default(false),
    batchSize: z.number().int().min(1).max(100).default(10),
    intervalSeconds: z.number().int().min(5).max(3600).default(60),
  }).optional(),
});

const UpdateWebhookSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.enum([
    'job_completed', 'job_failed', 'monitor_change', 'alert_triggered', 'credits_low',
  ])).min(1).optional(),
  active: z.boolean().optional(),
  secret: z.string().optional(),
  batch: z.object({
    enabled: z.boolean().default(false),
    batchSize: z.number().int().min(1).max(100).default(10),
    intervalSeconds: z.number().int().min(5).max(3600).default(60),
  }).optional(),
});

// --- Route Registration --------------------------------------------------------

export async function webhookRoutes(app: FastifyInstance) {
  // -- POST /v1/webhooks -- Create a webhook ------------------------------------

  app.post('/v1/webhooks', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = CreateWebhookSchema.safeParse(request.body);
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

    // Check webhook limit (5 per user on starter, 20 on pro, unlimited on business)
    const existingCount = await db.webhook.count({ where: { userId: apiKey.userId } });
    const limits: Record<string, number> = { starter: 5, pro: 20, business: 100 };
    const limit = limits[apiKey.plan] || 5;

    if (existingCount >= limit) {
      return reply.status(403).send({
        success: false,
        error: `Webhook limit reached. Your ${apiKey.plan} plan allows up to ${limit} webhooks.`,
      });
    }

    const webhook = await db.webhook.create({
      data: {
        id: randomUUID(),
        userId: apiKey.userId,
        url: data.url,
        events: data.events as any,
        secret: data.secret || crypto.randomBytes(32).toString('hex'),
        active: true,
      },
    });

    // Configure batching if provided
    if (data.batch) {
      await webhookDispatcher.setBatchConfig(webhook.id, {
        enabled: data.batch.enabled,
        batchSize: data.batch.batchSize,
        intervalMs: data.batch.intervalSeconds * 1000,
      });
    }

    return reply.status(201).send({
      success: true,
      data: {
        id: webhook.id,
        url: webhook.url,
        events: webhook.events,
        secret: webhook.secret,
        active: webhook.active,
        batch: data.batch || { enabled: false, batchSize: 10, intervalSeconds: 60 },
        createdAt: webhook.createdAt,
      },
    });
  });

  // -- GET /v1/webhooks -- List webhooks ----------------------------------------

  app.get('/v1/webhooks', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;

    const webhooks = await db.webhook.findMany({
      where: { userId: apiKey.userId },
      orderBy: { createdAt: 'desc' },
    });

    // Enrich with health data
    const enriched = await Promise.all(
      webhooks.map(async (w) => {
        try {
          const health = await webhookDispatcher.getWebhookHealth(w.id);
          return {
            id: w.id,
            url: w.url,
            events: w.events,
            active: w.active,
            lastSent: w.lastSent,
            failCount: w.failCount,
            health: {
              successRate: health.successRate,
              avgLatencyMs: health.avgLatencyMs,
              consecutiveFailures: health.consecutiveFailures,
            },
            createdAt: w.createdAt,
          };
        } catch {
          return {
            id: w.id,
            url: w.url,
            events: w.events,
            active: w.active,
            lastSent: w.lastSent,
            failCount: w.failCount,
            createdAt: w.createdAt,
          };
        }
      }),
    );

    return reply.send({
      success: true,
      data: enriched,
    });
  });

  // -- GET /v1/webhooks/:id -- Get webhook details ------------------------------

  app.get('/v1/webhooks/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    const webhook = await db.webhook.findFirst({
      where: { id, userId: apiKey.userId },
      include: {
        logs: {
          orderBy: { sentAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!webhook) {
      return reply.status(404).send({ success: false, error: 'Webhook not found' });
    }

    // Get health metrics
    let health: import('../../scheduler/webhooks').WebhookHealth | null = null;
    try {
      health = await webhookDispatcher.getWebhookHealth(webhook.id);
    } catch {
      // Health may not be available yet
    }

    return reply.send({
      success: true,
      data: {
        id: webhook.id,
        url: webhook.url,
        events: webhook.events,
        active: webhook.active,
        lastSent: webhook.lastSent,
        failCount: webhook.failCount,
        recentLogs: webhook.logs,
        health,
        createdAt: webhook.createdAt,
      },
    });
  });

  // -- PATCH /v1/webhooks/:id -- Update a webhook -------------------------------

  app.patch('/v1/webhooks/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    const body = UpdateWebhookSchema.safeParse(request.body);
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
    const existing = await db.webhook.findFirst({ where: { id, userId: apiKey.userId } });
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Webhook not found' });
    }

    const updateData: any = {};
    if (data.url !== undefined) updateData.url = data.url;
    if (data.events !== undefined) updateData.events = data.events as any;
    if (data.active !== undefined) updateData.active = data.active;
    if (data.secret !== undefined) updateData.secret = data.secret;

    const updated = await db.webhook.update({ where: { id }, data: updateData });

    // Update batch config if provided
    if (data.batch) {
      await webhookDispatcher.setBatchConfig(id, {
        enabled: data.batch.enabled,
        batchSize: data.batch.batchSize,
        intervalMs: data.batch.intervalSeconds * 1000,
      });
    }

    return reply.send({
      success: true,
      data: {
        id: updated.id,
        url: updated.url,
        events: updated.events,
        active: updated.active,
        createdAt: updated.createdAt,
      },
    });
  });

  // -- DELETE /v1/webhooks/:id -- Delete a webhook ------------------------------

  app.delete('/v1/webhooks/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    const webhook = await db.webhook.findFirst({ where: { id, userId: apiKey.userId } });
    if (!webhook) {
      return reply.status(404).send({ success: false, error: 'Webhook not found' });
    }

    await db.webhook.delete({ where: { id } });

    return reply.send({ success: true });
  });

  // -- POST /v1/webhooks/:id/test -- Test a webhook -----------------------------

  app.post('/v1/webhooks/:id/test', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    const webhook = await db.webhook.findFirst({ where: { id, userId: apiKey.userId } });
    if (!webhook) {
      return reply.status(404).send({ success: false, error: 'Webhook not found' });
    }

    try {
      const result = await webhookDispatcher.testWebhook(webhook.id);

      return reply.send({
        success: true,
        data: result,
      });
    } catch (error: any) {
      return reply.status(502).send({
        success: false,
        error: `Webhook test failed: ${error.message}`,
      });
    }
  });

  // -- GET /v1/webhooks/:id/health -- Get webhook health metrics ----------------

  app.get('/v1/webhooks/:id/health', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    const webhook = await db.webhook.findFirst({ where: { id, userId: apiKey.userId } });
    if (!webhook) {
      return reply.status(404).send({ success: false, error: 'Webhook not found' });
    }

    try {
      const health = await webhookDispatcher.getWebhookHealth(webhook.id);
      return reply.send({ success: true, data: health });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: `Failed to get webhook health: ${error.message}`,
      });
    }
  });
}
