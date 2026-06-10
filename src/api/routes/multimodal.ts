/**
 * Multi-Modal Extraction API Routes -- ScrapeSuite Engine
 *
 * REST API endpoints for multi-modal content extraction including
 * images, PDFs, audio, video, and HTML tables.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { multiModalManager } from '../../multimodal';
import { ContentType, ExtractionMethod } from '../../multimodal/types';

interface ExtractBody {
  content_type: ContentType;
  content: string; // Base64 encoded for binary, plain text for text types
  extraction_methods: ExtractionMethod[];
  language?: string;
  ocr_engine?: 'tesseract' | 'easyocr' | 'paddleocr';
  image_dpi?: number;
  pdf_pages?: number[] | 'all';
  audio_language?: string;
  video_frame_interval_ms?: number;
  confidence_threshold?: number;
}

interface BatchExtractBody {
  requests: ExtractBody[];
}

export async function multimodalRoutes(app: FastifyInstance): Promise<void> {

  // Extract data from content
  app.post('/v1/multimodal/extract', async (req: FastifyRequest<{ Body: ExtractBody }>, reply: FastifyReply) => {
    const { content_type, content, extraction_methods, language, ocr_engine, image_dpi, pdf_pages, audio_language, video_frame_interval_ms, confidence_threshold } = req.body;

    if (!content_type || !content || !extraction_methods?.length) {
      return reply.status(400).send({ error: 'content_type, content, and extraction_methods are required' });
    }

    const result = await multiModalManager.extract({
      content_type,
      content: Buffer.from(content, 'base64'),
      extraction_methods,
      options: {
        language,
        ocr_engine,
        image_dpi,
        pdf_pages,
        audio_language,
        video_frame_interval_ms,
        confidence_threshold,
      },
    });

    return reply.send(result);
  });

  // Batch extraction
  app.post('/v1/multimodal/extract/batch', async (req: FastifyRequest<{ Body: BatchExtractBody }>, reply) => {
    const { requests } = req.body;
    if (!requests?.length) {
      return reply.status(400).send({ error: 'requests array is required' });
    }

    const extractRequests = requests.map(r => ({
      content_type: r.content_type,
      content: Buffer.from(r.content, 'base64') as Buffer | string,
      extraction_methods: r.extraction_methods,
      options: {
        language: r.language,
        ocr_engine: r.ocr_engine,
        image_dpi: r.image_dpi,
        pdf_pages: r.pdf_pages,
        audio_language: r.audio_language,
        video_frame_interval_ms: r.video_frame_interval_ms,
        confidence_threshold: r.confidence_threshold,
      },
    }));

    const results = await multiModalManager.extractBatch(extractRequests);
    return reply.send({ results });
  });

  // Get supported methods for a content type
  app.get('/v1/multimodal/methods/:contentType', async (req: FastifyRequest<{ Params: { contentType: string } }>, reply) => {
    const methods = multiModalManager.getSupportedMethods(req.params.contentType as ContentType);
    return reply.send({ content_type: req.params.contentType, methods });
  });

  // Get multimodal statistics
  app.get('/v1/multimodal/stats', async (_req, reply) => {
    const stats = await multiModalManager.getStats();
    return reply.send(stats);
  });

  // Detect content type from base64-encoded binary data
  app.post('/v1/multimodal/detect-type', async (req: FastifyRequest<{ Body: { content: string } }>, reply) => {
    const { content } = req.body;
    if (!content) {
      return reply.status(400).send({ error: 'content (base64 encoded) is required' });
    }
    const buffer = Buffer.from(content, 'base64');
    const detectedType = multiModalManager.detectContentType(buffer);
    return reply.send({ detected_type: detectedType, size_bytes: buffer.length });
  });
}
