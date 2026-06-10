/**
 * Device Farm Types — ScrapeSuite Engine
 *
 * Type definitions for the device fingerprint management system.
 * Netflix and Google use advanced fingerprinting (Canvas, WebGL,
 * AudioContext, fonts) to detect bots. This module provides
 * pre-built consistent fingerprint sets that pass cross-validation.
 */

// ===============================================================================
// FINGERPRINT TYPES
// ===============================================================================

export type FingerprintCategory = 'desktop-windows' | 'desktop-mac' | 'desktop-linux' | 'mobile-ios' | 'mobile-android' | 'tablet';

export interface DeviceFingerprint {
  id: string;
  category: FingerprintCategory;
  name: string;

  // Navigator properties
  userAgent: string;
  platform: string;
  vendor: string;
  language: string;
  languages: string[];
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  cookieEnabled: boolean;
  doNotTrack: string | null;

  // Screen properties
  screenWidth: number;
  screenHeight: number;
  availableWidth: number;
  availableHeight: number;
  colorDepth: number;
  pixelDepth: number;
  devicePixelRatio: number;

  // GPU/WebGL properties
  webglVendor: string;
  webglRenderer: string;
  webglExtensions: string[];
  webglHash: string;

  // Canvas fingerprint
  canvasHash: string;
  canvasDataUrl: string;

  // AudioContext fingerprint
  audioHash: string;
  audioSampleRate: number;
  audioFrequencyData: number[];

  // Font enumeration
  detectedFonts: string[];
  fontHash: string;

  // Plugin list
  plugins: Array<{ name: string; description: string; filename: string }>;
  mimeTypes: string[];

  // Consistency hash (ensures all components match)
  consistencyHash: string;

  // Popularity score (more popular = harder to detect as bot)
  popularityScore: number;

  // Which sites this fingerprint is known to work on
  compatibleSites: string[];

  // Creation and usage metadata
  createdAt: number;
  lastUsed: number;
  useCount: number;
  blockCount: number;
  successRate: number;
}

// ===============================================================================
// GPU EMULATION TYPES
// ===============================================================================

export interface GPUProfile {
  vendor: string;
  renderer: string;
  extensions: string[];
  maxTextureSize: number;
  maxRenderbufferSize: number;
  maxViewportDims: [number, number];
  maxCubeMapTextureSize: number;
  maxTextureImageUnits: number;
  maxVertexTextureImageUnits: number;
  maxCombinedTextureImageUnits: number;
  maxVertexAttribs: number;
  maxVertexUniformVectors: number;
  maxFragmentUniformVectors: number;
  maxVaryingVectors: number;
  unmaskedVendor: string;
  unmaskedRenderer: string;
  antialiasing: boolean;
}

// ===============================================================================
// CANVAS EMULATION TYPES
// ===============================================================================

export type CanvasOperation = 'text' | 'gradient' | 'arc' | 'bezier' | 'image';

export interface CanvasConfig {
  width: number;
  height: number;
  operations: CanvasOperation[];
  font: string;
  fillStyle: string;
  strokeStyle: string;
  globalCompositeOperation: string;
  textBaseline: string;
  textRendering: string;
}

export interface CanvasResult {
  hash: string;
  dataUrl: string;
  width: number;
  height: number;
  operationCount: number;
}

// ===============================================================================
// AUDIO EMULATION TYPES
// ===============================================================================

export interface AudioProfile {
  sampleRate: number;
  channelCount: number;
  fftSize: number;
  frequencyBinCount: number;
  minDecibels: number;
  maxDecibels: number;
  smoothingTimeConstant: number;
  hash: string;
  frequencyData: number[];
  timeDomainData: number[];
}

// ===============================================================================
// CONSISTENCY ENGINE TYPES
// ===============================================================================

export type ConsistencyCheck = 'navigator_screen' | 'webgl_canvas' | 'audio_webgl' | 'fonts_platform' | 'plugins_ua' | 'memory_cores' | 'touch_mobile' | 'dpi_screen';

export interface ConsistencyResult {
  check: ConsistencyCheck;
  passed: boolean;
  score: number; // 0-1
  details: string;
  autoFixed: boolean;
}

export interface ConsistencyReport {
  fingerprintId: string;
  overallScore: number; // 0-1
  checks: ConsistencyResult[];
  warnings: string[];
  autoFixes: string[];
  isUsable: boolean;
}

// ===============================================================================
// DEVICE FARM CONFIG
// ===============================================================================

export interface DeviceFarmConfig {
  /** Minimum number of fingerprints per category */
  minPerCategory: number;
  /** Whether to auto-generate new fingerprints when pool is low */
  autoGenerate: boolean;
  /** Whether to auto-retire fingerprints with low success rates */
  autoRetire: boolean;
  /** Minimum success rate to keep a fingerprint (0-1) */
  minSuccessRate: number;
  /** Maximum use count before rotation */
  maxUseCount: number;
  /** Whether to run consistency checks on new fingerprints */
  enforceConsistency: boolean;
  /** Minimum consistency score to use a fingerprint */
  minConsistencyScore: number;
  /** Netflix-specific: preferred fingerprint categories */
  netflixPreferredCategories: FingerprintCategory[];
  /** Google-specific: preferred fingerprint categories */
  googlePreferredCategories: FingerprintCategory[];
}

export interface DeviceFarmStats {
  totalFingerprints: number;
  byCategory: Record<FingerprintCategory, number>;
  avgSuccessRate: number;
  avgConsistency: number;
  retiredCount: number;
  activeCount: number;
  bySite: Record<string, { count: number; avgSuccess: number }>;
}
