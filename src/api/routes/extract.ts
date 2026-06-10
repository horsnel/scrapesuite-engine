import { FastifyInstance } from 'fastify';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { checkCredits, deductCredits } from '../middleware/credits';
import { nlExtractor } from '../../extractor/nl-extractor';
import { createChildLogger } from '../../utils/logger';
import { z } from 'zod';
import { CREDIT_COSTS } from '../../types';

const logger = createChildLogger('api:extract');

// --- Request Validation Schema -------------------------------------------------

const ExtractRequestSchema = z.object({
  html: z.string().min(1, { message: 'HTML content is required' }),
  url: z.string().url().optional(),
  instruction: z.string().min(1, { message: 'Extraction instruction is required' }),
});

// --- Route Registration --------------------------------------------------------

export async function extractRoutes(app: FastifyInstance) {
  // -- POST /v1/extract -- Extract structured data from HTML ----------------------

  app.post('/v1/extract', {
    preHandler: [authMiddleware, checkCredits],
  }, async (request, reply) => {
    // Validate request body
    const body = ExtractRequestSchema.safeParse(request.body);
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
    const cost = CREDIT_COSTS.NL_EXTRACTION;

    // Verify sufficient credits for NL extraction
    if (apiKey.creditsRemaining < cost) {
      return reply.status(402).send({
        success: false,
        error: `Insufficient credits. Need ${cost}, have ${apiKey.creditsRemaining}`,
        creditsRequired: cost,
        creditsRemaining: apiKey.creditsRemaining,
      });
    }

    try {
      // Run extraction
      const result = await nlExtractor.extract({
        html: data.html,
        url: data.url,
        instruction: data.instruction,
      });

      // If extraction failed, don't charge credits
      if (result.error) {
        logger.warn(
          { error: result.error, url: data.url },
          'Extraction returned error -- not deducting credits',
        );

        return reply.status(422).send({
          success: false,
          error: 'Extraction failed to produce valid results',
          details: result.error,
          confidence: result.confidence,
          tokensUsed: result.tokensUsed,
          creditsUsed: 0,
          creditsRemaining: apiKey.creditsRemaining,
        });
      }

      // Deduct credits only on successful extraction
      const deducted = await deductCredits(apiKey.userId, apiKey.id, cost);
      if (!deducted) {
        // Race condition: credits ran out between check and deduction
        logger.warn(
          { apiKeyId: apiKey.id, cost },
          'Credit deduction failed after extraction -- likely insufficient credits',
        );
        return reply.status(402).send({
          success: false,
          error: 'Insufficient credits at time of deduction. Please upgrade your plan.',
          creditsUsed: 0,
        });
      }

      return reply.send({
        success: true,
        data: result.data,
        confidence: result.confidence,
        schemaMatch: result.schemaMatch,
        tokensUsed: result.tokensUsed,
        creditsUsed: cost,
        creditsRemaining: apiKey.creditsRemaining - cost,
      });
    } catch (error: any) {
      logger.error({ error: error.message, url: data.url }, 'Extract endpoint failed');

      return reply.status(500).send({
        success: false,
        error: 'Extraction failed due to an internal error. Please try again.',
        creditsUsed: 0,
        creditsRemaining: apiKey.creditsRemaining,
      });
    }
  });

  // -- POST /v1/extract/batch -- Batch extraction from multiple HTML documents ----

  const BatchExtractRequestSchema = z.object({
    items: z.array(
      z.object({
        html: z.string().min(1),
        url: z.string().url().optional(),
        instruction: z.string().min(1),
      }),
    ).min(1).max(25),
    concurrency: z.number().int().min(1).max(5).optional().default(3),
  });

  app.post('/v1/extract/batch', {
    preHandler: [authMiddleware, checkCredits],
  }, async (request, reply) => {
    const body = BatchExtractRequestSchema.safeParse(request.body);
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
    const costPerItem = CREDIT_COSTS.NL_EXTRACTION;
    const totalCost = costPerItem * data.items.length;

    // Verify sufficient credits for the full batch
    if (apiKey.creditsRemaining < totalCost) {
      return reply.status(402).send({
        success: false,
        error: `Insufficient credits for batch. Need ${totalCost} (${data.items.length} × ${costPerItem}), have ${apiKey.creditsRemaining}`,
        creditsRequired: totalCost,
        creditsRemaining: apiKey.creditsRemaining,
      });
    }

    try {
      const results = await nlExtractor.extractBatch(
        data.items.map((item) => ({
          html: item.html,
          url: item.url,
          instruction: item.instruction,
        })),
        data.concurrency,
      );

      // Count successful extractions for billing
      const successfulCount = results.filter((r) => !r.error).length;
      const creditsToDeduct = successfulCount * costPerItem;

      // Deduct credits for successful extractions only
      if (creditsToDeduct > 0) {
        await deductCredits(apiKey.userId, apiKey.id, creditsToDeduct);
      }

      return reply.send({
        success: true,
        data: results.map((r, i) => ({
          index: i,
          data: r.data,
          confidence: r.confidence,
          schemaMatch: r.schemaMatch,
          tokensUsed: r.tokensUsed,
          error: r.error,
        })),
        creditsUsed: creditsToDeduct,
        creditsRemaining: apiKey.creditsRemaining - creditsToDeduct,
        totalItems: data.items.length,
        successfulItems: successfulCount,
        failedItems: data.items.length - successfulCount,
      });
    } catch (error: any) {
      logger.error({ error: error.message, itemCount: data.items.length }, 'Batch extract failed');

      return reply.status(500).send({
        success: false,
        error: 'Batch extraction failed due to an internal error.',
        creditsUsed: 0,
        creditsRemaining: apiKey.creditsRemaining,
      });
    }
  });
}
