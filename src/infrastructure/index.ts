/**
 * Infrastructure Module — ScrapeSuite Engine
 *
 * Enterprise-grade infrastructure for Netflix and Google scraping at scale.
 * Provides proxy farms, IP reputation management, browser farms, session
 * management, and mobile device emulation.
 */

// Types
export type {
  ProxyTier, ProxyProtocol, ProxyProvider, ProxyHealthStatus,
  ProxyEndpoint, ProxyFarmConfig, ProxyAllocationRequest, ProxyAllocationResult,
  IPReputationLevel, IPReputationRecord, IPGeoData, IPReputationConfig, IPReputationReport,
  BrowserInstanceStatus, BrowserType, StealthLevel,
  BrowserInstance, BrowserFarmConfig, BrowserAllocationRequest, BrowserAllocationResult,
  SessionStatus, SessionType, SessionRecord, SessionFarmConfig,
  MobilePlatform, MobileDevice, MobileProfile, MobileEmulationConfig,
  InfrastructureStats,
} from './types';

// Proxy Farm
export { ProxyFarmManager, DEFAULT_PROXY_FARM_CONFIG, proxyFarmManager } from './proxy-farm';

// IP Reputation
export { IPReputationManager, DEFAULT_IP_REPUTATION_CONFIG, ipReputationManager } from './ip-reputation';

// Browser Farm
export { BrowserFarmManager, DEFAULT_BROWSER_FARM_CONFIG, browserFarmManager } from './browser-farm';

// Session Farm
export { SessionFarmManager, DEFAULT_SESSION_FARM_CONFIG, sessionFarmManager } from './session-farm';

// Mobile Emulation
export { MobileEmulationManager, DEFAULT_MOBILE_EMULATION_CONFIG, mobileEmulationManager } from './mobile-emulation';

// Infrastructure Manager (top-level orchestrator)
export { InfrastructureManager, infrastructureManager } from './manager';
