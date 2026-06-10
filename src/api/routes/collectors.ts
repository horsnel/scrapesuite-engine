/**
 * Collector / Dataset API Routes -- CRUD, execution, and data retrieval for
 * recurring structured data collection tasks.
 *
 * Endpoints
 * ---------
 *   POST   /v1/collectors                    -- Create a collector
 *   GET    /v1/collectors                    -- List user's collectors
 *   GET    /v1/collectors/:id                -- Get collector details
 *   PATCH  /v1/collectors/:id                -- Update collector
 *   DELETE /v1/collectors/:id                -- Delete collector
 *   POST   /v1/collectors/:id/run            -- Run a collector
 *   GET    /v1/collectors/:id/datasets       -- List datasets for collector
 *   GET    /v1/collectors/:id/datasets/latest -- Get latest dataset
 *   GET    /v1/datasets/:id                  -- Get dataset
 *   GET    /v1/datasets/:id/delta            -- Get delta vs previous run
 *   GET    /v1/datasets/:id/export           -- Export dataset (query: format=json|csv)
 *
 * All endpoints require authentication via authMiddleware.
 * POST /v1/collectors/:id/run uses checkCredits middleware (costs 5 credits per URL).
 */

import { FastifyInstance } from 'fastify';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { checkCredits } from '../middleware/credits';
import { deductCredits } from '../middleware/credits';
import { collectorManager } from '../../collector';
import { createChildLogger } from '../../utils/logger';
import { z } from 'zod';

const logger = createChildLogger('api:collectors');

// --- Request Validation Schemas ------------------------------------------------

const CreateCollectorSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  templateId: z.string().min(1),
  urls: z.array(z.string().url()).min(1).max(100),
  pagination: z.object({
    type: z.enum(['url_param', 'offset', 'next_link']),
    param: z.string(),
    startValue: z.number().int(),
    maxValue: z.number().int().min(1).max(100),
    step: z.number().int().min(1).optional().default(1),
  }).optional(),
  schedule: z.string().optional(),
  outputFormat: z.enum(['json', 'csv']).optional().default('json'),
  webhookUrl: z.string().url().optional(),
  maxConcurrency: z.number().int().min(1).max(10).optional().default(3),
  proxyTier: z.enum(['residential', 'mobile', 'datacenter', 'isp']).optional(),
  proxyCountry: z.string().min(2).max(2).optional(),
  active: z.boolean().optional().default(true),
});

const UpdateCollectorSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  templateId: z.string().min(1).optional(),
  urls: z.array(z.string().url()).min(1).max(100).optional(),
  pagination: z.object({
    type: z.enum(['url_param', 'offset', 'next_link']),
    param: z.string(),
    startValue: z.number().int(),
    maxValue: z.number().int().min(1).max(100),
    step: z.number().int().min(1).optional().default(1),
  }).optional(),
  schedule: z.string().optional(),
  outputFormat: z.enum(['json', 'csv']).optional(),
  webhookUrl: z.string().url().optional(),
  maxConcurrency: z.number().int().min(1).max(10).optional(),
  proxyTier: z.enum(['residential', 'mobile', 'datacenter', 'isp']).optional(),
  proxyCountry: z.string().min(2).max(2).optional(),
  active: z.boolean().optional(),
});

// --- Helpers -------------------------------------------------------------------

/**
 * Verify that the collector belongs to the authenticated user.
 * Returns the collector if valid, or sends an error response and returns null.
 */
async function verifyOwnership(
  collectorId: string,
  userId: string,
  reply: any,
): Promise<any | null> {
  const collector = await collectorManager.getCollector(collectorId);

  if (!collector) {
    reply.status(404).send({
      success: false,
      error: 'Collector not found.',
    });
    return null;
  }

  if (collector.userId !== userId) {
    reply.status(403).send({
      success: false,
      error: 'You do not have access to this collector.',
    });
    return null;
  }

  return collector;
}

// --- Route Registration --------------------------------------------------------

export async function collectorRoutes(app: FastifyInstance) {
  // -- POST /v1/collectors -- Create a collector -------------------------------

  app.post('/v1/collectors', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = CreateCollectorSchema.safeParse(request.body);
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

    try {
      const collector = await collectorManager.createCollector({
        userId: apiKey.userId,
        name: data.name,
        description: data.description,
        templateId: data.templateId,
        urls: data.urls,
        pagination: data.pagination,
        schedule: data.schedule,
        outputFormat: data.outputFormat,
        webhookUrl: data.webhookUrl,
        maxConcurrency: data.maxConcurrency,
        proxyTier: data.proxyTier,
        proxyCountry: data.proxyCountry,
        active: data.active,
      });

      return reply.status(201).send({
        success: true,
        data: collector,
      });
    } catch (error: any) {
      logger.error({ error: error.message, userId: apiKey.userId }, 'Failed to create collector');

      // Template not found
      if (error.message.includes('Template not found')) {
        return reply.status(400).send({
          success: false,
          error: error.message,
        });
      }

      return reply.status(500).send({
        success: false,
        error: 'Failed to create collector. Please try again.',
      });
    }
  });

  // -- GET /v1/collectors -- List user's collectors -----------------------------

  app.get('/v1/collectors', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;

    try {
      const collectors = await collectorManager.listCollectors(apiKey.userId);

      return reply.send({
        success: true,
        data: collectors,
        total: collectors.length,
      });
    } catch (error: any) {
      logger.error({ error: error.message, userId: apiKey.userId }, 'Failed to list collectors');
      return reply.status(500).send({
        success: false,
        error: 'Failed to list collectors.',
      });
    }
  });

  // -- GET /v1/collectors/:id -- Get collector details --------------------------

  app.get('/v1/collectors/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };

    const collector = await verifyOwnership(id, apiKey.userId, reply);
    if (!collector) return;

    return reply.send({
      success: true,
      data: collector,
    });
  });

  // -- PATCH /v1/collectors/:id -- Update collector -----------------------------

  app.patch('/v1/collectors/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };

    // Verify ownership first
    const existing = await collectorManager.getCollector(id);
    if (!existing) {
      return reply.status(404).send({
        success: false,
        error: 'Collector not found.',
      });
    }
    if (existing.userId !== apiKey.userId) {
      return reply.status(403).send({
        success: false,
        error: 'You do not have access to this collector.',
      });
    }

    const body = UpdateCollectorSchema.safeParse(request.body);
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
      const updated = await collectorManager.updateCollector(id, body.data);

      return reply.send({
        success: true,
        data: updated,
      });
    } catch (error: any) {
      logger.error({ error: error.message, collectorId: id }, 'Failed to update collector');

      if (error.message.includes('Template not found')) {
        return reply.status(400).send({
          success: false,
          error: error.message,
        });
      }

      if (error.message.includes('Collector not found')) {
        return reply.status(404).send({
          success: false,
          error: error.message,
        });
      }

      return reply.status(500).send({
        success: false,
        error: 'Failed to update collector.',
      });
    }
  });

  // -- DELETE /v1/collectors/:id -- Delete collector ----------------------------

  app.delete('/v1/collectors/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };

    const collector = await verifyOwnership(id, apiKey.userId, reply);
    if (!collector) return;

    try {
      await collectorManager.deleteCollector(id);

      return reply.send({
        success: true,
        data: { collectorId: id, deleted: true },
      });
    } catch (error: any) {
      logger.error({ error: error.message, collectorId: id }, 'Failed to delete collector');
      return reply.status(500).send({
        success: false,
        error: 'Failed to delete collector.',
      });
    }
  });

  // -- POST /v1/collectors/:id/run -- Run a collector --------------------------

  app.post('/v1/collectors/:id/run', {
    preHandler: [authMiddleware, checkCredits],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };

    // Verify ownership
    const collector = await collectorManager.getCollector(id);
    if (!collector) {
      return reply.status(404).send({
        success: false,
        error: 'Collector not found.',
      });
    }
    if (collector.userId !== apiKey.userId) {
      return reply.status(403).send({
        success: false,
        error: 'You do not have access to this collector.',
      });
    }

    // Estimate cost: 5 credits per URL
    const estimatedUrlCount = collector.urls.length * (collector.pagination?.maxValue ?? 1);
    const cost = estimatedUrlCount * 5;

    if (apiKey.creditsRemaining < cost) {
      return reply.status(402).send({
        success: false,
        error: `Insufficient credits. Estimated cost: ${cost} credits (5 per URL × ${estimatedUrlCount} URLs), but you have ${apiKey.creditsRemaining}.`,
        creditsRequired: cost,
        creditsRemaining: apiKey.creditsRemaining,
      });
    }

    try {
      const result = await collectorManager.runCollector(id);

      // Deduct credits based on actual URLs processed
      const actualCost = result.totalUrls * 5;
      const deducted = await deductCredits(apiKey.userId, apiKey.id, actualCost);

      if (!deducted) {
        logger.warn(
          { collectorId: id, actualCost, userId: apiKey.userId },
          'Collector run completed but credit deduction failed',
        );
      }

      return reply.send({
        success: true,
        data: result,
        creditsUsed: deducted ? actualCost : 0,
        creditsRemaining: apiKey.creditsRemaining - (deducted ? actualCost : 0),
      });
    } catch (error: any) {
      logger.error({ error: error.message, collectorId: id }, 'Collector run failed');

      if (error.message.includes('Collector not found')) {
        return reply.status(404).send({
          success: false,
          error: error.message,
        });
      }

      return reply.status(500).send({
        success: false,
        error: 'Collector run failed. Please try again.',
        creditsUsed: 0,
      });
    }
  });

  // -- GET /v1/collectors/:id/datasets -- List datasets for collector -----------

  app.get('/v1/collectors/:id/datasets', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const query = request.query as { limit?: string };

    const collector = await verifyOwnership(id, apiKey.userId, reply);
    if (!collector) return;

    try {
      const limit = query.limit ? Math.min(parseInt(query.limit, 10) || 20, 100) : 20;
      const datasets = await collectorManager.listDatasets(id, limit);

      return reply.send({
        success: true,
        data: datasets,
        total: datasets.length,
      });
    } catch (error: any) {
      logger.error({ error: error.message, collectorId: id }, 'Failed to list datasets');
      return reply.status(500).send({
        success: false,
        error: 'Failed to list datasets.',
      });
    }
  });

  // -- GET /v1/collectors/:id/datasets/latest -- Get latest dataset -------------

  app.get('/v1/collectors/:id/datasets/latest', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };

    const collector = await verifyOwnership(id, apiKey.userId, reply);
    if (!collector) return;

    try {
      const dataset = await collectorManager.getLatestDataset(id);

      if (!dataset) {
        return reply.status(404).send({
          success: false,
          error: 'No datasets found for this collector. Run the collector first.',
        });
      }

      return reply.send({
        success: true,
        data: dataset,
      });
    } catch (error: any) {
      logger.error({ error: error.message, collectorId: id }, 'Failed to get latest dataset');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get latest dataset.',
      });
    }
  });

  // -- GET /v1/datasets/:id -- Get dataset -------------------------------------

  app.get('/v1/datasets/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };

    try {
      const dataset = await collectorManager.getDataset(id);

      if (!dataset) {
        return reply.status(404).send({
          success: false,
          error: 'Dataset not found.',
        });
      }

      // Verify ownership
      if (dataset.userId !== apiKey.userId) {
        return reply.status(403).send({
          success: false,
          error: 'You do not have access to this dataset.',
        });
      }

      return reply.send({
        success: true,
        data: dataset,
      });
    } catch (error: any) {
      logger.error({ error: error.message, datasetId: id }, 'Failed to get dataset');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get dataset.',
      });
    }
  });

  // -- GET /v1/datasets/:id/delta -- Get delta vs previous run -----------------

  app.get('/v1/datasets/:id/delta', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };

    try {
      // First verify the dataset exists and belongs to the user
      const dataset = await collectorManager.getDataset(id);

      if (!dataset) {
        return reply.status(404).send({
          success: false,
          error: 'Dataset not found.',
        });
      }

      if (dataset.userId !== apiKey.userId) {
        return reply.status(403).send({
          success: false,
          error: 'You do not have access to this dataset.',
        });
      }

      // Get delta for the collector this dataset belongs to
      const delta = await collectorManager.getDelta(dataset.collectorId);

      if (!delta) {
        return reply.status(404).send({
          success: false,
          error: 'Not enough datasets to compute a delta. At least two runs are required.',
        });
      }

      return reply.send({
        success: true,
        data: delta,
      });
    } catch (error: any) {
      logger.error({ error: error.message, datasetId: id }, 'Failed to get dataset delta');
      return reply.status(500).send({
        success: false,
        error: 'Failed to compute dataset delta.',
      });
    }
  });

  // -- GET /v1/datasets/:id/export -- Export dataset ---------------------------

  app.get('/v1/datasets/:id/export', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const query = request.query as { format?: string };

    try {
      // Verify ownership
      const dataset = await collectorManager.getDataset(id);

      if (!dataset) {
        return reply.status(404).send({
          success: false,
          error: 'Dataset not found.',
        });
      }

      if (dataset.userId !== apiKey.userId) {
        return reply.status(403).send({
          success: false,
          error: 'You do not have access to this dataset.',
        });
      }

      const format = query.format === 'csv' ? 'csv' : 'json';
      const exported = await collectorManager.exportDataset(id, format);

      // Set appropriate content type for the response
      if (format === 'csv') {
        reply.header('Content-Type', 'text/csv');
        reply.header('Content-Disposition', `attachment; filename="dataset-${id}.csv"`);
        return reply.send(exported);
      }

      reply.header('Content-Type', 'application/json');
      reply.header('Content-Disposition', `attachment; filename="dataset-${id}.json"`);
      return reply.send(exported);
    } catch (error: any) {
      logger.error({ error: error.message, datasetId: id }, 'Failed to export dataset');
      return reply.status(500).send({
        success: false,
        error: 'Failed to export dataset.',
      });
    }
  });
}
