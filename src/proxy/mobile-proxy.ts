/**
 * Mobile Proxy Integration (4G/5G) -- ScrapeSuite Engine
 *
 * The single biggest bypass improvement (+10-15% against DataDome/Akamai).
 * Mobile IPs carry ISP-level trust that residential proxies cannot replicate.
 * Akamai/DataDome cross-reference IP ranges with expected carriers, so
 * carrier-accurate geo-targeting is critical.
 */

import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('mobile-proxy');

// -- Types --------------------------------------------------------------------

export type MobileProviderName = 'soax' | 'proxy-cheap' | 'iproyal';
export type SignalType = '4G_LTE' | '5G_NR';

export interface CarrierInfo {
  name: string;
  country: string;
  countryCode: string;
  mcc: string;
  mnc: string;
  signalTypes: SignalType[];
  reputationScore: number; // 0-100, higher = more trusted
}

export interface MobileProxyConfig {
  provider: MobileProviderName;
  username: string;
  password: string;
  endpoint: string;
  port: number;
  costPerGb: number;
  maxConcurrent: number;
  preferredCarriers: string[];
  preferredSignal: SignalType;
  sessionMode: 'rotating' | 'sticky';
  stickyDurationMin: number;
}

export interface MobileSession {
  sessionId: string;
  provider: MobileProviderName;
  carrier: CarrierInfo;
  signalType: SignalType;
  proxyHost: string;
  proxyPort: number;
  proxyUrl: string;
  mode: 'rotating' | 'sticky';
  createdAt: number;
  expiresAt: number;
  lastIpRefresh: number;
  currentIp: string;
  requestCount: number;
  active: boolean;
  domain: string;
}

export interface MobileProxyResult {
  success: boolean;
  proxyUrl: string;
  proxyHost: string;
  proxyPort: number;
  sessionId: string;
  carrier: CarrierInfo;
  signalType: SignalType;
  mode: 'rotating' | 'sticky';
  estimatedCostPerRequest: number;
  ipQualityScore: number;
  escalationReason?: string;
  error?: string;
}

export interface EscalationRecord {
  domain: string;
  blockCount: number;
  lastBlockedAt: number;
  escalatedAt: number;
  requiresMobile: boolean;
  carrierHint?: string;
}

export interface MobileProxyStats {
  totalSessions: number;
  activeSessions: number;
  totalRequests: number;
  totalCostUsd: number;
  escalationCount: number;
  byProvider: Record<MobileProviderName, { sessions: number; requests: number; cost: number }>;
  byCarrier: Record<string, { sessions: number; requests: number }>;
}

// -- Carrier Database -- 30+ carriers across US, EU, Asia, Africa, LATAM ------

export const CARRIER_DATABASE: CarrierInfo[] = [
  // United States
  { name: 'AT&T',        country: 'United States',  countryCode: 'US', mcc: '310', mnc: '410', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 95 },
  { name: 'Verizon',     country: 'United States',  countryCode: 'US', mcc: '311', mnc: '480', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 96 },
  { name: 'T-Mobile',    country: 'United States',  countryCode: 'US', mcc: '310', mnc: '260', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 92 },
  // United Kingdom
  { name: 'Vodafone UK', country: 'United Kingdom', countryCode: 'GB', mcc: '234', mnc: '015', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 90 },
  { name: 'EE',          country: 'United Kingdom', countryCode: 'GB', mcc: '234', mnc: '030', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 91 },
  { name: 'Three UK',    country: 'United Kingdom', countryCode: 'GB', mcc: '234', mnc: '020', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 87 },
  // Germany
  { name: 'Telekom',     country: 'Germany', countryCode: 'DE', mcc: '262', mnc: '001', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 94 },
  { name: 'Vodafone DE', country: 'Germany', countryCode: 'DE', mcc: '262', mnc: '002', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 90 },
  { name: 'O2 DE',       country: 'Germany', countryCode: 'DE', mcc: '262', mnc: '007', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 88 },
  // France
  { name: 'Orange FR',   country: 'France',  countryCode: 'FR', mcc: '208', mnc: '001', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 93 },
  { name: 'SFR',         country: 'France',  countryCode: 'FR', mcc: '208', mnc: '010', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 86 },
  // Spain
  { name: 'Telefonica',  country: 'Spain',   countryCode: 'ES', mcc: '214', mnc: '007', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 91 },
  { name: 'Vodafone ES', country: 'Spain',   countryCode: 'ES', mcc: '214', mnc: '001', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 89 },
  // Italy
  { name: 'TIM',         country: 'Italy',   countryCode: 'IT', mcc: '222', mnc: '001', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 88 },
  { name: 'Vodafone IT', country: 'Italy',   countryCode: 'IT', mcc: '222', mnc: '010', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 89 },
  // Japan
  { name: 'NTT Docomo',  country: 'Japan',   countryCode: 'JP', mcc: '440', mnc: '010', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 97 },
  { name: 'SoftBank',    country: 'Japan',   countryCode: 'JP', mcc: '440', mnc: '020', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 93 },
  { name: 'KDDI',        country: 'Japan',   countryCode: 'JP', mcc: '440', mnc: '070', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 92 },
  // South Korea
  { name: 'SK Telecom',  country: 'South Korea', countryCode: 'KR', mcc: '450', mnc: '005', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 96 },
  { name: 'KT',          country: 'South Korea', countryCode: 'KR', mcc: '450', mnc: '008', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 94 },
  // India
  { name: 'Jio',         country: 'India',   countryCode: 'IN', mcc: '405', mnc: '840', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 82 },
  { name: 'Airtel',      country: 'India',   countryCode: 'IN', mcc: '404', mnc: '010', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 85 },
  { name: 'Vodafone Idea', country: 'India', countryCode: 'IN', mcc: '404', mnc: '010', signalTypes: ['4G_LTE'],           reputationScore: 78 },
  // Nigeria
  { name: 'MTN Nigeria', country: 'Nigeria',   countryCode: 'NG', mcc: '621', mnc: '030', signalTypes: ['4G_LTE'], reputationScore: 75 },
  { name: 'Airtel NG',   country: 'Nigeria',   countryCode: 'NG', mcc: '621', mnc: '020', signalTypes: ['4G_LTE'], reputationScore: 73 },
  // South Africa
  { name: 'Vodacom',     country: 'South Africa', countryCode: 'ZA', mcc: '655', mnc: '001', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 83 },
  { name: 'MTN SA',      country: 'South Africa', countryCode: 'ZA', mcc: '655', mnc: '010', signalTypes: ['4G_LTE'],           reputationScore: 79 },
  // Brazil
  { name: 'Claro BR',    country: 'Brazil',   countryCode: 'BR', mcc: '724', mnc: '005', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 80 },
  { name: 'Vivo',        country: 'Brazil',   countryCode: 'BR', mcc: '724', mnc: '011', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 82 },
  // Mexico
  { name: 'Telcel',      country: 'Mexico',   countryCode: 'MX', mcc: '334', mnc: '020', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 81 },
  // Australia
  { name: 'Telstra',     country: 'Australia', countryCode: 'AU', mcc: '505', mnc: '001', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 94 },
  { name: 'Optus',       country: 'Australia', countryCode: 'AU', mcc: '505', mnc: '002', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 89 },
  // Canada
  { name: 'Rogers',      country: 'Canada',   countryCode: 'CA', mcc: '302', mnc: '720', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 91 },
  { name: 'Bell',        country: 'Canada',   countryCode: 'CA', mcc: '302', mnc: '610', signalTypes: ['4G_LTE', '5G_NR'], reputationScore: 90 },
];

// -- Provider Defaults --------------------------------------------------------

export const MOBILE_PROVIDER_DEFAULTS: Record<MobileProviderName, Omit<MobileProxyConfig, 'username' | 'password' | 'preferredCarriers' | 'preferredSignal' | 'sessionMode' | 'stickyDurationMin'>> = {
  soax:         { provider: 'soax',         endpoint: 'gate.soax.com',           port: 10000, costPerGb: 8.5,  maxConcurrent: 50 },
  'proxy-cheap':{ provider: 'proxy-cheap',  endpoint: 'mobile.proxy-cheap.com',  port: 8800,  costPerGb: 5.0,  maxConcurrent: 100 },
  iproyal:      { provider: 'iproyal',      endpoint: 'geo.iproyal.com',         port: 12321, costPerGb: 6.75, maxConcurrent: 75 },
};

// -- Constants ----------------------------------------------------------------

const REDIS_KEY_PREFIX = 'scrapesuite:mobile-proxy:';
const ESCALATION_KEY = `${REDIS_KEY_PREFIX}escalations`;
const SESSION_KEY = `${REDIS_KEY_PREFIX}sessions`;
const BLOCK_HISTORY_KEY = `${REDIS_KEY_PREFIX}block-history`;
const DOMAIN_CARRIER_HINT_KEY = `${REDIS_KEY_PREFIX}carrier-hint:`;

const BLOCK_THRESHOLD_FOR_ESCALATION = 2;        // blocks on residential before escalation
const ESCALATION_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h before de-escalating a domain
const SESSION_RENEWAL_BUFFER_MS = 60 * 1000;      // renew 1 min before expiry
const IP_QUALITY_CACHE_TTL_SEC = 1800;            // 30 min

// -- MobileProxyEngine --------------------------------------------------------

export class MobileProxyEngine {
  private config: Map<MobileProviderName, MobileProxyConfig> = new Map();
  private activeSessions: Map<string, MobileSession> = new Map();
  private sessionRenewalTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private initialized = false;

  private stats = {
    totalSessions: 0,
    totalRequests: 0,
    totalCostUsd: 0,
    escalationCount: 0,
    byProvider: {
      soax: { sessions: 0, requests: 0, cost: 0 },
      'proxy-cheap': { sessions: 0, requests: 0, cost: 0 },
      iproyal: { sessions: 0, requests: 0, cost: 0 },
    } as Record<MobileProviderName, { sessions: number; requests: number; cost: number }>,
    byCarrier: {} as Record<string, { sessions: number; requests: number }>,
  };

  // -- Initialization ------------------------------------------------------

  async initialize(configs: MobileProxyConfig[]): Promise<void> {
    if (this.initialized) {
      logger.warn('MobileProxyEngine already initialized -- skipping');
      return;
    }
    for (const cfg of configs) {
      this.config.set(cfg.provider, cfg);
      logger.info({ provider: cfg.provider, endpoint: cfg.endpoint }, 'Registered mobile proxy provider');
    }
    await this.restoreSessions();
    this.initialized = true;
    logger.info({ providerCount: this.config.size }, 'MobileProxyEngine initialized');
  }

  // -- Core: Get Mobile Proxy ---------------------------------------------

  async getMobileProxy(params: {
    domain: string;
    countryCode?: string;
    carrierName?: string;
    signalType?: SignalType;
    mode?: 'rotating' | 'sticky';
    providerHint?: MobileProviderName;
  }): Promise<MobileProxyResult> {
    if (!this.initialized) {
      return this.failResult('4G_LTE', 'rotating', 'Engine not initialized');
    }

    const mode = params.mode ?? 'rotating';
    const signalType = params.signalType ?? '4G_LTE';

    const carrier = this.selectCarrier(params.countryCode, params.carrierName, signalType);
    if (!carrier) {
      return this.failResult(signalType, mode,
        `No carrier found for country=${params.countryCode} carrier=${params.carrierName}`);
    }

    const provider = this.selectProvider(params.providerHint);
    if (!provider) {
      return this.failResult(signalType, mode, 'No available mobile proxy provider', carrier);
    }

    // Check concurrency -- fall back to another provider if at capacity
    if (this.countProviderSessions(provider.provider) >= provider.maxConcurrent) {
      const fallback = this.selectProvider(undefined, [provider.provider]);
      if (!fallback || this.countProviderSessions(fallback.provider) >= fallback.maxConcurrent) {
        return this.failResult(signalType, mode, 'All providers at max concurrency', carrier);
      }
      return this.createSession(fallback, carrier, signalType, mode, params.domain);
    }

    return this.createSession(provider, carrier, signalType, mode, params.domain);
  }

  // -- Escalation: Residential → Mobile -----------------------------------

  async escalateToMobile(
    domain: string,
    residentialResult: { proxyUrl: string; proxyHost: string; proxyPort: number; success: boolean },
  ): Promise<MobileProxyResult | null> {
    const escalation = await this.getEscalationRecord(domain);
    if (!escalation || !escalation.requiresMobile) return null;

    logger.info({ domain, blockCount: escalation.blockCount }, 'Escalating domain to mobile proxy');

    const carrierHint = await this.getCarrierHint(domain);
    const countryCode = carrierHint ? this.inferCountryFromCarrier(carrierHint) : undefined;

    const result = await this.getMobileProxy({
      domain,
      countryCode,
      carrierName: carrierHint ?? undefined,
      mode: 'sticky', // sticky for escalated domains -- multi-page flows
    });

    if (result.success) {
      result.escalationReason = `Domain ${domain} blocked ${escalation.blockCount}x on residential`;
      this.stats.escalationCount++;
      await cacheSet(`${REDIS_KEY_PREFIX}escalation-used:${domain}`, Date.now().toString(), 3600);
    }

    return result;
  }

  // -- Record Block -- triggers escalation tracking -------------------------

  async recordBlock(domain: string, proxyType: 'residential' | 'datacenter', countryCode?: string): Promise<void> {
    if (proxyType !== 'residential') return;

    const key = `${BLOCK_HISTORY_KEY}:${domain}`;
    const raw = await cacheGet(key) as string | null;
    const blockCount = raw ? parseInt(raw, 10) + 1 : 1;
    await cacheSet(key, blockCount.toString(), 86400);

    logger.warn({ domain, blockCount, proxyType }, 'Block recorded -- checking escalation threshold');

    if (blockCount >= BLOCK_THRESHOLD_FOR_ESCALATION) {
      await this.flagDomainForMobile(domain, countryCode);
    }
  }

  // -- Session Management -------------------------------------------------

  async releaseSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'Attempted to release unknown session');
      return;
    }

    session.active = false;
    this.activeSessions.delete(sessionId);

    const timer = this.sessionRenewalTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.sessionRenewalTimers.delete(sessionId);
    }

    try {
      await redis.del(`${SESSION_KEY}:${sessionId}`);
    } catch (err) {
      logger.error({ sessionId, err }, 'Failed to delete session from Redis');
    }

    logger.info({ sessionId, domain: session.domain, requests: session.requestCount }, 'Session released');
  }

  getSessionStatus(sessionId: string): MobileSession | null {
    const session = this.activeSessions.get(sessionId);
    if (!session) return null;

    const remaining = Math.max(0, session.expiresAt - Date.now());
    const isExpiring = remaining < SESSION_RENEWAL_BUFFER_MS;

    return { ...session, active: session.active && !isExpiring };
  }

  // -- Stats --------------------------------------------------------------

  getStats(): MobileProxyStats {
    return {
      totalSessions: this.stats.totalSessions,
      activeSessions: this.activeSessions.size,
      totalRequests: this.stats.totalRequests,
      totalCostUsd: Math.round(this.stats.totalCostUsd * 100) / 100,
      escalationCount: this.stats.escalationCount,
      byProvider: { ...this.stats.byProvider },
      byCarrier: { ...this.stats.byCarrier },
    };
  }

  // -- Internal: Carrier Selection -----------------------------------------

  private selectCarrier(countryCode?: string, carrierName?: string, signalType?: SignalType): CarrierInfo | null {
    let candidates = CARRIER_DATABASE;

    if (countryCode) {
      candidates = candidates.filter(c => c.countryCode === countryCode.toUpperCase());
    }
    if (carrierName) {
      const exact = candidates.find(c => c.name.toLowerCase() === carrierName.toLowerCase());
      if (exact) return exact;
    }
    if (signalType) {
      const withSignal = candidates.filter(c => c.signalTypes.includes(signalType));
      if (withSignal.length > 0) candidates = withSignal;
    }

    if (candidates.length === 0) {
      logger.warn({ countryCode, carrierName, signalType }, 'No carrier match -- falling back to global best');
      return this.selectBestReputation(CARRIER_DATABASE, signalType);
    }

    return this.selectBestReputation(candidates, signalType);
  }

  private selectBestReputation(candidates: CarrierInfo[], signalType?: SignalType): CarrierInfo {
    const sorted = [...candidates].sort((a, b) => {
      const aHasSignal = signalType ? (a.signalTypes.includes(signalType) ? 1 : 0) : 0;
      const bHasSignal = signalType ? (b.signalTypes.includes(signalType) ? 1 : 0) : 0;
      if (bHasSignal !== aHasSignal) return bHasSignal - aHasSignal;
      return b.reputationScore - a.reputationScore;
    });
    return sorted[0];
  }

  // -- Internal: Provider Selection ----------------------------------------

  private selectProvider(hint?: MobileProviderName, exclude: MobileProviderName[] = []): MobileProxyConfig | null {
    if (hint && !exclude.includes(hint)) {
      const cfg = this.config.get(hint);
      if (cfg) return cfg;
    }
    // Pick cheapest available that isn't excluded
    const candidates = Array.from(this.config.values())
      .filter(c => !exclude.includes(c.provider))
      .sort((a, b) => a.costPerGb - b.costPerGb);
    return candidates[0] ?? null;
  }

  // -- Internal: Session Creation ------------------------------------------

  private async createSession(
    provider: MobileProxyConfig,
    carrier: CarrierInfo,
    signalType: SignalType,
    mode: 'rotating' | 'sticky',
    domain: string,
  ): Promise<MobileProxyResult> {
    const sessionId = this.generateSessionId(provider.provider, carrier);
    const now = Date.now();
    const stickyDurationMs = provider.stickyDurationMin * 60 * 1000;
    const expiresAt = mode === 'sticky' ? now + stickyDurationMs : now + (10 * 60 * 1000);

    const proxyUrl = this.buildProxyUrl(provider, carrier, sessionId, mode, signalType);
    const proxyHost = provider.endpoint;
    const proxyPort = provider.port;

    const session: MobileSession = {
      sessionId, provider: provider.provider, carrier, signalType,
      proxyHost, proxyPort, proxyUrl, mode,
      createdAt: now, expiresAt, lastIpRefresh: now,
      currentIp: 'pending', requestCount: 0, active: true, domain,
    };

    this.activeSessions.set(sessionId, session);

    try {
      await cacheSet(`${SESSION_KEY}:${sessionId}`, JSON.stringify(session), Math.ceil((expiresAt - now) / 1000));
    } catch (err) {
      logger.error({ sessionId, err }, 'Failed to persist session to Redis');
    }

    if (mode === 'sticky') this.scheduleRenewal(sessionId, expiresAt);

    // Update stats
    this.stats.totalSessions++;
    this.stats.byProvider[provider.provider].sessions++;
    if (!this.stats.byCarrier[carrier.name]) {
      this.stats.byCarrier[carrier.name] = { sessions: 0, requests: 0 };
    }
    this.stats.byCarrier[carrier.name].sessions++;

    const ipQuality = this.computeIpQualityScore(carrier, signalType);
    const estimatedCostPerRequest = this.estimateCostPerRequest(provider.costPerGb);

    logger.info(
      { sessionId, provider: provider.provider, carrier: carrier.name, signalType, mode, domain, ipQuality },
      'Mobile proxy session created',
    );

    return {
      success: true, proxyUrl, proxyHost, proxyPort, sessionId,
      carrier, signalType, mode, estimatedCostPerRequest, ipQualityScore: ipQuality,
    };
  }

  // -- Internal: Proxy URL Builder ----------------------------------------

  private buildProxyUrl(
    provider: MobileProxyConfig, carrier: CarrierInfo, sessionId: string,
    mode: 'rotating' | 'sticky', signalType: SignalType,
  ): string {
    const { username, password, endpoint, port } = provider;
    const sessionParam = mode === 'sticky' ? `-session-${sessionId}` : '';
    const carrierParam = `-country-${carrier.countryCode.toLowerCase()}-carrier-${carrier.mnc}`;
    const signalParam = signalType === '5G_NR' ? '-5g' : '';

    switch (provider.provider) {
      case 'soax':
        return `http://${username}${carrierParam}${sessionParam}${signalParam}:${password}@${endpoint}:${port}`;
      case 'proxy-cheap':
        return `http://${username}${sessionParam}${carrierParam}:${password}@${endpoint}:${port}`;
      case 'iproyal':
        return `http://${username}:${password}@${endpoint}:${port}?country=${carrier.countryCode.toLowerCase()}&carrier=${carrier.mnc}&session=${sessionId}&signal=${signalType}`;
      default:
        return `http://${username}:${password}@${endpoint}:${port}`;
    }
  }

  // -- Internal: Session Renewal ------------------------------------------

  private scheduleRenewal(sessionId: string, expiresAt: number): void {
    const renewAt = expiresAt - SESSION_RENEWAL_BUFFER_MS;
    const delay = Math.max(renewAt - Date.now(), 5000);

    const timer = setTimeout(async () => { await this.renewSession(sessionId); }, delay);
    this.sessionRenewalTimers.set(sessionId, timer);
  }

  private async renewSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.active) return;

    logger.info({ sessionId, domain: session.domain }, 'Auto-renewing sticky session');

    // Release old and recreate with same parameters
    await this.releaseSession(sessionId);

    const provider = this.config.get(session.provider);
    if (!provider) {
      logger.error({ provider: session.provider }, 'Provider config gone -- cannot renew');
      return;
    }
    await this.createSession(provider, session.carrier, session.signalType, session.mode, session.domain);
  }

  // -- Internal: Escalation Tracking --------------------------------------

  private async flagDomainForMobile(domain: string, countryCode?: string): Promise<void> {
    const existing = await this.getEscalationRecord(domain);
    if (existing?.requiresMobile) return; // already flagged

    const record: EscalationRecord = {
      domain,
      blockCount: existing?.blockCount ?? BLOCK_THRESHOLD_FOR_ESCALATION,
      lastBlockedAt: Date.now(),
      escalatedAt: Date.now(),
      requiresMobile: true,
      carrierHint: countryCode ? this.suggestCarrierForCountry(countryCode) : undefined,
    };

    try {
      await redis.hset(ESCALATION_KEY, domain, JSON.stringify(record));
    } catch (err) {
      logger.error({ domain, err }, 'Failed to flag domain for mobile escalation');
    }

    logger.info({ domain, record }, 'Domain flagged for mobile proxy escalation');
  }

  private async getEscalationRecord(domain: string): Promise<EscalationRecord | null> {
    try {
      const raw = await redis.hget(ESCALATION_KEY, domain) as string | null;
      if (!raw) return null;
      return JSON.parse(raw) as EscalationRecord;
    } catch { return null; }
  }

  private async getCarrierHint(domain: string): Promise<string | null> {
    try {
      const raw = await cacheGet(`${DOMAIN_CARRIER_HINT_KEY}${domain}`) as string | null;
      return raw ?? null;
    } catch { return null; }
  }

  private suggestCarrierForCountry(countryCode: string): string {
    const carriers = CARRIER_DATABASE.filter(c => c.countryCode === countryCode.toUpperCase());
    if (carriers.length === 0) return '';
    return carriers.sort((a, b) => b.reputationScore - a.reputationScore)[0].name;
  }

  private inferCountryFromCarrier(carrierName: string): string | undefined {
    return CARRIER_DATABASE.find(c => c.name === carrierName)?.countryCode;
  }

  // -- Internal: IP Quality Scoring ---------------------------------------

  private computeIpQualityScore(carrier: CarrierInfo, signalType: SignalType): number {
    let score = carrier.reputationScore;

    // 5G signals get a small bump -- they look more "modern device"
    if (signalType === '5G_NR') score = Math.min(100, score + 3);
    // Penalise low-reputation carriers
    if (carrier.reputationScore < 80) score -= 5;

    // Cache for quick lookups
    const cacheKey = `${REDIS_KEY_PREFIX}ip-quality:${carrier.mcc}:${carrier.mnc}:${signalType}`;
    cacheSet(cacheKey, score.toString(), IP_QUALITY_CACHE_TTL_SEC).catch(() => { /* non-critical */ });

    return Math.max(0, Math.min(100, score));
  }

  // -- Internal: Cost Estimation ------------------------------------------

  private estimateCostPerRequest(costPerGb: number): number {
    // Average request ≈ 50KB → ~20 000 requests per GB
    const requestsPerGb = (1024 * 1024) / 50;
    return Math.round((costPerGb / requestsPerGb) * 100000) / 100000;
  }

  // -- Internal: Session Helpers ------------------------------------------

  private countProviderSessions(provider: MobileProviderName): number {
    let count = 0;
    for (const s of this.activeSessions.values()) {
      if (s.provider === provider && s.active) count++;
    }
    return count;
  }

  private generateSessionId(provider: MobileProviderName, carrier: CarrierInfo): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `mob-${provider}-${carrier.countryCode.toLowerCase()}-${ts}-${rand}`;
  }

  private failResult(
    signalType: SignalType, mode: 'rotating' | 'sticky', error: string, carrier?: CarrierInfo,
  ): MobileProxyResult {
    return {
      success: false, proxyUrl: '', proxyHost: '', proxyPort: 0, sessionId: '',
      carrier: carrier ?? CARRIER_DATABASE[0], signalType, mode,
      estimatedCostPerRequest: 0, ipQualityScore: 0, error,
    };
  }

  private async restoreSessions(): Promise<void> {
    try {
      const keys = await redis.keys(`${SESSION_KEY}:*`);
      for (const key of keys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const session: MobileSession = JSON.parse(raw);
        if (session.expiresAt > Date.now() && session.active) {
          this.activeSessions.set(session.sessionId, session);
          if (session.mode === 'sticky') this.scheduleRenewal(session.sessionId, session.expiresAt);
        } else {
          await redis.del(key); // clean expired
        }
      }
      if (this.activeSessions.size > 0) {
        logger.info({ restoredCount: this.activeSessions.size }, 'Restored mobile proxy sessions from Redis');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to restore sessions from Redis');
    }
  }
}

// -- Singleton ----------------------------------------------------------------

export const mobileProxyEngine = new MobileProxyEngine();
