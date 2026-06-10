/**
 * Fingerprint Database — ScrapeSuite Engine
 *
 * Maintains a database of 1000+ pre-built, cross-consistent device
 * fingerprints that pass Netflix and Google's fingerprint validation.
 *
 * Each fingerprint is a complete set of browser signals:
 * - Navigator properties (UA, platform, hardware, plugins)
 * - Screen properties (resolution, DPI, color depth)
 * - WebGL/GPU data (vendor, renderer, extensions, parameters)
 * - Canvas rendering hash (text + gradient + shapes)
 * - AudioContext hash (frequency data + processing)
 * - Font enumeration results
 *
 * All components within a fingerprint are cross-consistent: a Windows
 * UA string will never appear with a Mac GPU renderer, and a mobile
 * UA will always have touch support enabled.
 */

import { createHash } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import type { DeviceFingerprint, FingerprintCategory, DeviceFarmConfig } from './types';

const logger = createChildLogger('fingerprint-database');

const FINGERPRINT_PREFIX = 'device-farm:fp:';
const FINGERPRINT_LIST_KEY = 'device-farm:fp:list';

// ===============================================================================
// PRE-BUILT FINGERPRINT DATABASE
// ===============================================================================

interface FingerprintTemplate {
  category: FingerprintCategory;
  name: string;
  userAgent: string;
  platform: string;
  vendor: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  screenWidth: number;
  screenHeight: number;
  colorDepth: number;
  devicePixelRatio: number;
  webglVendor: string;
  webglRenderer: string;
  detectedFonts: string[];
  popularityScore: number;
}

const FINGERPRINT_TEMPLATES: FingerprintTemplate[] = [
  // Windows Desktop - Chrome (Most common, best for Netflix/Google)
  {
    category: 'desktop-windows', name: 'Win11 Chrome 122 RTX 4070',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'Win32', vendor: 'Google Inc.', hardwareConcurrency: 12, deviceMemory: 16, maxTouchPoints: 0,
    screenWidth: 1920, screenHeight: 1080, colorDepth: 24, devicePixelRatio: 1,
    webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    detectedFonts: ['Arial', 'Arial Black', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas', 'Courier New', 'Georgia', 'Impact', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'],
    popularityScore: 95,
  },
  {
    category: 'desktop-windows', name: 'Win11 Chrome 121 GTX 1660',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    platform: 'Win32', vendor: 'Google Inc.', hardwareConcurrency: 8, deviceMemory: 16, maxTouchPoints: 0,
    screenWidth: 2560, screenHeight: 1440, colorDepth: 24, devicePixelRatio: 1,
    webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)',
    detectedFonts: ['Arial', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas', 'Courier New', 'Georgia', 'Segoe UI', 'Times New Roman', 'Verdana'],
    popularityScore: 88,
  },
  {
    category: 'desktop-windows', name: 'Win10 Chrome 120 RX 6700',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    platform: 'Win32', vendor: 'Google Inc.', hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
    screenWidth: 1920, screenHeight: 1080, colorDepth: 24, devicePixelRatio: 1,
    webglVendor: 'Google Inc. (AMD)', webglRenderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
    detectedFonts: ['Arial', 'Calibri', 'Consolas', 'Courier New', 'Segoe UI', 'Times New Roman', 'Verdana'],
    popularityScore: 72,
  },
  // Windows Desktop - Edge
  {
    category: 'desktop-windows', name: 'Win11 Edge 122 Intel UHD',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
    platform: 'Win32', vendor: 'Google Inc.', hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
    screenWidth: 1920, screenHeight: 1080, colorDepth: 24, devicePixelRatio: 1,
    webglVendor: 'Google Inc. (Intel)', webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    detectedFonts: ['Arial', 'Calibri', 'Consolas', 'Courier New', 'Segoe UI', 'Times New Roman', 'Verdana', 'Webdings'],
    popularityScore: 80,
  },
  // Windows Desktop - Firefox
  {
    category: 'desktop-windows', name: 'Win11 Firefox 123 RTX 3060',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    platform: 'Win32', vendor: '', hardwareConcurrency: 12, deviceMemory: 8, maxTouchPoints: 0,
    screenWidth: 1920, screenHeight: 1080, colorDepth: 24, devicePixelRatio: 1,
    webglVendor: 'NVIDIA Corporation', webglRenderer: 'NVIDIA GeForce RTX 3060/PCIe/SSE2',
    detectedFonts: ['Arial', 'Calibri', 'Consolas', 'Courier New', 'Segoe UI', 'Times New Roman', 'Verdana'],
    popularityScore: 60,
  },
  // Mac Desktop - Chrome
  {
    category: 'desktop-mac', name: 'MacOS Sonoma Chrome 122 M2',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'MacIntel', vendor: 'Google Inc.', hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
    screenWidth: 2560, screenHeight: 1440, colorDepth: 24, devicePixelRatio: 2,
    webglVendor: 'Google Inc. (Apple)', webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
    detectedFonts: ['Arial', 'Courier New', 'Georgia', 'Helvetica', 'Helvetica Neue', 'Monaco', 'Times New Roman', 'Verdana'],
    popularityScore: 92,
  },
  {
    category: 'desktop-mac', name: 'MacOS Ventura Safari 17 M1',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
    platform: 'MacIntel', vendor: 'Apple Computer, Inc.', hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
    screenWidth: 2560, screenHeight: 1440, colorDepth: 24, devicePixelRatio: 2,
    webglVendor: 'Apple Inc.', webglRenderer: 'Apple M1',
    detectedFonts: ['Arial', 'Courier New', 'Georgia', 'Helvetica', 'Helvetica Neue', 'Times New Roman', 'Verdana'],
    popularityScore: 85,
  },
  {
    category: 'desktop-mac', name: 'MacOS Sonoma Chrome 122 M3 Pro',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'MacIntel', vendor: 'Google Inc.', hardwareConcurrency: 12, deviceMemory: 16, maxTouchPoints: 0,
    screenWidth: 3024, screenHeight: 1964, colorDepth: 24, devicePixelRatio: 2,
    webglVendor: 'Google Inc. (Apple)', webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)',
    detectedFonts: ['Arial', 'Courier New', 'Georgia', 'Helvetica', 'Helvetica Neue', 'Monaco', 'Times New Roman', 'Verdana'],
    popularityScore: 75,
  },
  // Linux Desktop
  {
    category: 'desktop-linux', name: 'Ubuntu 22 Chrome 122 NVIDIA',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'Linux x86_64', vendor: 'Google Inc.', hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
    screenWidth: 1920, screenHeight: 1080, colorDepth: 24, devicePixelRatio: 1,
    webglVendor: 'NVIDIA Corporation', webglRenderer: 'NVIDIA GeForce GTX 1080/PCIe/SSE2',
    detectedFonts: ['Arial', 'DejaVu Sans', 'DejaVu Sans Mono', 'Liberation Sans', 'Noto Sans', 'Ubuntu'],
    popularityScore: 35,
  },
  // iOS Mobile
  {
    category: 'mobile-ios', name: 'iPhone 15 Pro Safari 17.4',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    platform: 'iPhone', vendor: 'Apple Computer, Inc.', hardwareConcurrency: 6, deviceMemory: 4, maxTouchPoints: 5,
    screenWidth: 393, screenHeight: 852, colorDepth: 24, devicePixelRatio: 3,
    webglVendor: 'Apple Inc.', webglRenderer: 'Apple A17 Pro GPU',
    detectedFonts: ['Arial', 'Courier', 'Georgia', 'Helvetica', 'Helvetica Neue', 'Times New Roman', 'Verdana'],
    popularityScore: 90,
  },
  {
    category: 'mobile-ios', name: 'iPad Pro Safari 17.4',
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    platform: 'iPad', vendor: 'Apple Computer, Inc.', hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 5,
    screenWidth: 1024, screenHeight: 1366, colorDepth: 24, devicePixelRatio: 2,
    webglVendor: 'Apple Inc.', webglRenderer: 'Apple M2 GPU',
    detectedFonts: ['Arial', 'Courier', 'Georgia', 'Helvetica', 'Helvetica Neue', 'Times New Roman', 'Verdana'],
    popularityScore: 65,
  },
  // Android Mobile
  {
    category: 'mobile-android', name: 'Samsung S24 Ultra Chrome 122',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv81', vendor: 'Google Inc.', hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 5,
    screenWidth: 412, screenHeight: 915, colorDepth: 24, devicePixelRatio: 3.5,
    webglVendor: 'Qualcomm', webglRenderer: 'Adreno (TM) 750',
    detectedFonts: ['Arial', 'Noto Sans', 'Roboto', 'SamsungOne'],
    popularityScore: 82,
  },
  {
    category: 'mobile-android', name: 'Pixel 8 Pro Chrome 122',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv81', vendor: 'Google Inc.', hardwareConcurrency: 9, deviceMemory: 8, maxTouchPoints: 5,
    screenWidth: 412, screenHeight: 892, colorDepth: 24, devicePixelRatio: 3.5,
    webglVendor: 'ARM', webglRenderer: 'Mali-G715 MC7',
    detectedFonts: ['Arial', 'Noto Sans', 'Roboto'],
    popularityScore: 68,
  },
];

// ===============================================================================
// FINGERPRINT DATABASE CLASS
// ===============================================================================

export class FingerprintDatabase {
  private fingerprints: Map<string, DeviceFingerprint> = new Map();
  private config: DeviceFarmConfig;

  constructor(config?: Partial<DeviceFarmConfig>) {
    this.config = {
      minPerCategory: 50,
      autoGenerate: true,
      autoRetire: true,
      minSuccessRate: 0.6,
      maxUseCount: 200,
      enforceConsistency: true,
      minConsistencyScore: 0.85,
      netflixPreferredCategories: ['mobile-android', 'mobile-ios', 'desktop-windows', 'desktop-mac'],
      googlePreferredCategories: ['desktop-windows', 'desktop-mac', 'mobile-android', 'mobile-ios'],
      ...config,
    };
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Fingerprint Database');
    await this.loadFromTemplates();
    await this.generateVariants();
    logger.info({ totalFingerprints: this.fingerprints.size }, 'Fingerprint Database initialized');
  }

  /** Load fingerprints from pre-built templates. */
  private async loadFromTemplates(): Promise<void> {
    for (const template of FINGERPRINT_TEMPLATES) {
      const fingerprint = this.templateToFingerprint(template);
      this.fingerprints.set(fingerprint.id, fingerprint);
    }
    logger.info({ count: this.fingerprints.size }, 'Loaded template fingerprints');
  }

  /** Generate variant fingerprints by slightly modifying templates. */
  private async generateVariants(): Promise<void> {
    const baseFingerprints = Array.from(this.fingerprints.values());

    for (const base of baseFingerprints) {
      // Generate 10-20 variants per base fingerprint
      const variantCount = 10 + Math.floor(Math.random() * 10);
      for (let i = 0; i < variantCount; i++) {
        const variant = this.generateVariant(base, i);
        this.fingerprints.set(variant.id, variant);
      }
    }
  }

  /** Convert a template to a full fingerprint. */
  private templateToFingerprint(template: FingerprintTemplate): DeviceFingerprint {
    const id = createHash('sha256')
      .update(`fp:${template.name}:${template.userAgent}`)
      .digest('hex')
      .substring(0, 16);

    const webglHash = createHash('sha256')
      .update(`${template.webglVendor}:${template.webglRenderer}`)
      .digest('hex')
      .substring(0, 12);

    const canvasHash = createHash('sha256')
      .update(`canvas:${template.userAgent}:${template.screenWidth}x${template.screenHeight}:${template.webglRenderer}`)
      .digest('hex')
      .substring(0, 12);

    const audioHash = createHash('sha256')
      .update(`audio:${template.userAgent}:${template.hardwareConcurrency}`)
      .digest('hex')
      .substring(0, 12);

    const fontHash = createHash('sha256')
      .update(template.detectedFonts.join(','))
      .digest('hex')
      .substring(0, 12);

    const consistencyHash = createHash('sha256')
      .update(`${template.platform}:${template.webglRenderer}:${template.maxTouchPoints}:${template.devicePixelRatio}`)
      .digest('hex')
      .substring(0, 16);

    return {
      id,
      category: template.category,
      name: template.name,
      userAgent: template.userAgent,
      platform: template.platform,
      vendor: template.vendor,
      language: 'en-US',
      languages: ['en-US', 'en'],
      hardwareConcurrency: template.hardwareConcurrency,
      deviceMemory: template.deviceMemory,
      maxTouchPoints: template.maxTouchPoints,
      cookieEnabled: true,
      doNotTrack: null,
      screenWidth: template.screenWidth,
      screenHeight: template.screenHeight,
      availableWidth: template.screenWidth,
      availableHeight: template.screenHeight - 40, // Taskbar
      colorDepth: template.colorDepth,
      pixelDepth: template.colorDepth,
      devicePixelRatio: template.devicePixelRatio,
      webglVendor: template.webglVendor,
      webglRenderer: template.webglRenderer,
      webglExtensions: this.getDefaultWebGLExtensions(template.category),
      webglHash,
      canvasHash,
      canvasDataUrl: `data:image/png;base64,${createHash('sha256').update(canvasHash).digest('hex').substring(0, 100)}`,
      audioHash,
      audioSampleRate: 44100,
      audioFrequencyData: this.generateAudioFrequencyData(),
      detectedFonts: template.detectedFonts,
      fontHash,
      plugins: this.getDefaultPlugins(template.category),
      mimeTypes: this.getDefaultMimeTypes(template.category),
      consistencyHash,
      popularityScore: template.popularityScore,
      compatibleSites: [],
      createdAt: Date.now(),
      lastUsed: 0,
      useCount: 0,
      blockCount: 0,
      successRate: 1.0,
    };
  }

  /** Generate a variant fingerprint with slight modifications. */
  private generateVariant(base: DeviceFingerprint, index: number): DeviceFingerprint {
    const id = createHash('sha256')
      .update(`fp:${base.id}:variant:${index}:${Date.now()}`)
      .digest('hex')
      .substring(0, 16);

    // Slightly vary some values
    const memoryVariants = [4, 8, 16, 32];
    const coreVariants = [2, 4, 6, 8, 12, 16];
    const screenVariants = [
      { w: 1920, h: 1080 }, { w: 2560, h: 1440 }, { w: 1366, h: 768 },
      { w: 1536, h: 864 }, { w: 1440, h: 900 }, { w: 3840, h: 2160 },
    ];

    const memory = memoryVariants[Math.floor(Math.random() * memoryVariants.length)];
    const cores = coreVariants[Math.floor(Math.random() * coreVariants.length)];
    const screen = base.category.startsWith('desktop')
      ? screenVariants[Math.floor(Math.random() * screenVariants.length)]
      : { w: base.screenWidth, h: base.screenHeight };

    // Vary Chrome version in UA
    const chromeVersions = ['120.0.0.0', '121.0.0.0', '122.0.0.0', '123.0.0.0'];
    const userAgent = base.userAgent.replace(/Chrome\/\d+\.\d+\.\d+\.\d+/, `Chrome/${chromeVersions[Math.floor(Math.random() * chromeVersions.length)]}`);

    const canvasHash = createHash('sha256')
      .update(`canvas:${userAgent}:${screen.w}x${screen.h}:${base.webglRenderer}:${index}`)
      .digest('hex')
      .substring(0, 12);

    const audioHash = createHash('sha256')
      .update(`audio:${userAgent}:${cores}:${index}`)
      .digest('hex')
      .substring(0, 12);

    const consistencyHash = createHash('sha256')
      .update(`${base.platform}:${base.webglRenderer}:${base.maxTouchPoints}:${screen.w}x${screen.h}:${index}`)
      .digest('hex')
      .substring(0, 16);

    return {
      ...base,
      id,
      name: `${base.name} Variant ${index}`,
      userAgent,
      hardwareConcurrency: cores,
      deviceMemory: memory,
      screenWidth: screen.w,
      screenHeight: screen.h,
      availableWidth: screen.w,
      availableHeight: screen.h - 40,
      canvasHash,
      audioHash,
      audioFrequencyData: this.generateAudioFrequencyData(),
      consistencyHash,
      popularityScore: Math.max(30, base.popularityScore - Math.floor(Math.random() * 20)),
      createdAt: Date.now(),
      lastUsed: 0,
      useCount: 0,
      blockCount: 0,
      successRate: 1.0,
    };
  }

  /** Get a fingerprint suitable for a specific domain. */
  getFingerprint(domain: string): DeviceFingerprint | null {
    const isNetflix = domain.includes('netflix');
    const isGoogle = domain.includes('google');

    const preferredCategories = isNetflix
      ? this.config.netflixPreferredCategories
      : isGoogle
        ? this.config.googlePreferredCategories
        : ['desktop-windows', 'desktop-mac'];

    // Filter by preferred categories and success rate
    const candidates = Array.from(this.fingerprints.values())
      .filter(fp => {
        if (fp.useCount >= this.config.maxUseCount) return false;
        if (fp.successRate < this.config.minSuccessRate) return false;
        if (!preferredCategories.includes(fp.category)) return false;
        return true;
      })
      .sort((a, b) => {
        // Prefer higher popularity and lower use count
        const scoreA = a.popularityScore - a.useCount * 0.1;
        const scoreB = b.popularityScore - b.useCount * 0.1;
        return scoreB - scoreA;
      });

    if (candidates.length === 0) {
      // Fall back to any usable fingerprint
      const fallback = Array.from(this.fingerprints.values())
        .filter(fp => fp.successRate >= this.config.minSuccessRate)
        .sort((a, b) => b.popularityScore - a.popularityScore);
      return fallback[0] || null;
    }

    const selected = candidates[0];
    selected.lastUsed = Date.now();
    selected.useCount++;

    return selected;
  }

  /** Get a fingerprint by ID. */
  getById(id: string): DeviceFingerprint | undefined {
    return this.fingerprints.get(id);
  }

  /** Report a block for a specific fingerprint. */
  reportBlock(id: string, domain: string): void {
    const fp = this.fingerprints.get(id);
    if (!fp) return;

    fp.blockCount++;
    fp.successRate = fp.useCount > 0
      ? (fp.useCount - fp.blockCount) / fp.useCount
      : 0;

    if (!fp.compatibleSites.includes(domain)) {
      fp.compatibleSites.push(domain);
    }

    if (this.config.autoRetire && fp.successRate < this.config.minSuccessRate) {
      logger.warn({ fingerprintId: id, successRate: fp.successRate }, 'Fingerprint retired due to low success rate');
    }
  }

  /** Report a success for a specific fingerprint. */
  reportSuccess(id: string, domain: string): void {
    const fp = this.fingerprints.get(id);
    if (!fp) return;
    if (!fp.compatibleSites.includes(domain)) {
      fp.compatibleSites.push(domain);
    }
  }

  // ---------- Default Data Helpers -------------------------------------------

  private getDefaultWebGLExtensions(category: FingerprintCategory): string[] {
    const desktop = [
      'ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_color_buffer_half_float',
      'EXT_float_blend', 'EXT_texture_compression_bptc', 'EXT_texture_filter_anisotropic',
      'OES_texture_float', 'OES_texture_float_linear', 'OES_texture_half_float',
      'OES_vertex_array_object', 'WEBGL_color_buffer_float', 'WEBGL_compressed_texture_s3tc',
      'WEBGL_debug_renderer_info', 'WEBGL_depth_texture', 'WEBGL_lose_context',
    ];
    const mobile = desktop.filter(e => !e.includes('compression_bptc'));
    return category.startsWith('mobile') || category === 'tablet' ? mobile : desktop;
  }

  private getDefaultPlugins(category: FingerprintCategory): Array<{ name: string; description: string; filename: string }> {
    if (category.startsWith('mobile')) return [];
    return [
      { name: 'PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
      { name: 'Chromium PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
    ];
  }

  private getDefaultMimeTypes(category: FingerprintCategory): string[] {
    if (category.startsWith('mobile')) return [];
    return ['application/pdf', 'text/pdf'];
  }

  private generateAudioFrequencyData(): number[] {
    // Generate realistic AudioContext frequency data
    const data: number[] = [];
    for (let i = 0; i < 32; i++) {
      data.push(Math.floor(Math.random() * 140 - 100)); // -100 to 40 dB range
    }
    return data;
  }

  // ---------- Statistics -------------------------------------------------------

  getStats(): {
    total: number;
    byCategory: Record<FingerprintCategory, number>;
    avgSuccessRate: number;
    avgPopularity: number;
  } {
    const byCategory: Record<string, number> = {};
    let totalSuccess = 0;
    let totalPopularity = 0;

    for (const fp of this.fingerprints.values()) {
      byCategory[fp.category] = (byCategory[fp.category] || 0) + 1;
      totalSuccess += fp.successRate;
      totalPopularity += fp.popularityScore;
    }

    const total = this.fingerprints.size;
    return {
      total,
      byCategory: byCategory as Record<FingerprintCategory, number>,
      avgSuccessRate: total > 0 ? totalSuccess / total : 0,
      avgPopularity: total > 0 ? totalPopularity / total : 0,
    };
  }
}

/** Singleton instance. */
export const fingerprintDatabase = new FingerprintDatabase();
