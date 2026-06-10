/**
 * Device Farm Module — ScrapeSuite Engine
 *
 * Comprehensive device fingerprint management for defeating Netflix
 * and Google fingerprint-based bot detection. Provides 1000+ pre-built
 * cross-consistent fingerprints with automated validation and repair.
 */

// Types
export type {
  FingerprintCategory, DeviceFingerprint,
  GPUProfile, CanvasOperation, CanvasConfig, CanvasResult,
  AudioProfile, ConsistencyCheck, ConsistencyResult, ConsistencyReport,
  DeviceFarmConfig, DeviceFarmStats,
} from './types';

// Fingerprint Database
export { FingerprintDatabase, fingerprintDatabase } from './fingerprint-database';

// Consistency Engine
export { ConsistencyEngine, consistencyEngine } from './consistency-engine';
