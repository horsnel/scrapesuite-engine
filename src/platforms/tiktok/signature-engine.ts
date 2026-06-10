/**
 * TikTok Signature Engine -- ScrapeSuite Engine
 *
 * Unified signing engine that combines X-Bogus, msToken, A-Bogus, _signature,
 * and ttwid into a single signing pipeline for TikTok API requests.
 *
 * Usage:
 *   const result = await signatureEngine.sign({
 *     url: 'https://api.tiktok.com/...',
 *     method: 'GET',
 *     device: profile,
 *     msToken: token,
 *     algorithms: ['x-bogus', 'msToken', 'ttwid'],
 *   });
 */

import { createChildLogger } from '../../utils/logger';
import { XBogusSignerEngine, xbogusSigner } from './xbogus-signer';
import { MsTokenRotatorEngine, msTokenRotator } from './mstoken-rotator';
import { DeviceRegistrarEngine, deviceRegistrar } from './device-registrar';
import type {
  SignatureRequest,
  SignatureResult,
  TikTokSignatureAlgorithm,
  TikTokDeviceType,
} from './types';

const logger = createChildLogger('tiktok-signature-engine');

// ===============================================================================
// TIKTOK API HEADERS
// ===============================================================================

/** Required headers for TikTok API requests */
const TIKTOK_API_HEADERS: Record<string, string> = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="130", "Not/A)Brand";v="99", "Google Chrome";v="130"',
  'Sec-Ch-Ua-Mobile': '?1',
  'Sec-Ch-Ua-Platform': '"Android"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  'Origin': 'https://www.tiktok.com',
  'Referer': 'https://www.tiktok.com/',
};

// ===============================================================================
// SIGNATURE ENGINE
// ===============================================================================

export class TikTokSignatureEngine {
  private xbogus: XBogusSignerEngine;
  private mstoken: MsTokenRotatorEngine;
  private devices: DeviceRegistrarEngine;
  private stats = {
    totalSigned: 0,
    byAlgorithm: {} as Record<string, number>,
    avgSignTimeMs: 0,
    failures: 0,
  };

  constructor() {
    this.xbogus = xbogusSigner;
    this.mstoken = msTokenRotator;
    this.devices = deviceRegistrar;
  }

  /**
   * Initialize the signature engine.
   */
  async initialize(): Promise<void> {
    await this.mstoken.initialize();
    logger.info('TikTok signature engine initialized');
  }

  /**
   * Sign a TikTok API request with all required signatures.
   */
  async sign(request: SignatureRequest): Promise<SignatureResult> {
    const startTime = performance.now();

    let signedUrl = request.url;
    const headers: Record<string, string> = { ...TIKTOK_API_HEADERS };
    const cookies: Record<string, string> = {};
    let msToken = request.msToken;

    // Apply each requested algorithm
    for (const algorithm of request.algorithms) {
      try {
        switch (algorithm) {
          case 'x-bogus': {
            const urlObj = new URL(request.url);
            const result = await this.xbogus.generate({
              url: urlObj.pathname,
              queryString: urlObj.searchParams.toString(),
              userAgent: request.device.userAgent,
              timestamp: Math.floor(Date.now() / 1000),
              platform: request.device.deviceType,
              body: request.body,
            });

            // Append X-Bogus to URL
            const separator = signedUrl.includes('?') ? '&' : '?';
            signedUrl = `${signedUrl}${separator}X-Bogus=${encodeURIComponent(result.xBogus)}`;

            this.stats.byAlgorithm['x-bogus'] = (this.stats.byAlgorithm['x-bogus'] || 0) + 1;
            break;
          }

          case 'msToken': {
            // Refresh msToken if needed
            if (!msToken || msToken.length < 50) {
              const tokenResult = this.mstoken.getActiveToken();
              msToken = tokenResult.token;
            }

            // Append msToken to URL
            const sep = signedUrl.includes('?') ? '&' : '?';
            signedUrl = `${signedUrl}${sep}msToken=${encodeURIComponent(msToken)}`;
            cookies['msToken'] = msToken;

            this.stats.byAlgorithm['msToken'] = (this.stats.byAlgorithm['msToken'] || 0) + 1;
            break;
          }

          case 'ttwid': {
            const registration = await this.devices.getRegisteredDevice(request.device.deviceId);
            if (registration) {
              cookies['ttwid'] = registration.ttwid;
              cookies['odin_tt'] = registration.odin_tt;
            }
            this.stats.byAlgorithm['ttwid'] = (this.stats.byAlgorithm['ttwid'] || 0) + 1;
            break;
          }

          case 'a-bogus': {
            // A-Bogus is a newer algorithm similar to X-Bogus
            // For now, generate a compatible signature
            const aBogusValue = this.generateABogus(request);
            const aBogusSep = signedUrl.includes('?') ? '&' : '?';
            signedUrl = `${signedUrl}${aBogusSep}a_bogus=${encodeURIComponent(aBogusValue)}`;

            this.stats.byAlgorithm['a-bogus'] = (this.stats.byAlgorithm['a-bogus'] || 0) + 1;
            break;
          }

          case '_signature': {
            // Legacy signature parameter (still used on some endpoints)
            const sigValue = this.generateLegacySignature(request);
            const sigSep = signedUrl.includes('?') ? '&' : '?';
            signedUrl = `${signedUrl}${sigSep}_signature=${encodeURIComponent(sigValue)}`;

            this.stats.byAlgorithm['_signature'] = (this.stats.byAlgorithm['_signature'] || 0) + 1;
            break;
          }
        }
      } catch (err: any) {
        logger.warn({ algorithm, error: err.message }, 'Signature algorithm failed');
        this.stats.failures++;
      }
    }

    // Set User-Agent header
    headers['User-Agent'] = request.device.userAgent;

    // Add cookie header
    if (Object.keys(cookies).length > 0) {
      headers['Cookie'] = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    const generationTime = performance.now() - startTime;
    this.stats.totalSigned++;
    this.stats.avgSignTimeMs = this.stats.totalSigned > 0
      ? (this.stats.avgSignTimeMs * (this.stats.totalSigned - 1) + generationTime) / this.stats.totalSigned
      : generationTime;

    // Extract x-bogus from URL if present
    const xBogusMatch = signedUrl.match(/[?&]X-Bogus=([^&]+)/);
    const aBogusMatch = signedUrl.match(/[?&]a_bogus=([^&]+)/);
    const sigMatch = signedUrl.match(/[?&]_signature=([^&]+)/);

    return {
      signedUrl,
      xBogus: xBogusMatch ? xBogusMatch[1] : undefined,
      aBogus: aBogusMatch ? aBogusMatch[1] : undefined,
      signature: sigMatch ? sigMatch[1] : undefined,
      msToken,
      headers,
      cookies,
      generationTimeMs: generationTime,
    };
  }

  /**
   * Quick-sign a URL with just X-Bogus and msToken (most common).
   */
  async quickSign(url: string, deviceType: TikTokDeviceType = 'mobile_android'): Promise<SignatureResult> {
    const device = this.devices.generateDevice(deviceType);
    const token = this.mstoken.getActiveToken();

    return this.sign({
      url,
      method: 'GET',
      device,
      msToken: token.token,
      algorithms: ['x-bogus', 'msToken'],
    });
  }

  /**
   * Generate A-Bogus signature (newer algorithm).
   */
  private generateABogus(request: SignatureRequest): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const data = `${request.url}:${request.method}:${timestamp}:${request.device.userAgent}`;
    const hash = this.simpleHash(data);
    return `${hash}_${timestamp.toString(16)}`;
  }

  /**
   * Generate legacy _signature parameter.
   */
  private generateLegacySignature(request: SignatureRequest): string {
    const data = `${request.url}:${request.device.deviceId}:${Date.now()}`;
    return `02${this.simpleHash(data)}`;
  }

  /**
   * Simple hash function for signatures.
   */
  private simpleHash(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * Get engine statistics.
   */
  getStats(): Record<string, unknown> {
    return {
      ...this.stats,
      xbogus: this.xbogus.getStats(),
      mstoken: this.mstoken.getStats(),
      devices: this.devices.getStats(),
    };
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const tiktokSignatureEngine = new TikTokSignatureEngine();
