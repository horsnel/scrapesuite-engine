/**
 * Advanced AudioContext Fingerprint Spoofer -- ScrapeSuite Engine
 *
 * Full audio rendering chain spoofing that replaces the basic single-method
 * getFloatFrequencyData jitter in stealth.ts with deterministic-per-profile
 * manipulation of the entire OfflineAudioContext pipeline.
 *
 * Architecture:
 *  +--------------------------------------------------------------------------+
 *  | xorshift128+ PRNG   | Seeded from profile ID → deterministic output    |
 *  | OscillatorNode      | frequency.setValueAtTime / linearRampToValueAtTime|
 *  |                     | micro-perturbations (±0.01 Hz deterministic)     |
 *  | DynamicsCompressor  | threshold/knee/ratio/attack/release getters      |
 *  |                     | return profile-specific values ±0.01 variance    |
 *  | OfflineAudioContext | startRendering() produces deterministic-but-     |
 *  |                     | unique AudioBuffer based on profile seed         |
 *  | AnalyserNode        | getFloatFrequencyData + getByteFrequencyData    |
 *  |                     | both overridden with deterministic jitter        |
 *  | GainNode            | gain.value perturbation ±0.001 dB               |
 *  | BiquadFilterNode    | frequency/Q/detune micro-shifts                 |
 *  | Anti-Detection      | toString spoof, length preservation,            |
 *  |                     | no Proxy detection                              |
 *  +--------------------------------------------------------------------------+
 *
 * Critical design constraint: the same profile seed MUST always produce the
 * same audio fingerprint. Advanced detectors hash the output of
 * OfflineAudioContext.startRendering() and flag inconsistencies across calls.
 * The old implementation used Math.random() which produces different hashes
 * per invocation — a direct detection signal.
 *
 * Exported function `getAudioSpoofScript()` returns plain JavaScript suitable
 * for injection via CDP `Page.addScriptToEvaluateOnNewDocument`.
 */

import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('anti-bot:audio-spoofer');

// ===============================================================================
// CONFIGURATION
// ===============================================================================

/**
 * Configuration for the audio fingerprint spoofing module.
 * Each component can be individually toggled, and overall noise intensity
 * controls the magnitude of all perturbations.
 */
export interface AudioSpoofConfig {
  /** Override OscillatorNode frequency scheduling methods */
  oscillatorPerturbation: boolean;
  /** Override DynamicsCompressorNode parameter getters */
  compressorPerturbation: boolean;
  /** Override OfflineAudioContext.startRendering for deterministic output */
  offlineContextOverride: boolean;
  /** Override AnalyserNode frequency data methods */
  analyserPerturbation: boolean;
  /** Override GainNode.gain value */
  gainPerturbation: boolean;
  /** Override BiquadFilterNode parameters */
  biquadFilterPerturbation: boolean;
  /** Overall noise intensity */
  noiseIntensity: 'subtle' | 'moderate' | 'strong';
}

export const DEFAULT_AUDIO_SPOOF_CONFIG: AudioSpoofConfig = {
  oscillatorPerturbation: true,
  compressorPerturbation: true,
  offlineContextOverride: true,
  analyserPerturbation: true,
  gainPerturbation: true,
  biquadFilterPerturbation: true,
  noiseIntensity: 'moderate',
};

// ===============================================================================
// NOISE INTENSITY MULTIPLIERS
// ===============================================================================

const INTENSITY_MAP: Record<string, {
  oscillatorFreqShift: number;
  compressorParamShift: number;
  analyserFloatShift: number;
  analyserByteShift: number;
  gainShift: number;
  biquadFreqShift: number;
  biquadQShift: number;
  biquadDetuneShift: number;
  renderingBufferShift: number;
}> = {
  subtle: {
    oscillatorFreqShift: 0.001,
    compressorParamShift: 0.001,
    analyserFloatShift: 0.0001,
    analyserByteShift: 0.1,
    gainShift: 0.0001,
    biquadFreqShift: 0.01,
    biquadQShift: 0.001,
    biquadDetuneShift: 0.01,
    renderingBufferShift: 0.000001,
  },
  moderate: {
    oscillatorFreqShift: 0.01,
    compressorParamShift: 0.01,
    analyserFloatShift: 0.001,
    analyserByteShift: 0.5,
    gainShift: 0.001,
    biquadFreqShift: 0.1,
    biquadQShift: 0.01,
    biquadDetuneShift: 0.1,
    renderingBufferShift: 0.00001,
  },
  strong: {
    oscillatorFreqShift: 0.05,
    compressorParamShift: 0.05,
    analyserFloatShift: 0.005,
    analyserByteShift: 1.0,
    gainShift: 0.005,
    biquadFreqShift: 0.5,
    biquadQShift: 0.05,
    biquadDetuneShift: 0.5,
    renderingBufferShift: 0.0001,
  },
};

// ===============================================================================
// STATS
// ===============================================================================

export interface AudioSpoofStats {
  scriptsGenerated: number;
  oscillatorOverrides: number;
  compressorOverrides: number;
  offlineContextOverrides: number;
  analyserOverrides: number;
  gainOverrides: number;
  biquadFilterOverrides: number;
}

let stats: AudioSpoofStats = {
  scriptsGenerated: 0,
  oscillatorOverrides: 0,
  compressorOverrides: 0,
  offlineContextOverrides: 0,
  analyserOverrides: 0,
  gainOverrides: 0,
  biquadFilterOverrides: 0,
};

export function getAudioSpoofStats(): AudioSpoofStats { return { ...stats }; }
export function resetAudioSpoofStats(): void {
  stats = {
    scriptsGenerated: 0, oscillatorOverrides: 0, compressorOverrides: 0,
    offlineContextOverrides: 0, analyserOverrides: 0, gainOverrides: 0, biquadFilterOverrides: 0,
  };
}

// ===============================================================================
// SEED UTILITIES (same PRNG as canvas-spoofer for consistency)
// ===============================================================================

/**
 * Derive a numeric seed from a profile ID string using FNV-1a hash.
 */
function deriveSeedFromProfileId(profileId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < profileId.length; i++) {
    hash ^= profileId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// ===============================================================================
// SCRIPT GENERATOR
// ===============================================================================

/**
 * Generate the complete audio fingerprint spoofing script for a given profile.
 *
 * @param seed      - Numeric seed for the deterministic PRNG.
 * @param profileId - The fingerprint profile identifier.
 * @param config    - Spoofing configuration.
 * @returns Plain JS source for `Page.addScriptToEvaluateOnNewDocument`.
 */
export function getAudioSpoofScript(
  seed: string | number,
  profileId: string,
  config: AudioSpoofConfig = DEFAULT_AUDIO_SPOOF_CONFIG,
): string {
  const numericSeed = typeof seed === 'string' ? deriveSeedFromProfileId(seed) : seed;
  const intensity = INTENSITY_MAP[config.noiseIntensity] || INTENSITY_MAP.moderate;

  stats.scriptsGenerated++;

  logger.debug({ profileId, numericSeed, intensity: config.noiseIntensity }, 'Generating audio spoof script');

  // Build the script sections conditionally
  const sections: string[] = [];

  // --- Core PRNG (always included) ---
  sections.push(`
// ScrapeSuite Audio Spoofer — Deterministic PRNG (profile: ${profileId})
(function() {
  'use strict';

  // xorshift128+ PRNG seeded from profile
  var __ssSeedLo = ${numericSeed} >>> 0;
  var __ssSeedHi = ((__ssSeedLo * 1103515245 + 12345) >>> 0);
  function __ssRand() {
    var s0 = __ssSeedLo;
    var s1 = __ssSeedHi;
    __ssSeedLo = s1;
    s0 ^= s0 << 23;
    s0 ^= s0 >>> 17;
    s0 ^= s1;
    s0 ^= s1 >>> 26;
    __ssSeedHi = s0;
    return (s0 + s1) >>> 0;
  }
  function __ssRandFloat() { return (__ssRand() >>> 0) / 4294967296; }
  function __ssRandSigned(mag) { return (__ssRandFloat() - 0.5) * 2 * mag; }
  function __ssRandInt(min, max) { return min + (__ssRand() >>> 0) % (max - min + 1); }

  // Helper: deterministic offset for a given call index (to keep stability)
  var __ssCallIdx = {};
  function __ssDetOffset(key, magnitude) {
    if (!__ssCallIdx[key]) __ssCallIdx[key] = 0;
    // Re-seed for each unique key so different keys get different sequences
    var savedLo = __ssSeedLo, savedHi = __ssSeedHi;
    var h = 2166136261;
    for (var i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
    __ssSeedLo = (h >>> 0);
    __ssSeedHi = ((__ssSeedLo * 1103515245 + 12345) >>> 0);
    var offset = __ssRandSigned(magnitude);
    __ssSeedLo = savedLo; __ssSeedHi = savedHi;
    __ssCallIdx[key]++;
    return offset;
  }

  // toString spoof — prevents detection of overridden native functions
  var __ssNativeToString = Function.prototype.toString;
  var __ssSpoofedFns = new WeakMap();
  function __ssMarkNative(fn, nativeName) {
    __ssSpoofedFns.set(fn, 'function ' + (nativeName || fn.name || '') + '() { [native code] }');
  }
  var __ssOrigToString = Function.prototype.toString;
  Function.prototype.toString = function() {
    if (__ssSpoofedFns.has(this)) return __ssSpoofedFns.get(this);
    return __ssOrigToString.call(this);
  };
  __ssMarkNative(Function.prototype.toString, 'toString');
`);

  // --- OscillatorNode perturbation ---
  if (config.oscillatorPerturbation) {
    stats.oscillatorOverrides++;
    sections.push(`
  // --- OscillatorNode frequency perturbation ---
  if (typeof OscillatorNode !== 'undefined') {
    var __ssOrigSetValueAtTime = OscillatorNode.prototype.setValueAtTime;
    OscillatorNode.prototype.setValueAtTime = function(value, startTime) {
      var offset = __ssDetOffset('osc_set_' + Math.round(value * 100) + '_' + Math.round(startTime * 100), ${intensity.oscillatorFreqShift});
      return __ssOrigSetValueAtTime.call(this, value + offset, startTime);
    };
    __ssMarkNative(OscillatorNode.prototype.setValueAtTime, 'setValueAtTime');

    var __ssOrigLinearRamp = OscillatorNode.prototype.linearRampToValueAtTime;
    OscillatorNode.prototype.linearRampToValueAtTime = function(value, endTime) {
      var offset = __ssDetOffset('osc_ramp_' + Math.round(value * 100) + '_' + Math.round(endTime * 100), ${intensity.oscillatorFreqShift});
      return __ssOrigLinearRamp.call(this, value + offset, endTime);
    };
    __ssMarkNative(OscillatorNode.prototype.linearRampToValueAtTime, 'linearRampToValueAtTime');

    var __ssOrigExponentialRamp = OscillatorNode.prototype.exponentialRampToValueAtTime;
    if (__ssOrigExponentialRamp) {
      OscillatorNode.prototype.exponentialRampToValueAtTime = function(value, endTime) {
        var offset = __ssDetOffset('osc_expramp_' + Math.round(value * 100), ${intensity.oscillatorFreqShift});
        var safeValue = value + offset;
        if (safeValue <= 0) safeValue = 0.0001; // exponentialRamp requires positive values
        return __ssOrigExponentialRamp.call(this, safeValue, endTime);
      };
      __ssMarkNative(OscillatorNode.prototype.exponentialRampToValueAtTime, 'exponentialRampToValueAtTime');
    }

    var __ssOrigSetTargetAtTime = OscillatorNode.prototype.setTargetAtTime;
    if (__ssOrigSetTargetAtTime) {
      OscillatorNode.prototype.setTargetAtTime = function(target, startTime, timeConstant) {
        var offset = __ssDetOffset('osc_target_' + Math.round(target * 100), ${intensity.oscillatorFreqShift});
        return __ssOrigSetTargetAtTime.call(this, target + offset, startTime, timeConstant);
      };
      __ssMarkNative(OscillatorNode.prototype.setTargetAtTime, 'setTargetAtTime');
    }

    var __ssOrigSetValueCurve = OscillatorNode.prototype.setValueCurveAtTime;
    if (__ssOrigSetValueCurve) {
      OscillatorNode.prototype.setValueCurveAtTime = function(values, startTime, duration) {
        if (values && values.length > 0) {
          var newValues = new Float32Array(values.length);
          for (var i = 0; i < values.length; i++) {
            newValues[i] = values[i] + __ssDetOffset('osc_curve_' + i + '_' + Math.round(values[i] * 100), ${intensity.oscillatorFreqShift});
          }
          return __ssOrigSetValueCurve.call(this, newValues, startTime, duration);
        }
        return __ssOrigSetValueCurve.call(this, values, startTime, duration);
      };
      __ssMarkNative(OscillatorNode.prototype.setValueCurveAtTime, 'setValueCurveAtTime');
    }
  }
`);
  }

  // --- DynamicsCompressorNode perturbation ---
  if (config.compressorPerturbation) {
    stats.compressorOverrides++;
    sections.push(`
  // --- DynamicsCompressorNode parameter perturbation ---
  if (typeof DynamicsCompressorNode !== 'undefined') {
    var __ssCompressorParams = ['threshold', 'knee', 'ratio', 'attack', 'release'];
    __ssCompressorParams.forEach(function(paramName) {
      var origDesc = Object.getOwnPropertyDescriptor(DynamicsCompressorNode.prototype, paramName);
      if (!origDesc) return;
      if (origDesc.get) {
        Object.defineProperty(DynamicsCompressorNode.prototype, paramName, {
          get: function() {
            var audioParam = origDesc.get.call(this);
            if (!audioParam || !audioParam.__ssPatched) {
              if (audioParam) {
                var origValue = audioParam.value;
                var offset = __ssDetOffset('comp_' + paramName + '_' + Math.round(origValue * 100), ${intensity.compressorParamShift});
                Object.defineProperty(audioParam, 'value', {
                  get: function() { return origValue + offset; },
                  set: function(v) { origValue = v; },
                  configurable: true,
                });
                audioParam.__ssPatched = true;
              }
            }
            return audioParam;
          },
          configurable: true,
        });
      }
    });
  }
`);
  }

  // --- OfflineAudioContext deterministic rendering ---
  if (config.offlineContextOverride) {
    stats.offlineContextOverrides++;
    sections.push(`
  // --- OfflineAudioContext deterministic rendering override ---
  if (typeof OfflineAudioContext !== 'undefined') {
    var __ssOrigStartRendering = OfflineAudioContext.prototype.startRendering;
    OfflineAudioContext.prototype.startRendering = function() {
      var ctx = this;
      return __ssOrigStartRendering.call(this).then(function(buffer) {
        // Apply deterministic noise to the rendered audio buffer
        if (buffer && buffer.numberOfChannels > 0 && buffer.length > 0) {
          var channelData = buffer.getChannelData(0);
          var seed = ${numericSeed};
          var lo = seed >>> 0;
          var hi = ((lo * 1103515245 + 12345) >>> 0);
          for (var i = 0; i < channelData.length; i++) {
            // xorshift128+ step
            var s0 = lo, s1 = hi;
            lo = s1;
            s0 ^= s0 << 23;
            s0 ^= s0 >>> 17;
            s0 ^= s1;
            s0 ^= s1 >>> 26;
            hi = s0;
            var rand = ((s0 + s1) >>> 0) / 4294967296;
            // Apply subtle deterministic noise — only to every Nth sample for performance
            if (i % 128 === 0) {
              channelData[i] += (rand - 0.5) * 2 * ${intensity.renderingBufferShift};
            }
          }
        }
        return buffer;
      });
    };
    __ssMarkNative(OfflineAudioContext.prototype.startRendering, 'startRendering');

    // Also override suspend/resume for consistency
    if (OfflineAudioContext.prototype.suspend) {
      var __ssOrigSuspend = OfflineAudioContext.prototype.suspend;
      OfflineAudioContext.prototype.suspend = function() {
        return __ssOrigSuspend.call(this);
      };
      __ssMarkNative(OfflineAudioContext.prototype.suspend, 'suspend');
    }
  }

  // --- AudioContext base class deterministic properties ---
  if (typeof AudioContext !== 'undefined') {
    var __ssOrigACCreateOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function() {
      var osc = __ssOrigACCreateOscillator.call(this);
      // Patch the frequency AudioParam for this oscillator instance
      var origFreqValue = osc.frequency.value;
      var freqOffset = __ssDetOffset('ac_osc_freq_' + Math.round(origFreqValue * 100), ${intensity.oscillatorFreqShift});
      var origFreqValueGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(osc.frequency), 'value');
      if (origFreqValueGetter && origFreqValueGetter.get) {
        Object.defineProperty(osc.frequency, 'value', {
          get: function() { return origFreqValue + freqOffset; },
          set: function(v) { origFreqValue = v; freqOffset = __ssDetOffset('ac_osc_freq_' + Math.round(v * 100), ${intensity.oscillatorFreqShift}); },
          configurable: true,
        });
      }
      return osc;
    };
    __ssMarkNative(AudioContext.prototype.createOscillator, 'createOscillator');
  }
`);
  }

  // --- AnalyserNode perturbation ---
  if (config.analyserPerturbation) {
    stats.analyserOverrides++;
    sections.push(`
  // --- AnalyserNode frequency data perturbation ---
  if (typeof AnalyserNode !== 'undefined') {
    var __ssOrigGetFloat = AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData = function(array) {
      __ssOrigGetFloat.call(this, array);
      // Deterministic perturbation — same input always gets same noise
      var lo = ${numericSeed} >>> 0;
      var hi = ((lo * 1103515245 + 12345) >>> 0);
      for (var i = 0; i < array.length; i++) {
        var s0 = lo, s1 = hi;
        lo = s1;
        s0 ^= s0 << 23;
        s0 ^= s0 >>> 17;
        s0 ^= s1;
        s0 ^= s1 >>> 26;
        hi = s0;
        var rand = ((s0 + s1) >>> 0) / 4294967296;
        array[i] += (rand - 0.5) * 2 * ${intensity.analyserFloatShift};
      }
    };
    __ssMarkNative(AnalyserNode.prototype.getFloatFrequencyData, 'getFloatFrequencyData');

    var __ssOrigGetByte = AnalyserNode.prototype.getByteFrequencyData;
    if (__ssOrigGetByte) {
      AnalyserNode.prototype.getByteFrequencyData = function(array) {
        __ssOrigGetByte.call(this, array);
        var lo = ${numericSeed} >>> 0;
        var hi = ((lo * 1103515245 + 12345) >>> 0);
        for (var i = 0; i < array.length; i++) {
          var s0 = lo, s1 = hi;
          lo = s1;
          s0 ^= s0 << 23;
          s0 ^= s0 >>> 17;
          s0 ^= s1;
          s0 ^= s1 >>> 26;
          hi = s0;
          var rand = ((s0 + s1) >>> 0) / 4294967296;
          var shift = Math.round((rand - 0.5) * 2 * ${intensity.analyserByteShift});
          array[i] = Math.max(0, Math.min(255, array[i] + shift));
        }
      };
      __ssMarkNative(AnalyserNode.prototype.getByteFrequencyData, 'getByteFrequencyData');
    }

    var __ssOrigGetByteTime = AnalyserNode.prototype.getByteTimeDomainData;
    if (__ssOrigGetByteTime) {
      AnalyserNode.prototype.getByteTimeDomainData = function(array) {
        __ssOrigGetByteTime.call(this, array);
        // Subtle deterministic shift — same seed, same output
        var lo = ${numericSeed} >>> 0;
        var hi = ((lo * 1103515245 + 12345) >>> 0);
        for (var i = 0; i < array.length; i++) {
          var s0 = lo, s1 = hi;
          lo = s1;
          s0 ^= s0 << 23;
          s0 ^= s0 >>> 17;
          s0 ^= s1;
          s0 ^= s1 >>> 26;
          hi = s0;
          var rand = ((s0 + s1) >>> 0) / 4294967296;
          var shift = Math.round((rand - 0.5) * 2 * ${intensity.analyserByteShift * 0.5});
          array[i] = Math.max(0, Math.min(255, array[i] + shift));
        }
      };
      __ssMarkNative(AnalyserNode.prototype.getByteTimeDomainData, 'getByteTimeDomainData');
    }

    // Override fftSize and frequencyBinCount for consistency
    var __ssOrigFftSizeDesc = Object.getOwnPropertyDescriptor(AnalyserNode.prototype, 'fftSize');
    if (__ssOrigFftSizeDesc && __ssOrigFftSizeDesc.get) {
      var __ssOrigFftSizeGetter = __ssOrigFftSizeDesc.get;
      Object.defineProperty(AnalyserNode.prototype, 'fftSize', {
        get: function() { return __ssOrigFftSizeGetter.call(this); },
        set: function(v) { __ssOrigFftSizeDesc.set.call(this, v); },
        configurable: true,
      });
    }
  }
`);
  }

  // --- GainNode perturbation ---
  if (config.gainPerturbation) {
    stats.gainOverrides++;
    sections.push(`
  // --- GainNode gain value perturbation ---
  if (typeof GainNode !== 'undefined') {
    var __ssOrigGainValueDesc = Object.getOwnPropertyDescriptor(GainNode.prototype, 'gain');
    if (__ssOrigGainValueDesc && __ssOrigGainValueDesc.get) {
      var __ssOrigGainGetter = __ssOrigGainValueDesc.get;
      Object.defineProperty(GainNode.prototype, 'gain', {
        get: function() {
          var audioParam = __ssOrigGainGetter.call(this);
          if (audioParam && !audioParam.__ssGainPatched) {
            var origValue = audioParam.value;
            var offset = __ssDetOffset('gain_' + Math.round(origValue * 10000), ${intensity.gainShift});
            var storedValue = origValue;
            Object.defineProperty(audioParam, 'value', {
              get: function() { return storedValue + offset; },
              set: function(v) { storedValue = v; },
              configurable: true,
            });
            audioParam.__ssGainPatched = true;
          }
          return audioParam;
        },
        configurable: true,
      });
    }
  }
`);
  }

  // --- BiquadFilterNode perturbation ---
  if (config.biquadFilterPerturbation) {
    stats.biquadFilterOverrides++;
    sections.push(`
  // --- BiquadFilterNode parameter perturbation ---
  if (typeof BiquadFilterNode !== 'undefined') {
    ['frequency', 'Q', 'detune', 'gain'].forEach(function(paramName) {
      var origDesc = Object.getOwnPropertyDescriptor(BiquadFilterNode.prototype, paramName);
      if (!origDesc || !origDesc.get) return;
      var origGetter = origDesc.get;
      Object.defineProperty(BiquadFilterNode.prototype, paramName, {
        get: function() {
          var audioParam = origGetter.call(this);
          if (audioParam && !audioParam['__ss_biquad_' + paramName]) {
            var origValue = audioParam.value;
            var shiftMag = paramName === 'frequency' ? ${intensity.biquadFreqShift}
                         : paramName === 'Q' ? ${intensity.biquadQShift}
                         : paramName === 'detune' ? ${intensity.biquadDetuneShift}
                         : ${intensity.gainShift};
            var offset = __ssDetOffset('biquad_' + paramName + '_' + Math.round(origValue * 100), shiftMag);
            var storedValue = origValue;
            Object.defineProperty(audioParam, 'value', {
              get: function() { return storedValue + offset; },
              set: function(v) { storedValue = v; },
              configurable: true,
            });
            audioParam['__ss_biquad_' + paramName] = true;
          }
          return audioParam;
        },
        configurable: true,
      });
    });
  }
`);
  }

  // --- Close IIFE ---
  sections.push(`
})();
`);

  const script = sections.join('\n');

  logger.debug({
    profileId,
    scriptLength: script.length,
    sections: sections.length,
  }, 'Audio spoof script generated');

  return script;
}

// ===============================================================================
// CONVENIENCE: Derive seed from profileId
// ===============================================================================

/**
 * Generate an audio spoofing script using a profile ID as the seed source.
 *
 * @param profileId - The fingerprint profile identifier.
 * @param config    - Spoofing configuration.
 * @returns Plain JS source for `Page.addScriptToEvaluateOnNewDocument`.
 */
export function getAudioSpoofScriptForProfile(
  profileId: string,
  config: AudioSpoofConfig = DEFAULT_AUDIO_SPOOF_CONFIG,
): string {
  const seed = deriveSeedFromProfileId(profileId);
  return getAudioSpoofScript(seed, profileId, config);
}

// ===============================================================================
// OOP WRAPPER
// ===============================================================================

/**
 * Object-oriented wrapper around the audio spoofing module.
 */
export class AudioSpoofer {
  private readonly config: AudioSpoofConfig;

  constructor(config: Partial<AudioSpoofConfig> = {}) {
    this.config = { ...DEFAULT_AUDIO_SPOOF_CONFIG, ...config };
  }

  /**
   * Generate the injectable audio spoofing script for a given profile.
   *
   * @param profileId - The fingerprint profile identifier.
   * @param seed      - Optional explicit seed.  If omitted, derived from profileId.
   * @returns Plain JS source for `Page.addScriptToEvaluateOnNewDocument`.
   */
  getScript(profileId: string, seed?: string): string {
    const actualSeed = seed ?? deriveSeedFromProfileId(profileId);
    return getAudioSpoofScript(actualSeed, profileId, this.config);
  }

  /** Return a copy of the current configuration. */
  getConfig(): AudioSpoofConfig {
    return { ...this.config };
  }

  /** Return a snapshot of the spoofing stats. */
  getStats(): AudioSpoofStats {
    return getAudioSpoofStats();
  }

  /** Reset stats counters. */
  resetStats(): void {
    resetAudioSpoofStats();
  }
}

// ===============================================================================
// SINGLETON INSTANCE
// ===============================================================================

/** Default audio spoofer instance with moderate intensity and all layers. */
export const audioSpoofer = new AudioSpoofer();
