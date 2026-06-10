/**
 * TikTok Platform Module -- ScrapeSuite Engine
 *
 * Complete anti-bot counter-measures for TikTok scraping.
 * Handles X-Bogus, msToken, device registration, and feed simulation.
 */

export { TikTokManager, tiktokManager } from './manager';
export { XBogusSignerEngine, xbogusSigner } from './xbogus-signer';
export { MsTokenRotatorEngine, msTokenRotator } from './mstoken-rotator';
export { DeviceRegistrarEngine, deviceRegistrar } from './device-registrar';
export { TikTokSignatureEngine, tiktokSignatureEngine } from './signature-engine';
export { FeedSimulatorEngine, feedSimulator } from './feed-simulator';
export { XBogusCDNExtractor, xbogusCDNExtractor } from './xbogus-cdn-extractor';

export type {
  TikTokDeviceType,
  TikTokDeviceProfile,
  XBogusParams,
  XBogusResult,
  MsTokenConfig,
  MsTokenResult,
  DeviceRegistrationParams,
  DeviceRegistrationResult,
  FeedSection,
  FeedSimulationConfig,
  FeedSimulationResult,
  SignatureRequest,
  SignatureResult,
  TikTokSignatureAlgorithm,
  TikTokManagerConfig,
  TikTokManagerStats,
} from './types';

export { DEFAULT_TIKTOK_CONFIG } from './types';
