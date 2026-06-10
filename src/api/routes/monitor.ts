import { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { db } from '../../utils/db';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { createChildLogger } from '../../utils/logger';
import { z } from 'zod';
import { randomUUID } from 'crypto';

const logger = createChildLogger('api:monitor');

// --- Request Validation Schemas ------------------------------------------------

const CreateMonitorSchema = z.object({
  url: z.string().url({ message: 'Invalid URL format' }),
  fields: z.array(z.string()).min(1, { message: 'At least one field is required' }),
  schedule: z.string().min(1, { message: 'Cron schedule is required' }),
  alertThresholds: z.array(
    z.object({
      field: z.string(),
      operator: z.enum(['gt', 'lt', 'eq', 'neq', 'change']),
      value: z.union([z.string(), z.number()]).optional(),
    }),
  ).optional(),
  webhookUrl: z.string().url().optional(),
});

const UpdateMonitorSchema = z.object({
  active: z.boolean().optional(),
  schedule: z.string().optional(),
  fields: z.array(z.string()).min(1).optional(),
  alertThresholds: z.array(
    z.object({
      field: z.string(),
      operator: z.enum(['gt', 'lt', 'eq', 'neq', 'change']),
      value: z.union([z.string(), z.number()]).optional(),
    }),
  ).optional().nullable(),
  webhookUrl: z.string().url().optional().nullable(),
});

// --- Route Registration --------------------------------------------------------

export async function monitorRoutes(app: FastifyInstance) {
  // -- POST /v1/monitor -- Create a new monitor -----------------------------------

  app.post('/v1/monitor', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = CreateMonitorSchema.safeParse(request.body);
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
    const monitorId = randomUUID();

    // Check monitor limit based on plan
    const existingMonitorCount = await db.monitor.count({
      where: { userId: apiKey.userId, active: true },
    });

    const PLAN_MONITOR_LIMITS: Record<string, number> = {
      starter: 5,
      pro: 50,
      business: 500,
    };

    const limit = PLAN_MONITOR_LIMITS[apiKey.plan] ?? 5;
    if (existingMonitorCount >= limit) {
      return reply.status(403).send({
        success: false,
        error: `Monitor limit reached. Your ${apiKey.plan} plan allows up to ${limit} active monitors. Please upgrade or deactivate existing monitors.`,
        limit,
        current: existingMonitorCount,
      });
    }

    try {
      const monitor = await db.monitor.create({
        data: {
          id: monitorId,
          apiKeyId: apiKey.id,
          userId: apiKey.userId,
          url: data.url,
          fields: data.fields,
          schedule: data.schedule,
          alertThresholds: data.alertThresholds ?? Prisma.JsonNull,
          webhookUrl: data.webhookUrl ?? null,
          active: true,
        },
      });

      logger.info(
        { monitorId, url: data.url, userId: apiKey.userId },
        'Monitor created',
      );

      return reply.status(201).send({
        success: true,
        data: {
          id: monitor.id,
          url: monitor.url,
          fields: monitor.fields,
          schedule: monitor.schedule,
          alertThresholds: monitor.alertThresholds,
          webhookUrl: monitor.webhookUrl,
          active: monitor.active,
          createdAt: monitor.createdAt,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message, url: data.url }, 'Failed to create monitor');
      return reply.status(500).send({
        success: false,
        error: 'Failed to create monitor. Please try again.',
      });
    }
  });

  // -- GET /v1/monitors -- List all monitors --------------------------------------

  app.get('/v1/monitors', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const query = request.query as {
      active?: string;
      limit?: string;
      offset?: string;
    };

    const limit = Math.min(parseInt(query.limit || '100', 10), 500);
    const offset = parseInt(query.offset || '0', 10);

    const where: any = { userId: apiKey.userId };
    if (query.active !== undefined) {
      where.active = query.active === 'true';
    }

    const [monitors, total] = await Promise.all([
      db.monitor.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.monitor.count({ where }),
    ]);

    return reply.send({
      success: true,
      data: monitors.map((m) => ({
        id: m.id,
        url: m.url,
        fields: m.fields,
        schedule: m.schedule,
        alertThresholds: m.alertThresholds,
        webhookUrl: m.webhookUrl,
        active: m.active,
        lastRun: m.lastRun,
        createdAt: m.createdAt,
      })),
      total,
      limit,
      offset,
    });
  });

  // -- GET /v1/monitor/:id -- Get a single monitor --------------------------------

  app.get('/v1/monitor/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    const monitor = await db.monitor.findFirst({
      where: { id, userId: apiKey.userId },
    });

    if (!monitor) {
      return reply.status(404).send({ success: false, error: 'Monitor not found' });
    }

    // Also fetch the most recent snapshots for context
    const recentSnapshots = await db.snapshot.findMany({
      where: { monitorId: id },
      orderBy: { capturedAt: 'desc' },
      take: 5,
    });

    return reply.send({
      success: true,
      data: {
        id: monitor.id,
        url: monitor.url,
        fields: monitor.fields,
        schedule: monitor.schedule,
        alertThresholds: monitor.alertThresholds,
        webhookUrl: monitor.webhookUrl,
        active: monitor.active,
        lastRun: monitor.lastRun,
        createdAt: monitor.createdAt,
        recentSnapshots: recentSnapshots.map((s) => ({
          id: s.id,
          data: s.data,
          capturedAt: s.capturedAt,
        })),
      },
    });
  });

  // -- PATCH /v1/monitor/:id -- Update a monitor ----------------------------------

  app.patch('/v1/monitor/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    const body = UpdateMonitorSchema.safeParse(request.body);
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

    // Verify ownership
    const existing = await db.monitor.findFirst({
      where: { id, userId: apiKey.userId },
    });

    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Monitor not found' });
    }

    try {
      const updateData: any = {};
      if (data.active !== undefined) updateData.active = data.active;
      if (data.schedule !== undefined) updateData.schedule = data.schedule;
      if (data.fields !== undefined) updateData.fields = data.fields;
      if (data.alertThresholds !== undefined) updateData.alertThresholds = data.alertThresholds;
      if (data.webhookUrl !== undefined) updateData.webhookUrl = data.webhookUrl;

      const updated = await db.monitor.update({
        where: { id },
        data: updateData,
      });

      logger.info({ monitorId: id, updates: Object.keys(updateData) }, 'Monitor updated');

      return reply.send({
        success: true,
        data: {
          id: updated.id,
          url: updated.url,
          fields: updated.fields,
          schedule: updated.schedule,
          alertThresholds: updated.alertThresholds,
          webhookUrl: updated.webhookUrl,
          active: updated.active,
          lastRun: updated.lastRun,
          createdAt: updated.createdAt,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message, monitorId: id }, 'Failed to update monitor');
      return reply.status(500).send({
        success: false,
        error: 'Failed to update monitor. Please try again.',
      });
    }
  });

  // -- DELETE /v1/monitor/:id -- Delete a monitor ---------------------------------

  app.delete('/v1/monitor/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    const monitor = await db.monitor.findFirst({
      where: { id, userId: apiKey.userId },
    });

    if (!monitor) {
      return reply.status(404).send({ success: false, error: 'Monitor not found' });
    }

    try {
      await db.monitor.delete({ where: { id } });

      logger.info({ monitorId: id, url: monitor.url }, 'Monitor deleted');

      return reply.send({ success: true });
    } catch (error: any) {
      logger.error({ error: error.message, monitorId: id }, 'Failed to delete monitor');
      return reply.status(500).send({
        success: false,
        error: 'Failed to delete monitor. Please try again.',
      });
    }
  });

  // -- GET /v1/monitor/:id/snapshots -- Get snapshots for a monitor ---------------

  app.get('/v1/monitor/:id/snapshots', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;
    const query = request.query as {
      limit?: string;
      offset?: string;
    };

    // Verify monitor ownership
    const monitor = await db.monitor.findFirst({
      where: { id, userId: apiKey.userId },
    });

    if (!monitor) {
      return reply.status(404).send({ success: false, error: 'Monitor not found' });
    }

    const limit = Math.min(parseInt(query.limit || '50', 10), 200);
    const offset = parseInt(query.offset || '0', 10);

    const [snapshots, total] = await Promise.all([
      db.snapshot.findMany({
        where: { monitorId: id },
        orderBy: { capturedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.snapshot.count({ where: { monitorId: id } }),
    ]);

    return reply.send({
      success: true,
      data: snapshots.map((s) => ({
        id: s.id,
        data: s.data,
        capturedAt: s.capturedAt,
      })),
      total,
      limit,
      offset,
    });
  });
}
