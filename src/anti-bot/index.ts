/**
 * Anti-Bot Module -- Barrel Exports for ScrapeSuite Engine
 *
 * Unified entry point for all anti-bot bypass functionality.
 * Import from this file for clean, consistent access:
 *
 *   import { antiBotManager, AntiBotPlatform } from './anti-bot';
 */

// --- Types ------------------------------------------------------------------
export type {
  AntiBotPlatform,
  BypassStrategy,
  ChallengePhase,
  DetectionSeverity,
  AntiBotResult,
  AntiBotPlatformConfig,
  AntiBotManagerConfig,
  AntiBotManagerStats,
  BypassContext,
  PlatformDetectionResult,
  DetectionIndicator,
  ManagedCookie,
  PlatformProfile,
  IAntiBotModule,
} from './types';

export {
  PLATFORM_NAMES,
  STRATEGY_ESCALATION,
  DEFAULT_PLATFORM_CONFIGS,
} from './types';

// --- Base Class -------------------------------------------------------------
export { AntiBotBase } from './base';

// --- Manager ----------------------------------------------------------------
export { antiBotManager, default as AntiBotManager } from './manager';

// --- Platform Modules -------------------------------------------------------
export { kasadaChallenger, default as KasadaChallengeOrchestrator } from './kasada-challenger';
export { akamaiSensorEngine } from './akamai-sensor';
export { akamaiHydra, default as AkamaiHydra } from './akamai-hydra';
export { cloudflareTurnstileSolver } from './cloudflare-turnstyle';
export { datadomeCircumvent } from './datadome-circumvent';
export { perimeterxEvader } from './perimeterx-evader';

// --- Kasada Sub-Modules -----------------------------------------------------
export { default as KasadaSwProxy } from './kasada-sw-proxy';
export { default as KasadaBehaviorEngine } from './kasada-behavior';
export { default as KasadaFingerprintSupplement } from './kasada-fingerprint';

// --- Core Modules -----------------------------------------------------------
export { deepBrowserPatcher, DeepBrowserPatcher, DEFAULT_DEEP_PATCH_CONFIG } from './deep-patcher';
export type { DeepPatchConfig, DeepPatchResult } from './deep-patcher';
export { stealthBrowserEngine } from './stealth-browser';
export type { StealthLaunchOptions, StealthBrowserResult } from './stealth-browser';
export { cdpInjectionEngine, CdpInjectionEngine } from './cdp-injection';
export { tlsFingerprintEngine, TlsFingerprintEngine } from './tls-fingerprint';
export { fingerprintConsistencyEngine, FingerprintConsistencyEngine } from './fingerprint-consistency';
export { humanBehaviorEngine, HumanBehaviorEngine } from './human-behavior';
export { profileGenerator, ProfileGenerator } from './profile-generator';
export { requestPacer } from './request-pacer';
export { stealthEngine } from './stealth';
export { canvasSpoofer, CanvasSpoofer, getCanvasSpoofScript, getCanvasSpoofStats, resetCanvasSpoofStats, deriveSeedFromProfileId, XorShift128Plus, DEFAULT_CANVAS_SPOOF_CONFIG } from './canvas-spoofer';
export type { CanvasSpoofConfig, CanvasSpoofStats } from './canvas-spoofer';
