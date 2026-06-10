/**
 * YouTube API Signer — ScrapeSuite Engine
 *
 * Signs YouTube InnerTube API requests with the required authentication
 * and context parameters. YouTube's InnerTube API is the internal API
 * used by all YouTube clients (WEB, ANDROID, IOS, etc.) and requires:
 *
 *   - SAPISIDHASH: A hash generated from the SAPISID cookie, origin,
 *     and timestamp, sent as an Authorization header
 *   - InnerTube context: A JSON object containing client info, user info,
 *     and request metadata that must be included in every request body
 *   - Session IDs: visitorData, session ID, and playback nonce (cpn)
 *     that must be consistent across a browsing session
 *   - API key: Required query parameter for all InnerTube endpoints
 *   - Client name/version headers: X-YouTube-Client-Name/Version
 *
 * InnerTube API format:
 *   POST https://www.youtube.com/youtubei/v1/{endpoint}?key={apiKey}
 *   Headers: Authorization: SAPISIDHASH {hash}
 *   Body: { context: { ... }, ...endpoint-specific params }
 *
 * Client name/version format:
 *   WEB:         clientName=1,  version="2.YYMM.DD.00"
 *   ANDROID:     clientName=3,  version="19.YY.MM.DD"
 *   IOS:         clientName=5,  version="19.YY.MM.DD"
 *   MWEB:        clientName=2,  version="2.YYMM.DD.00"
 *   TVHTML5:     clientName=7,  version="7.YYMM.DD.00"
 */

import { createChildLogger } from '../../utils/logger';
import { cacheGet, cacheSet } from '../../utils/redis';
import type {
  YouTubeApiSignerConfig,
  InnertubeSignParams,
  InnertubeSignResult,
  YouTubeSessionIds,
  YouTubeClientPlatform,
} from './types';

const logger = createChildLogger('youtube-api-signer');

// ===============================================================================
// CONSTANTS
// ===============================================================================

/** Default API signer configuration */
const DEFAULT_SIGNER_CONFIG: YouTubeApiSignerConfig = {
  defaultClientName: 'WEB',
  defaultClientVersion: '2.20260603.00.00',
  defaultClientScreen: 'WATCH_FULL_SCREEN',
  apiKey: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
  origin: 'https://www.youtube.com',
  generateSapisidhash: true,
  includeVisitorData: true,
  includeSessionIds: true,
};

/** InnerTube client name mapping (name → numeric ID) */
const CLIENT_NAME_IDS: Record<string, number> = {
  WEB: 1,
  MWEB: 2,
  ANDROID: 3,
  IOS: 5,
  TVHTML5: 7,
};

/** InnerTube client version patterns by platform */
const CLIENT_VERSIONS: Record<YouTubeClientPlatform, string> = {
  web: '2.20260603.00.00',
  mweb: '2.20260603.00.00',
  android: '19.29.37',
  ios: '19.29.1',
  tv: '7.20260603.00.00',
};

/** Known InnerTube API endpoints */
const KNOWN_ENDPOINTS = [
  'browse',
  'player',
  'search',
  'next',
  'get_transcript',
  'comment_service',
  'like',
  'subscribe',
  'notification',
  'guide',
  'updated_metadata',
  'music/get_search_suggestions',
  'feed',
  'account/account_menu',
];

/** Character set for generating session IDs */
const SESSION_ID_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base URL for InnerTube API */
const INNERTUBE_BASE_URL = 'https://www.youtube.com/youtubei/v1';

/** Cache key prefix for signed contexts */
const CACHE_KEY_PREFIX = 'youtube:api-signer';

// ===============================================================================
// HELPER FUNCTIONS
// ===============================================================================

/**
 * Generate a random string of the given length.
 */
function randomString(length: number, charset: string = SESSION_ID_CHARSET): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += charset[Math.floor(Math.random() * charset.length)];
  }
  return result;
}

/**
 * Generate a random hexadecimal string.
 */
function randomHex(length: number): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * Get the current date in YYMMDD format for version strings.
 */
function getCurrentVersionDate(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/**
 * Generate a date-based client version string.
 */
function generateClientVersion(platform: YouTubeClientPlatform): string {
  const dateStr = getCurrentVersionDate();

  switch (platform) {
    case 'web':
    case 'mweb':
      return `2.${dateStr}.00.00`;
    case 'android':
      return `19.${dateStr.slice(0, 2)}.${dateStr.slice(2, 4)}.${dateStr.slice(4)}`;
    case 'ios':
      return `19.${dateStr.slice(0, 2)}.${dateStr.slice(2, 4)}.1`;
    case 'tv':
      return `7.${dateStr}.00.00`;
    default:
      return `2.${dateStr}.00.00`;
  }
}

// ===============================================================================
// YOUTUBE API SIGNER CLASS
// ===============================================================================

export class YouTubeApiSigner {
  private config: YouTubeApiSignerConfig;
  private stats = {
    totalSigned: 0,
    totalSapisidhashGenerated: 0,
    totalContextsGenerated: 0,
    totalSessionIdsGenerated: 0,
    avgSigningTimeMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
  private contextCache = new Map<string, { context: Record<string, unknown>; expiresAt: number }>();

  constructor(config?: Partial<YouTubeApiSignerConfig>) {
    this.config = { ...DEFAULT_SIGNER_CONFIG, ...config };
    logger.info('YouTube API signer initialized');
  }

  // ---------------------------------------------------------------------------
  // INNERTUBE REQUEST SIGNING
  // ---------------------------------------------------------------------------

  /**
   * Sign a YouTube InnerTube API request with all required parameters.
   *
   * Generates the complete set of headers, cookies, URL parameters, and
   * request body context needed for a valid InnerTube API call.
   *
   * @param params - Parameters for the request to sign
   * @returns Signed request details including headers, cookies, and context
   */
  async signInnertubeRequest(params: InnertubeSignParams): Promise<InnertubeSignResult> {
    const startTime = performance.now();

    const clientName = params.clientName || this.config.defaultClientName;
    const clientVersion = params.clientVersion || this.config.defaultClientVersion;
    const platform = this.getClientPlatform(clientName);

    // Generate session IDs
    const sessionIds = this.generateSessionIds();
    if (params.visitorData) {
      sessionIds.visitorData = params.visitorData;
    }

    // Build InnerTube context
    const context = this.buildInnertubeContext(
      clientName,
      clientVersion,
      sessionIds,
      params.sessionIndex,
    );

    // Generate SAPISIDHASH if SAPISID is available
    let sapisidhash: string | undefined;
    const sapisid = params.sapisid || this.config.sapisid;
    if (this.config.generateSapisidhash && sapisid) {
      sapisidhash = this.generateSAPISIDHASH(
        sapisid,
        this.config.origin,
        Math.floor(Date.now() / 1000),
      );
    }

    // Build signed URL
    const signedUrl = this.buildSignedUrl(params.endpoint);

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Youtube-Client-Name': String(CLIENT_NAME_IDS[clientName] || 1),
      'X-Youtube-Client-Version': clientVersion,
      'Origin': this.config.origin,
      'Referer': `${this.config.origin}/`,
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': this.generateUserAgent(platform),
    };

    if (sapisidhash) {
      headers['Authorization'] = `SAPISIDHASH ${sapisidhash}`;
      headers['X-Origin'] = this.config.origin;
    }

    // Build cookies
    const cookies: Record<string, string> = {};
    if (sapisid) {
      cookies['SAPISID'] = sapisid;
    }
    if (sessionIds.visitorData) {
      cookies['VISITOR_INFO1_LIVE'] = sessionIds.visitorKey;
    }

    // Cache the context
    if (this.config.includeVisitorData) {
      const cacheKey = `ctx:${clientName}:${clientVersion}:${sessionIds.visitorData}`;
      this.contextCache.set(cacheKey, {
        context,
        expiresAt: Date.now() + 600000, // 10 minutes
      });

      // Prune old entries
      if (this.contextCache.size > 500) {
        const now = Date.now();
        const entries = Array.from(this.contextCache.entries());
        for (const [key, value] of entries) {
          if (value.expiresAt <= now) {
            this.contextCache.delete(key);
          }
        }
      }
    }

    const signingTime = performance.now() - startTime;

    // Update stats
    this.stats.totalSigned++;
    this.stats.avgSigningTimeMs =
      (this.stats.avgSigningTimeMs * (this.stats.totalSigned - 1) + signingTime) /
      this.stats.totalSigned;

    logger.debug({
      endpoint: params.endpoint,
      clientName,
      clientVersion,
      hasSapisidhash: !!sapisidhash,
      signingTimeMs: signingTime.toFixed(2),
    }, 'InnerTube request signed');

    return {
      signedUrl,
      headers,
      cookies,
      context,
      sapisidhash,
      sessionIds,
      signingTimeMs: signingTime,
    };
  }

  // ---------------------------------------------------------------------------
  // SAPISIDHASH GENERATION
  // ---------------------------------------------------------------------------

  /**
   * Generate SAPISIDHASH for YouTube API authentication.
   *
   * SAPISIDHASH is the primary authentication mechanism for YouTube's
   * InnerTube API. It is computed as:
   *
   *   SHA1(timestamp + " " + SAPISID + " " + origin)
   *
   * Where:
   *   - timestamp: Current Unix time in seconds
   *   - SAPISID: The SAPISID cookie value
   *   - origin: The Origin header value (e.g. "https://www.youtube.com")
   *
   * The result is formatted as: "{timestamp}_{sha1hash}"
   *
   * @param sapisid - The SAPISID cookie value
   * @param origin - The Origin header value
   * @param timestamp - Current Unix timestamp in seconds
   * @returns SAPISIDHASH string
   */
  generateSAPISIDHASH(sapisid: string, origin: string, timestamp: number): string {
    const input = `${timestamp} ${sapisid} ${origin}`;

    // SHA-1 hash using Node.js crypto
    const crypto = require('crypto');
    const hash = crypto.createHash('sha1').update(input).digest('hex');

    const sapisidhash = `${timestamp}_${hash}`;

    this.stats.totalSapisidhashGenerated++;

    logger.debug({
      sapisidPrefix: sapisid.substring(0, 8) + '...',
      timestamp,
      hashPrefix: hash.substring(0, 8) + '...',
    }, 'SAPISIDHASH generated');

    return sapisidhash;
  }

  // ---------------------------------------------------------------------------
  // INNERTUBE CONTEXT BUILDING
  // ---------------------------------------------------------------------------

  /**
   * Build a YouTube InnerTube context object.
   *
   * The context is a JSON structure included in every InnerTube API request
   * body. It contains client information, user settings, and request metadata
   * that YouTube uses for authentication, personalization, and rate limiting.
   *
   * Example context structure:
   * {
   *   "client": {
   *     "clientName": "WEB",
   *     "clientVersion": "2.20260603.00.00",
   *     "hl": "en",
   *     "gl": "US",
   *     ...
   *   },
   *   "user": { "lockedSafetyMode": false },
   *   "request": { ... }
   * }
   *
   * @param clientName - InnerTube client name (e.g. "WEB", "ANDROID")
   * @param clientVersion - InnerTube client version string
   * @param sessionIds - Session identifiers
   * @param sessionIndex - Optional session index (for multi-session)
   * @returns InnerTube context object
   */
  buildInnertubeContext(
    clientName: string,
    clientVersion: string,
    sessionIds?: YouTubeSessionIds,
    sessionIndex?: number,
  ): Record<string, unknown> {
    const platform = this.getClientPlatform(clientName);
    const clientNameId = CLIENT_NAME_IDS[clientName] || 1;

    // Base context structure
    const context: Record<string, unknown> = {
      client: {
        clientName,
        clientVersion,
        clientNameId,
        gl: 'US',
        hl: 'en',
        deviceMake: '',
        deviceModel: '',
        osName: this.getOSName(platform),
        osVersion: this.getOSVersion(platform),
        originalUrl: this.config.origin + '/',
        platform: platform === 'web' ? 'DESKTOP' : 'MOBILE',
        clientFormFactor: platform === 'web' ? 'UNKNOWN_FORM_FACTOR' : 'SMALL_FORM_FACTOR',
        userInterfaceTheme: 'USER_INTERFACE_THEME_LIGHT',
        browserName: platform === 'web' ? 'Chrome' : '',
        browserVersion: platform === 'web' ? '131.0.0.0' : '',
        timeZone: 'America/New_York',
        utcOffsetMinutes: -300,
        screenDensityFloat: 1,
        screenPixelDensity: 1,
        connectionType: 'CONN_WIFI',
        mainAppWebDomain: 'www.youtube.com',
        playerType: 'UNIPLAYER',
        tvAppInfo: {
          tvAppInstallFrom: '',
          tvAppLaunchFrom: '',
        },
      },
      user: {
        lockedSafetyMode: false,
      },
      request: {
        useSsl: true,
        internalExperimentFlags: [],
        consistencyTokenJars: [],
      },
    };

    // Add visitor data if available
    if (sessionIds && this.config.includeVisitorData) {
      (context.client as Record<string, unknown>).visitorData = sessionIds.visitorData;
    }

    // Add session index if provided
    if (sessionIndex !== undefined) {
      (context.user as Record<string, unknown>).onBehalfOfUser = sessionIndex;
    }

    // Add click tracking parameters
    if (sessionIds?.clickTrackingParams) {
      (context.request as Record<string, unknown>).clickTracking = {
        clickTrackingParams: sessionIds.clickTrackingParams,
      };
    }

    // Add active playlist info for watch contexts
    if (sessionIds?.cpn) {
      (context.client as Record<string, unknown>).playbackNonce = sessionIds.cpn;
    }

    // Platform-specific context additions
    if (platform === 'android') {
      (context.client as Record<string, unknown>).androidSdkVersion = 34;
      (context.client as Record<string, unknown>).deviceMake = 'Google';
      (context.client as Record<string, unknown>).deviceModel = 'Pixel 8';
    } else if (platform === 'ios') {
      (context.client as Record<string, unknown>).deviceMake = 'Apple';
      (context.client as Record<string, unknown>).deviceModel = 'iPhone15,2';
    }

    this.stats.totalContextsGenerated++;

    return context;
  }

  // ---------------------------------------------------------------------------
  // SESSION ID GENERATION
  // ---------------------------------------------------------------------------

  /**
   * Generate valid YouTube session IDs.
   *
   * YouTube uses several session-level identifiers that must be consistent
   * across requests in the same browsing session:
   *
   * - visitorData: A base64-encoded protobuf string containing a visitor ID
   *   and timestamp, used to correlate requests from the same visitor
   * - visitorKey: An 11-character alphanumeric string used as the
   *   _visitor_key URL parameter and VISITOR_INFO1_LIVE cookie
   * - sessionId: A "U" prefixed session identifier (format: "UgSx...")
   * - cpn: Canonical Playback Nonce — a 16-character unique ID per video watch
   * - delegatedSessionId: Optional session ID for delegated auth
   *
   * @returns Generated session identifiers
   */
  generateSessionIds(): YouTubeSessionIds {
    // visitorKey: 11-character alphanumeric (used for VISITOR_INFO1_LIVE cookie)
    const visitorKey = randomString(11);

    // visitorData: Base64-encoded protobuf-like string
    // Real visitorData starts with "Cgs" (base64 for protobuf field 1, type 2 + small length)
    const visitorId = randomString(11);
    const timestamp = Math.floor(Date.now() / 1000);

    // Build protobuf for visitorData
    const idBytes = Buffer.from(visitorId, 'utf-8');
    const protoParts: number[] = [];

    // Field 1 (length-delimited): visitor ID
    protoParts.push(0x0A);
    protoParts.push(idBytes.length);
    for (let i = 0; i < idBytes.length; i++) {
      protoParts.push(idBytes[i]!);
    }

    // Field 2 (varint): timestamp
    protoParts.push(0x10);
    let ts = timestamp;
    while (ts > 0x7F) {
      protoParts.push((ts & 0x7F) | 0x80);
      ts >>>= 7;
    }
    protoParts.push(ts & 0x7F);

    const visitorData = Buffer.from(protoParts).toString('base64');

    // sessionId: Starts with "UgSx" followed by base64-like characters
    // Typically 40-80 characters long
    const sessionId = `UgSx${randomString(56)}`;

    // cpn (canonical playback nonce): 16 characters
    const cpn = randomString(16);

    // delegatedSessionId: Similar format to sessionId but optional
    const delegatedSessionId = Math.random() < 0.3 ? `UgSx${randomString(40)}` : undefined;

    // clickTrackingParams: Base64-encoded click tracking data
    const clickTrackingParams = this.generateClickTrackingParams();

    this.stats.totalSessionIdsGenerated++;

    const sessionIds: YouTubeSessionIds = {
      visitorData,
      visitorKey,
      sessionId,
      cpn,
      delegatedSessionId,
      clickTrackingParams,
    };

    logger.debug({
      visitorKey: visitorKey.substring(0, 6) + '...',
      sessionId: sessionId.substring(0, 10) + '...',
      cpn,
    }, 'Session IDs generated');

    return sessionIds;
  }

  // ---------------------------------------------------------------------------
  // PRIVATE HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Build the signed URL for an InnerTube API endpoint.
   */
  private buildSignedUrl(endpoint: string): string {
    // Validate endpoint
    const cleanEndpoint = endpoint.replace(/^\/+|\/+$/g, '');
    return `${INNERTUBE_BASE_URL}/${cleanEndpoint}?key=${this.config.apiKey}`;
  }

  /**
   * Get the client platform from a client name string.
   */
  private getClientPlatform(clientName: string): YouTubeClientPlatform {
    const name = clientName.toUpperCase();
    if (name === 'WEB') return 'web';
    if (name === 'MWEB') return 'mweb';
    if (name === 'ANDROID') return 'android';
    if (name === 'IOS') return 'ios';
    if (name.startsWith('TV')) return 'tv';
    return 'web';
  }

  /**
   * Get the OS name for a given platform.
   */
  private getOSName(platform: YouTubeClientPlatform): string {
    switch (platform) {
      case 'web':
      case 'mweb':
        return 'Windows';
      case 'android':
        return 'Android';
      case 'ios':
        return 'iPhone';
      case 'tv':
        return 'TV';
      default:
        return 'Windows';
    }
  }

  /**
   * Get the OS version for a given platform.
   */
  private getOSVersion(platform: YouTubeClientPlatform): string {
    switch (platform) {
      case 'web':
      case 'mweb':
        return '10.0';
      case 'android':
        return '14';
      case 'ios':
        return '17.5.1';
      case 'tv':
        return '0';
      default:
        return '10.0';
    }
  }

  /**
   * Generate a User-Agent string for the given platform.
   */
  private generateUserAgent(platform: YouTubeClientPlatform): string {
    const chromeVersion = '131.0.6778.70';

    switch (platform) {
      case 'web':
        return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
      case 'mweb':
        return `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Mobile Safari/537.36`;
      case 'android':
        return `com.google.android.youtube/19.29.37 (Linux; U; Android 14; US; Pixel 8; Build/AP2A.240905.003; Cronet/TT2.0-rc1)`;
      case 'ios':
        return `com.google.ios.youtube/19.29.1 (iPhone; U; CPU iOS 17_5_1 like Mac OS X; US)`;
      case 'tv':
        return `Mozilla/5.0 (Linux; Android 12; Build/STTL.230808.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
      default:
        return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    }
  }

  /**
   * Generate click tracking parameters.
   *
   * YouTube uses click tracking params (CAUQ) to track user interactions.
   * These are base64-encoded protobuf messages.
   */
  private generateClickTrackingParams(): string {
    // Generate a realistic-looking base64-encoded tracking param
    // Typically 40-80 characters of base64
    const rawBytes: number[] = [];

    // Field 1: Some identifier bytes
    protoField(1, 2, rawBytes); // length-delimited
    const idBytes = Buffer.from(randomString(12), 'utf-8');
    rawBytes.push(idBytes.length);
    for (let i = 0; i < idBytes.length; i++) rawBytes.push(idBytes[i]!);

    // Field 2: Timestamp
    protoField(2, 0, rawBytes); // varint
    let ts = Math.floor(Date.now() / 1000);
    while (ts > 0x7F) {
      rawBytes.push((ts & 0x7F) | 0x80);
      ts >>>= 7;
    }
    rawBytes.push(ts & 0x7F);

    return Buffer.from(rawBytes).toString('base64');
  }

  /**
   * Get signer statistics.
   */
  getStats(): Record<string, unknown> {
    return {
      ...this.stats,
      contextCacheSize: this.contextCache.size,
    };
  }
}

/**
 * Helper: add a protobuf field tag to the byte array.
 */
function protoField(fieldNumber: number, wireType: number, bytes: number[]): void {
  const tag = (fieldNumber << 3) | wireType;
  bytes.push(tag);
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const youtubeApiSigner = new YouTubeApiSigner();
