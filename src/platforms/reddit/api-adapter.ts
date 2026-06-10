/**
 * Reddit API Adapter -- ScrapeSuite Engine
 *
 * Handles all Reddit API interaction including:
 *   - OAuth2 authentication (client credentials & authorization code flows)
 *   - Token refresh and lifecycle management
 *   - Request building with proper headers and authentication
 *   - URL parsing for old.reddit.com vs new.reddit.com
 *   - JSON API (.json suffix) vs HTML rendering selection
 *   - Request ID generation for Reddit's tracing systems
 *
 * Reddit API specifics:
 *   - OAuth base URL: https://www.reddit.com/api/v1/access_token
 *   - API base URL: https://oauth.reddit.com/
 *   - User-Agent format: <platform>:<app_id>:<version> (by /u/<username>)
 *   - Rate limits: 60/min OAuth, 10/min unauthenticated
 *   - Tokens expire after 1 hour, refresh tokens are long-lived
 *   - JSON API: append .json to any Reddit URL
 *   - old.reddit.com: separate domain with different HTML structure
 */

import { createChildLogger } from '../../utils/logger';
import { cacheGet, cacheSet } from '../../utils/redis';
import type { RedditApiConfig, RedditAuthResult, RedditListingParseResult } from './types';
import { DEFAULT_REDDIT_CONFIG } from './types';

const logger = createChildLogger('reddit-api-adapter');

// ===============================================================================
// CONSTANTS
// ===============================================================================

/** Reddit OAuth2 token endpoint */
const OAUTH_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';

/** Reddit OAuth2 authorization endpoint */
const OAUTH_AUTHORIZE_URL = 'https://www.reddit.com/api/v1/authorize';

/** Reddit API base URL (for OAuth requests) */
const OAUTH_API_BASE = 'https://oauth.reddit.com/';

/** Reddit public API base URL (for unauthenticated .json requests) */
const PUBLIC_API_BASE = 'https://www.reddit.com/';

/** Old Reddit base URL */
const OLD_REDDIT_BASE = 'https://old.reddit.com/';

/** Token cache key prefix */
const TOKEN_CACHE_PREFIX = 'reddit:auth:token:';

/** Token cache TTL (slightly less than actual expiry for safety) */
const TOKEN_CACHE_TTL = 3300; // 55 minutes

/** Request ID cache prefix */
const REQUEST_ID_CACHE_PREFIX = 'reddit:request_id:';

// ===============================================================================
// REDDIT API ADAPTER
// ===============================================================================

export class RedditApiAdapter {
  private config: RedditApiConfig;
  private currentToken: RedditAuthResult | null = null;
  private initialized = false;
  private stats = {
    totalRequests: 0,
    totalAuthentications: 0,
    totalTokenRefreshes: 0,
    totalParseOperations: 0,
    authSuccesses: 0,
    authFailures: 0,
    avgRequestBuildTimeMs: 0,
  };

  constructor(config?: Partial<RedditApiConfig>) {
    this.config = { ...DEFAULT_REDDIT_CONFIG.api, ...config };
  }

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  /**
   * Initialize the Reddit API adapter.
   * Attempts to load a cached OAuth token from Redis.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing Reddit API adapter...');

    try {
      // Try to load cached token
      const cachedToken = await cacheGet<RedditAuthResult>(`${TOKEN_CACHE_PREFIX}current`);
      if (cachedToken && cachedToken.expiresAt > Date.now()) {
        this.currentToken = cachedToken;
        logger.info({
          expiresIn: Math.round((cachedToken.expiresAt - Date.now()) / 1000),
          scope: cachedToken.scope,
        }, 'Restored cached OAuth token');
      } else if (this.config.clientId && this.config.clientSecret) {
        // Authenticate if credentials are available
        await this.authenticate(this.config.clientId, this.config.clientSecret);
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to initialize with cached token');
    }

    this.initialized = true;
    logger.info('Reddit API adapter initialized');
  }

  // ===========================================================================
  // REQUEST BUILDING
  // ===========================================================================

  /**
   * Build an authenticated Reddit API request with all necessary headers,
   * cookies, and parameters for anti-detection.
   *
   * @param url - Target URL (can be a Reddit URL or API path)
   * @param method - HTTP method
   * @param options - Additional request options
   * @returns Complete request configuration with headers, URL, and options
   */
  buildRequest(
    url: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
    options?: {
      body?: Record<string, unknown>;
      queryParams?: Record<string, string>;
      useOAuth?: boolean;
      useJsonApi?: boolean;
      requestId?: string;
    }
  ): {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  } {
    const startTime = performance.now();
    this.stats.totalRequests++;

    const useOAuth = options?.useOAuth ?? !!this.currentToken?.accessToken;
    const useJsonApi = options?.useJsonApi ?? this.config.useJsonApi;

    // Build the final URL
    let finalUrl = url;

    // If it's a relative path, prepend the API base
    if (url.startsWith('/')) {
      finalUrl = useOAuth
        ? `${OAUTH_API_BASE}${this.config.apiVersion}${url}`
        : `${PUBLIC_API_BASE}${url}`;
    }

    // Apply JSON API suffix if needed
    if (useJsonApi && !finalUrl.endsWith('.json')) {
      const separator = finalUrl.includes('?') ? '&' : '?';
      // Don't add .json to oauth.reddit.com URLs (they already return JSON)
      if (!finalUrl.includes('oauth.reddit.com')) {
        finalUrl = finalUrl + '.json';
      }
    }

    // Add query parameters
    if (options?.queryParams) {
      const params = new URLSearchParams(options.queryParams);
      const separator = finalUrl.includes('?') ? '&' : '?';
      finalUrl = `${finalUrl}${separator}${params.toString()}`;
    }

    // Build headers
    const headers = this.buildRequestHeaders(useOAuth, options?.requestId);

    // Build body
    const body = options?.body ? JSON.stringify(options.body) : undefined;

    const buildTime = performance.now() - startTime;
    this.stats.avgRequestBuildTimeMs = this.stats.totalRequests > 0
      ? (this.stats.avgRequestBuildTimeMs * (this.stats.totalRequests - 1) + buildTime) / this.stats.totalRequests
      : buildTime;

    logger.debug({
      url: finalUrl.substring(0, 100),
      method,
      useOAuth,
      useJsonApi,
      hasBody: !!body,
      buildTimeMs: buildTime.toFixed(2),
    }, 'Built Reddit API request');

    return {
      url: finalUrl,
      method,
      headers,
      body,
    };
  }

  // ===========================================================================
  // AUTHENTICATION
  // ===========================================================================

  /**
   * Authenticate with Reddit's OAuth2 API using client credentials.
   *
   * Supports two flows:
   *   - Client Credentials (for script/app type): client_id + client_secret
   *   - Authorization Code (for web app): requires code + redirect_uri
   *
   * @param clientId - Reddit app client ID
   * @param clientSecret - Reddit app client secret
   * @param options - Additional auth options
   * @returns Authentication result with access token
   */
  async authenticate(
    clientId: string,
    clientSecret: string,
    options?: {
      grantType?: 'client_credentials' | 'authorization_code' | 'refresh_token';
      code?: string;
      redirectUri?: string;
      refreshToken?: string;
      scopes?: string[];
    }
  ): Promise<RedditAuthResult> {
    this.stats.totalAuthentications++;

    const grantType = options?.grantType || 'client_credentials';
    const scopes = options?.scopes || this.config.scopes;

    logger.info({
      grantType,
      clientId: clientId.substring(0, 8) + '...',
      scopes,
    }, 'Authenticating with Reddit OAuth2');

    try {
      // Build the token request body
      const tokenBody: Record<string, string> = {
        grant_type: grantType,
      };

      if (grantType === 'authorization_code') {
        if (!options?.code || !options?.redirectUri) {
          throw new Error('Authorization code flow requires code and redirect_uri');
        }
        tokenBody.code = options.code;
        tokenBody.redirect_uri = options.redirectUri;
      } else if (grantType === 'refresh_token') {
        if (!options?.refreshToken && !this.config.refreshToken) {
          throw new Error('Refresh token flow requires a refresh token');
        }
        tokenBody.refresh_token = options?.refreshToken || this.config.refreshToken!;
      }

      // Build the authorization header (Basic auth with client_id:client_secret)
      const authString = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

      const response = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authString}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': this.config.userAgentFormat,
        },
        body: new URLSearchParams(tokenBody).toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorData: any = {};
        try { errorData = JSON.parse(errorText); } catch { /* non-JSON error */ }

        this.stats.authFailures++;
        const result: RedditAuthResult = {
          success: false,
          accessToken: '',
          tokenType: '',
          expiresIn: 0,
          scope: '',
          obtainedAt: Date.now(),
          expiresAt: 0,
          error: errorData.error || `HTTP ${response.status}`,
          errorDescription: errorData.error_description || errorText.substring(0, 200),
        };

        logger.error({
          status: response.status,
          error: result.error,
          errorDescription: result.errorDescription,
        }, 'Reddit OAuth2 authentication failed');

        return result;
      }

      const data = await response.json() as {
        access_token: string;
        token_type: string;
        expires_in: number;
        scope: string;
        refresh_token?: string;
      };

      const now = Date.now();
      const result: RedditAuthResult = {
        success: true,
        accessToken: data.access_token,
        tokenType: data.token_type,
        expiresIn: data.expires_in,
        scope: data.scope,
        refreshToken: data.refresh_token || this.config.refreshToken,
        obtainedAt: now,
        expiresAt: now + (data.expires_in * 1000),
      };

      this.currentToken = result;
      this.stats.authSuccesses++;

      // Cache the token
      try {
        await cacheSet(`${TOKEN_CACHE_PREFIX}current`, result, TOKEN_CACHE_TTL);
      } catch (err: any) {
        logger.debug({ err: err.message }, 'Failed to cache OAuth token');
      }

      // Update config
      this.config.accessToken = data.access_token;
      if (data.refresh_token) {
        this.config.refreshToken = data.refresh_token;
      }

      logger.info({
        tokenType: data.token_type,
        expiresIn: data.expires_in,
        scope: data.scope,
        hasRefreshToken: !!data.refresh_token,
      }, 'Reddit OAuth2 authentication successful');

      return result;
    } catch (err: any) {
      this.stats.authFailures++;

      const result: RedditAuthResult = {
        success: false,
        accessToken: '',
        tokenType: '',
        expiresIn: 0,
        scope: '',
        obtainedAt: Date.now(),
        expiresAt: 0,
        error: err.code || 'NETWORK_ERROR',
        errorDescription: err.message,
      };

      logger.error({
        err: err.message,
        code: err.code,
      }, 'Reddit OAuth2 authentication error');

      return result;
    }
  }

  // ===========================================================================
  // TOKEN REFRESH
  // ===========================================================================

  /**
   * Refresh an OAuth2 access token using a refresh token.
   *
   * Reddit's access tokens expire after 1 hour. Refresh tokens are
   * long-lived and can be used to obtain new access tokens without
   * requiring user interaction.
   *
   * @param refreshToken - The refresh token to use (or uses stored token)
   * @returns New authentication result with fresh access token
   */
  async refreshToken(refreshToken?: string): Promise<RedditAuthResult> {
    this.stats.totalTokenRefreshes++;

    const token = refreshToken || this.config.refreshToken;
    if (!token) {
      const result: RedditAuthResult = {
        success: false,
        accessToken: '',
        tokenType: '',
        expiresIn: 0,
        scope: '',
        obtainedAt: Date.now(),
        expiresAt: 0,
        error: 'NO_REFRESH_TOKEN',
        errorDescription: 'No refresh token available for token refresh',
      };
      logger.error('Token refresh attempted without a refresh token');
      return result;
    }

    logger.info('Refreshing Reddit OAuth2 token...');

    return this.authenticate(this.config.clientId, this.config.clientSecret || '', {
      grantType: 'refresh_token',
      refreshToken: token,
    });
  }

  // ===========================================================================
  // OAUTH HEADERS
  // ===========================================================================

  /**
   * Build OAuth authorization headers for a Reddit API request.
   *
   * Includes:
   *   - Authorization: Bearer <token>
   *   - User-Agent: Following Reddit's required format
   *   - Content-Type: application/json
   *   - Accept: application/json
   *   - X-Reddit-Request-Id: Unique request tracking ID
   *
   * @param accessToken - The OAuth2 access token
   * @returns Headers object for authenticated requests
   */
  buildOAuthHeaders(accessToken?: string): Record<string, string> {
    const token = accessToken || this.currentToken?.accessToken;
    return this.buildRequestHeaders(!!token, undefined, token);
  }

  // ===========================================================================
  // URL PARSING
  // ===========================================================================

  /**
   * Parse a Reddit listing URL into an API-compatible URL.
   *
   * Handles multiple URL formats:
   *   - https://www.reddit.com/r/programming/hot/
   *   - https://old.reddit.com/r/programming/comments/abc123/...
   *   - https://www.reddit.com/user/spez/overview/
   *   - https://www.reddit.com/search/?q=python&sort=relevance
   *   - https://www.reddit.com/r/wiki_pages/index/
   *
   * Returns a structured parse result with all extracted information.
   *
   * @param url - Reddit URL to parse
   * @returns Parsed result with API URL and extracted metadata
   */
  parseListingUrl(url: string): RedditListingParseResult {
    this.stats.totalParseOperations++;

    const defaultResult: RedditListingParseResult = {
      valid: false,
      apiUrl: '',
      subreddit: null,
      sort: null,
      timeRange: null,
      postId: null,
      username: null,
      searchQuery: null,
      isOldReddit: false,
      isJsonApi: false,
      after: null,
      page: 1,
    };

    try {
      const parsed = new URL(url);
      const isOldReddit = parsed.hostname === 'old.reddit.com';
      const isJsonApi = url.endsWith('.json');
      defaultResult.isOldReddit = isOldReddit;
      defaultResult.isJsonApi = isJsonApi;

      const pathParts = parsed.pathname
        .replace(/\.json$/, '')
        .split('/')
        .filter(Boolean);

      // Parse based on URL pattern
      if (pathParts.length === 0) {
        // Root URL — front page
        defaultResult.valid = true;
        defaultResult.apiUrl = isOldReddit
          ? `${OLD_REDDIT_BASE}.json`
          : `${PUBLIC_API_BASE}.json`;
        defaultResult.sort = 'hot';
        return defaultResult;
      }

      // /r/<subreddit>/...
      if (pathParts[0] === 'r' && pathParts.length >= 2) {
        defaultResult.subreddit = pathParts[1];

        if (pathParts.length === 2) {
          // /r/<subreddit>
          defaultResult.valid = true;
          defaultResult.apiUrl = this.buildApiUrl(`/r/${pathParts[1]}/hot`, isOldReddit, isJsonApi);
          defaultResult.sort = 'hot';
          return defaultResult;
        }

        // Sort listings
        const validSorts = ['hot', 'new', 'rising', 'top', 'controversial'];
        if (validSorts.includes(pathParts[2])) {
          defaultResult.valid = true;
          defaultResult.sort = pathParts[2] as RedditListingParseResult['sort'];

          // Check for time range (t parameter)
          const tParam = parsed.searchParams.get('t');
          if (tParam && ['hour', 'day', 'week', 'month', 'year', 'all'].includes(tParam)) {
            defaultResult.timeRange = tParam as RedditListingParseResult['timeRange'];
          }

          defaultResult.apiUrl = this.buildApiUrl(
            `/r/${pathParts[1]}/${pathParts[2]}`,
            isOldReddit,
            isJsonApi,
            parsed.searchParams
          );
          return defaultResult;
        }

        // Comments
        if (pathParts[2] === 'comments' && pathParts.length >= 4) {
          defaultResult.valid = true;
          defaultResult.postId = pathParts[3];
          defaultResult.apiUrl = this.buildApiUrl(
            `/r/${pathParts[1]}/comments/${pathParts[3]}`,
            isOldReddit,
            isJsonApi
          );
          defaultResult.sort = 'hot'; // Default comment sort
          return defaultResult;
        }

        // Wiki
        if (pathParts[2] === 'wiki' && pathParts.length >= 4) {
          defaultResult.valid = true;
          defaultResult.apiUrl = this.buildApiUrl(
            `/r/${pathParts[1]}/wiki/${pathParts.slice(3).join('/')}`,
            isOldReddit,
            isJsonApi
          );
          return defaultResult;
        }

        // Default subreddit page
        defaultResult.valid = true;
        defaultResult.apiUrl = this.buildApiUrl(
          `/r/${pathParts[1]}/hot`,
          isOldReddit,
          isJsonApi
        );
        defaultResult.sort = 'hot';
        return defaultResult;
      }

      // /user/<username>/...
      if (pathParts[0] === 'user' && pathParts.length >= 2) {
        defaultResult.valid = true;
        defaultResult.username = pathParts[1];

        const userSort = pathParts[2] || 'overview';
        defaultResult.apiUrl = this.buildApiUrl(
          `/user/${pathParts[1]}/${userSort}`,
          isOldReddit,
          isJsonApi
        );
        return defaultResult;
      }

      // /search
      if (pathParts[0] === 'search') {
        defaultResult.valid = true;
        defaultResult.searchQuery = parsed.searchParams.get('q') || '';
        defaultResult.sort = (parsed.searchParams.get('sort') as RedditListingParseResult['sort']) || 'relevance';
        defaultResult.timeRange = (parsed.searchParams.get('t') as RedditListingParseResult['timeRange']) || null;
        defaultResult.apiUrl = this.buildApiUrl(
          '/search',
          isOldReddit,
          isJsonApi,
          parsed.searchParams
        );
        return defaultResult;
      }

      // /r/popular, /r/all (special listings)
      if (pathParts[0] === 'r' && ['popular', 'all', 'friends', 'mod'].includes(pathParts[1])) {
        defaultResult.valid = true;
        defaultResult.subreddit = pathParts[1];
        const sort = pathParts[2] || 'hot';
        defaultResult.sort = ['hot', 'new', 'rising', 'top', 'controversial'].includes(sort) ? sort as RedditListingParseResult['sort'] : 'hot';
        defaultResult.apiUrl = this.buildApiUrl(
          `/r/${pathParts[1]}/${defaultResult.sort}`,
          isOldReddit,
          isJsonApi
        );
        return defaultResult;
      }

      logger.warn({ url, pathParts }, 'Unrecognized Reddit URL pattern');
      return defaultResult;
    } catch (err: any) {
      logger.error({ url, err: err.message }, 'Failed to parse Reddit URL');
      return defaultResult;
    }
  }

  // ===========================================================================
  // REQUEST ID GENERATION
  // ===========================================================================

  /**
   * Generate a unique Reddit request ID for tracing.
   *
   * Reddit uses request IDs for debugging and potentially for
   * session correlation. Generating realistic IDs helps avoid
   * detection through ID pattern analysis.
   *
   * Format: <8-char-hex>-<4-char-hex>-<4-char-hex>-<4-char-hex>-<12-char-hex>
   * (Similar to UUID v4 format but with Reddit-specific patterns)
   *
   * @returns A unique request ID string
   */
  generateRequestId(): string {
    const hex = (length: number) => {
      let result = '';
      const chars = '0123456789abcdef';
      for (let i = 0; i < length; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
      }
      return result;
    };

    // Reddit request IDs follow a UUID-like format
    const requestId = `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;

    // Cache the request ID briefly (for deduplication tracking)
    cacheSet(`${REQUEST_ID_CACHE_PREFIX}${requestId}`, Date.now(), 60).catch(() => {});

    return requestId;
  }

  // ===========================================================================
  // AUTHORIZATION URL GENERATION
  // ===========================================================================

  /**
   * Generate an OAuth2 authorization URL for the code grant flow.
   * Users must visit this URL to authorize the application.
   *
   * @param state - CSRF protection state parameter
   * @param scopes - OAuth2 scopes to request
   * @param redirectUri - Redirect URI (must match app configuration)
   * @returns Authorization URL string
   */
  getAuthorizationUrl(
    state: string,
    scopes?: string[],
    redirectUri?: string
  ): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      state,
      redirect_uri: redirectUri || this.config.redirectUri || 'http://localhost:8080/callback',
      duration: 'permanent',
      scope: (scopes || this.config.scopes).join(' '),
    });

    const url = `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
    logger.debug({ scopes: scopes || this.config.scopes }, 'Generated OAuth2 authorization URL');
    return url;
  }

  // ===========================================================================
  // TOKEN STATUS
  // ===========================================================================

  /**
   * Check if the current OAuth token is valid and not expired.
   */
  isTokenValid(): boolean {
    if (!this.currentToken) return false;
    if (!this.currentToken.success) return false;
    // Consider token invalid 5 minutes before actual expiry
    return this.currentToken.expiresAt > (Date.now() + 300000);
  }

  /**
   * Get the current access token (if valid).
   */
  getAccessToken(): string | null {
    if (this.isTokenValid()) {
      return this.currentToken!.accessToken;
    }
    return null;
  }

  /**
   * Get the current auth result.
   */
  getCurrentAuth(): RedditAuthResult | null {
    return this.currentToken;
  }

  // ===========================================================================
  // STATISTICS
  // ===========================================================================

  /**
   * Get API adapter statistics.
   */
  getStats(): Record<string, unknown> {
    return {
      ...this.stats,
      hasValidToken: this.isTokenValid(),
      tokenExpiresAt: this.currentToken?.expiresAt || null,
      tokenScope: this.currentToken?.scope || null,
    };
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Build request headers with proper authentication and anti-detection.
   */
  private buildRequestHeaders(
    useOAuth: boolean,
    requestId?: string,
    accessToken?: string
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': this.config.userAgentFormat,
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    };

    // OAuth bearer token
    if (useOAuth) {
      const token = accessToken || this.currentToken?.accessToken;
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    // Reddit-specific headers
    headers['X-Reddit-Request-Id'] = requestId || this.generateRequestId();

    // Origin and Referer for CORS compliance
    headers['Origin'] = 'https://www.reddit.com';
    headers['Referer'] = 'https://www.reddit.com/';

    // Sec-Fetch headers (browser-like)
    headers['Sec-Fetch-Dest'] = 'empty';
    headers['Sec-Fetch-Mode'] = 'cors';
    headers['Sec-Fetch-Site'] = 'same-site';

    // DNT and Sec-CH-UA (browser fingerprint consistency)
    headers['DNT'] = '1';
    headers['Sec-CH-UA'] = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';
    headers['Sec-CH-UA-Mobile'] = '?0';
    headers['Sec-CH-UA-Platform'] = '"Windows"';

    return headers;
  }

  /**
   * Build an API URL from a path, handling old.reddit.com and .json suffix.
   */
  private buildApiUrl(
    path: string,
    isOldReddit: boolean,
    isJsonApi: boolean,
    searchParams?: URLSearchParams
  ): string {
    const base = isOldReddit ? OLD_REDDIT_BASE : PUBLIC_API_BASE;
    let url = `${base}${path.replace(/^\//, '')}`;

    if (isJsonApi && !url.endsWith('.json')) {
      url += '.json';
    }

    if (searchParams && searchParams.toString()) {
      const separator = url.includes('?') ? '&' : '?';
      url += `${separator}${searchParams.toString()}`;
    }

    return url;
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const redditApiAdapter = new RedditApiAdapter();
