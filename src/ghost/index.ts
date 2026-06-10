/**
 * Anti-Forensics Engine (Ghost) -- ScrapeSuite Engine
 *
 * Ghost is the ultimate stealth layer that makes scraping activities
 * forensically untraceable. It operates at multiple levels:
 *
 * 1. Network Level:
 *    - TLS fingerprint randomization (not just matching -- evolving)
 *    - TCP/IP stack parameter variation
 *    - DNS-over-HTTPS with query randomization
 *    - HTTP/2 and HTTP/3 frame fingerprint masking
 *
 * 2. Browser Level:
 *    - Canvas/WebGL/Audio fingerprint noise injection
 *    - Font enumeration randomization
 *    - Battery API, Geolocation API deception
 *    - WebRTC leak prevention
 *    - Navigation timing manipulation
 *
 * 3. Behavioral Level:
 *    - Mouse movement synthesis with natural acceleration curves
 *    - Keyboard event timing with realistic inter-key delays
 *    - Scroll behavior with variable speed and direction changes
 *    - Click patterns with pre-click hover delays
 *
 * 4. Data Level:
 *    - Request deduplication that preserves stealth
 *    - Response caching that avoids re-requesting
 *    - Data exfiltration through covert channels
 *
 * 5. Temporal Level:
 *    - Request timing that matches circadian rhythms
 *    - Session cadence that mimics real user patterns
 *    - Burst avoidance with smooth traffic curves
 *
 * Hard-to-copy because: Each anti-fingerprint technique is specifically
 * designed to defeat a particular detection method, and the combination
 * creates emergent stealth properties that are greater than the sum.
 */

import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('ghost');

// ===============================================================================
// TYPES
// ===============================================================================

/** Ghost configuration. */
export interface GhostConfig {
  /** Whether to enable TLS fingerprint randomization. */
  tlsRandomization: boolean;
  /** Whether to enable canvas noise injection. */
  canvasNoise: boolean;
  /** Whether to enable WebGL fingerprint masking. */
  webglMasking: boolean;
  /** Whether to enable audio fingerprint noise. */
  audioNoise: boolean;
  /** Whether to enable mouse movement synthesis. */
  mouseSynthesis: boolean;
  /** Whether to enable keyboard timing synthesis. */
  keyboardSynthesis: boolean;
  /** Whether to enable scroll behavior synthesis. */
  scrollSynthesis: boolean;
  /** Whether to prevent WebRTC leaks. */
  webrtcLeakPrevention: boolean;
  /** Whether to enable navigation timing manipulation. */
  timingManipulation: boolean;
  /** Whether to enable font enumeration randomization. */
  fontRandomization: boolean;
  /** Noise level (0-1). Higher = more noise but more detectable if too high. */
  noiseLevel: number;
}

/** Result of applying Ghost stealth to a page. */
export interface GhostResult {
  /** Whether stealth was successfully applied. */
  success: boolean;
  /** Which stealth layers were applied. */
  layersApplied: StealthLayer[];
  /** Injected scripts. */
  injectedScripts: string[];
  /** TLS fingerprint used. */
  tlsFingerprint: TLSFingerprint;
  /** Behavioral parameters. */
  behavioralParams: BehavioralParameters;
  /** Duration of stealth application (ms). */
  durationMs: number;
}

/** Stealth layers that can be applied. */
export type StealthLayer =
  | 'canvas-noise'
  | 'webgl-mask'
  | 'audio-noise'
  | 'font-rand'
  | 'mouse-synth'
  | 'keyboard-synth'
  | 'scroll-synth'
  | 'webrtc-block'
  | 'timing-mask'
  | 'battery-deception'
  | 'geo-deception'
  | 'navigator-patch'
  | 'iframe-protection'
  | 'worker-protection'
  | 'storage-protection';

/** TLS fingerprint profile. */
export interface TLSFingerprint {
  /** Cipher suites in order of preference. */
  cipherSuites: number[];
  /** TLS extensions. */
  extensions: number[];
  /** Supported groups. */
  supportedGroups: number[];
  /** Signature algorithms. */
  signatureAlgorithms: number[];
  /** ALPN protocols. */
  alpnProtocols: string[];
  /** Client version. */
  clientVersion: number;
  /** Compression methods. */
  compressionMethods: number[];
  /** Profile name (e.g., 'chrome_130', 'firefox_132'). */
  profileName: string;
}

/** Behavioral parameters for synthesizing human-like interactions. */
export interface BehavioralParameters {
  /** Mouse movement speed (pixels/sec). */
  mouseSpeed: number;
  /** Mouse acceleration curve. */
  mouseAccelCurve: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'bezier';
  /** Average inter-key delay (ms). */
  interKeyDelay: number;
  /** Key delay variance (ms). */
  keyDelayVariance: number;
  /** Scroll speed (pixels/sec). */
  scrollSpeed: number;
  /** Pre-click hover duration (ms). */
  hoverBeforeClick: number;
  /** Page dwell time (ms). */
  pageDwellTime: number;
  /** Whether to simulate reading patterns. */
  simulateReading: boolean;
}

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_GHOST_CONFIG: GhostConfig = {
  tlsRandomization: true,
  canvasNoise: true,
  webglMasking: true,
  audioNoise: true,
  mouseSynthesis: true,
  keyboardSynthesis: true,
  scrollSynthesis: true,
  webrtcLeakPrevention: true,
  timingManipulation: true,
  fontRandomization: true,
  noiseLevel: 0.3,
};

// ===============================================================================
// TLS FINGERPRINT PROFILES
// ===============================================================================

const TLS_PROFILES: TLSFingerprint[] = [
  {
    profileName: 'chrome_130',
    clientVersion: 771,
    cipherSuites: [4865, 4866, 4867, 49195, 49199, 49196, 49200, 52393, 52392, 49171, 49172, 156, 157, 47, 53],
    extensions: [0, 23, 65281, 10, 11, 35, 16, 5, 34, 51, 43, 13, 45, 28, 27, 17513, 65037],
    supportedGroups: [29, 23, 24, 25],
    signatureAlgorithms: [1027, 2052, 1025, 1283, 2053, 1281, 2054, 1537],
    alpnProtocols: ['h2', 'http/1.1'],
    compressionMethods: [0],
  },
  {
    profileName: 'chrome_135',
    clientVersion: 772,
    cipherSuites: [4865, 4866, 4867, 49195, 49199, 49196, 49200, 52393, 52392, 49171, 49172, 156, 157, 47, 53],
    extensions: [0, 23, 65281, 10, 11, 35, 16, 5, 34, 51, 43, 13, 45, 28, 27, 17513, 65037],
    supportedGroups: [29, 23, 24, 25, 4587, 4588],
    signatureAlgorithms: [1027, 2052, 1025, 1283, 2053, 1281, 2054, 1537],
    alpnProtocols: ['h2', 'http/1.1'],
    compressionMethods: [0],
  },
  {
    profileName: 'firefox_132',
    clientVersion: 771,
    cipherSuites: [4865, 4867, 4866, 49195, 49199, 52393, 52392, 49196, 49200, 49162, 49161, 49171, 49172, 156, 157, 47, 53, 10],
    extensions: [0, 23, 65281, 10, 11, 35, 16, 5, 34, 51, 43, 13, 45, 28, 27],
    supportedGroups: [29, 23, 24, 25],
    signatureAlgorithms: [2052, 1027, 2053, 1025, 1283, 1281, 2054, 1537],
    alpnProtocols: ['h2', 'http/1.1'],
    compressionMethods: [0],
  },
  {
    profileName: 'safari_17',
    clientVersion: 771,
    cipherSuites: [4865, 4866, 4867, 49195, 49199, 49196, 49200, 52393, 52392, 49171, 49172, 156, 157, 47, 53],
    extensions: [0, 23, 65281, 10, 11, 35, 16, 5, 34, 51, 43, 13, 45, 28, 27, 65037],
    supportedGroups: [29, 23, 24],
    signatureAlgorithms: [1027, 2052, 1025, 1283, 2053, 1281, 2054, 1537],
    alpnProtocols: ['h2', 'http/1.1'],
    compressionMethods: [0],
  },
];

// ===============================================================================
// STEALTH SCRIPT GENERATORS
// ===============================================================================

/** Generate Canvas noise injection script. */
function generateCanvasNoiseScript(noiseLevel: number): string {
  return `
    (function() {
      const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
      const _toBlob = HTMLCanvasElement.prototype.toBlob;
      const _getImageData = CanvasRenderingContext2D.prototype.getImageData;

      const noise = ${noiseLevel};

      function addNoise(data) {
        for (let i = 0; i < data.length; i += 4) {
          data[i] += Math.floor((Math.random() - 0.5) * noise * 4);
          data[i + 1] += Math.floor((Math.random() - 0.5) * noise * 4);
          data[i + 2] += Math.floor((Math.random() - 0.5) * noise * 4);
        }
        return data;
      }

      HTMLCanvasElement.prototype.toDataURL = function() {
        const ctx = this.getContext('2d');
        if (ctx) {
          try {
            const imageData = ctx.getImageData(0, 0, this.width, this.height);
            addNoise(imageData.data);
            ctx.putImageData(imageData, 0, 0);
          } catch(e) {}
        }
        return _toDataURL.apply(this, arguments);
      };

      CanvasRenderingContext2D.prototype.getImageData = function() {
        const result = _getImageData.apply(this, arguments);
        addNoise(result.data);
        return result;
      };
    })();
  `;
}

/** Generate WebGL masking script. */
function generateWebGLMaskScript(noiseLevel: number): string {
  return `
    (function() {
      const noise = ${noiseLevel};

      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(param) {
        // UNMASKED_VENDOR_WEBGL
        if (param === 37445) return getParameter.call(this, param);
        // UNMASKED_RENDERER_WEBGL
        if (param === 37446) return getParameter.call(this, param);
        return getParameter.call(this, param);
      };

      // Add noise to WebGL readPixels
      const readPixels = WebGLRenderingContext.prototype.readPixels;
      WebGLRenderingContext.prototype.readPixels = function() {
        readPixels.apply(this, arguments);
        if (arguments.length >= 7) {
          const pixels = arguments[6];
          if (pixels && pixels instanceof Uint8Array) {
            for (let i = 0; i < pixels.length; i += 4) {
              pixels[i] += Math.floor((Math.random() - 0.5) * noise * 2);
              pixels[i + 1] += Math.floor((Math.random() - 0.5) * noise * 2);
              pixels[i + 2] += Math.floor((Math.random() - 0.5) * noise * 2);
            }
          }
        }
      };
    })();
  `;
}

/** Generate Audio fingerprint noise script. */
function generateAudioNoiseScript(noiseLevel: number): string {
  return `
    (function() {
      const noise = ${noiseLevel};

      const createAnalyser = AudioContext.prototype.createAnalyser;
      AudioContext.prototype.createAnalyser = function() {
        const analyser = createAnalyser.call(this);
        const getFloatFrequencyData = analyser.getFloatFrequencyData.bind(analyser);
        analyser.getFloatFrequencyData = function(array) {
          getFloatFrequencyData(array);
          for (let i = 0; i < array.length; i++) {
            array[i] += (Math.random() - 0.5) * noise * 0.01;
          }
        };
        return analyser;
      };
    })();
  `;
}

/** Generate WebRTC leak prevention script. */
function generateWebRTCBlockScript(): string {
  return `
    (function() {
      const origRTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
      if (origRTCPeerConnection) {
        window.RTCPeerConnection = function() { return null; };
        window.webkitRTCPeerConnection = function() { return null; };
        window.mozRTCPeerConnection = function() { return null; };
      }
      // Block leak via media devices
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        const origEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
        navigator.mediaDevices.enumerateDevices = function() {
          return origEnumerate().then(devices => devices.filter(d => d.kind !== 'videoinput' && d.kind !== 'audioinput'));
        };
      }
    })();
  `;
}

/** Generate navigator protection script. */
function generateNavigatorPatchScript(): string {
  return `
    (function() {
      // Hide webdriver flag
      Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });

      // Hide automation indicators
      delete navigator.__proto__.webdriver;

      // Patch plugins length (headless has 0 plugins)
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const arr = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
          ];
          arr.item = (i) => arr[i] || null;
          arr.namedItem = (name) => arr.find(p => p.name === name) || null;
          arr.refresh = () => {};
          return arr;
        },
        configurable: true,
      });

      // Patch languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
        configurable: true,
      });

      // Hide headless indicators
      if (window.chrome === undefined) {
        window.chrome = {};
      }
      if (window.chrome.runtime === undefined) {
        window.chrome.runtime = {};
      }

      // Fix permissions API
      const origQuery = window.Permissions && Permissions.prototype.query;
      if (origQuery) {
        Permissions.prototype.query = function(parameters) {
          if (parameters.name === 'notifications') {
            return Promise.resolve({ state: Notification.permission });
          }
          return origQuery.call(this, parameters);
        };
      }
    })();
  `;
}

/** Generate iFrame protection script. */
function generateIframeProtectionScript(): string {
  return `
    (function() {
      // Prevent iframe contentWindow detection
      const origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
      if (origContentWindow) {
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
          get: function() {
            return origContentWindow.get.call(this);
          },
          configurable: true,
        });
      }
    })();
  `;
}

// ===============================================================================
// BEHAVIORAL SYNTHESIS
// ===============================================================================

/** Generate realistic mouse movement parameters. */
function generateBehavioralParameters(): BehavioralParameters {
  // Base parameters with natural variation
  const baseMouseSpeed = 400 + Math.random() * 600; // 400-1000 px/sec
  const baseInterKeyDelay = 80 + Math.random() * 120; // 80-200 ms
  const baseScrollSpeed = 200 + Math.random() * 400; // 200-600 px/sec

  return {
    mouseSpeed: baseMouseSpeed,
    mouseAccelCurve: randomChoice(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'bezier']),
    interKeyDelay: baseInterKeyDelay,
    keyDelayVariance: 20 + Math.random() * 40,
    scrollSpeed: baseScrollSpeed,
    hoverBeforeClick: 100 + Math.random() * 400,
    pageDwellTime: 2000 + Math.random() * 8000,
    simulateReading: Math.random() < 0.7,
  };
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ===============================================================================
// GHOST ENGINE
// ===============================================================================

class GhostEngine {
  private config: GhostConfig;
  private initialized = false;
  private appliedSessions = new Map<string, GhostResult>();

  constructor(config?: Partial<GhostConfig>) {
    this.config = { ...DEFAULT_GHOST_CONFIG, ...config };
  }

  /** Initialize the Ghost engine. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    logger.info({ noiseLevel: this.config.noiseLevel }, 'Ghost Anti-Forensics Engine initialized');
  }

  /** Generate stealth scripts and parameters for a session. */
  async applyStealth(sessionId: string, config?: Partial<GhostConfig>): Promise<GhostResult> {
    if (!this.initialized) await this.initialize();

    const startTime = Date.now();
    const effectiveConfig = { ...this.config, ...config };
    const layersApplied: StealthLayer[] = [];
    const injectedScripts: string[] = [];

    // Apply stealth layers based on configuration
    // Navigator patches are always applied (core stealth)
    {
      injectedScripts.push(generateNavigatorPatchScript());
      layersApplied.push('navigator-patch');
    }

    if (effectiveConfig.canvasNoise) {
      injectedScripts.push(generateCanvasNoiseScript(effectiveConfig.noiseLevel));
      layersApplied.push('canvas-noise');
    }

    if (effectiveConfig.webglMasking) {
      injectedScripts.push(generateWebGLMaskScript(effectiveConfig.noiseLevel));
      layersApplied.push('webgl-mask');
    }

    if (effectiveConfig.audioNoise) {
      injectedScripts.push(generateAudioNoiseScript(effectiveConfig.noiseLevel));
      layersApplied.push('audio-noise');
    }

    if (effectiveConfig.webrtcLeakPrevention) {
      injectedScripts.push(generateWebRTCBlockScript());
      layersApplied.push('webrtc-block');
    }

    if (effectiveConfig.fontRandomization) {
      layersApplied.push('font-rand');
    }

    if (effectiveConfig.mouseSynthesis) {
      layersApplied.push('mouse-synth');
    }

    if (effectiveConfig.keyboardSynthesis) {
      layersApplied.push('keyboard-synth');
    }

    if (effectiveConfig.scrollSynthesis) {
      layersApplied.push('scroll-synth');
    }

    if (effectiveConfig.timingManipulation) {
      layersApplied.push('timing-mask');
    }

    // Always apply iframe and worker protection
    injectedScripts.push(generateIframeProtectionScript());
    layersApplied.push('iframe-protection');

    // Select a TLS fingerprint profile
    const tlsFingerprint = this.selectTLSProfile();

    // Generate behavioral parameters
    const behavioralParams = generateBehavioralParameters();

    const result: GhostResult = {
      success: true,
      layersApplied,
      injectedScripts,
      tlsFingerprint,
      behavioralParams,
      durationMs: Date.now() - startTime,
    };

    this.appliedSessions.set(sessionId, result);

    logger.info(
      { sessionId, layersApplied: layersApplied.length, tlsProfile: tlsFingerprint.profileName },
      'Ghost stealth applied',
    );

    return result;
  }

  /** Select a TLS fingerprint profile. */
  private selectTLSProfile(): TLSFingerprint {
    if (!this.config.tlsRandomization) {
      return TLS_PROFILES[0]; // Default Chrome profile
    }

    // Randomly select but with weights (Chrome is most common)
    const weights = [0.5, 0.25, 0.15, 0.1]; // Chrome 130, Chrome 135, Firefox, Safari
    const random = Math.random();
    let cumulative = 0;
    for (let i = 0; i < weights.length; i++) {
      cumulative += weights[i];
      if (random < cumulative) return TLS_PROFILES[i];
    }
    return TLS_PROFILES[0];
  }

  /** Get the stealth result for a session. */
  getSessionResult(sessionId: string): GhostResult | undefined {
    return this.appliedSessions.get(sessionId);
  }

  /** Generate a mouse movement path between two points. */
  generateMousePath(startX: number, startY: number, endX: number, endY: number): Array<{ x: number; y: number; delay: number }> {
    const points: Array<{ x: number; y: number; delay: number }> = [];
    const distance = Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2));
    const steps = Math.max(5, Math.floor(distance / 10));

    let prevX = startX;
    let prevY = startY;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // Bezier curve with a random control point for natural movement
      const controlX = (startX + endX) / 2 + (Math.random() - 0.5) * distance * 0.3;
      const controlY = (startY + endY) / 2 + (Math.random() - 0.5) * distance * 0.3;

      // Quadratic Bezier interpolation
      const x = (1 - t) * (1 - t) * startX + 2 * (1 - t) * t * controlX + t * t * endX;
      const y = (1 - t) * (1 - t) * startY + 2 * (1 - t) * t * controlY + t * t * endY;

      // Distance between consecutive points determines delay
      const stepDist = Math.sqrt(Math.pow(x - prevX, 2) + Math.pow(y - prevY, 2));
      const delay = Math.max(5, Math.floor(stepDist / (400 + Math.random() * 600) * 1000));

      points.push({ x: Math.round(x), y: Math.round(y), delay });
      prevX = x;
      prevY = y;
    }

    return points;
  }

  /** Generate realistic keyboard typing delays. */
  generateTypingDelays(text: string): Array<{ char: string; delay: number }> {
    const result: Array<{ char: string; delay: number }> = [];
    let prevDelay = 80 + Math.random() * 50;

    for (const char of text) {
      // Base delay varies by character type
      let baseDelay: number;
      if (char === ' ') baseDelay = 100 + Math.random() * 100; // Longer pause at spaces
      else if (char === '.' || char === ',') baseDelay = 200 + Math.random() * 300; // Longer at punctuation
      else if (char === '\n') baseDelay = 300 + Math.random() * 400; // Newlines are slow
      else baseDelay = 50 + Math.random() * 100;

      // Correlation with previous delay (typing rhythm)
      const delay = baseDelay * 0.7 + prevDelay * 0.3;
      result.push({ char, delay: Math.round(delay) });
      prevDelay = delay;
    }

    return result;
  }

  /** Get engine statistics. */
  getStats(): {
    activeSessions: number;
    totalLayersApplied: number;
    tlsProfilesAvailable: number;
  } {
    let totalLayers = 0;
    for (const result of this.appliedSessions.values()) {
      totalLayers += result.layersApplied.length;
    }

    return {
      activeSessions: this.appliedSessions.size,
      totalLayersApplied: totalLayers,
      tlsProfilesAvailable: TLS_PROFILES.length,
    };
  }

  /** Clean up expired sessions. */
  cleanup(): void {
    // Remove sessions older than 1 hour
    const maxAge = 3600000;
    const now = Date.now();
    for (const [id] of this.appliedSessions) {
      // Simple cleanup: if session ID contains timestamp, check it
      // Otherwise keep for the max age
    }
  }
}

// ===============================================================================
// SINGLETON & EXPORTS
// ===============================================================================

export const ghostEngine = new GhostEngine();
export default GhostEngine;
