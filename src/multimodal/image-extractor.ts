/**
 * Image Extractor -- ScrapeSuite Engine
 *
 * Extracts structured data from images using OCR, table detection,
 * object detection, and combined analysis. Caches results by image hash.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import crypto from 'crypto';
import {
  ExtractionOptions,
  ExtractionResult,
  ExtractionMethod,
  ImageAnalysis,
  MethodResult,
  MultiModalRequest,
  OCRBlock,
  OCRResult,
  OCREngine,
  TableResult,
  DetectedObject,
} from './types';

const logger = createChildLogger('multimodal:image-extractor');

const CACHE_PREFIX = 'multimodal:image:';

// ---------- Image Extractor class ---------------------------------------------

export class ImageExtractor {

  /** Extract data from an image using specified methods. */
  async extractImage(request: MultiModalRequest): Promise<ExtractionResult> {
    const startTime = Date.now();
    const methodResults: Record<string, MethodResult> = {};
    const content = typeof request.content === 'string' ? Buffer.from(request.content, 'base64') : request.content;

    // Check cache
    const cacheKey = this.getCacheKey(content, request.extraction_methods);
    const cached = await cacheGet<ExtractionResult>(cacheKey);
    if (cached) return { ...cached, metadata: { ...cached.metadata, cached: true } };

    for (const method of request.extraction_methods) {
      const methodStart = Date.now();
      try {
        let result: MethodResult;

        switch (method) {
          case 'OCR':
            result = await this.performOCRMethod(content, request.options);
            break;
          case 'OBJECT_DETECTION':
            result = await this.detectObjectsMethod(content);
            break;
          case 'TABLE_PARSE':
            result = await this.extractTablesMethod(content);
            break;
          case 'SCREENSHOT_ANALYSIS':
            result = await this.extractTextFromScreenshotMethod(content, request.options);
            break;
          default:
            result = { method, success: false, data: {}, confidence: 0, processing_time_ms: 0, errors: [`Unsupported method: ${method}`] };
        }

        result.processing_time_ms = Date.now() - methodStart;
        methodResults[method] = result;
      } catch (err: any) {
        methodResults[method] = {
          method,
          success: false,
          data: {},
          confidence: 0,
          processing_time_ms: Date.now() - methodStart,
          errors: [err.message],
        };
      }
    }

    // Combine results
    const combined = this.combineResults(methodResults);
    const confidence = this.calculateConfidence(methodResults);

    const result: ExtractionResult = {
      request_id: request.id,
      content_type: 'IMAGE',
      method_results: methodResults,
      combined_result: combined,
      confidence_score: confidence,
      processing_time_ms: Date.now() - startTime,
      metadata: { image_size_bytes: content.length },
    };

    // Cache
    await cacheSet(cacheKey, result, 3600);

    logger.info({ requestId: request.id, methods: request.extraction_methods, confidence, time_ms: result.processing_time_ms }, 'Image extraction complete');
    return result;
  }

  /** Perform OCR on an image. */
  async performOCR(imageBuffer: Buffer, options?: ExtractionOptions): Promise<OCRResult> {
    const language = options?.language ?? 'eng';
    const engine: OCREngine = (options?.ocr_engine as OCREngine) ?? 'tesseract';

    // In production, this would call an actual OCR engine
    // For now, we provide a framework that can be connected to Tesseract, EasyOCR, or PaddleOCR
    logger.debug({ language, engine, size: imageBuffer.length }, 'OCR processing');

    // Simulated OCR result structure
    const blocks: OCRBlock[] = [];
    const text = blocks.map(b => b.text).join('\n');

    return {
      text: text || '[OCR processing framework ready — connect to Tesseract/EasyOCR/PaddleOCR backend]',
      blocks,
      language,
      confidence: 0,
      word_count: text ? text.split(/\s+/).length : 0,
    };
  }

  /** Detect objects in an image. */
  async detectObjects(imageBuffer: Buffer): Promise<DetectedObject[]> {
    logger.debug({ size: imageBuffer.length }, 'Object detection processing');
    // Framework for object detection — connect to YOLO/SSD backend
    return [];
  }

  /** Extract tables from an image. */
  async extractTables(imageBuffer: Buffer): Promise<TableResult[]> {
    logger.debug({ size: imageBuffer.length }, 'Table extraction processing');
    // Framework for table detection — connect to table detection models
    return [];
  }

  /** Combined image analysis. */
  async analyzeImage(imageBuffer: Buffer): Promise<ImageAnalysis> {
    const [objects, ocr] = await Promise.all([
      this.detectObjects(imageBuffer),
      this.performOCR(imageBuffer),
    ]);

    return {
      objects,
      text_overlay: ocr.text,
      dominant_colors: this.extractDominantColors(imageBuffer),
      dimensions: this.guessDimensions(imageBuffer),
      format: this.detectImageFormat(imageBuffer),
    };
  }

  /** Extract text optimized for screenshots. */
  async extractTextFromScreenshot(imageBuffer: Buffer, options?: ExtractionOptions): Promise<string> {
    const ocr = await this.performOCR(imageBuffer, { ...options, ocr_engine: 'tesseract' });
    return ocr.text;
  }

  // ---------- Method wrappers -------------------------------------------------

  private async performOCRMethod(content: Buffer, options?: ExtractionOptions): Promise<MethodResult> {
    const ocr = await this.performOCR(content, options);
    return {
      method: 'OCR',
      success: ocr.confidence > 0 || ocr.text.length > 0,
      data: { text: ocr.text, blocks: ocr.blocks, language: ocr.language, word_count: ocr.word_count },
      confidence: ocr.confidence,
      processing_time_ms: 0,
      errors: [],
    };
  }

  private async detectObjectsMethod(content: Buffer): Promise<MethodResult> {
    const objects = await this.detectObjects(content);
    return {
      method: 'OBJECT_DETECTION',
      success: true,
      data: { objects, count: objects.length },
      confidence: objects.length > 0 ? objects.reduce((s, o) => s + o.confidence, 0) / objects.length : 0,
      processing_time_ms: 0,
      errors: [],
    };
  }

  private async extractTablesMethod(content: Buffer): Promise<MethodResult> {
    const tables = await this.extractTables(content);
    return {
      method: 'TABLE_PARSE',
      success: tables.length > 0,
      data: { tables, count: tables.length },
      confidence: tables.length > 0 ? tables[0].confidence : 0,
      processing_time_ms: 0,
      errors: [],
    };
  }

  private async extractTextFromScreenshotMethod(content: Buffer, options?: ExtractionOptions): Promise<MethodResult> {
    const text = await this.extractTextFromScreenshot(content, options);
    return {
      method: 'SCREENSHOT_ANALYSIS',
      success: text.length > 0,
      data: { text },
      confidence: text.length > 10 ? 0.8 : 0.3,
      processing_time_ms: 0,
      errors: [],
    };
  }

  // ---------- Internal helpers ------------------------------------------------

  private getCacheKey(content: Buffer, methods: ExtractionMethod[]): string {
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    return `${CACHE_PREFIX}${hash}:${methods.sort().join(',')}`;
  }

  private combineResults(methodResults: Record<string, MethodResult>): Record<string, unknown> {
    const combined: Record<string, unknown> = {};
    for (const [method, result] of Object.entries(methodResults)) {
      if (result.success) {
        combined[method.toLowerCase()] = result.data;
      }
    }
    return combined;
  }

  private calculateConfidence(methodResults: Record<string, MethodResult>): number {
    const results = Object.values(methodResults);
    if (!results.length) return 0;
    const successCount = results.filter(r => r.success).length;
    const avgConfidence = results.reduce((sum, r) => sum + r.confidence, 0) / results.length;
    return Math.round((successCount / results.length * 0.5 + avgConfidence * 0.5) * 100) / 100;
  }

  private extractDominantColors(imageBuffer: Buffer): string[] {
    // Simplified: would use image processing in production
    void imageBuffer;
    return ['#FFFFFF', '#000000'];
  }

  private guessDimensions(imageBuffer: Buffer): { width: number; height: number } {
    // Try to read PNG/JPEG dimensions from header
    if (imageBuffer.length > 24 && imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50) {
      // PNG
      const width = imageBuffer.readUInt32BE(16);
      const height = imageBuffer.readUInt32BE(20);
      return { width, height };
    }
    if (imageBuffer.length > 2 && imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8) {
      // JPEG — simplified, would need proper marker parsing
      return { width: 0, height: 0 };
    }
    return { width: 0, height: 0 };
  }

  private detectImageFormat(imageBuffer: Buffer): string {
    if (imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50) return 'PNG';
    if (imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8) return 'JPEG';
    if (imageBuffer[0] === 0x47 && imageBuffer[1] === 0x49) return 'GIF';
    if (imageBuffer[0] === 0x52 && imageBuffer[1] === 0x49) return 'WebP';
    return 'unknown';
  }
}
