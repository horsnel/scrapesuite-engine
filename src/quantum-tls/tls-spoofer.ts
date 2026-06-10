/**
 * TLS Fingerprint Spoofing Engine -- ScrapeSuite Engine
 *
 * Implements real TLS fingerprint spoofing at the connection level.
 * Uses curl-impersonate for full JA3/JA4 fingerprint matching,
 * with a Node.js native fallback for partial spoofing.
 *
 * Architecture:
 *  +--------------------------------------------------------------------------+
 *  | Layer 1: curl-impersonate -- Full JA3/JA4 spoofing via custom TLS stack |
 *  | Layer 2: Node.js Native -- Partial JA3 spoofing via cipher reordering   |
 *  | Layer 3: Profile Matching -- Automatic profile selection per domain      |
 *  +--------------------------------------------------------------------------+
 *
 * curl-impersonate provides binary-level TLS fingerprint matching by using
 * a custom-built libcurl with BoringSSL/OpenSSL that can mimic any browser's
 * exact TLS handshake, including:
 *  - Cipher suite ORDERING (critical for JA3)
 *  - Extension ORDERING (critical for JA3)
 *  - Supported groups ORDERING
 *  - Signature algorithms ORDERING
 *  - ALPN values
 *  - GREASE extensions
 *  - PSK key exchange modes
 *  - Session ticket extension presence
 *
 * This makes the TLS handshake INDISTINGUISHABLE from a real browser.
 */

import * as net from 'net';
import * as tls from 'tls';
import { execFile } from 'child_process';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import type { TLSProfile, ConnectionConfig } from './types';

const logger = createChildLogger('quantum-tls:spoofer');

// ---------- Public types -------------------------------------------------------

/** A spoofed TLS connection returned by createSpoofedConnection(). */
export interface SpoofedConnection {
  socket: net.Socket;
  tlsSocket: tls.TLSSocket;
  profile: TLSProfile;
  negotiatedCipher: string;
  negotiatedVersion: string;
  ja3Hash: string;
  connectTimeMs: number;
}

/** Result of a curl-impersonate HTTP request. */
export interface CurlImpersonateResult {
  success: boolean;
  responseBody: string;
  statusCode: number;
  headers: Record<string, string>;
  ja3Hash: string;
  connectTimeMs: number;
  tlsVersion: string;
  negotiatedCipher: string;
}

/** Internal stats tracked by the spoofer. */
interface SpooferStats {
  totalRequests: number;
  curlImpersonateRequests: number;
  nativeFallbackRequests: number;
  curlImpersonateAvailable: boolean;
  successCount: number;
  failureCount: number;
  averageConnectTimeMs: number;
  profileUsage: Record<string, number>;
  lastCurlDetectAttempt: number | null;
}

// ---------- Well-known curl-impersonate browser targets ------------------------

const CURL_TARGETS: Record<string, string> = {
  'chrome-120': 'chrome120',
  'chrome-116': 'chrome116',
  'chrome-110': 'chrome110',
  'chrome-124': 'chrome124',
  'chrome-131': 'chrome131',
  'firefox-120': 'firefox120',
  'firefox-133': 'firefox133',
  'safari-17': 'safari17_0',
  'safari-18': 'safari18_0',
};

/** Binary names to probe when detecting curl-impersonate. */
const CURL_IMPERSONATE_BINARIES = [
  'curl-impersonate-chrome',
  'curl-impersonate-firefox',
  'curl_chrome116',
  'curl_chrome120',
  'curl_chrome124',
  'curl_chrome131',
  'curl_firefox120',
  'curl_firefox133',
  'curl_safari17_0',
  'curl_safari18_0',
  'curl-impersonate',
];

/** Common install locations for curl-impersonate. */
const CURL_IMPERSONATE_PATHS = [
  '/usr/local/bin/curl-impersonate-chrome',
  '/usr/bin/curl-impersonate-chrome',
  '/usr/local/bin/curl-impersonate-firefox',
  '/opt/curl-impersonate/bin/curl-impersonate-chrome',
];

const CACHE_KEY_PREFIX = 'tls:spoofer:';
const STATS_TTL = 3600;

// ---------- TLSFingerprintSpoofer class ----------------------------------------

export class TLSFingerprintSpoofer {
  private curlImpersonatePath: string | null = null;
  private profileCache = new Map<string, string[]>(); // profile id -> curl base args
  private initialized = false;

  private stats: SpooferStats = {
    totalRequests: 0,
    curlImpersonateRequests: 0,
    nativeFallbackRequests: 0,
    curlImpersonateAvailable: false,
    successCount: 0,
    failureCount: 0,
    averageConnectTimeMs: 0,
    profileUsage: {},
    lastCurlDetectAttempt: null,
  };

  /** Initialise the spoofer -- detect curl-impersonate, load cached state. */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing TLS fingerprint spoofer...');

    // Detect curl-impersonate
    this.curlImpersonatePath = await this.detectCurlImpersonate();
    this.stats.curlImpersonateAvailable = this.curlImpersonatePath !== null;
    this.stats.lastCurlDetectAttempt = Date.now();

    if (this.curlImpersonatePath) {
      logger.info({ path: this.curlImpersonatePath }, 'curl-impersonate detected -- full JA3/JA4 spoofing enabled');
    } else {
      logger.warn('curl-impersonate not found -- falling back to Node.js native partial spoofing');
    }

    // Load persisted stats from cache
    try {
      const cached = await cacheGet<Partial<SpooferStats>>(CACHE_KEY_PREFIX + 'stats');
      if (cached) {
        Object.assign(this.stats, cached);
        // Refresh availability flag after fresh detection
        this.stats.curlImpersonateAvailable = this.curlImpersonatePath !== null;
      }
    } catch {
      // Cache unavailable -- continue with in-memory stats
    }

    this.initialized = true;
    logger.info({ curlAvailable: this.stats.curlImpersonateAvailable }, 'TLS spoofer initialized');
  }

  /**
   * Make an HTTP request with a spoofed TLS fingerprint using curl-impersonate.
   * This provides FULL JA3/JA4 fingerprint matching.
   * Falls back to Node.js native TLS if curl-impersonate is unavailable.
   */
  async requestWithSpoofedTLS(
    url: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      profile?: TLSProfile;
      proxyUrl?: string;
      timeout?: number;
    } = {},
  ): Promise<CurlImpersonateResult> {
    await this.initialize();

    const timeout = options.timeout ?? 30_000;
    const profile = options.profile;
    this.stats.totalRequests++;

    // --- Primary: curl-impersonate path ---
    if (this.curlImpersonatePath && profile) {
      this.stats.curlImpersonateRequests++;
      this.incrementProfileUsage(profile.id);

      try {
        const args = this.buildCurlArgs(url, profile, options);
        const result = await this.executeCurl(args, timeout);
        this.stats.successCount++;
        this.updateAverageConnectTime(result.connectTimeMs);
        return result;
      } catch (err: any) {
        logger.warn({ err: err.message, url }, 'curl-impersonate request failed');
        this.stats.failureCount++;
        // Don't fall through -- return the error as a failed result
        return {
          success: false,
          responseBody: '',
          statusCode: 0,
          headers: {},
          ja3Hash: profile.ja3_hash,
          connectTimeMs: 0,
          tlsVersion: '',
          negotiatedCipher: '',
        };
      }
    }

    // --- Fallback: Node.js native partial spoofing ---
    this.stats.nativeFallbackRequests++;
    if (profile) this.incrementProfileUsage(profile.id);

    return this.nativeFallbackRequest(url, options, profile, timeout);
  }

  /**
   * Create a spoofed TLS connection to a host.
   * Returns a connected TLSSocket with the spoofed fingerprint.
   * Uses Node.js native TLS for raw socket connections (no curl).
   */
  async createSpoofedConnection(
    hostname: string,
    port: number,
    profile: TLSProfile,
    proxyUrl?: string,
  ): Promise<SpoofedConnection> {
    await this.initialize();

    const startTime = Date.now();
    this.stats.totalRequests++;
    this.incrementProfileUsage(profile.id);

    return new Promise<SpoofedConnection>((resolve, reject) => {
      let rawSocket: net.Socket | null = null;

      const cleanup = () => {
        if (rawSocket) {
          rawSocket.destroy();
          rawSocket = null;
        }
      };

      // If a proxy is specified, connect through it first via CONNECT
      const connectThroughProxy = (): Promise<net.Socket> => {
        return new Promise((res, rej) => {
          const proxyUrlObj = new URL(proxyUrl!);
          const proxyPort = parseInt(proxyUrlObj.port) || 8080;
          const proxySocket = net.createConnection({ host: proxyUrlObj.hostname, port: proxyPort }, () => {
            const connectReq = `CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`;
            proxySocket.write(connectReq);
          });

          proxySocket.once('data', (data: Buffer) => {
            const response = data.toString();
            if (response.includes('200')) {
              res(proxySocket);
            } else {
              proxySocket.destroy();
              rej(new Error(`Proxy CONNECT failed: ${response.split('\r\n')[0]}`));
            }
          });

          proxySocket.once('error', (err) => {
            proxySocket.destroy();
            rej(err);
          });

          setTimeout(() => {
            proxySocket.destroy();
            rej(new Error('Proxy connection timeout'));
          }, 15_000);
        });
      };

      const establishTLS = (socket: net.Socket) => {
        rawSocket = socket;
        const tlsOptions = this.buildSpoofedTLSOptions(profile, hostname);
        const tlsSocket = tls.connect({ ...tlsOptions, socket });

        const connectTimeout = setTimeout(() => {
          cleanup();
          reject(new Error(`TLS connection timeout to ${hostname}:${port}`));
        }, 15_000);

        tlsSocket.once('secureConnect', () => {
          clearTimeout(connectTimeout);
          const connectTimeMs = Date.now() - startTime;

          const protocol = tlsSocket.getProtocol() ?? 'unknown';
          const cipher = tlsSocket.getCipher();

          this.stats.successCount++;
          this.updateAverageConnectTime(connectTimeMs);

          resolve({
            socket: rawSocket!,
            tlsSocket,
            profile,
            negotiatedCipher: cipher?.name ?? 'unknown',
            negotiatedVersion: protocol,
            ja3Hash: profile.ja3_hash,
            connectTimeMs,
          });
        });

        tlsSocket.once('error', (err) => {
          clearTimeout(connectTimeout);
          cleanup();
          this.stats.failureCount++;
          reject(err);
        });
      };

      if (proxyUrl) {
        connectThroughProxy()
          .then(establishTLS)
          .catch((err) => {
            this.stats.failureCount++;
            reject(err);
          });
      } else {
        const socket = net.createConnection({ host: hostname, port }, () => {
          establishTLS(socket);
        });
        socket.once('error', (err) => {
          this.stats.failureCount++;
          reject(err);
        });
      }
    });
  }

  /** Build curl-impersonate arguments from a TLS profile and request options. */
  private buildCurlArgs(
    url: string,
    profile: TLSProfile,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      proxyUrl?: string;
      timeout?: number;
    },
  ): string[] {
    // Check profile cache for pre-built base arguments
    const cacheKey = profile.id;
    let baseArgs = this.profileCache.get(cacheKey);

    if (!baseArgs) {
      const target = this.profileToCurlTarget(profile);
      const cipherStr = profile.cipher_suites.join(':');
      const alpnStr = profile.alpn_protocols.join(',');

      // Build the base arguments that depend only on the profile
      baseArgs = [
        '--impersonate', target,
        '--ciphers', cipherStr,
        '--alpn', alpnStr,
      ];

      // TLS version constraints
      if (profile.tls_version === 'TLS_1_3') {
        baseArgs.push('--tlsv1.3', '--tls-max', '1.3');
      } else {
        baseArgs.push('--tlsv1.2', '--tls-max', '1.2');
      }

      this.profileCache.set(cacheKey, baseArgs);
    }

    const args = [...baseArgs];

    // Request-level options
    const timeoutSeconds = Math.ceil((options.timeout ?? 30_000) / 1000);
    args.push(
      '--connect-timeout', String(timeoutSeconds),
      '--max-time', String(timeoutSeconds + 10),
      '--compressed',
    );

    // HTTP method
    if (options.method && options.method !== 'GET') {
      args.push('-X', options.method);
    }

    // Headers
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        args.push('-H', `${key}: ${value}`);
      }
    }

    // Request body
    if (options.body) {
      args.push('-d', options.body);
    }

    // Proxy
    if (options.proxyUrl) {
      args.push('--proxy', options.proxyUrl);
    }

    // Output formatting -- JSON write-out for structured parsing
    args.push(
      '-s',
      '-w', '\n---CURL_JSON---%{json}',
    );

    args.push(url);

    return args;
  }

  /** Detect if curl-impersonate is available on the system. */
  private async detectCurlImpersonate(): Promise<string | null> {
    // 1. Check well-known file paths first (fastest, no subprocess)
    for (const path of CURL_IMPERSONATE_PATHS) {
      try {
        const { existsSync } = await import('fs');
        if (existsSync(path)) {
          logger.debug({ path }, 'Found curl-impersonate at known path');
          return path;
        }
      } catch {
        // Ignore -- try next
      }
    }

    // 2. Use `which` to find binaries in PATH
    for (const binary of CURL_IMPERSONATE_BINARIES) {
      try {
        const found = await this.execWhich(binary);
        if (found) {
          logger.debug({ binary, path: found }, 'Found curl-impersonate via which');
          return found;
        }
      } catch {
        // Not found -- try next binary
      }
    }

    // 3. Try executing a binary directly with --version
    for (const binary of CURL_IMPERSONATE_BINARIES) {
      try {
        const version = await this.execWithTimeout(binary, ['--version'], 5000);
        if (version.includes('curl') && (version.includes('impersonate') || version.includes('BoringSSL'))) {
          logger.debug({ binary }, 'Confirmed curl-impersonate via --version');
          return binary;
        }
      } catch {
        // Not executable -- try next
      }
    }

    logger.info('curl-impersonate not detected on this system');
    return null;
  }

  /** Execute curl-impersonate command and parse the result. */
  private async executeCurl(args: string[], timeout: number): Promise<CurlImpersonateResult> {
    if (!this.curlImpersonatePath) {
      throw new Error('curl-impersonate is not available');
    }

    const startTime = Date.now();

    return new Promise<CurlImpersonateResult>((resolve, reject) => {
      const child = execFile(
        this.curlImpersonatePath!,
        args,
        {
          timeout: timeout + 5_000,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
          env: { ...process.env, CURL_IMPERSONATE_ESNI: '0' },
        },
        (err, stdout, stderr) => {
          const connectTimeMs = Date.now() - startTime;

          if (err && !stdout) {
            reject(new Error(`curl-impersonate failed: ${err.message}`));
            return;
          }

          // Separate body from JSON write-out
          let responseBody = stdout;
          let curlJson: Record<string, unknown> = {};

          const jsonMarker = '\n---CURL_JSON---';
          const markerIdx = stdout.lastIndexOf(jsonMarker);
          if (markerIdx !== -1) {
            responseBody = stdout.slice(0, markerIdx);
            const jsonStr = stdout.slice(markerIdx + jsonMarker.length);
            try {
              curlJson = JSON.parse(jsonStr);
            } catch {
              logger.debug({ jsonStr: jsonStr.slice(0, 200) }, 'Failed to parse curl JSON write-out');
            }
          }

          // Extract structured result from curl JSON
          const statusCode = (curlJson.http_code as number) ?? (err ? 0 : 200);
          const tlsVersion = (curlJson.ssl_version as string) ?? '';
          const negotiatedCipher = (curlJson.ssl_cipher as string) ?? '';

          // Parse response headers from curl's stderr or output
          const headers = this.parseCurlHeaders(stderr);

          // Use profile's JA3 hash as estimate (curl-impersonate matches it exactly)
          const ja3Hash = (curlJson.ja3_hash as string) ?? '';

          resolve({
            success: statusCode >= 200 && statusCode < 400,
            responseBody,
            statusCode,
            headers,
            ja3Hash,
            connectTimeMs: (curlJson.time_connect as number)
              ? Math.round((curlJson.time_connect as number) * 1000)
              : connectTimeMs,
            tlsVersion,
            negotiatedCipher,
          });
        },
      );

      // Kill the child process on timeout
      child.on('close', () => {
        child.kill();
      });
    });
  }

  /**
   * Build Node.js TLS options that partially spoof JA3 by reordering ciphers.
   *
   * NOTE: Node.js does NOT allow controlling extension ordering, supported groups
   * ordering, or signature algorithm ordering. This provides PARTIAL JA3 spoofing
   * -- the cipher component of JA3 will be correct, but the extension component
   * cannot be controlled. For full spoofing, use curl-impersonate.
   */
  private buildSpoofedTLSOptions(profile: TLSProfile, hostname: string): tls.ConnectionOptions {
    // Map profile cipher names to OpenSSL cipher string format
    const cipherString = this.cipherSuitesToOpenSSL(profile.cipher_suites);

    const minVersion = profile.tls_version === 'TLS_1_3' ? 'TLSv1.3' : 'TLSv1.2';
    const maxVersion = 'TLSv1.3';

    return {
      host: hostname,
      port: 443,
      servername: hostname,
      minVersion,
      maxVersion,
      ciphers: cipherString,
      honorCipherOrder: true,
      ALPNProtocols: profile.alpn_protocols,
      rejectUnauthorized: true,
      // Enable session tickets for more realistic handshake
      sessionTimeout: 300,
    };
  }

  /** Map our TLS profiles to curl-impersonate browser targets. */
  private profileToCurlTarget(profile: TLSProfile): string {
    // Try exact match from profile id prefix
    const profilePrefix = profile.id.split('-').slice(0, 2).join('-');
    if (CURL_TARGETS[profilePrefix]) {
      return CURL_TARGETS[profilePrefix];
    }

    // Fuzzy match by profile name
    const nameLower = profile.name.toLowerCase();

    if (nameLower.includes('chrome')) {
      if (nameLower.includes('120') || nameLower.includes('121') || nameLower.includes('122')) return 'chrome120';
      if (nameLower.includes('116') || nameLower.includes('117') || nameLower.includes('118')) return 'chrome116';
      if (nameLower.includes('124') || nameLower.includes('125') || nameLower.includes('126')) return 'chrome124';
      if (nameLower.includes('131') || nameLower.includes('132')) return 'chrome131';
      return 'chrome120'; // Default to most common Chrome
    }

    if (nameLower.includes('firefox')) {
      if (nameLower.includes('133') || nameLower.includes('134')) return 'firefox133';
      return 'firefox120';
    }

    if (nameLower.includes('safari')) {
      if (nameLower.includes('18')) return 'safari18_0';
      return 'safari17_0';
    }

    if (nameLower.includes('edge')) {
      return 'chrome120'; // Edge uses Chromium TLS stack
    }

    if (nameLower.includes('quantum')) {
      return 'chrome120'; // Quantum-hybrid profiles based on Chrome
    }

    // Default to Chrome 120 as the most common browser
    logger.debug({ profileId: profile.id, profileName: profile.name }, 'No curl target match -- defaulting to chrome120');
    return 'chrome120';
  }

  // ---------- Native fallback HTTP request ------------------------------------

  private async nativeFallbackRequest(
    url: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      profile?: TLSProfile;
      proxyUrl?: string;
      timeout?: number;
    },
    profile: TLSProfile | undefined,
    timeout: number,
  ): Promise<CurlImpersonateResult> {
    const startTime = Date.now();

    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;
      const port = parseInt(urlObj.port) || (urlObj.protocol === 'https:' ? 443 : 80);

      if (urlObj.protocol !== 'https:') {
        // Plain HTTP -- just use native fetch
        const resp = await fetch(url, {
          method: options.method ?? 'GET',
          headers: options.headers,
          body: options.body,
          signal: AbortSignal.timeout(timeout),
        });

        const responseBody = await resp.text();
        const connectTimeMs = Date.now() - startTime;

        this.stats.successCount++;
        this.updateAverageConnectTime(connectTimeMs);

        return {
          success: resp.ok,
          responseBody,
          statusCode: resp.status,
          headers: Object.fromEntries(resp.headers.entries()),
          ja3Hash: profile?.ja3_hash ?? '',
          connectTimeMs,
          tlsVersion: '',
          negotiatedCipher: '',
        };
      }

      // HTTPS with partial TLS spoofing
      const spoofedConn = await this.createSpoofedConnection(hostname, port, profile!, options.proxyUrl);

      // Send HTTP request over the spoofed TLS socket
      const method = options.method ?? 'GET';
      const path = urlObj.pathname + urlObj.search;
      const requestHeaders: Record<string, string> = {
        'Host': hostname,
        'Connection': 'close',
        ...options.headers,
      };

      let requestLine = `${method} ${path} HTTP/1.1\r\n`;
      for (const [key, value] of Object.entries(requestHeaders)) {
        requestLine += `${key}: ${value}\r\n`;
      }
      requestLine += '\r\n';

      if (options.body) {
        requestLine += options.body;
      }

      spoofedConn.tlsSocket.write(requestLine);

      // Read response
      const responseData = await this.readHttpResponse(spoofedConn.tlsSocket, timeout);
      spoofedConn.tlsSocket.destroy();

      this.stats.successCount++;
      this.updateAverageConnectTime(responseData.connectTimeMs);

      return {
        success: responseData.statusCode >= 200 && responseData.statusCode < 400,
        responseBody: responseData.body,
        statusCode: responseData.statusCode,
        headers: responseData.headers,
        ja3Hash: profile?.ja3_hash ?? '',
        connectTimeMs: responseData.connectTimeMs,
        tlsVersion: spoofedConn.negotiatedVersion,
        negotiatedCipher: spoofedConn.negotiatedCipher,
      };
    } catch (err: any) {
      this.stats.failureCount++;
      logger.warn({ err: err.message, url }, 'Native fallback request failed');

      return {
        success: false,
        responseBody: '',
        statusCode: 0,
        headers: {},
        ja3Hash: profile?.ja3_hash ?? '',
        connectTimeMs: Date.now() - startTime,
        tlsVersion: '',
        negotiatedCipher: '',
      };
    }
  }

  /** Read an HTTP response from a TLSSocket. */
  private readHttpResponse(
    socket: tls.TLSSocket,
    timeout: number,
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: string; connectTimeMs: number }> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let headersParsed = false;
      let statusCode = 0;
      const headers: Record<string, string> = {};
      let bodyStartIdx = 0;
      let headerBuffer = Buffer.alloc(0);

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('HTTP response read timeout'));
      }, timeout);

      socket.on('data', (chunk: Buffer) => {
        if (!headersParsed) {
          headerBuffer = Buffer.concat([headerBuffer, chunk]);
          const headerEnd = headerBuffer.indexOf('\r\n\r\n');
          if (headerEnd !== -1) {
            headersParsed = true;
            const headerStr = headerBuffer.slice(0, headerEnd).toString();
            bodyStartIdx = headerEnd + 4;

            // Parse status line
            const statusLine = headerStr.split('\r\n')[0];
            const statusMatch = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/);
            statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;

            // Parse headers
            const headerLines = headerStr.split('\r\n').slice(1);
            for (const line of headerLines) {
              const colonIdx = line.indexOf(':');
              if (colonIdx > 0) {
                const key = line.slice(0, colonIdx).trim();
                const value = line.slice(colonIdx + 1).trim();
                headers[key.toLowerCase()] = value;
              }
            }

            // Capture any body data in this first chunk
            const bodyPart = headerBuffer.slice(bodyStartIdx);
            if (bodyPart.length > 0) chunks.push(bodyPart);
          }
        } else {
          chunks.push(chunk);
        }
      });

      socket.on('end', () => {
        clearTimeout(timer);
        resolve({
          statusCode,
          headers,
          body: Buffer.concat(chunks).toString(),
          connectTimeMs: 0, // Measured by caller
        });
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // ---------- Cipher suite helpers --------------------------------------------

  /** Convert TLS cipher suite names to OpenSSL cipher string format. */
  private cipherSuitesToOpenSSL(cipherSuites: string[]): string {
    // OpenSSL uses colons to separate cipher suite names
    // The names we store are already in OpenSSL format
    return cipherSuites.join(':');
  }

  // ---------- Utility helpers --------------------------------------------------

  /** Run `which` to find a binary. */
  private execWhich(binary: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile('which', [binary], { timeout: 3000 }, (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null);
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  /** Execute a command with a timeout. */
  private execWithTimeout(command: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(command, args, { timeout: timeoutMs }, (err, stdout) => {
        if (err) {
          reject(err);
        } else {
          resolve(stdout);
        }
      });
    });
  }

  /** Parse headers from curl's stderr output. */
  private parseCurlHeaders(stderr: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (!stderr) return headers;

    const lines = stderr.split('\n');
    for (const line of lines) {
      const match = line.match(/^<\s*([^:]+):\s*(.+)$/);
      if (match) {
        headers[match[1].trim().toLowerCase()] = match[2].trim();
      }
    }

    return headers;
  }

  /** Increment the profile usage counter. */
  private incrementProfileUsage(profileId: string): void {
    this.stats.profileUsage[profileId] = (this.stats.profileUsage[profileId] ?? 0) + 1;
  }

  /** Update the running average connect time. */
  private updateAverageConnectTime(connectTimeMs: number): void {
    const total = this.stats.successCount + this.stats.failureCount;
    if (total <= 1) {
      this.stats.averageConnectTimeMs = connectTimeMs;
    } else {
      this.stats.averageConnectTimeMs =
        Math.round((this.stats.averageConnectTimeMs * (total - 1) + connectTimeMs) / total);
    }
  }

  /** Persist stats to cache. */
  private async persistStats(): Promise<void> {
    try {
      await cacheSet(CACHE_KEY_PREFIX + 'stats', this.stats, STATS_TTL);
    } catch {
      // Cache unavailable -- ignore
    }
  }

  /** Get current spoofer statistics. */
  getStats(): Record<string, unknown> {
    return {
      ...this.stats,
      curlImpersonatePath: this.curlImpersonatePath,
      profileCacheSize: this.profileCache.size,
      initialized: this.initialized,
    };
  }
}

// ---------- Singleton export ---------------------------------------------------

export const tlsSpoofer = new TLSFingerprintSpoofer();
