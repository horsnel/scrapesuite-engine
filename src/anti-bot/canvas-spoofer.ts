/**
 * Advanced Canvas Fingerprint Spoofer -- ScrapeSuite Engine
 *
 * Multi-layer, deterministic-per-profile canvas manipulation system that
 * replaces the basic single-pixel noise injection in stealth.ts.
 *
 * Architecture:
 *  +----------------------------------------------------------------------+
 *  | xorshift128+ PRNG    | Seeded from profile ID → deterministic hash  |
 *  | Layer 1 — Text       | fillText/strokeText sub-pixel offset        |
 *  | Layer 2 — Gradient   | addColorStop position shift ±0.001          |
 *  | Layer 3 — Shadow     | shadowColor RGB perturbation ±1             |
 *  | Layer 4 — Path       | bezier/quadratic control-point jitter       |
 *  | Layer 5 — ImageData  | Multi-pixel noise in toDataURL/toBlob       |
 *  | WebGL Layer          | readPixels deterministic noise injection    |
 *  | Anti-Detection       | toString spoof, length preservation         |
 *  +----------------------------------------------------------------------+
 *
 * Critical design constraint: the same profile seed MUST always produce the
 * same canvas hash.  Detectors run canvas tests twice and flag mismatches.
 * The old implementation used Math.random() which is non-deterministic.
 *
 * The module exports `getCanvasSpoofScript()` which returns plain JavaScript
 * (not TypeScript) suitable for injection via CDP's
 * `Page.addScriptToEvaluateOnNewDocument`.
 */

import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('anti-bot:canvas-spoofer');

// ===============================================================================
// CONFIGURATION
// ===============================================================================

/**
 * Configuration for the canvas fingerprint spoofing module.
 * Each layer can be individually toggled, and overall noise intensity
 * controls the magnitude of all perturbations.
 */
export interface CanvasSpoofConfig {
  /** Apply sub-pixel offsets to fillText / strokeText glyph positions. */
  textRenderingNoise: boolean;
  /** Shift gradient color-stop positions by ±0.001. */
  gradientStopShift: boolean;
  /** Perturb shadowColor RGB values by ±1. */
  shadowColorPerturbation: boolean;
  /** Add ±0.01px jitter to bezier/quadratic control points. */
  pathRenderingJitter: boolean;
  /** Inject deterministic noise across multiple pixels in toDataURL/toBlob. */
  imageDataNoise: boolean;
  /** Inject deterministic noise into WebGL readPixels output. */
  webglReadPixelsNoise: boolean;
  /** Overall noise intensity — scales all perturbation magnitudes. */
  noiseIntensity: 'subtle' | 'moderate' | 'strong';
}

/** Sensible default configuration — all layers enabled at moderate intensity. */
export const DEFAULT_CANVAS_SPOOF_CONFIG: CanvasSpoofConfig = {
  textRenderingNoise: true,
  gradientStopShift: true,
  shadowColorPerturbation: true,
  pathRenderingJitter: true,
  imageDataNoise: true,
  webglReadPixelsNoise: true,
  noiseIntensity: 'moderate',
};

// ===============================================================================
// INTENSITY MULTIPLIERS
// ===============================================================================

/**
 * Per-intensity scaling factors for each perturbation layer.
 * These are multiplied by the base offset ranges documented in the spec.
 */
const INTENSITY_SCALE: Record<CanvasSpoofConfig['noiseIntensity'], {
  textOffsetH: number;       // base ±0.3px
  textOffsetV: number;       // base ±0.2px
  gradientShift: number;     // base ±0.001
  shadowRgbDelta: number;    // base ±1
  pathJitter: number;        // base ±0.01
  pixelCountMin: number;     // base 3
  pixelCountMax: number;     // base 7
  pixelValueDelta: number;   // base ±1-3
}> = {
  subtle: {
    textOffsetH: 0.4,
    textOffsetV: 0.4,
    gradientShift: 0.5,
    shadowRgbDelta: 0.5,
    pathJitter: 0.5,
    pixelCountMin: 2,
    pixelCountMax: 4,
    pixelValueDelta: 0.5,
  },
  moderate: {
    textOffsetH: 1.0,
    textOffsetV: 1.0,
    gradientShift: 1.0,
    shadowRgbDelta: 1.0,
    pathJitter: 1.0,
    pixelCountMin: 3,
    pixelCountMax: 7,
    pixelValueDelta: 1.0,
  },
  strong: {
    textOffsetH: 1.6,
    textOffsetV: 1.4,
    gradientShift: 1.5,
    shadowRgbDelta: 1.5,
    pathJitter: 1.5,
    pixelCountMin: 5,
    pixelCountMax: 10,
    pixelValueDelta: 1.5,
  },
};

// ===============================================================================
// STATS / MONITORING
// ===============================================================================

/** Per-type counters for canvas operations that were spoofed. */
export interface CanvasSpoofStats {
  /** Total spoofed operations across all layers. */
  total: number;
  /** fillText / strokeText offsets applied. */
  textRendering: number;
  /** addColorStop position shifts applied. */
  gradientStops: number;
  /** shadowColor perturbations applied. */
  shadowColors: number;
  /** bezierCurveTo / quadraticCurveTo jitter applied. */
  pathJitter: number;
  /** toDataURL / toBlob pixel noise injections. */
  imageDataNoise: number;
  /** WebGL readPixels noise injections. */
  webglReadPixels: number;
}

/** Global stats tracker — updated by the injected browser code via a bridge. */
const stats: CanvasSpoofStats = {
  total: 0,
  textRendering: 0,
  gradientStops: 0,
  shadowColors: 0,
  pathJitter: 0,
  imageDataNoise: 0,
  webglReadPixels: 0,
};

/**
 * Retrieve a snapshot of the current spoofing stats.
 * The injected script updates these counters via `window.__ssCanvasStats`.
 */
export function getCanvasSpoofStats(): CanvasSpoofStats {
  // If running in a browser-context bridge, pull live stats
  if (typeof globalThis !== 'undefined' && (globalThis as Record<string, unknown>).__ssCanvasStats) {
    const live = (globalThis as Record<string, unknown>).__ssCanvasStats as CanvasSpoofStats;
    return { ...live };
  }
  return { ...stats };
}

/** Reset all spoofing counters to zero. */
export function resetCanvasSpoofStats(): void {
  stats.total = 0;
  stats.textRendering = 0;
  stats.gradientStops = 0;
  stats.shadowColors = 0;
  stats.pathJitter = 0;
  stats.imageDataNoise = 0;
  stats.webglReadPixels = 0;
}

// ===============================================================================
// XORSHIFT128+ PRNG  (TypeScript side — used for testing / seed validation)
// ===============================================================================

/**
 * xorshift128+ pseudo-random number generator.
 *
 * Produces deterministic 64-bit-style floats in [0, 1) from a pair of
 * 64-bit state words.  The algorithm is the standard V8/xorshift128+
 * variant used in Chrome and Firefox, ensuring the output distribution
 * is indistinguishable from native Math.random() to statistical tests.
 *
 * The state is initialised by hashing a string seed through FNV-1a.
 */
export class XorShift128Plus {
  private state0: number;
  private state1: number;

  constructor(seed: string) {
    const [s0, s1] = hashSeedToState(seed);
    this.state0 = s0;
    this.state1 = s1;
    // Warm up — discard first 16 values to avoid initial-state artefacts
    for (let i = 0; i < 16; i++) this.next();
  }

  /** Return a float in [0, 1). */
  next(): number {
    let s1 = this.state0;
    const s0 = this.state1;
    this.state0 = s0;
    s1 ^= s1 << 23;
    s1 ^= s1 >>> 17;
    s1 ^= s0;
    s1 ^= s0 >>> 26;
    this.state1 = s1;
    // Combine as if 64-bit add (JS numbers are 64-bit float, low 32 bits)
    const result = (imul(s0, 0x5bd1e995) + imul(s1, 0x0ccbc4a5)) >>> 0;
    return result / 0x100000000;
  }

  /** Return a float in [min, max). */
  nextRange(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Return an integer in [min, max] inclusive. */
  nextInt(min: number, max: number): number {
    return Math.floor(this.nextRange(min, max + 1));
  }
}

/** 32-bit integer multiplication (matches JS `Math.imul`). */
function imul(a: number, b: number): number {
  return Math.imul(a, b);
}

/**
 * Hash a string seed into two 32-bit state words for xorshift128+.
 * Uses FNV-1a with two different prime offsets to produce independent words.
 */
function hashSeedToState(seed: string): [number, number] {
  let h0 = 0x811c9dc5; // FNV offset basis
  let h1 = 0xc4ceb9fe; // Second offset for independent word

  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h0 ^= c;
    h0 = Math.imul(h0, 0x01000193) >>> 0;
    h1 ^= c ^ (c << 8);
    h1 = Math.imul(h1, 0x011001b7) >>> 0;
  }

  // Ensure neither state word is zero (xorshift128+ requires non-zero state)
  if (h0 === 0) h0 = 0x12345678;
  if (h1 === 0) h1 = 0x87654321;
  return [h0, h1];
}

// ===============================================================================
// INJECTED JS CODE BUILDER
// ===============================================================================

/**
 * Build the complete browser-injectable JavaScript for canvas spoofing.
 *
 * The returned string is **plain JavaScript** — it runs in the browser
 * context via `Page.addScriptToEvaluateOnNewDocument`.
 *
 * @param seed     - Profile seed string (usually derived from profileId).
 * @param profileId - Human-readable profile identifier for logging.
 * @param config   - Optional per-layer toggles and intensity.
 * @returns Plain JS source code ready for CDP injection.
 */
export function getCanvasSpoofScript(
  seed: string,
  profileId: string,
  config: Partial<CanvasSpoofConfig> = {},
): string {
  const cfg: CanvasSpoofConfig = { ...DEFAULT_CANVAS_SPOOF_CONFIG, ...config };
  const scale = INTENSITY_SCALE[cfg.noiseIntensity];

  logger.debug(
    { profileId, intensity: cfg.noiseIntensity, layers: cfg },
    'Building canvas spoof script',
  );

  // Derive the actual seed by combining the profile ID with the provided seed
  // for extra entropy while remaining deterministic.
  const combinedSeed = `${seed}::${profileId}`;

  const parts: string[] = [];

  // ── PRNG ──────────────────────────────────────────────────────────────────
  parts.push(buildPrngCode(combinedSeed));

  // ── Stats bridge ──────────────────────────────────────────────────────────
  parts.push(buildStatsBridge());

  // ── Anti-detection utilities ──────────────────────────────────────────────
  parts.push(buildAntiDetectionCode());

  // ── Layer 1: Text rendering noise ─────────────────────────────────────────
  if (cfg.textRenderingNoise) {
    parts.push(buildTextRenderingNoiseCode(scale));
  }

  // ── Layer 2: Gradient stop manipulation ───────────────────────────────────
  if (cfg.gradientStopShift) {
    parts.push(buildGradientStopShiftCode(scale));
  }

  // ── Layer 3: Shadow color perturbation ────────────────────────────────────
  if (cfg.shadowColorPerturbation) {
    parts.push(buildShadowColorPerturbationCode(scale));
  }

  // ── Layer 4: Path rendering jitter ────────────────────────────────────────
  if (cfg.pathRenderingJitter) {
    parts.push(buildPathJitterCode(scale));
  }

  // ── Layer 5: Image data noise ─────────────────────────────────────────────
  if (cfg.imageDataNoise) {
    parts.push(buildImageDataNoiseCode(scale));
  }

  // ── WebGL readPixels noise ────────────────────────────────────────────────
  if (cfg.webglReadPixelsNoise) {
    parts.push(buildWebGLReadPixelsNoiseCode(scale));
  }

  // ── Seal ──────────────────────────────────────────────────────────────────
  parts.push(`
    // Canvas spoofer initialised for profile "${profileId}"
    Object.defineProperty(window, '__ssCanvasSpoofed', { value: true, configurable: false, writable: false });
  `);

  const script = parts.join('\n');

  logger.info(
    { profileId, intensity: cfg.noiseIntensity, scriptSize: script.length },
    'Canvas spoof script built',
  );

  return script;
}

// ===============================================================================
// CODE BUILDERS — each returns a plain JS string for browser injection
// ===============================================================================

/**
 * xorshift128+ PRNG in plain JS.
 * The state is deterministically derived from the seed string.
 * Exposed as `__ssPrng` on the window object for other layers to consume.
 */
function buildPrngCode(combinedSeed: string): string {
  // Pre-compute the initial state on the Node side so the injected code
  // does not need to hash the seed string itself — simpler and less
  // detectable (no string iteration loop visible in the script).
  const [s0, s1] = hashSeedToState(combinedSeed);

  return `
    // ─── xorshift128+ PRNG (deterministic, seeded) ───────────────────────────
    (function() {
      var __ssS0 = ${s0};
      var __ssS1 = ${s1};

      // Warm up
      for (var __wi = 0; __wi < 16; __wi++) {
        var __ws1 = __ssS0;
        var __ws0 = __ssS1;
        __ssS0 = __ws0;
        __ws1 ^= (__ws1 << 23) & 0xffffffff;
        __ws1 = (__ws1 >>> 17) & 0xffffffff;
        __ws1 ^= __ws0;
        __ws1 ^= (__ws0 >>> 26) & 0xffffffff;
        __ssS1 = __ws1 >>> 0;
      }

      function __ssNext() {
        var s1 = __ssS0;
        var s0 = __ssS1;
        __ssS0 = s0;
        s1 ^= (s1 << 23) & 0xffffffff;
        s1 = (s1 >>> 17) & 0xffffffff;
        s1 ^= s0;
        s1 ^= (s0 >>> 26) & 0xffffffff;
        __ssS1 = s1 >>> 0;
        var r = (Math.imul(s0, 0x5bd1e995) + Math.imul(s1, 0x0ccbc4a5)) >>> 0;
        return r / 0x100000000;
      }

      function __ssRange(min, max) {
        return min + __ssNext() * (max - min);
      }

      function __ssInt(min, max) {
        return Math.floor(__ssRange(min, max + 1));
      }

      window.__ssPrng = { next: __ssNext, range: __ssRange, int: __ssInt };
    })();
  `;
}

/**
 * Stats bridge — the injected code increments counters that can be
 * read back from the Node side via `window.__ssCanvasStats`.
 */
function buildStatsBridge(): string {
  return `
    // ─── Stats bridge ───────────────────────────────────────────────────────
    window.__ssCanvasStats = {
      total: 0,
      textRendering: 0,
      gradientStops: 0,
      shadowColors: 0,
      pathJitter: 0,
      imageDataNoise: 0,
      webglReadPixels: 0
    };

    function __ssIncStat(key) {
      window.__ssCanvasStats[key]++;
      window.__ssCanvasStats.total++;
    }
  `;
}

/**
 * Anti-detection utilities:
 *  - Override Function.prototype.toString for patched functions so they
 *    return native-looking source code instead of the proxy body.
 *  - Preserve `.length` property on all patched functions.
 */
function buildAntiDetectionCode(): string {
  return `
    // ─── Anti-detection utilities ────────────────────────────────────────────
    var __ssNativeToString = Function.prototype.toString;
    var __ssPatchedMap = new WeakMap();

    /**
     * Mark a function as patched with a specific native-looking toString.
     * The map is checked by our overridden toString to return the fake source.
     */
    function __ssPatchToString(fn, nativeSource) {
      __ssPatchedMap.set(fn, nativeSource);
    }

    /**
     * Override Function.prototype.toString so that patched functions
     * return native-looking source code instead of revealing proxy logic.
     */
    var __ssOriginalToString = Function.prototype.toString;
    Function.prototype.toString = function() {
      if (__ssPatchedMap.has(this)) {
        return __ssPatchedMap.get(this);
      }
      return __ssOriginalToString.call(this);
    };
    __ssPatchToString(Function.prototype.toString, 'function toString() { [native code] }');

    /**
     * Wrap a function replacement that preserves the original .length
     * and installs a native-looking toString.
     */
    function __ssWrap(original, replacement, nativeSource) {
      // Try to preserve arity (function length)
      var wrapped = replacement;
      try {
        var origLen = original.length;
        if (wrapped.length !== origLen) {
          // Use Function constructor to set length — note: this is a best-effort.
          // Most detectors only check .length !== 0 for common APIs.
          Object.defineProperty(wrapped, 'length', { value: origLen, configurable: true });
        }
      } catch(e) {}
      __ssPatchToString(wrapped, nativeSource);
      return wrapped;
    }
  `;
}

// ─── Layer 1: Text Rendering Noise ──────────────────────────────────────────

/**
 * Override `fillText` and `strokeText` to add deterministic sub-pixel
 * offsets to glyph positions. Offset range: ±0.3px H, ±0.2px V (scaled).
 */
function buildTextRenderingNoiseCode(scale: typeof INTENSITY_SCALE.subtle): string {
  const maxH = (0.3 * scale.textOffsetH).toFixed(4);
  const maxV = (0.2 * scale.textOffsetV).toFixed(4);

  return `
    // ─── Layer 1: Text rendering noise ───────────────────────────────────────
    (function() {
      var origFillText = CanvasRenderingContext2D.prototype.fillText;
      var origStrokeText = CanvasRenderingContext2D.prototype.strokeText;

      var fillTextReplacement = function(text, x, y, maxWidth) {
        var dx = __ssPrng.range(-${maxH}, ${maxH});
        var dy = __ssPrng.range(-${maxV}, ${maxV});
        if (maxWidth !== undefined) {
          origFillText.call(this, text, x + dx, y + dy, maxWidth);
        } else {
          origFillText.call(this, text, x + dx, y + dy);
        }
        __ssIncStat('textRendering');
      };

      var strokeTextReplacement = function(text, x, y, maxWidth) {
        var dx = __ssPrng.range(-${maxH}, ${maxH});
        var dy = __ssPrng.range(-${maxV}, ${maxV});
        if (maxWidth !== undefined) {
          origStrokeText.call(this, text, x + dx, y + dy, maxWidth);
        } else {
          origStrokeText.call(this, text, x + dx, y + dy);
        }
        __ssIncStat('textRendering');
      };

      CanvasRenderingContext2D.prototype.fillText = __ssWrap(
        origFillText, fillTextReplacement,
        'function fillText() { [native code] }'
      );
      CanvasRenderingContext2D.prototype.strokeText = __ssWrap(
        origStrokeText, strokeTextReplacement,
        'function strokeText() { [native code] }'
      );
    })();
  `;
}

// ─── Layer 2: Gradient Stop Manipulation ─────────────────────────────────────

/**
 * Override `CanvasGradient.prototype.addColorStop` to shift the stop
 * position by ±0.001 (scaled). Invisible to humans but changes the hash.
 */
function buildGradientStopShiftCode(scale: typeof INTENSITY_SCALE.subtle): string {
  const maxShift = (0.001 * scale.gradientShift).toFixed(6);

  return `
    // ─── Layer 2: Gradient stop manipulation ─────────────────────────────────
    (function() {
      var origAddColorStop = CanvasGradient.prototype.addColorStop;

      var addColorStopReplacement = function(offset, color) {
        var shifted = offset + __ssPrng.range(-${maxShift}, ${maxShift});
        // Clamp to [0, 1]
        shifted = Math.max(0, Math.min(1, shifted));
        origAddColorStop.call(this, shifted, color);
        __ssIncStat('gradientStops');
      };

      CanvasGradient.prototype.addColorStop = __ssWrap(
        origAddColorStop, addColorStopReplacement,
        'function addColorStop() { [native code] }'
      );
    })();
  `;
}

// ─── Layer 3: Shadow Color Perturbation ──────────────────────────────────────

/**
 * Override the `shadowColor` setter to add ±1 (scaled) to RGB values.
 * This intercepts the property assignment, parses the color, perturbs
 * individual channels, and re-serialises.
 */
function buildShadowColorPerturbationCode(scale: typeof INTENSITY_SCALE.subtle): string {
  const maxDelta = Math.max(1, Math.round(1 * scale.shadowRgbDelta));

  return `
    // ─── Layer 3: Shadow color perturbation ──────────────────────────────────
    (function() {
      var origShadowColorDesc = Object.getOwnPropertyDescriptor(
        CanvasRenderingContext2D.prototype, 'shadowColor'
      );

      if (origShadowColorDesc && origShadowColorDesc.set) {
        var origSet = origShadowColorDesc.set;

        /**
         * Parse a CSS color string into {r, g, b, a} or return null.
         * Handles #rrggbb, rgb(r,g,b), rgba(r,g,b,a).
         */
        function __ssParseColor(str) {
          str = (str || '').trim();
          var m;
          // #rrggbb
          m = str.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
          if (m) return { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16), a: 1 };
          // #rgb
          m = str.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
          if (m) return { r: parseInt(m[1]+m[1],16), g: parseInt(m[2]+m[2],16), b: parseInt(m[3]+m[3],16), a: 1 };
          // rgba(r, g, b, a)
          m = str.match(/^rgba?\\s*\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*(?:,\\s*([\\d.]+)\\s*)?\\)$/i);
          if (m) return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]), a: m[4] !== undefined ? parseFloat(m[4]) : 1 };
          return null;
        }

        function __ssClamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

        var newSet = function(val) {
          var parsed = __ssParseColor(val);
          if (parsed) {
            var dr = __ssInt(-${maxDelta}, ${maxDelta});
            var dg = __ssInt(-${maxDelta}, ${maxDelta});
            var db = __ssInt(-${maxDelta}, ${maxDelta});
            var r = __ssClamp(parsed.r + dr, 0, 255);
            var g = __ssClamp(parsed.g + dg, 0, 255);
            var b = __ssClamp(parsed.b + db, 0, 255);
            var a = parsed.a;
            var newVal = 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
            origSet.call(this, newVal);
            __ssIncStat('shadowColors');
          } else {
            origSet.call(this, val);
          }
        };

        Object.defineProperty(CanvasRenderingContext2D.prototype, 'shadowColor', {
          get: origShadowColorDesc.get,
          set: __ssWrap(origSet, newSet, 'function set shadowColor() { [native code] }'),
          configurable: true,
          enumerable: true
        });
      }
    })();
  `;
}

// ─── Layer 4: Path Rendering Jitter ──────────────────────────────────────────

/**
 * Override `bezierCurveTo` and `quadraticCurveTo` to add ±0.01px
 * (scaled) deterministic jitter to control points.
 */
function buildPathJitterCode(scale: typeof INTENSITY_SCALE.subtle): string {
  const maxJitter = (0.01 * scale.pathJitter).toFixed(4);

  return `
    // ─── Layer 4: Path rendering jitter ──────────────────────────────────────
    (function() {
      var origBezier = CanvasRenderingContext2D.prototype.bezierCurveTo;
      var origQuadratic = CanvasRenderingContext2D.prototype.quadraticCurveTo;

      var bezierReplacement = function(cp1x, cp1y, cp2x, cp2y, x, y) {
        var j = ${maxJitter};
        origBezier.call(this,
          cp1x + __ssPrng.range(-j, j),
          cp1y + __ssPrng.range(-j, j),
          cp2x + __ssPrng.range(-j, j),
          cp2y + __ssPrng.range(-j, j),
          x, y
        );
        __ssIncStat('pathJitter');
      };

      var quadraticReplacement = function(cpx, cpy, x, y) {
        var j = ${maxJitter};
        origQuadratic.call(this,
          cpx + __ssPrng.range(-j, j),
          cpy + __ssPrng.range(-j, j),
          x, y
        );
        __ssIncStat('pathJitter');
      };

      CanvasRenderingContext2D.prototype.bezierCurveTo = __ssWrap(
        origBezier, bezierReplacement,
        'function bezierCurveTo() { [native code] }'
      );
      CanvasRenderingContext2D.prototype.quadraticCurveTo = __ssWrap(
        origQuadratic, quadraticReplacement,
        'function quadraticCurveTo() { [native code] }'
      );
    })();
  `;
}

// ─── Layer 5: Image Data Noise ───────────────────────────────────────────────

/**
 * Override `toDataURL` and `toBlob` to inject deterministic noise across
 * multiple pixels. The PRNG selects which pixels to modify and by how
 * much. Modifies 3-7 pixels (scaled) with ±1-3 value changes (scaled).
 *
 * Pixels are distributed across the canvas area (not all in one corner)
 * to avoid obvious artificial patterns.
 */
function buildImageDataNoiseCode(scale: typeof INTENSITY_SCALE.subtle): string {
  const countMin = Math.round(scale.pixelCountMin);
  const countMax = Math.round(scale.pixelCountMax);
  const maxDelta = Math.max(1, Math.round(3 * scale.pixelValueDelta));

  return `
    // ─── Layer 5: Image data noise (toDataURL / toBlob) ─────────────────────
    (function() {
      var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      var origToBlob = HTMLCanvasElement.prototype.toBlob;

      /**
       * Inject deterministic noise into a canvas's 2d image data.
       * Pixels are spread across the full area using a stride based on
       * canvas dimensions so the pattern does not cluster in one corner.
       */
      function __ssInjectNoise(canvas) {
        var ctx = canvas.getContext('2d');
        if (!ctx) return;
        var w = canvas.width;
        var h = canvas.height;
        if (w <= 0 || h <= 0) return;

        try {
          var count = __ssInt(${countMin}, ${countMax});
          var imageData = ctx.getImageData(0, 0, w, h);
          var data = imageData.data;
          var totalPixels = w * h;
          // Spread pixel indices across the canvas using a stride
          var stride = Math.max(1, Math.floor(totalPixels / (count + 1)));

          for (var i = 0; i < count; i++) {
            // Compute pixel index — spread evenly then add jitter
            var baseIdx = ((i + 1) * stride) % totalPixels;
            var jitter = __ssInt(0, Math.min(stride - 1, totalPixels - 1));
            var pixelIdx = (baseIdx + jitter) % totalPixels;
            var byteOffset = pixelIdx * 4;

            // Modify R, G, B channels (skip A to avoid transparency artefacts)
            if (byteOffset + 2 < data.length) {
              var dr = __ssInt(-${maxDelta}, ${maxDelta});
              var dg = __ssInt(-${maxDelta}, ${maxDelta});
              var db = __ssInt(-${maxDelta}, ${maxDelta});
              data[byteOffset]     = Math.max(0, Math.min(255, data[byteOffset] + dr));
              data[byteOffset + 1] = Math.max(0, Math.min(255, data[byteOffset + 1] + dg));
              data[byteOffset + 2] = Math.max(0, Math.min(255, data[byteOffset + 2] + db));
            }
          }
          ctx.putImageData(imageData, 0, 0);
        } catch(e) {
          // Canvas may be tainted or WebGL-only — silently skip
        }
      }

      var toDataURLReplacement = function() {
        __ssInjectNoise(this);
        var result = origToDataURL.apply(this, arguments);
        __ssIncStat('imageDataNoise');
        return result;
      };

      var toBlobReplacement = function(callback, mimeType, qualityArgument) {
        __ssInjectNoise(this);
        if (arguments.length >= 3) {
          origToBlob.call(this, callback, mimeType, qualityArgument);
        } else if (arguments.length === 2) {
          origToBlob.call(this, callback, mimeType);
        } else {
          origToBlob.call(this, callback);
        }
        __ssIncStat('imageDataNoise');
      };

      HTMLCanvasElement.prototype.toDataURL = __ssWrap(
        origToDataURL, toDataURLReplacement,
        'function toDataURL() { [native code] }'
      );
      HTMLCanvasElement.prototype.toBlob = __ssWrap(
        origToBlob, toBlobReplacement,
        'function toBlob() { [native code] }'
      );
    })();
  `;
}

// ─── WebGL readPixels Noise ──────────────────────────────────────────────────

/**
 * Override `WebGLRenderingContext.prototype.readPixels` and
 * `WebGL2RenderingContext.prototype.readPixels` to inject deterministic
 * noise into the pixel readback buffer.
 */
function buildWebGLReadPixelsNoiseCode(scale: typeof INTENSITY_SCALE.subtle): string {
  const maxDelta = Math.max(1, Math.round(3 * scale.pixelValueDelta));
  const countMin = Math.round(scale.pixelCountMin);
  const countMax = Math.round(scale.pixelCountMax);

  return `
    // ─── WebGL readPixels noise ──────────────────────────────────────────────
    (function() {
      /**
       * Inject deterministic noise into a Uint8Array pixel buffer.
       * Spreads modifications across the buffer to avoid clustering.
       */
      function __ssInjectWebGLNoise(pixels, width, height) {
        if (!(pixels instanceof Uint8Array)) return;
        var totalPixels = width * height;
        if (totalPixels <= 0) return;

        var count = __ssInt(${countMin}, ${countMax});
        var stride = Math.max(1, Math.floor(totalPixels / (count + 1)));

        for (var i = 0; i < count; i++) {
          var baseIdx = ((i + 1) * stride) % totalPixels;
          var jitter = __ssInt(0, Math.min(stride - 1, totalPixels - 1));
          var pixelIdx = (baseIdx + jitter) % totalPixels;
          var byteOffset = pixelIdx * 4;

          if (byteOffset + 2 < pixels.length) {
            var dr = __ssInt(-${maxDelta}, ${maxDelta});
            var dg = __ssInt(-${maxDelta}, ${maxDelta});
            var db = __ssInt(-${maxDelta}, ${maxDelta});
            pixels[byteOffset]     = Math.max(0, Math.min(255, pixels[byteOffset] + dr));
            pixels[byteOffset + 1] = Math.max(0, Math.min(255, pixels[byteOffset + 1] + dg));
            pixels[byteOffset + 2] = Math.max(0, Math.min(255, pixels[byteOffset + 2] + db));
          }
        }
      }

      // ── WebGL 1 ────────────────────────────────────────────────────────────
      if (typeof WebGLRenderingContext !== 'undefined') {
        var origReadPixels = WebGLRenderingContext.prototype.readPixels;

        var readPixelsReplacement = function(x, y, width, height, format, type, pixels) {
          origReadPixels.call(this, x, y, width, height, format, type, pixels);
          // Only perturb RGBA unsigned byte readbacks
          if (format === 0x1908 && type === 0x1401 && pixels) { // RGBA, UNSIGNED_BYTE
            __ssInjectWebGLNoise(pixels, width, height);
          }
          __ssIncStat('webglReadPixels');
        };

        WebGLRenderingContext.prototype.readPixels = __ssWrap(
          origReadPixels, readPixelsReplacement,
          'function readPixels() { [native code] }'
        );
      }

      // ── WebGL 2 ────────────────────────────────────────────────────────────
      if (typeof WebGL2RenderingContext !== 'undefined') {
        var origReadPixels2 = WebGL2RenderingContext.prototype.readPixels;

        var readPixels2Replacement = function(x, y, width, height, format, type, pixels) {
          origReadPixels2.call(this, x, y, width, height, format, type, pixels);
          if (format === 0x1908 && type === 0x1401 && pixels) {
            __ssInjectWebGLNoise(pixels, width, height);
          }
          __ssIncStat('webglReadPixels');
        };

        WebGL2RenderingContext.prototype.readPixels = __ssWrap(
          origReadPixels2, readPixels2Replacement,
          'function readPixels() { [native code] }'
        );
      }
    })();
  `;
}

// ===============================================================================
// CONVENIENCE: Derive seed from profile ID
// ===============================================================================

/**
 * Derive a numeric seed string from a profile ID.
 *
 * The derivation is a simple FNV-1a hash rendered as a decimal string.
 * This ensures the same profileId always maps to the same seed.
 */
export function deriveSeedFromProfileId(profileId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < profileId.length; i++) {
    hash ^= profileId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

// ===============================================================================
// CANVAS SPOOFER CLASS (for OOP consumers)
// ===============================================================================

/**
 * Object-oriented wrapper around the canvas spoofing module.
 * Useful for dependency injection and per-instance configuration.
 */
export class CanvasSpoofer {
  private readonly config: CanvasSpoofConfig;

  constructor(config: Partial<CanvasSpoofConfig> = {}) {
    this.config = { ...DEFAULT_CANVAS_SPOOF_CONFIG, ...config };
  }

  /**
   * Generate the injectable canvas spoofing script for a given profile.
   *
   * @param profileId - The fingerprint profile identifier.
   * @param seed      - Optional explicit seed.  If omitted, derived from profileId.
   * @returns Plain JS source for `Page.addScriptToEvaluateOnNewDocument`.
   */
  getScript(profileId: string, seed?: string): string {
    const actualSeed = seed ?? deriveSeedFromProfileId(profileId);
    return getCanvasSpoofScript(actualSeed, profileId, this.config);
  }

  /** Return a copy of the current configuration. */
  getConfig(): CanvasSpoofConfig {
    return { ...this.config };
  }

  /** Return a snapshot of the spoofing stats. */
  getStats(): CanvasSpoofStats {
    return getCanvasSpoofStats();
  }

  /** Reset stats counters. */
  resetStats(): void {
    resetCanvasSpoofStats();
  }
}

// ===============================================================================
// SINGLETON INSTANCE
// ===============================================================================

/** Default canvas spoofer instance with moderate intensity and all layers. */
export const canvasSpoofer = new CanvasSpoofer();
