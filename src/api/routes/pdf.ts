/**
 * PDF Capture API Routes -- Capture web pages as PDF documents, check
 * capture status, and download completed PDFs.
 *
 * Endpoints
 * ---------
 *   POST   /v1/pdf/capture           -- Capture URL as PDF
 *   GET    /v1/pdf/:jobId/status      -- Get PDF capture status
 *   GET    /v1/pdf/:jobId/download    -- Download captured PDF
 */

import { FastifyInstance } from 'fastify';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { pdfCapture } from '../../pdf';
import { createChildLogger } from '../../utils/logger';
import { z } from 'zod';
import { db } from '../../utils/db';

const logger = createChildLogger('api:pdf');

// --- Request Validation Schemas ------------------------------------------------

const PdfCaptureSchema = z.object({
  url: z.string().url({ message: 'Invalid URL format' }),
  options: z.object({
    format: z.enum([
      'Letter', 'Legal', 'Tabloid', 'Ledger',
      'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6',
    ]).optional().default('A4'),
    orientation: z.enum(['portrait', 'landscape']).optional().default('portrait'),
    captureMode: z.enum(['fullpage', 'viewport']).optional().default('fullpage'),
    printBackground: z.boolean().optional().default(true),
    margins: z.object({
      top: z.number().optional(),
      right: z.number().optional(),
      bottom: z.number().optional(),
      left: z.number().optional(),
    }).optional(),
    customCSS: z.string().optional(),
    waitForSelector: z.string().optional(),
    timeout: z.number().int().min(5000).max(60000).optional().default(30000),
    watermark: z.object({
      text: z.string(),
      fontSize: z.number().optional(),
      color: z.string().optional(),
      rotation: z.number().optional(),
    }).optional(),
    header: z.object({
      template: z.string().optional(),
      enabled: z.boolean().optional(),
    }).optional(),
    footer: z.object({
      template: z.string().optional(),
      enabled: z.boolean().optional(),
    }).optional(),
    outputPath: z.string().optional(),
    useCache: z.boolean().optional().default(true),
    cacheTtl: z.number().int().min(0).max(86400).optional(),
    screenMedia: z.boolean().optional().default(false),
    scale: z.number().min(0.1).max(2).optional(),
    pageRanges: z.string().optional(),
  }).optional().default({}),
});

// --- In-memory job tracking for async PDF captures ----------------------------

interface PdfJobEntry {
  id: string;
  userId: string;
  url: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
  result?: any;
  error?: string;
}

const pdfJobs = new Map<string, PdfJobEntry>();

// --- Route Registration --------------------------------------------------------

export async function pdfRoutes(app: FastifyInstance) {
  // -- POST /v1/pdf/capture -- Capture URL as PDF -------------------------------

  app.post('/v1/pdf/capture', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = PdfCaptureSchema.safeParse(request.body);
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
    const { url, options } = body.data;
    const jobId = `pdf-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    // Track job
    const jobEntry: PdfJobEntry = {
      id: jobId,
      userId: apiKey.userId,
      url,
      status: 'pending',
      createdAt: new Date(),
    };
    pdfJobs.set(jobId, jobEntry);

    // Check credit balance (2 credits per page)
    const estimatedCredits = 4; // Estimate 2 pages minimum
    if (apiKey.creditsRemaining < estimatedCredits) {
      pdfJobs.delete(jobId);
      return reply.status(402).send({
        success: false,
        error: `Insufficient credits. PDF capture requires at least ${estimatedCredits} credits.`,
        creditsRequired: estimatedCredits,
        creditsRemaining: apiKey.creditsRemaining,
      });
    }

    try {
      // For now, use the synchronous capture approach with the browser pool
      // In a production system, this would be offloaded to a job queue
      jobEntry.status = 'processing';

      // Build capture options
      const captureOptions: any = {
        url,
        format: options.format,
        orientation: options.orientation,
        captureMode: options.captureMode,
        printBackground: options.printBackground,
        useCache: options.useCache,
        cacheTtl: options.cacheTtl,
        userId: apiKey.userId,
        apiKeyId: apiKey.id,
        screenMedia: options.screenMedia,
      };

      if (options.margins) captureOptions.margins = options.margins;
      if (options.customCSS) captureOptions.customCSS = options.customCSS;
      if (options.waitForSelector) captureOptions.waitForSelector = options.waitForSelector;
      if (options.timeout) captureOptions.timeout = options.timeout;
      if (options.watermark) captureOptions.watermark = options.watermark;
      if (options.header) captureOptions.header = options.header;
      if (options.footer) captureOptions.footer = options.footer;
      if (options.outputPath) captureOptions.outputPath = options.outputPath;
      if (options.scale) captureOptions.scale = options.scale;
      if (options.pageRanges) captureOptions.pageRanges = options.pageRanges;

      // We need a browser page to capture - check if browser pool is available
      // For the API route, we return a job ID and process asynchronously
      // The actual capture will happen via the worker system

      // Attempt synchronous capture if browser pool is available
      try {
        const { browserPool } = await import('../../browser-pool');
        const lease = await browserPool.acquire();

        try {
          const result = await pdfCapture.capture(captureOptions, lease.page);

          jobEntry.status = 'completed';
          jobEntry.completedAt = new Date();
          jobEntry.result = {
            captureId: result.captureId,
            url: result.url,
            sizeBytes: result.sizeBytes,
            format: result.format,
            orientation: result.orientation,
            pageCount: result.pageCount,
            cached: result.cached,
            captureMs: result.captureMs,
            creditsUsed: result.creditsUsed,
            contentHash: result.contentHash,
          };

          // Store the buffer for download (in production, use S3/object storage)
          (jobEntry as any).buffer = result.buffer;

          logger.info({
            captureId: result.captureId,
            url,
            pageCount: result.pageCount,
            creditsUsed: result.creditsUsed,
          }, 'PDF capture completed');

          return reply.status(202).send({
            success: true,
            data: {
              jobId,
              status: 'completed',
              captureId: result.captureId,
              url: result.url,
              sizeBytes: result.sizeBytes,
              format: result.format,
              orientation: result.orientation,
              pageCount: result.pageCount,
              cached: result.cached,
              captureMs: result.captureMs,
              creditsUsed: result.creditsUsed,
              contentHash: result.contentHash,
              downloadUrl: `/v1/pdf/${jobId}/download`,
            },
          });
        } finally {
          await browserPool.release(lease);
        }
      } catch (poolError: any) {
        // Browser pool not available - mark as pending for async processing
        logger.warn({ error: poolError.message }, 'Browser pool unavailable, queuing PDF capture');

        jobEntry.status = 'pending';

        return reply.status(202).send({
          success: true,
          data: {
            jobId,
            status: 'pending',
            url,
            message: 'PDF capture queued. Poll /v1/pdf/:jobId/status for updates.',
          },
        });
      }
    } catch (error: any) {
      jobEntry.status = 'failed';
      jobEntry.error = error.message;
      jobEntry.completedAt = new Date();

      logger.error({ error: error.message, url, jobId }, 'PDF capture failed');

      return reply.status(500).send({
        success: false,
        error: `PDF capture failed: ${error.message}`,
      });
    }
  });

  // -- GET /v1/pdf/:jobId/status -- Get PDF capture status -----------------------

  app.get('/v1/pdf/:jobId/status', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const { apiKey } = request as AuthenticatedRequest;

    try {
      const job = pdfJobs.get(jobId);

      if (!job) {
        // Also check the database for persisted PDF capture records
        try {
          const dbJob = await db.scrapeJob.findFirst({
            where: { id: jobId, userId: apiKey.userId },
          });

          if (dbJob) {
            return reply.send({
              success: true,
              data: {
                jobId: dbJob.id,
                status: dbJob.status === 'done' ? 'completed' : dbJob.status === 'failed' ? 'failed' : 'processing',
                url: dbJob.url,
              },
            });
          }
        } catch {
          // DB lookup failed, continue to 404
        }

        return reply.status(404).send({
          success: false,
          error: 'PDF capture job not found.',
        });
      }

      // Verify ownership
      if (job.userId !== apiKey.userId) {
        return reply.status(403).send({
          success: false,
          error: 'You do not have access to this PDF capture job.',
        });
      }

      const response: any = {
        jobId: job.id,
        status: job.status,
        url: job.url,
        createdAt: job.createdAt,
      };

      if (job.status === 'completed' && job.result) {
        response.result = job.result;
        response.downloadUrl = `/v1/pdf/${jobId}/download`;
        response.completedAt = job.completedAt;
      }

      if (job.status === 'failed') {
        response.error = job.error;
        response.completedAt = job.completedAt;
      }

      return reply.send({
        success: true,
        data: response,
      });
    } catch (error: any) {
      logger.error({ error: error.message, jobId }, 'Failed to get PDF status');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get PDF capture status.',
      });
    }
  });

  // -- GET /v1/pdf/:jobId/download -- Download captured PDF ----------------------

  app.get('/v1/pdf/:jobId/download', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const { apiKey } = request as AuthenticatedRequest;

    try {
      const job = pdfJobs.get(jobId);

      if (!job) {
        return reply.status(404).send({
          success: false,
          error: 'PDF capture job not found.',
        });
      }

      // Verify ownership
      if (job.userId !== apiKey.userId) {
        return reply.status(403).send({
          success: false,
          error: 'You do not have access to this PDF capture.',
        });
      }

      if (job.status !== 'completed') {
        return reply.status(202).send({
          success: false,
          error: `PDF is not ready yet. Current status: ${job.status}`,
        });
      }

      const buffer = (job as any).buffer;
      if (!buffer) {
        return reply.status(404).send({
          success: false,
          error: 'PDF file no longer available. It may have expired.',
        });
      }

      // Stream the PDF as a downloadable file
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="capture-${jobId}.pdf"`)
        .header('Content-Length', buffer.length)
        .send(buffer);
    } catch (error: any) {
      logger.error({ error: error.message, jobId }, 'PDF download failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to download PDF.',
      });
    }
  });
}
