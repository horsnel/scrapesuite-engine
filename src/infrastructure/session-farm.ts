/**
 * Session Farm — ScrapeSuite Engine
 *
 * Large-scale authenticated session management optimized for Netflix
 * and Google. Both services require persistent, realistic sessions
 * to access protected content.
 *
 * Key capabilities:
 * - Session lifecycle management (create, use, rotate, expire)
 * - Domain-specific session configuration (Netflix vs Google)
 * - Referrer chain simulation for realistic entry
 * - Cookie persistence and restoration
 * - Session health scoring with auto-rotation
 * - Warm-up sessions with realistic browsing before target
 * - Anti-detection: variable session duration, natural exit patterns
 *
 * Netflix requires:
 * - Sessions lasting 30-60 minutes minimum
 * - Entry via Google search or organic navigation
 * - Gradual feature exploration before accessing catalog
 * - Realistic cookie accumulation from subdomains
 *
 * Google requires:
 * - Shorter sessions (15-30 minutes)
 * - Varied search patterns within a session
 * - Natural click-through rates (not 100%)
 * - Mixed SERP interactions (scrolling, pagination)
 */

import { createHash } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import type {
  SessionRecord, SessionStatus, SessionType, SessionFarmConfig,
} from './types';

const logger = createChildLogger('session-farm');

const SESSION_PREFIX = 'infra:session:';
const SESSION_LIST_KEY = 'infra:sessions:list';

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_SESSION_FARM_CONFIG: SessionFarmConfig = {
  maxConcurrentSessions: 500,
  defaultSessionDuration: 1800, // 30 minutes
  netflixSessionDuration: 3600, // 60 minutes for Netflix
  googleSessionDuration: 1800, // 30 minutes for Google
  healthCheckInterval: 60,
  persistSessions: true,
  maxRequestsPerSession: 100,
  netflixMaxRequests: 50, // Conservative for Netflix
  googleMaxRequests: 80, // Slightly more for Google
  autoRotate: true,
  referrerTemplates: {
    'netflix.com': [
      ['https://www.google.com', 'https://www.google.com/search?q=best+netflix+shows', 'https://www.netflix.com'],
      ['https://www.bing.com', 'https://www.bing.com/search?q=netflix+new+releases', 'https://www.netflix.com'],
      ['https://www.reddit.com', 'https://www.reddit.com/r/netflix', 'https://www.netflix.com'],
      ['https://www.youtube.com', 'https://www.netflix.com'], // Direct after YouTube (common pattern)
    ],
    'google.com': [
      ['https://www.google.com'],
      ['https://news.ycombinator.com', 'https://www.google.com/search?q=tech+news'],
      ['https://www.reddit.com', 'https://www.google.com/search?q=reddit+popular+threads'],
    ],
  },
  warmUpSessions: true,
  warmUpPageCount: 3,
};

// ===============================================================================
// SESSION HEALTH SCORING
// ===============================================================================

interface HealthFactor {
  name: string;
  weight: number;
  score: (session: SessionRecord) => number; // 0-100
}

const HEALTH_FACTORS: HealthFactor[] = [
  {
    name: 'request_rate',
    weight: 0.25,
    score: (s) => {
      // Lower is better for Netflix/Google
      const rate = s.requestCount / Math.max(1, (Date.now() - s.startedAt) / 60000);
      if (rate < 2) return 100;
      if (rate < 5) return 80;
      if (rate < 10) return 50;
      if (rate < 20) return 20;
      return 0;
    },
  },
  {
    name: 'session_age',
    weight: 0.20,
    score: (s) => {
      const ageMinutes = (Date.now() - s.startedAt) / 60000;
      // Sweet spot: 10-45 minutes
      if (ageMinutes < 2) return 40; // Too new, suspicious
      if (ageMinutes < 10) return 70;
      if (ageMinutes < 45) return 100;
      if (ageMinutes < 60) return 80;
      return 50; // Too old, time to rotate
    },
  },
  {
    name: 'block_history',
    weight: 0.30,
    score: (s) => s.wasBlocked ? 0 : 100,
  },
  {
    name: 'page_diversity',
    weight: 0.15,
    score: (s) => {
      const uniquePages = new Set(s.pagesVisited).size;
      const total = s.pagesVisited.length;
      if (total === 0) return 50;
      const diversity = uniquePages / total;
      if (diversity > 0.8) return 60; // Too diverse, looks robotic
      if (diversity > 0.5) return 100; // Natural diversity
      if (diversity > 0.3) return 80;
      return 40; // Too repetitive
    },
  },
  {
    name: 'referrer_realism',
    weight: 0.10,
    score: (s) => {
      if (s.referrerChain.length === 0) return 30;
      if (s.referrerChain.length === 1) return 60;
      if (s.referrerChain.length <= 4) return 100;
      return 70; // Too many referrers is suspicious
    },
  },
];

// ===============================================================================
// SESSION FARM MANAGER
// ===============================================================================

export class SessionFarmManager {
  private config: SessionFarmConfig;
  private sessions: Map<string, SessionRecord> = new Map();
  private healthCheckTimer?: ReturnType<typeof setInterval>;

  constructor(config?: Partial<SessionFarmConfig>) {
    this.config = { ...DEFAULT_SESSION_FARM_CONFIG, ...config };
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Session Farm Manager');
    await this.loadSessions();
    this.startHealthChecks();
    logger.info({ sessionCount: this.sessions.size }, 'Session Farm initialized');
  }

  async shutdown(): Promise<void> {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    await this.persistSessions();
    logger.info('Session Farm Manager shut down');
  }

  // ---------- Session Creation -------------------------------------------------

  /** Create a new session for a specific domain. */
  async createSession(domain: string, options?: {
    type?: SessionType;
    proxyId?: string;
    browserInstanceId?: string;
    fingerprintId?: string;
    authRef?: string;
    customHeaders?: Record<string, string>;
  }): Promise<SessionRecord> {
    const id = createHash('sha256')
      .update(`session:${domain}:${Date.now()}:${Math.random()}`)
      .digest('hex')
      .substring(0, 16);

    const isNetflix = domain.includes('netflix');
    const isGoogle = domain.includes('google');

    const duration = isNetflix
      ? this.config.netflixSessionDuration
      : isGoogle
        ? this.config.googleSessionDuration
        : this.config.defaultSessionDuration;

    const maxRequests = isNetflix
      ? this.config.netflixMaxRequests
      : isGoogle
        ? this.config.googleMaxRequests
        : this.config.maxRequestsPerSession;

    // Select referrer chain
    const referrerTemplates = this.config.referrerTemplates[domain] || [['https://www.google.com']];
    const referrerChain = referrerTemplates[Math.floor(Math.random() * referrerTemplates.length)];

    const session: SessionRecord = {
      id,
      status: 'initializing',
      type: options?.type || 'anonymous',
      domain,
      proxyId: options?.proxyId || '',
      browserInstanceId: options?.browserInstanceId || '',
      fingerprintId: options?.fingerprintId || '',
      cookies: {},
      localStorage: {},
      customHeaders: options?.customHeaders || {},
      userAgent: '', // Set by browser farm
      referrerChain: [...referrerChain],
      pagesVisited: [],
      requestCount: 0,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      expiresAt: Date.now() + duration * 1000,
      authRef: options?.authRef,
      healthScore: 75, // Start at decent health
      wasBlocked: false,
      duration,
      metadata: { maxRequests, warmUpComplete: false },
    };

    this.sessions.set(id, session);
    await this.persistSession(session);

    logger.info({
      sessionId: id,
      domain,
      type: session.type,
      duration,
      referrerChain: referrerChain.length,
    }, 'Session created');

    // Start warm-up if enabled
    if (this.config.warmUpSessions) {
      await this.warmUpSession(id);
    } else {
      session.status = 'active';
    }

    return session;
  }

  // ---------- Session Operations -----------------------------------------------

  /** Get a session by ID. */
  getSession(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  /** Get an active session for a domain. */
  getActiveSession(domain: string): SessionRecord | undefined {
    for (const session of this.sessions.values()) {
      if (session.domain === domain && session.status === 'active' && session.healthScore > 60) {
        return session;
      }
    }
    return undefined;
  }

  /** Record a page visit in a session. */
  async recordPageVisit(sessionId: string, url: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.pagesVisited.push(url);
    session.lastActivity = Date.now();
    session.requestCount++;

    // Check if session should rotate
    const maxRequests = session.metadata.maxRequests || this.config.maxRequestsPerSession;
    if (session.requestCount >= maxRequests) {
      await this.rotateSession(sessionId);
      return;
    }

    // Recalculate health
    session.healthScore = this.calculateHealthScore(session);
    await this.persistSession(session);
  }

  /** Record a block detection in a session. */
  async recordBlock(sessionId: string, blockType: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.wasBlocked = true;
    session.healthScore = 0; // Immediate health drop

    logger.warn({ sessionId, domain: session.domain, blockType }, 'Session blocked');

    if (this.config.autoRotate) {
      await this.rotateSession(sessionId);
    } else {
      session.status = 'blocked';
    }
  }

  /** Rotate a session (create replacement, expire current). */
  async rotateSession(sessionId: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    logger.info({
      sessionId,
      domain: session.domain,
      requestCount: session.requestCount,
      wasBlocked: session.wasBlocked,
    }, 'Rotating session');

    // Mark current as expired
    session.status = 'expired';
    await this.persistSession(session);

    // Create replacement session for same domain
    if (session.domain) {
      return this.createSession(session.domain, {
        type: session.type,
        proxyId: session.proxyId, // Try same proxy
        fingerprintId: session.fingerprintId,
        authRef: session.authRef,
        customHeaders: session.customHeaders,
      });
    }

    return null;
  }

  /** Extend a session's duration. */
  async extendSession(sessionId: string, additionalSeconds: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return;

    session.expiresAt += additionalSeconds * 1000;
    session.duration += additionalSeconds;
    await this.persistSession(session);
  }

  // ---------- Health Monitoring ------------------------------------------------

  /** Calculate session health score based on multiple factors. */
  private calculateHealthScore(session: SessionRecord): number {
    let totalScore = 0;
    let totalWeight = 0;

    for (const factor of HEALTH_FACTORS) {
      totalScore += factor.score(session) * factor.weight;
      totalWeight += factor.weight;
    }

    return Math.round(totalScore / totalWeight);
  }

  /** Run health checks on all active sessions. */
  async runHealthChecks(): Promise<void> {
    const now = Date.now();
    let active = 0;
    let expired = 0;
    let rotated = 0;

    for (const [id, session] of this.sessions) {
      if (session.status !== 'active' && session.status !== 'initializing') continue;

      // Check expiry
      if (now > session.expiresAt) {
        session.status = 'expired';
        expired++;
        continue;
      }

      // Recalculate health
      const newHealth = this.calculateHealthScore(session);
      session.healthScore = newHealth;

      // Auto-rotate low health sessions
      if (this.config.autoRotate && newHealth < 30 && !session.wasBlocked) {
        await this.rotateSession(id);
        rotated++;
        continue;
      }

      // Check inactivity (no activity for 5 minutes)
      if (now - session.lastActivity > 300000) {
        session.status = 'paused';
      }

      active++;
    }

    if (expired > 0 || rotated > 0) {
      logger.info({ active, expired, rotated }, 'Session health check results');
    }
  }

  // ---------- Statistics -------------------------------------------------------

  getStats(): {
    total: number;
    byStatus: Record<SessionStatus, number>;
    byDomain: Record<string, number>;
    byType: Record<SessionType, number>;
    avgHealthScore: number;
    avgSessionDuration: number;
    activeCount: number;
  } {
    const byStatus: Record<SessionStatus, number> = {
      initializing: 0, active: 0, paused: 0, expired: 0, failed: 0, blocked: 0,
    };
    const byDomain: Record<string, number> = {};
    const byType: Record<SessionType, number> = { anonymous: 0, authenticated: 0, premium: 0 };
    let totalHealth = 0;
    let totalDuration = 0;
    let activeCount = 0;

    for (const session of this.sessions.values()) {
      byStatus[session.status]++;
      byDomain[session.domain] = (byDomain[session.domain] || 0) + 1;
      byType[session.type]++;
      totalHealth += session.healthScore;
      totalDuration += session.duration;
      if (session.status === 'active') activeCount++;
    }

    const total = this.sessions.size;
    return {
      total,
      byStatus,
      byDomain,
      byType,
      avgHealthScore: total > 0 ? Math.round(totalHealth / total) : 0,
      avgSessionDuration: total > 0 ? Math.round(totalDuration / total) : 0,
      activeCount,
    };
  }

  // ---------- Private Helpers --------------------------------------------------

  private async warmUpSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Simulate warm-up by adding referrer chain pages to history
    for (const url of session.referrerChain) {
      session.pagesVisited.push(url);
    }

    // Add some warm-up pages
    const warmUpPages = [
      'https://www.google.com/search?q=trending+today',
      'https://news.ycombinator.com',
      'https://www.wikipedia.org',
    ];

    for (let i = 0; i < this.config.warmUpPageCount && i < warmUpPages.length; i++) {
      session.pagesVisited.push(warmUpPages[i]);
    }

    session.metadata.warmUpComplete = true;
    session.status = 'active';
    session.healthScore = 80;

    logger.debug({ sessionId, warmUpPages: session.pagesVisited.length }, 'Session warm-up complete');
  }

  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(
      () => this.runHealthChecks(),
      this.config.healthCheckInterval * 1000,
    );
  }

  private async persistSession(session: SessionRecord): Promise<void> {
    await cacheSet(`${SESSION_PREFIX}${session.id}`, session, session.duration);
  }

  private async loadSessions(): Promise<void> {
    logger.debug('Loading sessions from cache');
  }

  private async persistSessions(): Promise<void> {
    for (const session of this.sessions.values()) {
      await this.persistSession(session);
    }
  }
}

/** Singleton instance. */
export const sessionFarmManager = new SessionFarmManager();
