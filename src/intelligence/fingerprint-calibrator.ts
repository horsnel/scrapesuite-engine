/**
 * Fingerprint Calibrator -- ScrapeSuite Engine
 *
 * Keeps TLS profiles and browser fingerprints fresh as browser
 * versions update and anti-bot systems evolve.
 *
 * * TLS profile calibration against latest Chrome/Firefox/Safari/Edge versions
 * * Browser fingerprint freshness scoring (0–100)
 * * Automated browser release monitoring (simulated chromium dash API)
 * * Coherent profile generation from latest browser version data
 * * Changelog tracking for all calibration events
 * * Staleness detection with configurable freshness rules
 */

import { createChildLogger } from '../utils/logger';
import { redis, cacheGet, cacheSet } from '../utils/redis';

const logger = createChildLogger('fingerprint-calibrator');

// ===============================================================================
// TYPES
// ===============================================================================

export type BrowserFamily = 'chrome' | 'firefox' | 'safari' | 'edge';

export interface BrowserRelease {
  family: BrowserFamily;
  version: string;
  releaseDate: string;
  majorVersion: number;
  isLts: boolean;
  status: 'stable' | 'beta' | 'dev' | 'deprecated';
  keyFingerprintChanges: string[];
}

export interface TlsCalibrationResult {
  browser: BrowserFamily;
  version: string;
  ja3Hash: string;
  ja4Hash: string;
  cipherSuites: string[];
  extensions: string[];
  alpnProtocols: string[];
  h2Settings: Record<string, number>;
  isCurrent: boolean;
  stalenessScore: number; // 0 = fresh, 100 = completely stale
  calibratedAt: number;
}

export interface BrowserCalibrationResult {
  profileName: string;
  browser: BrowserFamily;
  version: string;
  canvasHash: string;
  webglVendor: string;
  webglRenderer: string;
  fontList: string[];
  audioFingerprint: string;
  userAgent: string;
  freshnessScore: number; // 0–100
  issues: string[];
  calibratedAt: number;
}

export interface FreshnessValidation {
  profileName: string;
  overallScore: number; // 0–100
  breakdown: {
    versionFreshness: number;
    canvasFreshness: number;
    webglFreshness: number;
    fontFreshness: number;
    uaConsistency: number;
    tlsConsistency: number;
  };
  verdict: 'fresh' | 'aging' | 'stale' | 'risky';
  recommendations: string[];
}

export interface ChangelogEntry {
  timestamp: number;
  action: string;
  details: Record<string, unknown>;
  affectedProfiles: string[];
}

// ===============================================================================
// BROWSER RELEASE SCHEDULE
// ===============================================================================

export const BROWSER_RELEASE_SCHEDULE: Record<BrowserFamily, {
  cadenceWeeks: number;
  cadenceLabel: string;
  stableChannel: string;
  betaChannel: string;
}> = {
  chrome:  { cadenceWeeks: 4,  cadenceLabel: '4 weeks',  stableChannel: 'stable',  betaChannel: 'beta' },
  firefox: { cadenceWeeks: 4,  cadenceLabel: '4 weeks',  stableChannel: 'release', betaChannel: 'beta' },
  safari:  { cadenceWeeks: 26, cadenceLabel: '6–12 months', stableChannel: 'release', betaChannel: 'preview' },
  edge:    { cadenceWeeks: 4,  cadenceLabel: '4 weeks',  stableChannel: 'stable',  betaChannel: 'beta' },
};

// ===============================================================================
// CHROME VERSION TIMELINE -- 126 through 132
// ===============================================================================

export const CHROME_VERSION_TIMELINE: BrowserRelease[] = [
  {
    family: 'chrome', version: '126', majorVersion: 126, releaseDate: '2024-06-11', isLts: false, status: 'deprecated',
    keyFingerprintChanges: ['Updated Sec-CH-UA brand hints', 'New Accept-Language weightings'],
  },
  {
    family: 'chrome', version: '127', majorVersion: 127, releaseDate: '2024-07-23', isLts: false, status: 'deprecated',
    keyFingerprintChanges: ['TLS cipher suite reorder', 'New device memory rounding behavior'],
  },
  {
    family: 'chrome', version: '128', majorVersion: 128, releaseDate: '2024-08-20', isLts: false, status: 'deprecated',
    keyFingerprintChanges: ['Canvas fingerprint noise generation updated', 'WebGL ANGLE backend changes'],
  },
  {
    family: 'chrome', version: '129', majorVersion: 129, releaseDate: '2024-09-17', isLts: false, status: 'deprecated',
    keyFingerprintChanges: ['Updated JA3 extensions order', 'HTTP/2 SETTINGS frame value changes'],
  },
  {
    family: 'chrome', version: '130', majorVersion: 130, releaseDate: '2024-10-15', isLts: false, status: 'stable',
    keyFingerprintChanges: ['Sec-CH-UA brand format change to "Not?A_Brand"', 'New Font Access API affecting font enumeration'],
  },
  {
    family: 'chrome', version: '131', majorVersion: 131, releaseDate: '2024-11-12', isLts: false, status: 'beta',
    keyFingerprintChanges: ['Experimental WebGPU changes', 'Updated NavigatorUAData properties'],
  },
  {
    family: 'chrome', version: '132', majorVersion: 132, releaseDate: '2024-12-10', isLts: false, status: 'dev',
    keyFingerprintChanges: ['TLS 1.3 hybrid post-quantum key exchange', 'Updated AudioContext fingerprint surface'],
  },
];

// ===============================================================================
// FINGERPRINT FRESHNESS RULES
// ===============================================================================

export const FINGERPRINT_FRESHNESS_RULES = {
  /** Chrome version > 2 major versions behind latest = stale */
  CHROME_MAX_VERSIONS_BEHIND: 2,
  /** Firefox version > 2 major versions behind latest = stale */
  FIREFOX_MAX_VERSIONS_BEHIND: 2,
  /** Safari version > 1 major version behind latest = stale (slow release cycle) */
  SAFARI_MAX_VERSIONS_BEHIND: 1,
  /** Edge version > 2 major versions behind latest = stale */
  EDGE_MAX_VERSIONS_BEHIND: 2,
  /** Canvas hash not in known set = risky */
  CANVAS_UNKNOWN_PENALTY: 30,
  /** WebGL vendor/renderer not in known set = risky */
  WEBGL_UNKNOWN_PENALTY: 25,
  /** Font list too short (< 5 fonts) = suspicious */
  FONT_LIST_MIN_SIZE: 5,
  /** Font list too long (> 30 desktop fonts) = suspicious (likely system enumeration) */
  FONT_LIST_MAX_SIZE_DESKTOP: 30,
  /** User-Agent doesn't match browser version claim = inconsistency */
  UA_VERSION_MISMATCH_PENALTY: 40,
  /** TLS JA3 hash not matching claimed browser = serious inconsistency */
  TLS_JA3_MISMATCH_PENALTY: 50,
  /** Score thresholds for verdicts */
  VERDICT_THRESHOLDS: {
    fresh:  85,
    aging:  65,
    stale:  40,
    risky:  0,
  },
} as const;

// Known canvas hashes for current Chrome versions (simulated)
const KNOWN_CANVAS_HASHES = new Set([
  'a1b2c3d4e5f6', 'b2c3d4e5f6a1', 'c3d4e5f6a1b2', 'd4e5f6a1b2c3',
  'e5f6a1b2c3d4', 'f6a1b2c3d4e5', '1a2b3c4d5e6f', '2b3c4d5e6f1a',
]);

// Known WebGL vendor/renderer pairs
const KNOWN_WEBGL_PAIRS = new Set([
  'Google Inc. (Intel)|ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)',
  'Google Inc. (NVIDIA)|ANGLE (NVIDIA, NVIDIA GeForce GTX 1060, OpenGL 4.5)',
  'Google Inc. (Apple)|ANGLE (Apple, Apple M1, OpenGL 4.1)',
  'Apple Inc.|Apple GPU',
  'Mesa|Mesa Intel(R) UHD Graphics 630 (CFL GT2)',
  'Google Inc. (Qualcomm)|ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)',
]);

// ===============================================================================
// FINGERPRINT CALIBRATOR ENGINE
// ===============================================================================

export class FingerprintCalibratorEngine {
  private tlsCalibrations = new Map<string, TlsCalibrationResult>();
  private browserCalibrations = new Map<string, BrowserCalibrationResult>();
  private changelog: ChangelogEntry[] = [];
  private knownReleases: BrowserRelease[] = [...CHROME_VERSION_TIMELINE];
  private initialized = false;

  private readonly MAX_CHANGELOG = 500;

  // --- Initialization ---------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing Fingerprint Calibrator...');

    // Load cached calibrations from Redis
    try {
      const cachedTls = await cacheGet<Record<string, TlsCalibrationResult>>('calibrator:tls');
      if (cachedTls) {
        for (const [key, val] of Object.entries(cachedTls)) {
          this.tlsCalibrations.set(key, val);
        }
        logger.info({ count: Object.keys(cachedTls).length }, 'Loaded cached TLS calibrations');
      }
    } catch { /* ignore */ }

    try {
      const cachedBrowser = await cacheGet<Record<string, BrowserCalibrationResult>>('calibrator:browser');
      if (cachedBrowser) {
        for (const [key, val] of Object.entries(cachedBrowser)) {
          this.browserCalibrations.set(key, val);
        }
        logger.info({ count: Object.keys(cachedBrowser).length }, 'Loaded cached browser calibrations');
      }
    } catch { /* ignore */ }

    this.initialized = true;
    logger.info('Fingerprint Calibrator initialized');
  }

  // --- Calibrate TLS Profiles ------------------------------------------------

  async calibrateTlsProfiles(): Promise<TlsCalibrationResult[]> {
    logger.info('Starting TLS profile calibration...');

    const results: TlsCalibrationResult[] = [];
    const latestVersions = this.getLatestVersions();

    for (const release of latestVersions) {
      if (release.status === 'deprecated') continue;

      const key = `${release.family}-${release.version}`;
      const calibration = this.generateTlsCalibration(release);

      this.tlsCalibrations.set(key, calibration);
      results.push(calibration);

      this.addChangelog('tls_calibrated', {
        browser: release.family,
        version: release.version,
        ja3Hash: calibration.ja3Hash,
        isCurrent: calibration.isCurrent,
      }, [key]);
    }

    // Persist
    await this.persistTlsCalibrations();

    logger.info({ count: results.length }, 'TLS profile calibration completed');
    return results;
  }

  // --- Calibrate Browser Profiles --------------------------------------------

  async calibrateBrowserProfiles(): Promise<BrowserCalibrationResult[]> {
    logger.info('Starting browser profile calibration...');

    const results: BrowserCalibrationResult[] = [];
    const latestVersions = this.getLatestVersions();

    for (const release of latestVersions) {
      if (release.status === 'deprecated') continue;

      // Generate calibrations for each platform
      const platforms = release.family === 'safari'
        ? ['mac', 'ios']
        : ['win', 'mac', 'linux', 'android'];

      for (const platform of platforms) {
        const key = `${release.family}-${release.version}-${platform}`;
        const calibration = this.generateBrowserCalibration(release, platform);

        this.browserCalibrations.set(key, calibration);
        results.push(calibration);

        this.addChangelog('browser_calibrated', {
          browser: release.family,
          version: release.version,
          platform,
          freshnessScore: calibration.freshnessScore,
          issues: calibration.issues,
        }, [key]);
      }
    }

    await this.persistBrowserCalibrations();

    logger.info({ count: results.length }, 'Browser profile calibration completed');
    return results;
  }

  // --- Check For Browser Updates ----------------------------------------------

  async checkForBrowserUpdates(): Promise<{
    newReleases: BrowserRelease[];
    updatedReleases: BrowserRelease[];
    deprecatedReleases: BrowserRelease[];
  }> {
    logger.info('Checking for browser updates...');

    // In production this would call the chromium dash API or similar
    // Simulated: check if our known releases need status updates
    const now = new Date();
    const newReleases: BrowserRelease[] = [];
    const updatedReleases: BrowserRelease[] = [];
    const deprecatedReleases: BrowserRelease[] = [];

    for (const release of this.knownReleases) {
      const releaseDate = new Date(release.releaseDate);
      const ageWeeks = (now.getTime() - releaseDate.getTime()) / (7 * 24 * 60 * 60 * 1000);
      const schedule = BROWSER_RELEASE_SCHEDULE[release.family];

      // Promote beta → stable after cadence
      if (release.status === 'beta' && ageWeeks >= schedule.cadenceWeeks) {
        release.status = 'stable';
        updatedReleases.push(release);
        this.addChangelog('release_promoted', {
          browser: release.family,
          version: release.version,
          newStatus: 'stable',
        }, [`${release.family}-${release.version}`]);
      }

      // Deprecate stable after 3 cadence cycles
      if (release.status === 'stable' && ageWeeks >= schedule.cadenceWeeks * 3) {
        release.status = 'deprecated';
        deprecatedReleases.push(release);
        this.addChangelog('release_deprecated', {
          browser: release.family,
          version: release.version,
        }, [`${release.family}-${release.version}`]);
      }
    }

    // Simulate discovering a new release
    const latestChrome = this.knownReleases
      .filter(r => r.family === 'chrome')
      .reduce((max, r) => r.majorVersion > max ? r.majorVersion : max, 0);

    const nextChromeVersion = latestChrome + 1;
    const existing = this.knownReleases.find(r => r.majorVersion === nextChromeVersion);
    if (!existing) {
      const newRelease: BrowserRelease = {
        family: 'chrome',
        version: String(nextChromeVersion),
        majorVersion: nextChromeVersion,
        releaseDate: new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        isLts: false,
        status: 'dev',
        keyFingerprintChanges: ['Pending analysis on release'],
      };
      this.knownReleases.push(newRelease);
      newReleases.push(newRelease);
      this.addChangelog('new_release_discovered', {
        browser: 'chrome',
        version: String(nextChromeVersion),
        status: 'dev',
      }, [`chrome-${nextChromeVersion}`]);
    }

    logger.info({
      new: newReleases.length,
      updated: updatedReleases.length,
      deprecated: deprecatedReleases.length,
    }, 'Browser update check completed');

    return { newReleases, updatedReleases, deprecatedReleases };
  }

  // --- Generate Fresh Profile -------------------------------------------------

  generateFreshProfile(
    browser: BrowserFamily,
    platform: string,
  ): {
    userAgent: string;
    platformString: string;
    tlsJa3: string;
    tlsJa4: string;
    cipherSuites: string[];
    extensions: string[];
    alpnProtocols: string[];
    h2Settings: Record<string, number>;
    canvasExpectedHash: string;
    webglVendor: string;
    webglRenderer: string;
    fontList: string[];
    colorDepth: number;
    deviceMemory: number;
    hardwareConcurrency: number;
    freshnessScore: number;
  } {
    const latestRelease = this.getLatestStableRelease(browser);
    const version = latestRelease?.version ?? '130';

    // Build user agent
    const userAgent = this.buildUserAgent(browser, version, platform);
    const platformString = this.buildPlatformString(platform);

    // TLS profile for this browser version
    const tlsCal = this.tlsCalibrations.get(`${browser}-${version}`);
    const tlsJa3 = tlsCal?.ja3Hash ?? this.simulateJa3Hash(browser, version);
    const tlsJa4 = tlsCal?.ja4Hash ?? this.simulateJa4Hash(browser, version);
    const cipherSuites = tlsCal?.cipherSuites ?? ['TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256'];
    const extensions = tlsCal?.extensions ?? ['0', '10', '11', '13', '16', '23', '27', '35', '43', '45', '51', '65281'];
    const alpnProtocols = tlsCal?.alpnProtocols ?? ['h2', 'http/1.1'];
    const h2Settings = tlsCal?.h2Settings ?? { HEADER_TABLE_SIZE: 65536, MAX_CONCURRENT_STREAMS: 1000, INITIAL_WINDOW_SIZE: 6291456, MAX_HEADER_LIST_SIZE: 262144 };

    // WebGL
    const { vendor, renderer } = this.getWebGLForPlatform(platform, browser);

    // Fonts
    const fontList = this.getFontsForPlatform(platform);

    // Hardware
    const isMobile = platform === 'android' || platform === 'ios';
    const deviceMemory = isMobile ? [2, 4, 8][Math.floor(Math.random() * 3)] : [8, 16, 32][Math.floor(Math.random() * 3)];
    const hardwareConcurrency = isMobile ? [4, 6, 8][Math.floor(Math.random() * 3)] : [8, 12, 16][Math.floor(Math.random() * 3)];

    // Canvas hash
    const canvasExpectedHash = [...KNOWN_CANVAS_HASHES][Math.floor(Math.random() * KNOWN_CANVAS_HASHES.size)];

    // Compute freshness score
    const freshnessScore = this.computeFreshnessScore(browser, parseInt(version, 10), canvasExpectedHash, vendor, renderer, fontList);

    return {
      userAgent,
      platformString,
      tlsJa3,
      tlsJa4,
      cipherSuites,
      extensions,
      alpnProtocols,
      h2Settings,
      canvasExpectedHash,
      webglVendor: vendor,
      webglRenderer: renderer,
      fontList,
      colorDepth: 24,
      deviceMemory,
      hardwareConcurrency,
      freshnessScore,
    };
  }

  // --- Validate Profile Freshness ---------------------------------------------

  validateProfileFreshness(profile: {
    browser: BrowserFamily;
    version: string;
    canvasHash?: string;
    webglVendor?: string;
    webglRenderer?: string;
    fontList?: string[];
    userAgent?: string;
    tlsJa3Hash?: string;
    profileName: string;
  }): FreshnessValidation {
    const rules = FINGERPRINT_FRESHNESS_RULES;
    const majorVersion = parseInt(profile.version, 10);
    const latestStable = this.getLatestStableRelease(profile.browser);
    const latestMajor = latestStable?.majorVersion ?? majorVersion;
    const versionsBehind = latestMajor - majorVersion;

    // Version freshness (0–100)
    const maxBehind = profile.browser === 'safari'
      ? rules.SAFARI_MAX_VERSIONS_BEHIND
      : rules.CHROME_MAX_VERSIONS_BEHIND;
    const versionFreshness = Math.max(0, 100 - (versionsBehind / maxBehind) * 100);

    // Canvas freshness
    let canvasFreshness = 70; // default moderate
    if (profile.canvasHash) {
      canvasFreshness = KNOWN_CANVAS_HASHES.has(profile.canvasHash) ? 100 : 100 - rules.CANVAS_UNKNOWN_PENALTY;
    }

    // WebGL freshness
    let webglFreshness = 70;
    if (profile.webglVendor && profile.webglRenderer) {
      const webglKey = `${profile.webglVendor}|${profile.webglRenderer}`;
      webglFreshness = KNOWN_WEBGL_PAIRS.has(webglKey) ? 100 : 100 - rules.WEBGL_UNKNOWN_PENALTY;
    }

    // Font freshness
    let fontFreshness = 50;
    if (profile.fontList) {
      if (profile.fontList.length < rules.FONT_LIST_MIN_SIZE) {
        fontFreshness = 20;
      } else if (profile.fontList.length > rules.FONT_LIST_MAX_SIZE_DESKTOP) {
        fontFreshness = 40;
      } else {
        fontFreshness = 90;
      }
    }

    // UA consistency
    let uaConsistency = 80;
    if (profile.userAgent) {
      const uaVersionMatch = profile.userAgent.match(/(?:Chrome|Firefox|Version|Edg)\/(\d+)/);
      if (uaVersionMatch) {
        const uaMajor = parseInt(uaVersionMatch[1], 10);
        uaConsistency = uaMajor === majorVersion ? 100 : 100 - rules.UA_VERSION_MISMATCH_PENALTY;
      }
    }

    // TLS consistency
    let tlsConsistency = 75;
    if (profile.tlsJa3Hash) {
      const tlsCal = [...this.tlsCalibrations.values()].find(
        c => c.ja3Hash === profile.tlsJa3Hash && c.browser === profile.browser,
      );
      tlsConsistency = tlsCal ? 100 : 100 - rules.TLS_JA3_MISMATCH_PENALTY;
    }

    // Overall score: weighted average
    const overallScore = Math.round(
      versionFreshness * 0.25 +
      canvasFreshness * 0.15 +
      webglFreshness * 0.15 +
      fontFreshness * 0.10 +
      uaConsistency * 0.20 +
      tlsConsistency * 0.15,
    );

    // Determine verdict
    let verdict: FreshnessValidation['verdict'];
    if (overallScore >= rules.VERDICT_THRESHOLDS.fresh) verdict = 'fresh';
    else if (overallScore >= rules.VERDICT_THRESHOLDS.aging) verdict = 'aging';
    else if (overallScore >= rules.VERDICT_THRESHOLDS.stale) verdict = 'stale';
    else verdict = 'risky';

    // Build recommendations
    const recommendations: string[] = [];
    if (versionsBehind > maxBehind) {
      recommendations.push(`Update ${profile.browser} from v${profile.version} to v${latestMajor} -- ${versionsBehind} versions behind`);
    }
    if (canvasFreshness < 70) recommendations.push('Canvas hash not in known set -- may trigger fingerprint detection');
    if (webglFreshness < 70) recommendations.push('WebGL vendor/renderer combination unrecognized -- high detection risk');
    if (fontFreshness < 50) recommendations.push('Font list is suspicious (too short or too long)');
    if (uaConsistency < 70) recommendations.push('User-Agent version does not match claimed browser version');
    if (tlsConsistency < 70) recommendations.push('TLS JA3 hash does not match claimed browser -- will fail TLS fingerprinting');

    return {
      profileName: profile.profileName,
      overallScore,
      breakdown: {
        versionFreshness: Math.round(versionFreshness),
        canvasFreshness: Math.round(canvasFreshness),
        webglFreshness: Math.round(webglFreshness),
        fontFreshness: Math.round(fontFreshness),
        uaConsistency: Math.round(uaConsistency),
        tlsConsistency: Math.round(tlsConsistency),
      },
      verdict,
      recommendations,
    };
  }

  // --- Get Changelog ----------------------------------------------------------

  getChangelog(limit: number = 50): ChangelogEntry[] {
    return this.changelog.slice(-limit).reverse();
  }

  // --- Get Stats --------------------------------------------------------------

  async getStats(): Promise<{
    tlsCalibrationCount: number;
    browserCalibrationCount: number;
    knownReleases: number;
    latestVersions: Record<BrowserFamily, string>;
    changelogSize: number;
    initialized: boolean;
  }> {
    const latestVersions: Record<BrowserFamily, string> = {
      chrome: this.getLatestStableRelease('chrome')?.version ?? 'unknown',
      firefox: this.getLatestStableRelease('firefox')?.version ?? 'unknown',
      safari: this.getLatestStableRelease('safari')?.version ?? 'unknown',
      edge: this.getLatestStableRelease('edge')?.version ?? 'unknown',
    };

    return {
      tlsCalibrationCount: this.tlsCalibrations.size,
      browserCalibrationCount: this.browserCalibrations.size,
      knownReleases: this.knownReleases.length,
      latestVersions,
      changelogSize: this.changelog.length,
      initialized: this.initialized,
    };
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  private getLatestVersions(): BrowserRelease[] {
    const latest = new Map<BrowserFamily, BrowserRelease>();
    for (const release of this.knownReleases) {
      const existing = latest.get(release.family);
      if (!existing || release.majorVersion > existing.majorVersion) {
        latest.set(release.family, release);
      }
    }
    return [...latest.values()];
  }

  private getLatestStableRelease(family: BrowserFamily): BrowserRelease | null {
    const stable = this.knownReleases
      .filter(r => r.family === family && r.status === 'stable')
      .sort((a, b) => b.majorVersion - a.majorVersion);
    return stable[0] ?? null;
  }

  private generateTlsCalibration(release: BrowserRelease): TlsCalibrationResult {
    const latestStable = this.getLatestStableRelease(release.family);
    const isCurrent = release.status === 'stable' || release.status === 'beta';
    const versionsBehind = latestStable ? latestStable.majorVersion - release.majorVersion : 0;
    const stalenessScore = isCurrent ? 0 : Math.min(100, versionsBehind * 30);

    return {
      browser: release.family,
      version: release.version,
      ja3Hash: this.simulateJa3Hash(release.family, release.version),
      ja4Hash: this.simulateJa4Hash(release.family, release.version),
      cipherSuites: ['TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256'],
      extensions: release.family === 'safari'
        ? ['0', '10', '11', '13', '16', '23', '27', '35', '43', '51']
        : ['0', '10', '11', '13', '16', '23', '27', '35', '43', '45', '51', '65281'],
      alpnProtocols: ['h2', 'http/1.1'],
      h2Settings: release.family === 'safari'
        ? { HEADER_TABLE_SIZE: 4096, MAX_CONCURRENT_STREAMS: 100, INITIAL_WINDOW_SIZE: 1048576 }
        : { HEADER_TABLE_SIZE: 65536, MAX_CONCURRENT_STREAMS: 1000, INITIAL_WINDOW_SIZE: 6291456, MAX_HEADER_LIST_SIZE: 262144 },
      isCurrent,
      stalenessScore,
      calibratedAt: Date.now(),
    };
  }

  private generateBrowserCalibration(release: BrowserRelease, platform: string): BrowserCalibrationResult {
    const key = `${release.family}-${release.version}-${platform}`;
    const canvasHash = [...KNOWN_CANVAS_HASHES][Math.floor(Math.random() * KNOWN_CANVAS_HASHES.size)];
    const { vendor, renderer } = this.getWebGLForPlatform(platform, release.family);
    const fontList = this.getFontsForPlatform(platform);
    const userAgent = this.buildUserAgent(release.family, release.version, platform);
    const audioFp = `audio_${release.family}_${release.version}_${platform}_hash`;

    const freshnessScore = this.computeFreshnessScore(release.family, release.majorVersion, canvasHash, vendor, renderer, fontList);

    const issues: string[] = [];
    if (freshnessScore < 65) issues.push('Profile freshness below recommended threshold');
    if (!KNOWN_CANVAS_HASHES.has(canvasHash)) issues.push('Canvas hash not in known set');
    if (release.status === 'deprecated') issues.push(`Browser version ${release.version} is deprecated`);

    return {
      profileName: key,
      browser: release.family,
      version: release.version,
      canvasHash,
      webglVendor: vendor,
      webglRenderer: renderer,
      fontList,
      audioFingerprint: audioFp,
      userAgent,
      freshnessScore,
      issues,
      calibratedAt: Date.now(),
    };
  }

  private computeFreshnessScore(
    browser: BrowserFamily,
    majorVersion: number,
    canvasHash: string,
    webglVendor: string,
    webglRenderer: string,
    fontList: string[],
  ): number {
    const latestStable = this.getLatestStableRelease(browser);
    const latestMajor = latestStable?.majorVersion ?? majorVersion;
    const versionsBehind = latestMajor - majorVersion;
    const maxBehind = browser === 'safari'
      ? FINGERPRINT_FRESHNESS_RULES.SAFARI_MAX_VERSIONS_BEHIND
      : FINGERPRINT_FRESHNESS_RULES.CHROME_MAX_VERSIONS_BEHIND;

    let score = 100;

    // Version penalty
    score -= Math.min(40, (versionsBehind / maxBehind) * 40);

    // Canvas penalty
    if (!KNOWN_CANVAS_HASHES.has(canvasHash)) {
      score -= FINGERPRINT_FRESHNESS_RULES.CANVAS_UNKNOWN_PENALTY * 0.5;
    }

    // WebGL penalty
    const webglKey = `${webglVendor}|${webglRenderer}`;
    if (!KNOWN_WEBGL_PAIRS.has(webglKey)) {
      score -= FINGERPRINT_FRESHNESS_RULES.WEBGL_UNKNOWN_PENALTY * 0.5;
    }

    // Font penalty
    if (fontList.length < FINGERPRINT_FRESHNESS_RULES.FONT_LIST_MIN_SIZE) {
      score -= 15;
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  private simulateJa3Hash(browser: BrowserFamily, version: string): string {
    // Simulated JA3 hash -- in production, capture from real browser
    const seed = `${browser}-${version}`;
    let hash = '';
    for (let i = 0; i < 32; i++) {
      hash += ((seed.charCodeAt(i % seed.length) + i) % 16).toString(16);
    }
    return hash;
  }

  private simulateJa4Hash(browser: BrowserFamily, version: string): string {
    const seed = `ja4-${browser}-${version}`;
    let hash = '';
    for (let i = 0; i < 36; i++) {
      hash += ((seed.charCodeAt(i % seed.length) + i * 3) % 16).toString(16);
    }
    return hash;
  }

  private buildUserAgent(browser: BrowserFamily, version: string, platform: string): string {
    if (browser === 'chrome') {
      if (platform === 'win') return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;
      if (platform === 'mac') return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;
      if (platform === 'linux') return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;
      if (platform === 'android') return `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Mobile Safari/537.36`;
    }
    if (browser === 'firefox') {
      if (platform === 'ios') return `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/${version} Mobile/15E148 Safari/605.1.15`;
      return `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`;
    }
    if (browser === 'safari') {
      if (platform === 'ios') return `Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version}.0 Mobile/15E148 Safari/604.1`;
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version}.0 Safari/605.1.15`;
    }
    if (browser === 'edge') {
      return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36 Edg/${version}.0.0.0`;
    }
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/${version}.0.0.0 Safari/537.36`;
  }

  private buildPlatformString(platform: string): string {
    switch (platform) {
      case 'win': return 'Win32';
      case 'mac': return 'MacIntel';
      case 'linux': return 'Linux x86_64';
      case 'android': return 'Linux armv8l';
      case 'ios': return 'iPhone';
      default: return 'Win32';
    }
  }

  private getWebGLForPlatform(platform: string, browser: BrowserFamily): { vendor: string; renderer: string } {
    if (browser === 'safari') return { vendor: 'Apple Inc.', renderer: 'Apple GPU' };
    if (browser === 'firefox') return { vendor: 'Mozilla', renderer: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)' };

    switch (platform) {
      case 'win':
        return { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, OpenGL 4.5)' };
      case 'mac':
        return { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)' };
      case 'linux':
        return { vendor: 'Mesa', renderer: 'Mesa Intel(R) UHD Graphics 630 (CFL GT2)' };
      case 'android':
        return { vendor: 'Google Inc. (Qualcomm)', renderer: 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)' };
      case 'ios':
        return { vendor: 'Apple Inc.', renderer: 'Apple GPU' };
      default:
        return { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)' };
    }
  }

  private getFontsForPlatform(platform: string): string[] {
    switch (platform) {
      case 'win':
        return ['Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana', 'Segoe UI', 'Calibri', 'Trebuchet MS'];
      case 'mac':
        return ['Helvetica', 'Courier', 'Georgia', 'Times', 'Verdana', 'Helvetica Neue', 'SF Pro', 'Avenir'];
      case 'linux':
        return ['DejaVu Sans', 'Liberation Sans', 'Ubuntu', 'Noto Sans', 'Roboto', 'DejaVu Sans Mono'];
      case 'android':
        return ['Roboto', 'Noto Sans', 'Droid Sans', 'sans-serif', 'Arial'];
      case 'ios':
        return ['SF Pro', 'Helvetica Neue', 'Helvetica', 'Arial', 'Georgia'];
      default:
        return ['Arial', 'Courier New', 'Georgia', 'Verdana'];
    }
  }

  private addChangelog(action: string, details: Record<string, unknown>, affectedProfiles: string[]): void {
    this.changelog.push({
      timestamp: Date.now(),
      action,
      details,
      affectedProfiles,
    });
    if (this.changelog.length > this.MAX_CHANGELOG) {
      this.changelog = this.changelog.slice(-this.MAX_CHANGELOG);
    }
  }

  private async persistTlsCalibrations(): Promise<void> {
    try {
      const obj: Record<string, TlsCalibrationResult> = {};
      for (const [key, val] of this.tlsCalibrations) {
        obj[key] = val;
      }
      await cacheSet('calibrator:tls', obj, 3600);
    } catch (err) {
      logger.debug({ err }, 'Failed to persist TLS calibrations');
    }
  }

  private async persistBrowserCalibrations(): Promise<void> {
    try {
      const obj: Record<string, BrowserCalibrationResult> = {};
      for (const [key, val] of this.browserCalibrations) {
        obj[key] = val;
      }
      await cacheSet('calibrator:browser', obj, 3600);
    } catch (err) {
      logger.debug({ err }, 'Failed to persist browser calibrations');
    }
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const fingerprintCalibrator = new FingerprintCalibratorEngine();
