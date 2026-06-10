/**
 * Multi-Modal Manager -- ScrapeSuite Engine
 *
 * Main orchestrator for multi-modal content extraction. Routes
 * requests to the appropriate extractor based on content type,
 * supports multiple methods on the same content, and provides
 * batch processing capabilities.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import { ImageExtractor } from './image-extractor';
import { PDFExtractor } from './pdf-extractor';
import { AudioExtractor } from './audio-extractor';
import { VideoExtractor } from './video-extractor';
import {
  ContentType,
  ExtractionMethod,
  ExtractionResult,
  MultiModalRequest,
  MultiModalStats,
} from './types';

const logger = createChildLogger('multimodal:manager');

const STATS_KEY = 'multimodal:stats';

// ---------- Content type detection from magic bytes ---------------------------

const MAGIC_BYTES: [number[], ContentType][] = [
  [[0x89, 0x50, 0x4E, 0x47], 'IMAGE'], // PNG
  [[0xFF, 0xD8], 'IMAGE'],               // JPEG
  [[0x47, 0x49, 0x46], 'IMAGE'],         // GIF
  [[0x52, 0x49, 0x46, 0x46], 'IMAGE'],   // WebP (RIFF)
  [[0x25, 0x50, 0x44, 0x46], 'PDF'],     // PDF (%PDF)
  [[0x49, 0x44, 0x33], 'AUDIO'],         // MP3 (ID3)
  [[0x66, 0x4C, 0x61, 0x43], 'AUDIO'],   // FLAC
  [[0x4F, 0x67, 0x67, 0x53], 'AUDIO'],   // OGG
  [[0x00, 0x00, 0x00, 0x18], 'VIDEO'],   // MP4
  [[0x1A, 0x45, 0xDF, 0xA3], 'VIDEO'],   // MKV/WebM
];

function detectContentType(buffer: Buffer): ContentType | null {
  for (const [magic, type] of MAGIC_BYTES) {
    if (magic.every((byte, i) => buffer[i] === byte)) {
      return type;
    }
  }
  return null;
}

// ---------- Multi-Modal Manager class -----------------------------------------

export class MultiModalManager {
  private imageExtractor: ImageExtractor;
  private pdfExtractor: PDFExtractor;
  private audioExtractor: AudioExtractor;
  private videoExtractor: VideoExtractor;

  constructor() {
    this.imageExtractor = new ImageExtractor();
    this.pdfExtractor = new PDFExtractor();
    this.audioExtractor = new AudioExtractor();
    this.videoExtractor = new VideoExtractor();
  }

  /** Extract data from a multi-modal request. */
  async extract(request: Omit<MultiModalRequest, 'id'>): Promise<ExtractionResult> {
    const fullRequest: MultiModalRequest = { ...request, id: uuid() };

    // Auto-detect content type if TEXT (auto-detect placeholder)
    let contentType = fullRequest.content_type;
    if (contentType === 'TEXT') {
      const content = typeof fullRequest.content === 'string' ? Buffer.from(fullRequest.content, 'base64') : fullRequest.content;
      const detected = detectContentType(content);
      if (detected) {
        contentType = detected;
        fullRequest.content_type = detected;
      }
    }

    // Route to correct extractor
    let result: ExtractionResult;

    switch (contentType) {
      case 'IMAGE':
      case 'SVG':
        result = await this.imageExtractor.extractImage(fullRequest);
        break;
      case 'PDF':
      case 'DOCUMENT':
        result = await this.pdfExtractor.extractPDF(fullRequest);
        break;
      case 'AUDIO':
        result = await this.audioExtractor.extractAudio(fullRequest);
        break;
      case 'VIDEO':
        result = await this.videoExtractor.extractVideo(fullRequest);
        break;
      case 'HTML_TABLE':
        result = await this.extractHTMLTable(fullRequest);
        break;
      case 'TEXT':
      default:
        result = await this.extractText(fullRequest);
        break;
    }

    // Update stats
    const hasSuccess = Object.values(result.method_results).some(m => m.success);
    await this.updateStats(contentType, fullRequest.extraction_methods, hasSuccess ? 'success' : 'failure', result.processing_time_ms);

    return result;
  }

  /** Process multiple extraction requests in batch. */
  async extractBatch(requests: Omit<MultiModalRequest, 'id'>[]): Promise<ExtractionResult[]> {
    const results: ExtractionResult[] = [];
    for (const request of requests) {
      try {
        const result = await this.extract(request);
        results.push(result);
      } catch (err: any) {
        results.push({
          request_id: uuid(),
          content_type: request.content_type,
          method_results: {},
          combined_result: {},
          confidence_score: 0,
          processing_time_ms: 0,
          metadata: { error: err.message },
        });
      }
    }
    return results;
  }

  /** Get supported extraction methods for a content type. */
  getSupportedMethods(contentType: ContentType): ExtractionMethod[] {
    switch (contentType) {
      case 'IMAGE':
      case 'SVG':
        return ['OCR', 'OBJECT_DETECTION', 'TABLE_PARSE', 'SCREENSHOT_ANALYSIS', 'LLM_ANALYSIS'];
      case 'PDF':
      case 'DOCUMENT':
        return ['STRUCTURED_READ', 'TABLE_PARSE', 'OCR', 'LLM_ANALYSIS'];
      case 'AUDIO':
        return ['SPEECH_TO_TEXT', 'LLM_ANALYSIS'];
      case 'VIDEO':
        return ['SCREENSHOT_ANALYSIS', 'SPEECH_TO_TEXT', 'OCR', 'LLM_ANALYSIS'];
      case 'HTML_TABLE':
        return ['TABLE_PARSE', 'STRUCTURED_READ'];
      case 'TEXT':
        return ['STRUCTURED_READ', 'LLM_ANALYSIS'];
      default:
        return ['LLM_ANALYSIS'];
    }
  }

  /** Get aggregate multi-modal statistics. */
  async getStats(): Promise<MultiModalStats> {
    const stats = await cacheGet<MultiModalStats>(STATS_KEY);
    return stats ?? {
      total_requests: 0,
      by_content_type: {},
      by_method: {},
      avg_processing_time_ms: 0,
      success_rate: 0,
    };
  }

  /** Detect content type from a buffer. */
  detectContentType(buffer: Buffer): ContentType | null {
    return detectContentType(buffer);
  }

  // ---------- Internal extractors ---------------------------------------------

  private async extractHTMLTable(request: MultiModalRequest): Promise<ExtractionResult> {
    const startTime = Date.now();
    const content = typeof request.content === 'string' ? request.content : request.content.toString('utf-8');

    // Simple HTML table parser
    const tables: { headers: string[]; rows: string[][] }[] = [];
    const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    let match: RegExpExecArray | null;

    while ((match = tableRegex.exec(content)) !== null) {
      const tableHtml = match[1];
      const headers: string[] = [];
      const rows: string[][] = [];

      // Extract headers
      const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi;
      let thMatch: RegExpExecArray | null;
      while ((thMatch = thRegex.exec(tableHtml)) !== null) {
        headers.push(thMatch[1].replace(/<[^>]+>/g, '').trim());
      }

      // Extract rows
      const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let trMatch: RegExpExecArray | null;
      while ((trMatch = trRegex.exec(tableHtml)) !== null) {
        const cells: string[] = [];
        const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        let tdMatch: RegExpExecArray | null;
        while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
          cells.push(tdMatch[1].replace(/<[^>]+>/g, '').trim());
        }
        if (cells.length) rows.push(cells);
      }

      if (headers.length || rows.length) {
        tables.push({ headers, rows });
      }
    }

    return {
      request_id: request.id,
      content_type: 'HTML_TABLE',
      method_results: {
        TABLE_PARSE: {
          method: 'TABLE_PARSE',
          success: tables.length > 0,
          data: { tables, count: tables.length },
          confidence: tables.length > 0 ? 0.9 : 0,
          processing_time_ms: Date.now() - startTime,
          errors: [],
        },
      },
      combined_result: { tables },
      confidence_score: tables.length > 0 ? 0.9 : 0,
      processing_time_ms: Date.now() - startTime,
      metadata: { table_count: tables.length },
    };
  }

  private async extractText(request: MultiModalRequest): Promise<ExtractionResult> {
    const startTime = Date.now();
    const content = typeof request.content === 'string' ? request.content : request.content.toString('utf-8');

    return {
      request_id: request.id,
      content_type: 'TEXT',
      method_results: {
        STRUCTURED_READ: {
          method: 'STRUCTURED_READ',
          success: true,
          data: { text: content, length: content.length, word_count: content.split(/\s+/).length },
          confidence: 1,
          processing_time_ms: Date.now() - startTime,
          errors: [],
        },
      },
      combined_result: { text: content, length: content.length },
      confidence_score: 1,
      processing_time_ms: Date.now() - startTime,
      metadata: { encoding: 'utf-8' },
    };
  }

  // ---------- Stats tracking --------------------------------------------------

  private async updateStats(
    contentType: ContentType,
    methods: ExtractionMethod[],
    outcome: 'success' | 'failure',
    processingTimeMs: number,
  ): Promise<void> {
    try {
      const stats = await this.getStats();
      stats.total_requests++;
      stats.by_content_type[contentType] = (stats.by_content_type[contentType] ?? 0) + 1;

      for (const method of methods) {
        stats.by_method[method] = (stats.by_method[method] ?? 0) + 1;
      }

      // Running average for processing time
      const prevAvg = stats.avg_processing_time_ms;
      const prevCount = stats.total_requests - 1;
      stats.avg_processing_time_ms = prevCount > 0
        ? Math.round((prevAvg * prevCount + processingTimeMs) / stats.total_requests)
        : processingTimeMs;

      // Running success rate
      const successes = outcome === 'success' ? 1 : 0;
      stats.success_rate = Math.round(((stats.success_rate / 100 * prevCount) + successes) / stats.total_requests * 10000) / 100;

      await cacheSet(STATS_KEY, stats, 86400);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to update multimodal stats');
    }
  }
}

// ---------- Singleton export --------------------------------------------------

export const multiModalManager = new MultiModalManager();
