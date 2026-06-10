/**
 * Marketplace API Routes -- Browse, search, publish, purchase, install,
 * and review marketplace templates and datasets.
 *
 * Endpoints
 * ---------
 *   GET    /v1/marketplace/items              -- Browse/search marketplace items
 *   GET    /v1/marketplace/items/:id           -- Get item details
 *   POST   /v1/marketplace/items               -- Publish a new item (auth required)
 *   PUT    /v1/marketplace/items/:id           -- Update item (auth required, author only)
 *   DELETE /v1/marketplace/items/:id           -- Deprecate item (auth required, author only)
 *   POST   /v1/marketplace/items/:id/install   -- Install template (auth required)
 *   POST   /v1/marketplace/items/:id/purchase  -- Purchase item (auth required)
 *   POST   /v1/marketplace/items/:id/review    -- Submit review (auth required)
 *   GET    /v1/marketplace/items/:id/reviews   -- Get reviews
 *   GET    /v1/marketplace/author/:authorId    -- Get items by author
 *   GET    /v1/marketplace/categories           -- Get categories with counts
 *   GET    /v1/marketplace/stats                -- Marketplace statistics
 */

import { FastifyInstance } from 'fastify';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { marketplaceEngine, MARKETPLACE_CATEGORIES, CATEGORY_LABELS } from '../../marketplace';
import { createChildLogger } from '../../utils/logger';
import { z } from 'zod';
import { db } from '../../utils/db';

const logger = createChildLogger('api:marketplace');

// --- Request Validation Schemas ------------------------------------------------

const BrowseItemsSchema = z.object({
  search: z.string().optional(),
  category: z.enum([
    'ecommerce', 'social-media', 'jobs', 'real-estate',
    'travel', 'news', 'finance', 'tech', 'education', 'government',
  ]).optional(),
  itemType: z.enum(['template', 'dataset']).optional(),
  sortBy: z.enum(['popular', 'newest', 'rating', 'price-asc', 'price-desc']).optional().default('popular'),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

const PublishItemSchema = z.object({
  templateId: z.string().optional(),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(500),
  longDescription: z.string().max(10000).optional(),
  category: z.enum([
    'ecommerce', 'social-media', 'jobs', 'real-estate',
    'travel', 'news', 'finance', 'tech', 'education', 'government',
  ]),
  tags: z.array(z.string()).optional(),
  pricingModel: z.enum(['free', 'credits']),
  creditCost: z.number().int().min(1).max(10000).optional(),
  itemType: z.enum(['template', 'dataset']),
});

const UpdateItemSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(500).optional(),
  longDescription: z.string().max(10000).optional(),
  tags: z.array(z.string()).optional(),
  pricingModel: z.enum(['free', 'credits']).optional(),
  creditCost: z.number().int().min(1).max(10000).optional(),
});

const SubmitReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  reviewText: z.string().max(2000).optional(),
  itemType: z.enum(['template', 'dataset']),
});

// --- Route Registration --------------------------------------------------------

export async function marketplaceRoutes(app: FastifyInstance) {
  // -- GET /v1/marketplace/items -- Browse/search marketplace items -------------

  app.get('/v1/marketplace/items', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const parsed = BrowseItemsSchema.safeParse(query);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: 'Validation error',
        details: parsed.error.issues.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      });
    }

    const { search, category, itemType, sortBy, page, limit } = parsed.data;
    const offset = (page - 1) * limit;

    try {
      const searchParams: any = {
        query: search,
        category,
        sort: sortBy,
        offset,
        limit,
      };

      let result: any;
      if (itemType === 'dataset') {
        result = await marketplaceEngine.searchDatasets(searchParams);
      } else if (itemType === 'template') {
        result = await marketplaceEngine.searchTemplates(searchParams);
      } else {
        // Search both templates and datasets
        const [templates, datasets] = await Promise.all([
          marketplaceEngine.searchTemplates(searchParams),
          marketplaceEngine.searchDatasets(searchParams),
        ]);
        return reply.send({
          success: true,
          data: {
            templates: templates.items,
            datasets: datasets.items,
            totalTemplates: templates.total,
            totalDatasets: datasets.total,
            page,
            limit,
          },
        });
      }

      return reply.send({
        success: true,
        data: result.items,
        total: result.total,
        page,
        limit,
      });
    } catch (error: any) {
      logger.error({ error: error.message, query }, 'Marketplace search failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to search marketplace items.',
      });
    }
  });

  // -- GET /v1/marketplace/items/:id -- Get item details ------------------------

  app.get('/v1/marketplace/items/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      // Try template first, then dataset
      const template = await marketplaceEngine.getTemplate(id);
      if (template) {
        return reply.send({ success: true, data: { ...template, itemType: 'template' } });
      }

      const dataset = await marketplaceEngine.getDataset(id);
      if (dataset) {
        return reply.send({ success: true, data: { ...dataset, itemType: 'dataset' } });
      }

      return reply.status(404).send({
        success: false,
        error: 'Marketplace item not found.',
      });
    } catch (error: any) {
      logger.error({ error: error.message, itemId: id }, 'Failed to get marketplace item');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get marketplace item details.',
      });
    }
  });

  // -- POST /v1/marketplace/items -- Publish a new item (auth required) ---------

  app.post('/v1/marketplace/items', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = PublishItemSchema.safeParse(request.body);
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
      if (data.itemType === 'template') {
        if (!data.templateId) {
          return reply.status(400).send({
            success: false,
            error: 'templateId is required when publishing a template.',
          });
        }

        const result = await marketplaceEngine.publishTemplate({
          templateId: data.templateId,
          name: data.name,
          description: data.description,
          longDescription: data.longDescription,
          category: data.category,
          tags: data.tags,
          pricingModel: data.pricingModel,
          creditCost: data.creditCost,
          publisherId: apiKey.userId,
          publisherName: apiKey.userId, // Could be enriched with user profile
        });

        if (!result.success) {
          return reply.status(400).send({ success: false, error: result.error });
        }

        return reply.status(201).send({
          success: true,
          data: { id: result.templateListingId, itemType: 'template' },
        });
      } else {
        // Dataset publishing requires additional fields not in the base schema
        return reply.status(400).send({
          success: false,
          error: 'Dataset publishing requires additional metadata (columns, sampleData, storageKey, format, fileSizeBytes, rowCount, dataAsOf). Use the dataset-specific publish endpoint.',
        });
      }
    } catch (error: any) {
      logger.error({ error: error.message, userId: apiKey.userId }, 'Failed to publish marketplace item');
      return reply.status(500).send({
        success: false,
        error: 'Failed to publish marketplace item.',
      });
    }
  });

  // -- PUT /v1/marketplace/items/:id -- Update item (auth required, author only)

  app.put('/v1/marketplace/items/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;
    const body = UpdateItemSchema.safeParse(request.body);
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
      const item = await db.marketplaceItem.findUnique({ where: { id } });
      if (!item) {
        return reply.status(404).send({ success: false, error: 'Item not found.' });
      }
      if (item.publisherId !== apiKey.userId) {
        return reply.status(403).send({ success: false, error: 'Only the author can update this item.' });
      }

      const updateData: any = {};
      if (body.data.name !== undefined) updateData.name = body.data.name;
      if (body.data.description !== undefined) updateData.description = body.data.description;
      if (body.data.longDescription !== undefined) updateData.longDescription = body.data.longDescription;
      if (body.data.tags !== undefined) updateData.tags = body.data.tags;
      if (body.data.pricingModel !== undefined) updateData.pricingModel = body.data.pricingModel;
      if (body.data.creditCost !== undefined) updateData.creditCost = body.data.creditCost;
      updateData.updatedAt = new Date();

      await db.marketplaceItem.update({ where: { id }, data: updateData });

      return reply.send({ success: true, data: { id, updated: true } });
    } catch (error: any) {
      logger.error({ error: error.message, itemId: id }, 'Failed to update marketplace item');
      return reply.status(500).send({
        success: false,
        error: 'Failed to update marketplace item.',
      });
    }
  });

  // -- DELETE /v1/marketplace/items/:id -- Deprecate item (auth required, author only)

  app.delete('/v1/marketplace/items/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    try {
      const item = await db.marketplaceItem.findUnique({ where: { id } });
      if (!item) {
        return reply.status(404).send({ success: false, error: 'Item not found.' });
      }
      if (item.publisherId !== apiKey.userId) {
        return reply.status(403).send({ success: false, error: 'Only the author can deprecate this item.' });
      }

      await db.marketplaceItem.update({
        where: { id },
        data: { status: 'deprecated', updatedAt: new Date() },
      });

      return reply.send({ success: true, data: { id, deprecated: true } });
    } catch (error: any) {
      logger.error({ error: error.message, itemId: id }, 'Failed to deprecate marketplace item');
      return reply.status(500).send({
        success: false,
        error: 'Failed to deprecate marketplace item.',
      });
    }
  });

  // -- POST /v1/marketplace/items/:id/install -- Install template (auth required)

  app.post('/v1/marketplace/items/:id/install', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    try {
      const result = await marketplaceEngine.installTemplate(id, apiKey.userId);
      if (!result.success) {
        return reply.status(400).send({ success: false, error: result.error });
      }

      return reply.send({ success: true, data: { id, installed: true } });
    } catch (error: any) {
      logger.error({ error: error.message, itemId: id, userId: apiKey.userId }, 'Template install failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to install template.',
      });
    }
  });

  // -- POST /v1/marketplace/items/:id/purchase -- Purchase item (auth required) --

  app.post('/v1/marketplace/items/:id/purchase', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;

    try {
      // Determine item type and route to the correct purchase method
      const item = await db.marketplaceItem.findUnique({ where: { id } });
      if (!item) {
        return reply.status(404).send({ success: false, error: 'Item not found.' });
      }

      let result;
      if (item.itemType === 'dataset') {
        result = await marketplaceEngine.purchaseDataset(id, apiKey.userId);
      } else {
        result = await marketplaceEngine.purchaseTemplate(id, apiKey.userId);
      }

      if (!result.success) {
        return reply.status(400).send({ success: false, error: result.error });
      }

      return reply.send({ success: true, data: result });
    } catch (error: any) {
      logger.error({ error: error.message, itemId: id, userId: apiKey.userId }, 'Purchase failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to purchase item.',
      });
    }
  });

  // -- POST /v1/marketplace/items/:id/review -- Submit review (auth required) ---

  app.post('/v1/marketplace/items/:id/review', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = SubmitReviewSchema.safeParse(request.body);
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

    const { id } = request.params as { id: string };
    const { apiKey } = request as AuthenticatedRequest;
    const { rating, reviewText, itemType } = body.data;

    try {
      const result = await marketplaceEngine.submitReview(
        id,
        itemType,
        apiKey.userId,
        apiKey.userId, // Could be enriched with user profile
        rating,
        reviewText || '',
      );

      if (!result.success) {
        return reply.status(400).send({ success: false, error: result.error });
      }

      return reply.status(201).send({ success: true, data: { reviewId: result.reviewId } });
    } catch (error: any) {
      logger.error({ error: error.message, itemId: id, userId: apiKey.userId }, 'Review submission failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to submit review.',
      });
    }
  });

  // -- GET /v1/marketplace/items/:id/reviews -- Get reviews ----------------------

  app.get('/v1/marketplace/items/:id/reviews', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { page?: string; limit?: string };
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    try {
      const [reviews, total] = await Promise.all([
        db.marketplaceReview.findMany({
          where: { itemId: id },
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
        }),
        db.marketplaceReview.count({ where: { itemId: id } }),
      ]);

      return reply.send({
        success: true,
        data: reviews,
        total,
        page,
        limit,
      });
    } catch (error: any) {
      logger.error({ error: error.message, itemId: id }, 'Failed to get reviews');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get reviews.',
      });
    }
  });

  // -- GET /v1/marketplace/author/:authorId -- Get items by author ---------------

  app.get('/v1/marketplace/author/:authorId', async (request, reply) => {
    const { authorId } = request.params as { authorId: string };
    const query = request.query as { page?: string; limit?: string };
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    try {
      const where: any = { publisherId: authorId, status: 'published' };

      const [items, total] = await Promise.all([
        db.marketplaceItem.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
        }),
        db.marketplaceItem.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: items,
        total,
        page,
        limit,
      });
    } catch (error: any) {
      logger.error({ error: error.message, authorId }, 'Failed to get author items');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get items by author.',
      });
    }
  });

  // -- GET /v1/marketplace/categories -- Get categories with counts --------------

  app.get('/v1/marketplace/categories', async (request, reply) => {
    try {
      const counts = await Promise.all(
        MARKETPLACE_CATEGORIES.map(async (category) => {
          const count = await db.marketplaceItem.count({
            where: { category, status: 'published' },
          });
          return {
            id: category,
            label: CATEGORY_LABELS[category],
            count,
          };
        }),
      );

      return reply.send({
        success: true,
        data: counts,
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to get categories');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get marketplace categories.',
      });
    }
  });

  // -- GET /v1/marketplace/stats -- Marketplace statistics -----------------------

  app.get('/v1/marketplace/stats', async (request, reply) => {
    try {
      const [totalItems, totalTemplates, totalDatasets, totalInstalls, totalPurchases] =
        await Promise.all([
          db.marketplaceItem.count({ where: { status: 'published' } }),
          db.marketplaceItem.count({ where: { status: 'published', itemType: 'template' } }),
          db.marketplaceItem.count({ where: { status: 'published', itemType: 'dataset' } }),
          db.marketplaceItem.aggregate({ _sum: { installCount: true }, where: { status: 'published' } }),
          db.marketplaceItem.aggregate({ _sum: { purchaseCount: true }, where: { status: 'published' } }),
        ]);

      return reply.send({
        success: true,
        data: {
          totalItems,
          totalTemplates,
          totalDatasets,
          totalInstalls: totalInstalls._sum.installCount ?? 0,
          totalPurchases: totalPurchases._sum.purchaseCount ?? 0,
          categories: MARKETPLACE_CATEGORIES.length,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to get marketplace stats');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get marketplace statistics.',
      });
    }
  });
}
