/**
 * Multi-Modal Extraction -- ScrapeSuite Engine
 *
 * Extracts structured data from non-text content: images (OCR, object
 * detection), PDFs, audio (speech-to-text), video, and HTML tables.
 * Provides a unified interface with multiple extraction methods per
 * content type and batch processing support.
 */

export { ImageExtractor } from './image-extractor';
export { PDFExtractor } from './pdf-extractor';
export { AudioExtractor } from './audio-extractor';
export { VideoExtractor } from './video-extractor';
export { MultiModalManager, multiModalManager } from './manager';
export * from './types';
