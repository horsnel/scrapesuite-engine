/**
 * Multi-Modal Extraction Types -- ScrapeSuite Engine
 *
 * Type definitions for extracting structured data from non-text
 * content including images (OCR), PDFs, audio, and video.
 */

/** Supported content types for multi-modal extraction. */
export type ContentType = 'TEXT' | 'IMAGE' | 'PDF' | 'AUDIO' | 'VIDEO' | 'HTML_TABLE' | 'SVG' | 'DOCUMENT';

/** Available extraction methods. */
export type ExtractionMethod = 'OCR' | 'OBJECT_DETECTION' | 'SPEECH_TO_TEXT' | 'TABLE_PARSE' | 'STRUCTURED_READ' | 'LLM_ANALYSIS' | 'SCREENSHOT_ANALYSIS';

/** OCR engine options. */
export type OCREngine = 'tesseract' | 'easyocr' | 'paddleocr';

/** A multi-modal extraction request. */
export interface MultiModalRequest {
  id: string;
  content_type: ContentType;
  content: Buffer | string;
  extraction_methods: ExtractionMethod[];
  options: ExtractionOptions;
  callback_url?: string;
}

/** Options for fine-tuning extraction behavior. */
export interface ExtractionOptions {
  language?: string;
  ocr_engine?: OCREngine;
  image_dpi?: number;
  pdf_pages?: number[] | 'all';
  audio_language?: string;
  video_frame_interval_ms?: number;
  confidence_threshold?: number;
  output_schema?: Record<string, unknown>;
}

/** The result of a multi-modal extraction. */
export interface ExtractionResult {
  request_id: string;
  content_type: ContentType;
  method_results: Record<string, MethodResult>;
  combined_result: Record<string, unknown>;
  confidence_score: number;
  processing_time_ms: number;
  metadata: Record<string, unknown>;
}

/** Result from a single extraction method. */
export interface MethodResult {
  method: ExtractionMethod;
  success: boolean;
  data: Record<string, unknown>;
  confidence: number;
  processing_time_ms: number;
  errors: string[];
}

/** OCR extraction result with block-level detail. */
export interface OCRResult {
  text: string;
  blocks: OCRBlock[];
  language: string;
  confidence: number;
  word_count: number;
}

/** A single block detected by OCR. */
export interface OCRBlock {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  confidence: number;
  block_type: 'text' | 'heading' | 'table' | 'image' | 'caption';
}

/** Table extraction result. */
export interface TableResult {
  headers: string[];
  rows: string[][];
  row_count: number;
  confidence: number;
  bbox?: { x: number; y: number; width: number; height: number };
}

/** Image analysis result. */
export interface ImageAnalysis {
  objects: DetectedObject[];
  text_overlay: string;
  dominant_colors: string[];
  dimensions: { width: number; height: number };
  format: string;
}

/** A detected object in an image. */
export interface DetectedObject {
  label: string;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
  category: string;
}

/** Audio transcription result. */
export interface AudioTranscription {
  text: string;
  segments: TranscriptSegment[];
  language: string;
  duration_seconds: number;
}

/** A segment of transcribed audio. */
export interface TranscriptSegment {
  text: string;
  start_time: number;
  end_time: number;
  confidence: number;
  speaker?: string;
}

/** Video extraction result. */
export interface VideoExtraction {
  frames_extracted: number;
  key_frames: VideoFrame[];
  transcription?: AudioTranscription;
  duration_seconds: number;
}

/** A single extracted video frame. */
export interface VideoFrame {
  timestamp_ms: number;
  image_base64: string;
  ocr_text?: string;
  objects?: DetectedObject[];
}

/** PDF metadata. */
export interface PDFMetadata {
  title?: string;
  author?: string;
  subject?: string;
  creation_date?: string;
  page_count: number;
  is_encrypted: boolean;
}

/** Video metadata. */
export interface VideoMetadata {
  duration_seconds: number;
  width: number;
  height: number;
  codec: string;
  fps: number;
  has_audio: boolean;
}

/** Aggregate multi-modal statistics. */
export interface MultiModalStats {
  total_requests: number;
  by_content_type: Record<string, number>;
  by_method: Record<string, number>;
  avg_processing_time_ms: number;
  success_rate: number;
}
