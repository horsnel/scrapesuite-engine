import { createChildLogger } from '../utils/logger';
import { profileGenerator } from './profile-generator';
import { canvasSpoofer } from './canvas-spoofer';
import { audioSpoofer } from './audio-spoofer';

const logger = createChildLogger('anti-bot:stealth');

// --- Browser Fingerprint Profiles ---------------------------------------------

interface BrowserProfile {
  userAgent: string;
  platform: string;
  viewport: { width: number; height: number };
  locale: string;
  timezone: string;
  webglVendor: string;
  webglRenderer: string;
  colorDepth: number;
  deviceMemory: number;
  hardwareConcurrency: number;
  screenResolution: { width: number; height: number };
  touchSupport: boolean;
  fonts: string[];
  // New fields for advanced fingerprinting
  canvasNoise?: number;
  audioNoise?: number;
  profileHash?: string;
}

const PROFILES: BrowserProfile[] = [
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platform: 'Win32',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezone: 'America/New_York',
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)',
    colorDepth: 24,
    deviceMemory: 8,
    hardwareConcurrency: 8,
    screenResolution: { width: 1920, height: 1080 },
    touchSupport: false,
    fonts: ['Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana'],
  },
  {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    viewport: { width: 1680, height: 1050 },
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)',
    colorDepth: 24,
    deviceMemory: 16,
    hardwareConcurrency: 8,
    screenResolution: { width: 2560, height: 1600 },
    touchSupport: false,
    fonts: ['Helvetica', 'Courier', 'Georgia', 'Times', 'Verdana'],
  },
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    platform: 'Win32',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezone: 'America/Chicago',
    webglVendor: 'Mozilla',
    webglRenderer: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
    colorDepth: 24,
    deviceMemory: 8,
    hardwareConcurrency: 4,
    screenResolution: { width: 1366, height: 768 },
    touchSupport: false,
    fonts: ['Arial', 'Courier New', 'Georgia', 'Times New Roman'],
  },
  {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platform: 'Linux x86_64',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezone: 'America/Denver',
    webglVendor: 'Mesa',
    webglRenderer: 'Mesa Intel(R) HD Graphics 630 (KBL GT2)',
    colorDepth: 24,
    deviceMemory: 16,
    hardwareConcurrency: 12,
    screenResolution: { width: 1920, height: 1080 },
    touchSupport: false,
    fonts: ['DejaVu Sans', 'Liberation Sans', 'Ubuntu'],
  },
  {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    platform: 'MacIntel',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezone: 'America/New_York',
    webglVendor: 'Apple Inc.',
    webglRenderer: 'Apple GPU',
    colorDepth: 24,
    deviceMemory: 16,
    hardwareConcurrency: 8,
    screenResolution: { width: 2560, height: 1600 },
    touchSupport: false,
    fonts: ['Helvetica', 'Courier', 'Georgia', 'Times'],
  },
];

// --- Anti-Bot Detection Signatures --------------------------------------------

export interface AntiBotDetection {
  cloudflare: boolean;
  cloudflareVariant: 'challenge' | 'turnstile' | 'managed' | 'none';
  datadome: boolean;
  akamai: boolean;
  perimeterX: boolean;
  imperva: boolean;
  reCaptcha: boolean;
  hCaptcha: boolean;
  confidenceScore: number; // 0-1, how confident we are about the detection
}

// --- Stealth Engine -----------------------------------------------------------

export class StealthEngine {
  /**
   * Get a random browser profile for fingerprint randomization.
   * Uses the dynamic profile generator with 200+ unique profiles.
   * Falls back to the static PROFILES array if the generator fails.
   */
  getRandomProfile(): BrowserProfile {
    try {
      return profileGenerator.getRandomProfile() as BrowserProfile;
    } catch (err) {
      logger.warn({ err }, 'Profile generator failed, falling back to static profiles');
      return PROFILES[Math.floor(Math.random() * PROFILES.length)];
    }
  }

  /**
   * Get Playwright context options with full anti-detection configuration.
   */
  getContextOptions(profile?: BrowserProfile) {
    const p = profile || this.getRandomProfile();

    return {
      viewport: p.viewport,
      locale: p.locale,
      timezoneId: p.timezone,
      userAgent: p.userAgent,
      colorScheme: 'light' as const,
      extraHTTPHeaders: {
        'Accept-Language': `${p.locale},en;q=0.9`,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Ch-Ua': this.buildSecChUa(p.userAgent),
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': `"${p.platform}"`,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      bypassCSP: true,
    };
  }

  /**
   * Get the full stealth initialization script for Playwright addInitScript.
   * This overrides browser APIs that bot detection systems check.
   */
  getStealthInitScript(profile?: BrowserProfile): string {
    const p = profile || this.getRandomProfile();

    return `
      // --- navigator.webdriver --------------------------------
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true,
      });

      // --- navigator.plugins (fake non-empty) ----------------
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const plugins = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
          ];
          plugins.length = 3;
          return plugins;
        },
        configurable: true,
      });

      // --- navigator.languages --------------------------------
      Object.defineProperty(navigator, 'languages', {
        get: () => ['${p.locale}', 'en'],
        configurable: true,
      });

      // --- navigator.platform ---------------------------------
      Object.defineProperty(navigator, 'platform', {
        get: () => '${p.platform}',
        configurable: true,
      });

      // --- navigator.hardwareConcurrency ----------------------
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => ${p.hardwareConcurrency},
        configurable: true,
      });

      // --- navigator.deviceMemory -----------------------------
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => ${p.deviceMemory},
        configurable: true,
      });

      // --- screen dimensions ----------------------------------
      Object.defineProperty(screen, 'width', { get: () => ${p.screenResolution.width}, configurable: true });
      Object.defineProperty(screen, 'height', { get: () => ${p.screenResolution.height}, configurable: true });
      Object.defineProperty(screen, 'availWidth', { get: () => ${p.screenResolution.width}, configurable: true });
      Object.defineProperty(screen, 'availHeight', { get: () => ${p.screenResolution.height} - 40, configurable: true });
      Object.defineProperty(screen, 'colorDepth', { get: () => ${p.colorDepth}, configurable: true });
      Object.defineProperty(screen, 'pixelDepth', { get: () => ${p.colorDepth}, configurable: true });

      // --- WebGL vendor/renderer ------------------------------
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return '${p.webglVendor}';
        if (param === 37446) return '${p.webglRenderer}';
        return getParameter.call(this, param);
      };

      // --- Remove automation markers --------------------------
      delete window.__playwright;
      delete window.__pw_manual;
      delete window.__PW_inspect;

      // --- chrome runtime (fake) ------------------------------
      if (!window.chrome) {
        window.chrome = {};
      }
      if (!window.chrome.runtime) {
        window.chrome.runtime = {
          connect: function() {},
          sendMessage: function() {},
        };
      }

      // --- Permissions API (fake) -----------------------------
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );

      // --- iframe contentWindow (fix for some detections) -----
      const originalContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        get: function() {
          const result = originalContentWindow.get.call(this);
          if (result) {
            try {
              Object.defineProperty(result.navigator, 'webdriver', { get: () => undefined });
            } catch(e) {}
          }
          return result;
        },
      });

      // --- Console detection evasion --------------------------
      const originalDebug = console.debug;
      let debugCallCount = 0;
      console.debug = function() {
        debugCallCount++;
        if (debugCallCount > 10) return; // Some detectors spam console.debug
        return originalDebug.apply(console, arguments);
      };

      // --- Canvas fingerprint spoofing (Advanced — deterministic per-profile) ---
      // Replaced basic single-pixel noise with multi-layer canvas spoofer.
      // The canvas-spoofer module provides: text rendering offsets, gradient stop
      // manipulation, shadow color perturbation, path rendering jitter,
      // multi-pixel image data noise, and WebGL readPixels noise — all
      // deterministic per profile seed so the same profile always produces the
      // same canvas hash (critical to defeat double-test detection).
      //
      // If the advanced spoofer fails to generate a script, fall back to the
      // basic single-pixel approach with the profile's canvasNoise value.
      ${(() => {
        try {
          return canvasSpoofer.getScript(p.profileHash || 'default', String(p.canvasNoise || 0.001));
        } catch {
          // Fallback to basic canvas noise
          return p.canvasNoise ? `
      const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function() {
        const ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
          const imageData = ctx.getImageData(0, 0, Math.min(this.width, 1), Math.min(this.height, 1));
          if (imageData.data.length > 0) {
            imageData.data[0] = imageData.data[0] + ${p.canvasNoise};
            ctx.putImageData(imageData, 0, 0);
          }
        }
        return originalToDataURL.apply(this, arguments);
      };
      const originalToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function() {
        const ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
          const imageData = ctx.getImageData(0, 0, Math.min(this.width, 1), Math.min(this.height, 1));
          if (imageData.data.length > 0) {
            imageData.data[0] = imageData.data[0] + ${p.canvasNoise};
            ctx.putImageData(imageData, 0, 0);
          }
        }
        return originalToBlob.apply(this, arguments);
      };
          ` : '';
        }
      })()}

      // --- Audio context spoofing (Advanced — full pipeline) ---
      // Replaced basic getFloatFrequencyData jitter with full OfflineAudioContext
      // pipeline spoofing. The audio-spoofer module provides: OscillatorNode
      // frequency perturbation, DynamicsCompressor parameter overrides,
      // OfflineAudioContext deterministic rendering, AnalyserNode float+byte
      // frequency data overrides, GainNode perturbation, and BiquadFilter
      // parameter shifts — all deterministic per profile seed.
      ${(() => {
        try {
          return audioSpoofer.getScript(p.profileHash || 'default', String(p.audioNoise || 0.0001));
        } catch {
          // Fallback to basic audio noise
          return p.audioNoise ? `
      const originalGetFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function(array) {
        originalGetFloatFrequencyData.call(this, array);
        for (let i = 0; i < array.length; i++) {
          array[i] += (Math.random() - 0.5) * ${p.audioNoise};
        }
      };
          ` : '';
        }
      })()}
    `;
  }

  /**
   * Detect anti-bot protections in HTML response.
   * Returns detailed detection with confidence scoring.
   */
  detectAntiBot(html: string, statusCode?: number, headers?: Record<string, string>): AntiBotDetection {
    const lower = (html || '').toLowerCase();
    const headerLower: Record<string, string> = {};
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        headerLower[k.toLowerCase()] = v.toLowerCase();
      }
    }

    // -- Cloudflare ------------------------------------------
    let cloudflare = false;
    let cloudflareVariant: AntiBotDetection['cloudflareVariant'] = 'none';

    if (headerLower['cf-ray'] || headerLower['server']?.includes('cloudflare')) {
      cloudflare = true;
    }

    if (lower.includes('cf-browser-verification') || lower.includes('cf-challenge')) {
      cloudflare = true;
      cloudflareVariant = 'challenge';
    } else if (lower.includes('cf-turnstile') || lower.includes('challenges.cloudflare.com/turnstile')) {
      cloudflare = true;
      cloudflareVariant = 'turnstile';
    } else if (lower.includes('cloudflare') && lower.includes('challenge-platform')) {
      cloudflare = true;
      cloudflareVariant = 'managed';
    } else if (cloudflare) {
      cloudflareVariant = 'managed';
    }

    if (lower.includes('just a moment') && (lower.includes('cloudflare') || lower.includes('cf-'))) {
      cloudflare = true;
      if (cloudflareVariant === 'none') cloudflareVariant = 'challenge';
    }

    // -- DataDome --------------------------------------------
    const datadome =
      lower.includes('datadome') ||
      lower.includes('dd_key') ||
      lower.includes('ddkey') ||
      lower.includes('data-dome') ||
      headerLower['x-datadome'] !== undefined ||
      headerLower['set-cookie']?.includes('datadome');

    // -- Akamai ----------------------------------------------
    const akamai =
      lower.includes('akamai') ||
      lower.includes('_abck') ||
      lower.includes('akamai_swf') ||
      headerLower['x-akamai-transformed'] !== undefined ||
      headerLower['set-cookie']?.includes('_abck');

    // -- PerimeterX ------------------------------------------
    const perimeterX =
      lower.includes('perimeterx') ||
      lower.includes('_px3') ||
      lower.includes('px-captcha') ||
      headerLower['set-cookie']?.includes('_px');

    // -- Imperva / Incapsula ---------------------------------
    const imperva =
      lower.includes('incapsula') ||
      lower.includes('imperva') ||
      lower.includes('visid_incap') ||
      lower.includes('incap_ses') ||
      headerLower['x-iinfo'] !== undefined ||
      headerLower['set-cookie']?.includes('visid_incap');

    // -- CAPTCHAs --------------------------------------------
    const reCaptcha =
      lower.includes('recaptcha') ||
      lower.includes('g-recaptcha') ||
      lower.includes('google.com/recaptcha');

    const hCaptcha =
      lower.includes('hcaptcha') ||
      lower.includes('h-captcha') ||
      lower.includes('challenges.cloudflare.com/cdn-cgi/challenge-platform');

    // -- Confidence score ------------------------------------
    let confidenceScore = 0;
    const signals = [cloudflare, datadome, akamai, perimeterX, imperva, reCaptcha, hCaptcha];
    const activeSignals = signals.filter(Boolean).length;
    if (activeSignals > 0) confidenceScore = Math.min(1, activeSignals * 0.25);

    return {
      cloudflare,
      cloudflareVariant,
      datadome,
      akamai,
      perimeterX,
      imperva,
      reCaptcha,
      hCaptcha,
      confidenceScore,
    };
  }

  /**
   * Get recommended strategy based on detected anti-bot protection.
   */
  getStrategyRecommendation(detection: AntiBotDetection): {
    strategy: 'http' | 'browser' | 'stealth-browser';
    proxyTier: 'residential' | 'mobile' | 'datacenter';
    retryWithStealth: boolean;
  } {
    // Heavy protection -- need stealth browser + residential proxies
    if (detection.cloudflare && detection.cloudflareVariant === 'challenge') {
      return { strategy: 'stealth-browser', proxyTier: 'residential', retryWithStealth: true };
    }

    if (detection.datadome || detection.akamai || detection.perimeterX || detection.imperva) {
      return { strategy: 'stealth-browser', proxyTier: 'residential', retryWithStealth: true };
    }

    // Managed Cloudflare -- regular browser might work
    if (detection.cloudflare) {
      return { strategy: 'browser', proxyTier: 'residential', retryWithStealth: false };
    }

    // CAPTCHAs present -- need browser + possibly manual intervention
    if (detection.reCaptcha || detection.hCaptcha) {
      return { strategy: 'stealth-browser', proxyTier: 'residential', retryWithStealth: true };
    }

    // No protection detected
    return { strategy: 'http', proxyTier: 'datacenter', retryWithStealth: false };
  }

  // --- Helpers ----------------------------------------------------------------

  private buildSecChUa(userAgent: string): string {
    if (userAgent.includes('Firefox')) return '';
    if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
      return '"Not A(Brand";v="99", "Safari";v="605", "ACGI";v="1"';
    }
    return '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"';
  }
}

export const stealthEngine = new StealthEngine();
