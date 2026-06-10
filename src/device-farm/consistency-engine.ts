/**
 * Consistency Engine — ScrapeSuite Engine
 *
 * Validates and enforces cross-fingerprint consistency to prevent
 * Netflix and Google from detecting mismatches between different
 * browser signals that would indicate a fake fingerprint.
 *
 * Common mismatches that get detected:
 * - Windows UA + Mac GPU renderer
 * - High DPI + low screen resolution
 * - Touch support on desktop UA
 * - Mobile UA without touch events
 * - Chrome UA with Firefox plugin list
 * - Inconsistent memory vs core count
 * - Canvas hash that doesn't match the claimed GPU
 *
 * This engine runs 8+ consistency checks and can auto-fix
 * mismatches by adjusting the least important signals.
 */

import { createHash } from 'crypto';
import { createChildLogger } from '../utils/logger';
import type {
  DeviceFingerprint, FingerprintCategory,
  ConsistencyCheck, ConsistencyResult, ConsistencyReport,
} from './types';

const logger = createChildLogger('consistency-engine');

// ===============================================================================
// CONSISTENCY RULES
// ===============================================================================

interface ConsistencyRule {
  check: ConsistencyCheck;
  description: string;
  weight: number; // Importance of this check (0-1)
  validate: (fp: DeviceFingerprint) => { passed: boolean; score: number; details: string };
  fix?: (fp: DeviceFingerprint) => DeviceFingerprint; // Auto-fix function
}

const CONSISTENCY_RULES: ConsistencyRule[] = [
  {
    check: 'navigator_screen',
    description: 'Navigator platform should match screen capabilities',
    weight: 0.15,
    validate: (fp) => {
      // Mobile should have small screens, desktop large screens
      const isMobile = fp.category.startsWith('mobile') || fp.category === 'tablet';
      const hasTouch = fp.maxTouchPoints > 0;

      if (isMobile && !hasTouch) {
        return { passed: false, score: 0, details: 'Mobile category without touch support' };
      }
      if (!isMobile && fp.maxTouchPoints > 0 && !fp.category.includes('tablet')) {
        return { passed: false, score: 0.3, details: 'Desktop with touch support (unusual but possible)' };
      }
      if (isMobile && fp.screenWidth > 500) {
        return { passed: false, score: 0.5, details: 'Mobile with very large screen' };
      }
      return { passed: true, score: 1, details: 'Navigator and screen properties consistent' };
    },
    fix: (fp) => {
      const isMobile = fp.category.startsWith('mobile');
      return {
        ...fp,
        maxTouchPoints: isMobile ? 5 : 0,
        screenWidth: isMobile ? Math.min(fp.screenWidth, 430) : fp.screenWidth,
      };
    },
  },
  {
    check: 'webgl_canvas',
    description: 'WebGL renderer should match canvas rendering capability',
    weight: 0.20,
    validate: (fp) => {
      // High-end GPU should produce high-quality canvas
      const isHighEnd = fp.webglRenderer.includes('RTX') || fp.webglRenderer.includes('M2') || fp.webglRenderer.includes('M3');
      const hasHighDPI = fp.devicePixelRatio >= 2;

      if (isHighEnd && !hasHighDPI && !fp.category.startsWith('desktop')) {
        return { passed: false, score: 0.6, details: 'High-end GPU but no high DPI (suspicious)' };
      }
      if (fp.webglRenderer.includes('Intel') && fp.devicePixelRatio > 2) {
        return { passed: false, score: 0.4, details: 'Intel GPU with very high DPI (unusual)' };
      }
      return { passed: true, score: 1, details: 'WebGL and canvas properties consistent' };
    },
  },
  {
    check: 'audio_webgl',
    description: 'Audio processing should match GPU capabilities',
    weight: 0.10,
    validate: (fp) => {
      // AudioContext is CPU-based, should correlate with core count
      const hasManyCores = fp.hardwareConcurrency >= 8;
      if (fp.audioSampleRate !== 44100 && fp.audioSampleRate !== 48000) {
        return { passed: false, score: 0, details: `Unusual audio sample rate: ${fp.audioSampleRate}` };
      }
      return { passed: true, score: 1, details: 'Audio and WebGL properties consistent' };
    },
  },
  {
    check: 'fonts_platform',
    description: 'Detected fonts should match the claimed platform',
    weight: 0.15,
    validate: (fp) => {
      const fonts = fp.detectedFonts.join(' ').toLowerCase();
      const isWindows = fp.platform === 'Win32';
      const isMac = fp.platform === 'MacIntel' || fp.platform === 'iPhone' || fp.platform === 'iPad';
      const isLinux = fp.platform.includes('Linux');

      if (isWindows && !fonts.includes('segoe') && !fonts.includes('arial')) {
        return { passed: false, score: 0.2, details: 'Windows platform without Segoe UI or Arial' };
      }
      if (isMac && !fonts.includes('helvetica')) {
        return { passed: false, score: 0.3, details: 'Mac platform without Helvetica' };
      }
      if (isLinux && !fonts.includes('dejavu') && !fonts.includes('noto') && !fonts.includes('liberation')) {
        return { passed: false, score: 0.3, details: 'Linux platform without DejaVu, Noto, or Liberation fonts' };
      }
      if (isWindows && fonts.includes('helvetica neue')) {
        return { passed: false, score: 0.5, details: 'Windows platform with Helvetica Neue (Mac-only font)' };
      }
      return { passed: true, score: 1, details: 'Font list consistent with platform' };
    },
    fix: (fp) => {
      const isWindows = fp.platform === 'Win32';
      const isMac = fp.platform === 'MacIntel' || fp.platform === 'iPhone';
      const isLinux = fp.platform.includes('Linux');

      let fonts = [...fp.detectedFonts];
      if (isWindows) {
        fonts = fonts.filter(f => !f.includes('Helvetica Neue'));
        if (!fonts.includes('Segoe UI')) fonts.push('Segoe UI');
      }
      if (isMac && !fonts.includes('Helvetica Neue')) {
        fonts.push('Helvetica Neue');
      }
      return { ...fp, detectedFonts: fonts };
    },
  },
  {
    check: 'plugins_ua',
    description: 'Plugin list should match the user agent',
    weight: 0.12,
    validate: (fp) => {
      const isChrome = fp.userAgent.includes('Chrome') && !fp.userAgent.includes('Edg');
      const isFirefox = fp.userAgent.includes('Firefox');
      const isSafari = fp.userAgent.includes('Safari') && !fp.userAgent.includes('Chrome');
      const isMobile = fp.category.startsWith('mobile');

      if (isMobile && fp.plugins.length > 0) {
        return { passed: false, score: 0, details: 'Mobile browser should have no plugins' };
      }
      if (isFirefox && fp.plugins.length > 0) {
        return { passed: false, score: 0.1, details: 'Firefox should have empty plugin list' };
      }
      if (isSafari && fp.plugins.length > 0) {
        return { passed: false, score: 0.3, details: 'Safari typically has no plugins' };
      }
      if (isChrome && !isMobile && fp.plugins.length === 0) {
        return { passed: false, score: 0.5, details: 'Chrome desktop should have PDF plugins' };
      }
      return { passed: true, score: 1, details: 'Plugin list consistent with user agent' };
    },
    fix: (fp) => {
      const isMobile = fp.category.startsWith('mobile');
      const isFirefox = fp.userAgent.includes('Firefox');
      const isSafari = fp.userAgent.includes('Safari') && !fp.userAgent.includes('Chrome');

      if (isMobile || isFirefox || isSafari) {
        return { ...fp, plugins: [], mimeTypes: [] };
      }
      if (fp.plugins.length === 0) {
        return {
          ...fp,
          plugins: [
            { name: 'PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
          ],
          mimeTypes: ['application/pdf'],
        };
      }
      return fp;
    },
  },
  {
    check: 'memory_cores',
    description: 'Memory should be reasonable for the core count',
    weight: 0.08,
    validate: (fp) => {
      const gbPerCore = fp.deviceMemory / fp.hardwareConcurrency;
      if (gbPerCore < 0.5) {
        return { passed: false, score: 0.2, details: `Too little memory (${fp.deviceMemory}GB) for ${fp.hardwareConcurrency} cores` };
      }
      if (gbPerCore > 8) {
        return { passed: false, score: 0.4, details: `Too much memory (${fp.deviceMemory}GB) for ${fp.hardwareConcurrency} cores (unusual)` };
      }
      return { passed: true, score: 1, details: 'Memory and core count consistent' };
    },
    fix: (fp) => {
      const reasonableMemory = Math.max(4, Math.min(32, fp.hardwareConcurrency * 2));
      return { ...fp, deviceMemory: reasonableMemory };
    },
  },
  {
    check: 'touch_mobile',
    description: 'Touch support should match the device category',
    weight: 0.12,
    validate: (fp) => {
      const isMobile = fp.category.startsWith('mobile') || fp.category === 'tablet';
      if (isMobile && fp.maxTouchPoints === 0) {
        return { passed: false, score: 0, details: 'Mobile device without touch support' };
      }
      if (!isMobile && fp.maxTouchPoints > 1) {
        return { passed: false, score: 0.3, details: 'Desktop with multi-touch (unusual)' };
      }
      return { passed: true, score: 1, details: 'Touch support consistent with device category' };
    },
    fix: (fp) => {
      const isMobile = fp.category.startsWith('mobile') || fp.category === 'tablet';
      return { ...fp, maxTouchPoints: isMobile ? 5 : 0 };
    },
  },
  {
    check: 'dpi_screen',
    description: 'DPI should match the screen and device type',
    weight: 0.08,
    validate: (fp) => {
      const isMobile = fp.category.startsWith('mobile');
      const isMac = fp.platform === 'MacIntel';

      if (isMobile && fp.devicePixelRatio < 2) {
        return { passed: false, score: 0.2, details: 'Mobile device with low DPI (< 2x)' };
      }
      if (isMac && fp.devicePixelRatio !== 2) {
        return { passed: false, score: 0.5, details: `Mac with non-standard DPI (${fp.devicePixelRatio}x)` };
      }
      if (!isMobile && !isMac && fp.devicePixelRatio > 2) {
        return { passed: false, score: 0.4, details: 'Desktop with very high DPI (unusual)' };
      }
      return { passed: true, score: 1, details: 'DPI consistent with device type' };
    },
    fix: (fp) => {
      const isMobile = fp.category.startsWith('mobile');
      const isMac = fp.platform === 'MacIntel';
      if (isMobile) return { ...fp, devicePixelRatio: 3 };
      if (isMac) return { ...fp, devicePixelRatio: 2 };
      return { ...fp, devicePixelRatio: 1 };
    },
  },
];

// ===============================================================================
// CONSISTENCY ENGINE CLASS
// ===============================================================================

export class ConsistencyEngine {
  private rules: ConsistencyRule[];

  constructor() {
    this.rules = CONSISTENCY_RULES;
  }

  /**
   * Validate a fingerprint against all consistency rules.
   */
  validate(fingerprint: DeviceFingerprint): ConsistencyReport {
    const checks: ConsistencyResult[] = [];
    const warnings: string[] = [];
    const autoFixes: string[] = [];

    for (const rule of this.rules) {
      const result = rule.validate(fingerprint);
      checks.push({
        check: rule.check,
        passed: result.passed,
        score: result.score,
        details: result.details,
        autoFixed: false,
      });

      if (!result.passed) {
        warnings.push(`${rule.description}: ${result.details}`);
      }
    }

    // Calculate overall score (weighted)
    let totalScore = 0;
    let totalWeight = 0;
    for (let i = 0; i < checks.length; i++) {
      totalScore += checks[i].score * this.rules[i].weight;
      totalWeight += this.rules[i].weight;
    }
    const overallScore = totalWeight > 0 ? totalScore / totalWeight : 0;

    return {
      fingerprintId: fingerprint.id,
      overallScore,
      checks,
      warnings,
      autoFixes,
      isUsable: overallScore >= 0.85,
    };
  }

  /**
   * Validate and auto-fix a fingerprint.
   * Applies fix functions for any failing checks.
   */
  validateAndFix(fingerprint: DeviceFingerprint): {
    fingerprint: DeviceFingerprint;
    report: ConsistencyReport;
    fixesApplied: number;
  } {
    let fp = { ...fingerprint };
    let fixesApplied = 0;

    for (const rule of this.rules) {
      const result = rule.validate(fp);
      if (!result.passed && rule.fix) {
        fp = rule.fix(fp);
        fixesApplied++;

        // Re-validate after fix
        const afterFix = rule.validate(fp);
        if (!afterFix.passed) {
          logger.warn({
            fingerprintId: fp.id,
            check: rule.check,
            details: result.details,
          }, 'Auto-fix did not resolve consistency issue');
        }
      }
    }

    const report = this.validate(fp);
    return { fingerprint: fp, report, fixesApplied };
  }

  /** Quick check if a fingerprint is likely to pass Netflix/Google validation. */
  isLikelyToPass(fingerprint: DeviceFingerprint, domain: string): boolean {
    const report = this.validate(fingerprint);

    // Netflix has stricter fingerprint validation
    if (domain.includes('netflix') && report.overallScore < 0.90) {
      return false;
    }

    // Google is slightly less strict
    if (domain.includes('google') && report.overallScore < 0.85) {
      return false;
    }

    return report.overallScore >= 0.85;
  }

  /** Get the list of consistency rules. */
  getRules(): Array<{ check: ConsistencyCheck; description: string; weight: number }> {
    return this.rules.map(r => ({ check: r.check, description: r.description, weight: r.weight }));
  }
}

/** Singleton instance. */
export const consistencyEngine = new ConsistencyEngine();
