/**
 * Residential Proxy Provider Integration
 * 
 * Provides robust integration with major residential proxy providers:
 * - Bright Data (formerly Luminati) -- 400M+ IPs
 * - Oxylabs -- 100M+ IPs  
 * - SmartProxy -- 55M+ IPs
 * - IPRoyal -- 6M+ IPs
 * - Webshare -- 30M+ IPs
 * 
 * Features:
 * - Connection testing before returning proxy
 * - Automatic session management with provider-specific session IDs
 * - Geographic targeting (country, city, ASN)
 * - Provider health monitoring and failover
 * - Cost tracking per provider
 * - Sticky sessions via provider session IDs
 * - Automatic provider rotation on failures
 */

import { testProxy } from '../utils/proxy-fetch';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('residential-providers');

// --- Types --------------------------------------------------------------------

export type ProxyProvider = 'brightdata' | 'oxylabs' | 'smartproxy' | 'iproyal' | 'webshare' | 'generic';

export interface ResidentialProxyConfig {
  provider: ProxyProvider;
  url: string;       // Base proxy URL (user:pass@gateway:port)
  username?: string;  // Parsed from URL
  password?: string;  // Parsed from URL
  gateway?: string;   // Parsed from URL
  port?: number;      // Parsed from URL
  enabled: boolean;
  priority: number;   // Lower = higher priority
  costPerGb: number;  // Cost tracking
  maxConcurrent: number; // Max concurrent connections
  currentConcurrent: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  lastError?: string;
  lastErrorAt?: number;
  lastHealthCheck?: number;
  isHealthy: boolean;
}

export interface ProxyRequestOptions {
  country?: string;
  city?: string;
  asn?: string;
  sessionId?: string;  // For sticky sessions
  tier?: 'residential' | 'mobile' | 'datacenter' | 'isp';
}

export interface ProxyResult {
  proxyUrl: string;
  proxyId: string;
  provider: ProxyProvider;
  country: string;
  city?: string;
  asn?: string;
  tier: string;
  sessionId?: string;
  costPerGb: number;
}

// --- Provider URL Builders -----------------------------------------------------

/**
 * Build a Bright Data proxy URL with geo-targeting and session support.
 * Format: http://user-zone-country-city-session:pass@brd.superproxy.io:22225
 */
function buildBrightDataUrl(config: ResidentialProxyConfig, options: ProxyRequestOptions): string {
  try {
    const parsed = new URL(config.url);
    let username = parsed.username;

    // Add zone if not already present
    if (!username.includes('-zone-')) {
      const tier = options.tier || 'residential';
      const zoneMap: Record<string, string> = {
        residential: 'residential',
        mobile: 'mobile',
        datacenter: 'datacenter',
        isp: 'isp',
      };
      username += `-zone-${zoneMap[tier] || 'residential'}`;
    }

    // Add country targeting
    if (options.country) {
      username += `-country-${options.country.toLowerCase()}`;
    }

    // Add city targeting
    if (options.city) {
      username += `-city-${options.city.toLowerCase().replace(/\s+/g, '_')}`;
    }

    // Add ASN targeting
    if (options.asn) {
      username += `-asn-${options.asn}`;
    }

    // Add session for sticky IP
    const session = options.sessionId || `ss_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    username += `-session-${session}`;

    parsed.username = username;
    return parsed.toString();
  } catch {
    return config.url;
  }
}

/**
 * Build an Oxylabs proxy URL with geo-targeting and session support.
 * Format: http://user-country-XX-city-XXX-session-XXX:pass@pr.oxylabs.io:7777
 */
function buildOxylabsUrl(config: ResidentialProxyConfig, options: ProxyRequestOptions): string {
  try {
    const parsed = new URL(config.url);
    let username = parsed.username;

    if (options.country) {
      username += `-country-${options.country.toLowerCase()}`;
    }

    if (options.city) {
      username += `-city_${options.city.toLowerCase().replace(/\s+/g, '_')}`;
    }

    const session = options.sessionId || `sess_${Date.now()}`;
    username += `-sessid-${session}`;

    parsed.username = username;
    return parsed.toString();
  } catch {
    return config.url;
  }
}

/**
 * Build a SmartProxy proxy URL with geo-targeting.
 * Format: http://user-country-XX-city-XXX:pass@gate.smartproxy.com:7000
 */
function buildSmartProxyUrl(config: ResidentialProxyConfig, options: ProxyRequestOptions): string {
  try {
    const parsed = new URL(config.url);
    let username = parsed.username;

    if (options.country) {
      username += `-cc-${options.country.toLowerCase()}`;
    }

    if (options.city) {
      username += `-city-${options.city.toLowerCase().replace(/\s+/g, '')}`;
    }

    const session = options.sessionId || `sp_${Date.now()}`;
    username += `-session-${session}`;

    parsed.username = username;
    return parsed.toString();
  } catch {
    return config.url;
  }
}

/**
 * Build an IPRoyal proxy URL with geo-targeting and session.
 * Format: http://user_country-XX_city-XXX_session-XXX:pass@geo.iproyal.com:12321
 */
function buildIproyalUrl(config: ResidentialProxyConfig, options: ProxyRequestOptions): string {
  try {
    const parsed = new URL(config.url);
    let username = parsed.username;

    if (options.country) {
      username += `_country-${options.country.toLowerCase()}`;
    }

    if (options.city) {
      username += `_city-${options.city.toLowerCase().replace(/\s+/g, '_')}`;
    }

    const session = options.sessionId || `ipr_${Math.random().toString(36).substring(2, 10)}`;
    username += `_session-${session}`;

    parsed.username = username;
    return parsed.toString();
  } catch {
    return config.url;
  }
}

/**
 * Build a Webshare proxy URL.
 */
function buildWebshareUrl(config: ResidentialProxyConfig, options: ProxyRequestOptions): string {
  // Webshare uses country-specific endpoints
  try {
    const parsed = new URL(config.url);
    if (options.country) {
      // Webshare uses country prefix in the gateway hostname
      parsed.hostname = `${options.country.toLowerCase()}.${parsed.hostname}`;
    }
    return parsed.toString();
  } catch {
    return config.url;
  }
}

// --- ResidentialProxyManager --------------------------------------------------

export class ResidentialProxyManager {
  private providers = new Map<ProxyProvider, ResidentialProxyConfig>();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.loadProvidersFromEnv();
  }

  /**
   * Initialize providers from environment variables.
   */
  private loadProvidersFromEnv(): void {
    const providerConfigs: Array<{ envKey: string; provider: ProxyProvider; costPerGb: number }> = [
      { envKey: 'BRIGHTDATA_URL', provider: 'brightdata', costPerGb: 15 },
      { envKey: 'OXYLABS_URL', provider: 'oxylabs', costPerGb: 12 },
      { envKey: 'SMARTPROXY_URL', provider: 'smartproxy', costPerGb: 14 },
      { envKey: 'IPROYAL_URL', provider: 'iproyal', costPerGb: 5 },
      { envKey: 'WEBSHARE_URL', provider: 'webshare', costPerGb: 4 },
      { envKey: 'PROXY_URL', provider: 'generic', costPerGb: 2 },
    ];

    for (const { envKey, provider, costPerGb } of providerConfigs) {
      const url = process.env[envKey];
      if (url) {
        const config = this.parseProviderUrl(url, provider, costPerGb);
        this.providers.set(provider, config);
        logger.info({ provider, costPerGb }, 'Residential proxy provider configured');
      }
    }
  }

  /**
   * Parse a proxy URL into a provider config.
   */
  private parseProviderUrl(url: string, provider: ProxyProvider, costPerGb: number): ResidentialProxyConfig {
    try {
      const parsed = new URL(url);
      return {
        provider,
        url,
        username: parsed.username,
        password: parsed.password,
        gateway: parsed.hostname,
        port: parseInt(parsed.port, 10),
        enabled: true,
        priority: this.getDefaultPriority(provider),
        costPerGb,
        maxConcurrent: 50,
        currentConcurrent: 0,
        totalRequests: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        isHealthy: true,
      };
    } catch {
      return {
        provider,
        url,
        enabled: false,
        priority: 99,
        costPerGb,
        maxConcurrent: 0,
        currentConcurrent: 0,
        totalRequests: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        isHealthy: false,
      };
    }
  }

  private getDefaultPriority(provider: ProxyProvider): number {
    const priorities: Record<ProxyProvider, number> = {
      brightdata: 1,
      oxylabs: 2,
      smartproxy: 3,
      iproyal: 4,
      webshare: 5,
      generic: 10,
    };
    return priorities[provider];
  }

  /**
   * Get a residential proxy from the best available provider.
   * Builds the correct URL for the provider with geo-targeting and session support.
   * Optionally tests the connection before returning.
   */
  async getProxy(options: ProxyRequestOptions = {}): Promise<ProxyResult | null> {
    const availableProviders = Array.from(this.providers.values())
      .filter(p => p.enabled && p.isHealthy && p.currentConcurrent < p.maxConcurrent)
      .sort((a, b) => a.priority - b.priority);

    if (availableProviders.length === 0) {
      logger.warn('No residential proxy providers available');
      return null;
    }

    // Try providers in priority order
    for (const config of availableProviders) {
      try {
        const proxyUrl = this.buildProviderUrl(config, options);
        const sessionId = options.sessionId || `${config.provider}_${Date.now()}`;

        const result: ProxyResult = {
          proxyUrl,
          proxyId: `${config.provider}-${options.tier || 'residential'}-${options.country || 'any'}`,
          provider: config.provider,
          country: options.country || 'US',
          city: options.city,
          asn: options.asn,
          tier: options.tier || 'residential',
          sessionId,
          costPerGb: config.costPerGb,
        };

        // Increment concurrent counter
        config.currentConcurrent++;
        config.totalRequests++;

        // Test the proxy connection (with a short timeout)
        const testResult = await testProxy(proxyUrl, 'https://httpbin.org/ip', 10_000);
        if (testResult.working) {
          config.totalSuccesses++;
          config.isHealthy = true;

          // Cache the working proxy for a short time
          await cacheSet(
            `residential_proxy:${sessionId}`,
            { proxyUrl, provider: config.provider, testedAt: Date.now() },
            120, // 2 minutes
          );

          logger.info(
            { provider: config.provider, country: options.country, city: options.city, ip: testResult.ip, latencyMs: testResult.latencyMs },
            'Residential proxy acquired and tested',
          );

          return result;
        } else {
          config.totalFailures++;
          logger.warn(
            { provider: config.provider, error: testResult.error, latencyMs: testResult.latencyMs },
            'Residential proxy test failed -- trying next provider',
          );
        }
      } catch (err: any) {
        config.totalFailures++;
        config.lastError = err.message;
        config.lastErrorAt = Date.now();
        logger.warn(
          { provider: config.provider, error: err.message },
          'Residential proxy provider error -- trying next',
        );
      } finally {
        config.currentConcurrent = Math.max(0, config.currentConcurrent - 1);
      }
    }

    logger.error({ options }, 'All residential proxy providers failed');
    return null;
  }

  /**
   * Release a proxy back to the pool (decrement concurrent counter).
   */
  async releaseProxy(provider: ProxyProvider, success: boolean): Promise<void> {
    const config = this.providers.get(provider);
    if (!config) return;

    config.currentConcurrent = Math.max(0, config.currentConcurrent - 1);
    if (success) {
      config.totalSuccesses++;
    } else {
      config.totalFailures++;
      // If failure rate is too high, mark as unhealthy
      const totalRecent = config.totalSuccesses + config.totalFailures;
      if (totalRecent > 10 && config.totalFailures / totalRecent > 0.5) {
        config.isHealthy = false;
        logger.warn({ provider, failureRate: config.totalFailures / totalRecent }, 'Provider marked as unhealthy');
      }
    }
  }

  /**
   * Build the correct URL for a specific provider.
   */
  private buildProviderUrl(config: ResidentialProxyConfig, options: ProxyRequestOptions): string {
    switch (config.provider) {
      case 'brightdata':
        return buildBrightDataUrl(config, options);
      case 'oxylabs':
        return buildOxylabsUrl(config, options);
      case 'smartproxy':
        return buildSmartProxyUrl(config, options);
      case 'iproyal':
        return buildIproyalUrl(config, options);
      case 'webshare':
        return buildWebshareUrl(config, options);
      default:
        return config.url;
    }
  }

  /**
   * Run health checks on all providers.
   */
  async runHealthChecks(): Promise<void> {
    for (const [provider, config] of this.providers) {
      if (!config.enabled) continue;

      try {
        const proxyUrl = this.buildProviderUrl(config, {});
        const result = await testProxy(proxyUrl, 'https://httpbin.org/ip', 15_000);

        config.isHealthy = result.working;
        config.lastHealthCheck = Date.now();

        if (result.working) {
          logger.info({ provider, latencyMs: result.latencyMs, ip: result.ip }, 'Provider health check passed');
        } else {
          logger.warn({ provider, error: result.error }, 'Provider health check failed');
        }
      } catch (err: any) {
        config.isHealthy = false;
        config.lastHealthCheck = Date.now();
        logger.warn({ provider, error: err.message }, 'Provider health check error');
      }
    }
  }

  /**
   * Get stats for all providers.
   */
  getProviderStats(): Array<ResidentialProxyConfig & { successRate: number }> {
    return Array.from(this.providers.values()).map(config => ({
      ...config,
      successRate: config.totalRequests > 0
        ? config.totalSuccesses / config.totalRequests
        : 0,
    }));
  }

  /**
   * Start periodic health checks.
   */
  startHealthChecks(intervalMs: number = 300_000): void {
    if (this.healthCheckInterval) return;
    this.healthCheckInterval = setInterval(() => {
      this.runHealthChecks().catch(err => {
        logger.warn({ error: (err as Error).message }, 'Provider health check sweep failed');
      });
    }, intervalMs);
    logger.info({ intervalMs }, 'Provider health checks started');
  }

  /**
   * Stop periodic health checks.
   */
  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }
}

// --- Singleton ----------------------------------------------------------------

export const residentialProxyManager = new ResidentialProxyManager();
