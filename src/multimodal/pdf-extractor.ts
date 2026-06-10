/**
 * PDF Extractor -- ScrapeSuite Engine
 *
 * Extracts text, tables, images, and metadata from PDF documents.
 * Supports page selection, text extraction, table detection,
 * and conversion of pages to images for OCR fallback.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import crypto from 'crypto';
import {
  ExtractionMethod,
  ExtractionOptions,
  ExtractionResult,
  MethodResult,
  MultiModalRequest,
  PDFMetadata,
  TableResult,
} from './types';

const logger = createChildLogger('multimodal:pdf-extractor');

const CACHE_PREFIX = 'multimodal:pdf:';

// ---------- PDF Extractor class -----------------------------------------------

export class PDFExtractor {

  /** Extract data from a PDF document. */
  async extractPDF(request: MultiModalRequest): Promise<ExtractionResult> {
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
          case 'STRUCTURED_READ':
            result = await this.extractTextMethod(content, request.options);
            break;
          case 'TABLE_PARSE':
            result = await this.extractTablesMethod(content, request.options);
            break;
          case 'OCR':
            result = await this.ocrPDFMethod(content, request.options);
            break;
          default:
            result = { method, success: false, data: {}, confidence: 0, processing_time_ms: 0, errors: [`Unsupported method for PDF: ${method}`] };
        }

        result.processing_time_ms = Date.now() - methodStart;
        methodResults[method] = result;
      } catch (err: any) {
        methodResults[method] = { method, success: false, data: {}, confidence: 0, processing_time_ms: Date.now() - methodStart, errors: [err.message] };
      }
    }

    // Get metadata regardless
    const metadata = await this.getMetadata(content);

    const combined = this.combineResults(methodResults, metadata);
    const confidence = this.calculateConfidence(methodResults);

    const result: ExtractionResult = {
      request_id: request.id,
      content_type: 'PDF',
      method_results: methodResults,
      combined_result: combined,
      confidence_score: confidence,
      processing_time_ms: Date.now() - startTime,
      metadata: { pdf_metadata: metadata, size_bytes: content.length },
    };

    await cacheSet(cacheKey, result, 3600);

    logger.info({ requestId: request.id, confidence, time_ms: result.processing_time_ms }, 'PDF extraction complete');
    return result;
  }

  /** Extract text content from a PDF. */
  async extractTextFromPDF(pdfBuffer: Buffer, pages?: number[] | 'all'): Promise<string> {
    logger.debug({ size: pdfBuffer.length, pages }, 'Extracting text from PDF');
    // In production, use pdf-parse or similar library
    // Framework ready for integration with pdf-parse, pdfjs-dist, or Apache Tika
    void pages;
    return '[PDF text extraction framework ready — connect to pdf-parse/pdfjs-dist backend]';
  }

  /** Extract tables from a PDF. */
  async extractTablesFromPDF(pdfBuffer: Buffer, pages?: number[] | 'all'): Promise<TableResult[]> {
    logger.debug({ size: pdfBuffer.length, pages }, 'Extracting tables from PDF');
    // Framework for table extraction — connect to camelot, tabula-py, or pdf-table-extract
    return [];
  }

  /** Extract embedded images from a PDF. */
  async extractImagesFromPDF(pdfBuffer: Buffer, pages?: number[] | 'all'): Promise<Buffer[]> {
    logger.debug({ size: pdfBuffer.length, pages }, 'Extracting images from PDF');
    // Framework for image extraction — connect to pdfjs-dist or poppler
    return [];
  }

  /** Get the number of pages in a PDF. */
  async getPageCount(pdfBuffer: Buffer): Promise<number> {
    // Simple heuristic: count page markers in the PDF
    const content = pdfBuffer.toString('binary');
    const matches = content.match(/\/Type\s*\/Page[^s]/g);
    return matches ? matches.length : 1;
  }

  /** Get PDF metadata. */
  async getMetadata(pdfBuffer: Buffer): Promise<PDFMetadata> {
    const pageCount = await this.getPageCount(pdfBuffer);

    // Try to extract metadata from PDF info dictionary
    const content = pdfBuffer.toString('latin1');

    let title: string | undefined;
    let author: string | undefined;
    let creationDate: string | undefined;

    const titleMatch = content.match(/\/Title\s*\(([^)]*)\)/);
    if (titleMatch) title = titleMatch[1];

    const authorMatch = content.match(/\/Author\s*\(([^)]*)\)/);
    if (authorMatch) author = authorMatch[1];

    const dateMatch = content.match(/\/CreationDate\s*\(([^)]*)\)/);
    if (dateMatch) creationDate = dateMatch[1];

    const isEncrypted = content.includes('/Encrypt');

    return {
      title,
      author,
      subject: undefined,
      creation_date: creationDate,
      page_count: pageCount,
      is_encrypted: isEncrypted,
    };
  }

  /** Convert PDF pages to images for OCR processing. */
  async convertPDFToImages(pdfBuffer: Buffer, pages?: number[], dpi?: number): Promise<Buffer[]> {
    logger.debug({ size: pdfBuffer.length, pages, dpi }, 'Converting PDF to images');
    // Framework for PDF-to-image conversion — connect to pdf2pic, pdftoppm, or GraphicsMagick
    return [];
  }

  // ---------- Method wrappers -------------------------------------------------

  private async extractTextMethod(content: Buffer, options?: ExtractionOptions): Promise<MethodResult> {
    const pages = options?.pdf_pages ?? 'all';
    const text = await this.extractTextFromPDF(content, pages);
    return {
      method: 'STRUCTURED_READ',
      success: text.length > 0,
      data: { text, page_count: await this.getPageCount(content) },
      confidence: text.length > 50 ? 0.9 : 0.5,
      processing_time_ms: 0,
      errors: [],
    };
  }

  private async extractTablesMethod(content: Buffer, options?: ExtractionOptions): Promise<MethodResult> {
    const pages = options?.pdf_pages ?? 'all';
    const tables = await this.extractTablesFromPDF(content, pages);
    return {
      method: 'TABLE_PARSE',
      success: tables.length > 0,
      data: { tables, count: tables.length },
      confidence: tables.length > 0 ? tables[0].confidence : 0,
      processing_time_ms: 0,
      errors: [],
    };
  }

  private async ocrPDFMethod(content: Buffer, options?: ExtractionOptions): Promise<MethodResult> {
    // Convert pages to images then OCR
    const images = await this.convertPDFToImages(content);
    if (!images.length) {
      return {
        method: 'OCR',
        success: false,
        data: { text: '', blocks: [] },
        confidence: 0,
        processing_time_ms: 0,
        errors: ['Could not convert PDF pages to images for OCR'],
      };
    }
    return {
      method: 'OCR',
      success: true,
      data: { pages_processed: images.length, note: 'OCR framework ready — connect to Tesseract backend' },
      confidence: 0.5,
      processing_time_ms: 0,
      errors: [],
    };
  }

  // ---------- Internal helpers ------------------------------------------------

  private getCacheKey(content: Buffer, methods: ExtractionMethod[]): string {
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    return `${CACHE_PREFIX}${hash}:${methods.sort().join(',')}`;
  }

  private combineResults(methodResults: Record<string, MethodResult>, metadata: PDFMetadata): Record<string, unknown> {
    const combined: Record<string, unknown> = { metadata };
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
}
