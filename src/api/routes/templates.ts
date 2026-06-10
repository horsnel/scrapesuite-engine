/**
 * Template Discovery API Routes -- Browse, inspect, and auto-detect scraper
 * templates for structured data extraction.
 *
 * Endpoints
 * ---------
 *   GET    /v1/templates           -- List all available templates
 *   GET    /v1/templates/:id       -- Get template details
 *   POST   /v1/templates/detect    -- Detect which template applies to a URL
 *
 * All endpoints require authentication via authMiddleware.
 */

import { FastifyInstance } from 'fastify';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { templateRegistry } from '../../templates';
import { createChildLogger } from '../../utils/logger';
import { z } from 'zod';

const logger = createChildLogger('api:templates');

// --- Request Validation Schemas ------------------------------------------------

const DetectTemplateSchema = z.object({
  url: z.string().url(),
});

// --- Route Registration --------------------------------------------------------

export async function templateRoutes(app: FastifyInstance) {
  // -- GET /v1/templates -- List all available templates ------------------------

  app.get('/v1/templates', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      const templates = templateRegistry.listTemplates();

      return reply.send({
        success: true,
        data: templates,
        total: templates.length,
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to list templates');
      return reply.status(500).send({
        success: false,
        error: 'Failed to list templates.',
      });
    }
  });

  // -- GET /v1/templates/:id -- Get template details ---------------------------

  app.get('/v1/templates/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const template = templateRegistry.getTemplate(id);

      if (!template) {
        return reply.status(404).send({
          success: false,
          error: `Template not found: ${id}`,
        });
      }

      return reply.send({
        success: true,
        data: {
          id: template.id,
          name: template.name,
          description: template.description,
          domainPatterns: template.domainPatterns,
          outputSchema: template.outputSchema,
          requiredStrategy: template.requiredStrategy,
          requiredProxyTier: template.requiredProxyTier,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message, templateId: id }, 'Failed to get template');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get template details.',
      });
    }
  });

  // -- POST /v1/templates/detect -- Detect which template applies to a URL -----

  app.post('/v1/templates/detect', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = DetectTemplateSchema.safeParse(request.body);
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

    const { url } = body.data;

    try {
      const match = templateRegistry.detectTemplate(url);

      if (!match) {
        return reply.send({
          success: true,
          data: {
            detected: false,
            templateId: null,
            confidence: 0,
            message: 'No matching template found for the provided URL. A generic extractor will be used.',
          },
        });
      }

      return reply.send({
        success: true,
        data: {
          detected: true,
          templateId: match.templateId,
          templateName: match.template.name,
          confidence: match.confidence,
          description: match.template.description,
          outputFields: Object.keys(match.template.outputSchema),
          requiredStrategy: match.template.requiredStrategy,
          requiredProxyTier: match.template.requiredProxyTier,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message, url }, 'Failed to detect template');
      return reply.status(500).send({
        success: false,
        error: 'Failed to detect template for the provided URL.',
      });
    }
  });
}
