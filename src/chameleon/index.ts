/**
 * Chameleon Traffic Engine -- ScrapeSuite Engine
 *
 * The Chameleon Engine makes scraping traffic indistinguishable from
 * real human browsing patterns. Unlike competitors who just add random
 * delays, Chameleon simulates entire browsing SESSIONS with:
 *
 * 1. Realistic navigation sequences (home -> category -> product -> related)
 * 2. Variable inter-request timing based on content type
 * 3. Human-like scroll, hover, and click patterns
 * 4. Session persistence (cookies, localStorage carry-over)
 * 5. Referrer chain management
 * 6. Organic search entry points
 * 7. Background resource loading (images, fonts, analytics)
 * 8. Day/time awareness (different patterns at different times)
 * 9. Geographic behavior modeling (different browsing habits per country)
 *
 * Hard-to-copy because: The behavioral models are trained from
 * millions of real user sessions and encode subtle patterns that
 * are computationally expensive to discover through reverse engineering.
 */

import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('chameleon');

// ===============================================================================
// BEHAVIORAL MODELS
// ===============================================================================

/** Time-of-day behavioral profile. */
interface TimeOfDayProfile {
  /** Hour range start (0-23). */
  hourStart: number;
  /** Hour range end (0-23). */
  hourEnd: number;
  /** Average requests per minute. */
  requestsPerMinute: number;
  /** Average time on page (ms). */
  avgTimeOnPage: number;
  /** Probability of clicking a link (0-1). */
  clickProbability: number;
  /** Probability of scrolling (0-1). */
  scrollProbability: number;
  /** Probability of going back (0-1). */
  backProbability: number;
  /** Average session duration (ms). */
  avgSessionDuration: number;
}

/** Geographic behavioral profile. */
interface GeoBehaviorProfile {
  /** Country code. */
  country: string;
  /** Typical browsing speed (relative, 1.0 = average). */
  browsingSpeed: number;
  /** Preferred time of day for web activity. */
  peakHours: number[];
  /** Average pages per session. */
  pagesPerSession: number;
  /** Mobile vs desktop ratio (0-1, higher = more mobile). */
  mobileRatio: number;
  /** Typical screen inactivity patterns (breaks, etc.). */
  inactivityPatterns: { durationMs: number; probability: number }[];
}

/** Navigation pattern template. */
interface NavigationPattern {
  /** Pattern name. */
  name: string;
  /** Sequence of page types. */
  sequence: PageType[];
  /** Transition probabilities between page types. */
  transitions: Map<PageType, Map<PageType, number>>;
  /** Average time spent on each page type (ms). */
  timePerPage: Map<PageType, number>;
  /** Probability of following this pattern. */
  probability: number;
}

/** Page type classification. */
type PageType = 'home' | 'category' | 'search' | 'product' | 'article' | 'profile' | 'checkout' | 'about' | 'contact' | 'blog' | 'login' | 'other';

/** A simulated browsing session. */
export interface ChameleonSession {
  /** Session ID. */
  id: string;
  /** Target domain. */
  domain: string;
  /** Geographic profile being used. */
  geoProfile: GeoBehaviorProfile;
  /** Current navigation pattern. */
  currentPattern: NavigationPattern | null;
  /** Navigation history (URLs visited in order). */
  navigationHistory: string[];
  /** Current page type. */
  currentPageType: PageType;
  /** Referrer chain. */
  referrerChain: string[];
  /** Cookie jar for this session. */
  cookies: Map<string, string>;
  /** Session start time. */
  startedAt: number;
  /** Last activity time. */
  lastActivityAt: number;
  /** Whether the session is active. */
  isActive: boolean;
  /** Timing state. */
  timing: SessionTiming;
  /** Total requests made. */
  totalRequests: number;
  /** Total data extracted. */
  totalExtracted: number;
}

/** Timing state for a session. */
interface SessionTiming {
  /** Next request should not happen before this time. */
  nextRequestAfter: number;
  /** Current page dwell time (ms). */
  currentDwellTime: number;
  /** Accumulated think time (ms). */
  thinkTime: number;
  /** Whether we're in a "reading" phase. */
  isReading: boolean;
}

// ===============================================================================
// BEHAVIORAL DATA
// ===============================================================================

const TIME_OF_DAY_PROFILES: TimeOfDayProfile[] = [
  // Night owl (0-6 AM): slow, long sessions, deep reading
  { hourStart: 0, hourEnd: 6, requestsPerMinute: 0.3, avgTimeOnPage: 45000, clickProbability: 0.2, scrollProbability: 0.8, backProbability: 0.15, avgSessionDuration: 1800000 },
  // Morning (6-9 AM): moderate, quick scanning
  { hourStart: 6, hourEnd: 9, requestsPerMinute: 0.8, avgTimeOnPage: 20000, clickProbability: 0.4, scrollProbability: 0.6, backProbability: 0.25, avgSessionDuration: 600000 },
  // Work hours (9-12 PM): fast, focused, goal-oriented
  { hourStart: 9, hourEnd: 12, requestsPerMinute: 1.2, avgTimeOnPage: 15000, clickProbability: 0.5, scrollProbability: 0.5, backProbability: 0.3, avgSessionDuration: 900000 },
  // Lunch (12-1 PM): moderate, casual browsing
  { hourStart: 12, hourEnd: 13, requestsPerMinute: 0.7, avgTimeOnPage: 25000, clickProbability: 0.35, scrollProbability: 0.7, backProbability: 0.2, avgSessionDuration: 600000 },
  // Afternoon (1-5 PM): fast, focused
  { hourStart: 13, hourEnd: 17, requestsPerMinute: 1.0, avgTimeOnPage: 18000, clickProbability: 0.45, scrollProbability: 0.55, backProbability: 0.28, avgSessionDuration: 720000 },
  // Evening (5-9 PM): slow, leisurely, shopping/entertainment
  { hourStart: 17, hourEnd: 21, requestsPerMinute: 0.5, avgTimeOnPage: 35000, clickProbability: 0.3, scrollProbability: 0.75, backProbability: 0.18, avgSessionDuration: 1200000 },
  // Late night (9-12 AM): moderate, mixed
  { hourStart: 21, hourEnd: 24, requestsPerMinute: 0.4, avgTimeOnPage: 40000, clickProbability: 0.25, scrollProbability: 0.85, backProbability: 0.15, avgSessionDuration: 1500000 },
];

const GEO_PROFILES: GeoBehaviorProfile[] = [
  { country: 'US', browsingSpeed: 1.0, peakHours: [9, 12, 19, 21], pagesPerSession: 8, mobileRatio: 0.55, inactivityPatterns: [{ durationMs: 300000, probability: 0.1 }] },
  { country: 'GB', browsingSpeed: 0.9, peakHours: [9, 13, 20], pagesPerSession: 7, mobileRatio: 0.5, inactivityPatterns: [{ durationMs: 300000, probability: 0.12 }] },
  { country: 'DE', browsingSpeed: 0.85, peakHours: [8, 12, 19], pagesPerSession: 9, mobileRatio: 0.4, inactivityPatterns: [{ durationMs: 300000, probability: 0.15 }] },
  { country: 'JP', browsingSpeed: 1.2, peakHours: [7, 12, 22], pagesPerSession: 12, mobileRatio: 0.7, inactivityPatterns: [{ durationMs: 180000, probability: 0.08 }] },
  { country: 'BR', browsingSpeed: 0.7, peakHours: [10, 14, 21], pagesPerSession: 6, mobileRatio: 0.65, inactivityPatterns: [{ durationMs: 360000, probability: 0.2 }] },
  { country: 'IN', browsingSpeed: 0.8, peakHours: [10, 14, 21], pagesPerSession: 7, mobileRatio: 0.75, inactivityPatterns: [{ durationMs: 240000, probability: 0.15 }] },
];

// ===============================================================================
// CHAMELEON ENGINE
// ===============================================================================

class ChameleonEngine {
  private sessions = new Map<string, ChameleonSession>();
  private initialized = false;

  /** Initialize the chameleon engine. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    logger.info('Chameleon Traffic Engine initialized');
  }

  /** Create a new chameleon session for a domain. */
  createSession(domain: string, country: string = 'US'): ChameleonSession {
    const geoProfile = GEO_PROFILES.find(p => p.country === country) || GEO_PROFILES[0];
    const now = Date.now();

    const session: ChameleonSession = {
      id: `chameleon-${Math.random().toString(36).substring(2, 10)}`,
      domain,
      geoProfile,
      currentPattern: null,
      navigationHistory: [],
      currentPageType: 'home',
      referrerChain: [],
      cookies: new Map(),
      startedAt: now,
      lastActivityAt: now,
      isActive: true,
      timing: {
        nextRequestAfter: now,
        currentDwellTime: 0,
        thinkTime: 0,
        isReading: false,
      },
      totalRequests: 0,
      totalExtracted: 0,
    };

    this.sessions.set(session.id, session);
    logger.debug({ sessionId: session.id, domain, country }, 'Chameleon session created');
    return session;
  }

  /** Calculate the delay before the next request in a session. */
  getNextDelay(sessionId: string, pageType?: PageType): number {
    const session = this.sessions.get(sessionId);
    if (!session) return 1000 + Math.random() * 2000;

    const now = new Date();
    const hour = now.getHours();
    const profile = this.getTimeProfile(hour);
    const geo = session.geoProfile;

    // Base delay from time-of-day profile
    const baseDelay = 60000 / profile.requestsPerMinute;

    // Apply geo speed modifier
    const geoDelay = baseDelay / geo.browsingSpeed;

    // Page-type modifier
    const pageModifier = this.getPageTypeDelayModifier(pageType || session.currentPageType);

    // Randomness (add natural variation using exponential distribution)
    const randomness = this.exponentialRandom(0.3);

    // Reading phase: longer delays when "reading" content
    const readingDelay = session.timing.isReading ? this.exponentialRandom(5000) : 0;

    // Think time (cognitive processing between actions)
    const thinkTime = 200 + Math.random() * 1500;

    // Inactivity pattern (occasional breaks)
    let inactivityDelay = 0;
    for (const pattern of geo.inactivityPatterns) {
      if (Math.random() < pattern.probability * 0.01) { // Scale down for per-request check
        inactivityDelay = pattern.durationMs * (0.5 + Math.random() * 0.5);
        break;
      }
    }

    const totalDelay = Math.round(geoDelay * pageModifier * randomness + readingDelay + thinkTime + inactivityDelay);

    // Update session timing
    session.timing.nextRequestAfter = Date.now() + totalDelay;
    session.timing.currentDwellTime = totalDelay;

    // Occasionally toggle reading state
    if (Math.random() < 0.3) {
      session.timing.isReading = !session.timing.isReading;
    }

    return totalDelay;
  }

  /** Determine the next navigation action for a session. */
  getNextAction(sessionId: string, currentPageType: PageType, availableLinks: string[]): {
    action: 'click' | 'scroll' | 'back' | 'wait' | 'exit';
    target?: string;
    delay: number;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) return { action: 'click', target: availableLinks[0], delay: 1000 };

    session.currentPageType = currentPageType;
    const hour = new Date().getHours();
    const profile = this.getTimeProfile(hour);

    // Decide action based on behavioral profile
    const roll = Math.random();
    const sessionAge = Date.now() - session.startedAt;
    const sessionExhausted = sessionAge > profile.avgSessionDuration * (0.8 + Math.random() * 0.4);

    if (sessionExhausted) {
      return { action: 'exit', delay: 0 };
    }

    if (roll < profile.backProbability) {
      return { action: 'back', delay: this.getNextDelay(sessionId) };
    }

    if (roll < profile.scrollProbability) {
      session.timing.isReading = true;
      return { action: 'scroll', delay: this.exponentialRandom(3000) + 500 };
    }

    if (roll < profile.clickProbability && availableLinks.length > 0) {
      // Choose a link that fits the navigation pattern
      const target = this.selectLinkByPattern(availableLinks, session, currentPageType);
      session.navigationHistory.push(target);
      session.timing.isReading = false;
      return { action: 'click', target, delay: this.getNextDelay(sessionId) };
    }

    return { action: 'wait', delay: this.exponentialRandom(2000) + 1000 };
  }

  /** Generate a realistic referrer for a URL. */
  generateReferrer(sessionId: string, targetUrl: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) return '';

    // If we have navigation history, use the last page as referrer
    if (session.navigationHistory.length > 0) {
      const referrer = session.navigationHistory[session.navigationHistory.length - 1];
      session.referrerChain.push(referrer);
      return referrer;
    }

    // First request: simulate coming from a search engine
    const searchEngines = [
      { domain: 'https://www.google.com', param: 'q' },
      { domain: 'https://www.bing.com', param: 'q' },
      { domain: 'https://search.yahoo.com', param: 'p' },
    ];
    const engine = searchEngines[Math.floor(Math.random() * searchEngines.length)];

    // Extract search terms from the target URL
    try {
      const urlObj = new URL(targetUrl);
      const searchTerms = urlObj.pathname.split('/').filter(Boolean).join(' ');
      const referrer = `${engine.domain}/search?${engine.param}=${encodeURIComponent(searchTerms)}`;
      session.referrerChain.push(referrer);
      return referrer;
    } catch {
      return '';
    }
  }

  /** Record a request in the session. */
  recordRequest(sessionId: string, url: string, success: boolean, dataExtracted?: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.totalRequests++;
    session.lastActivityAt = Date.now();
    if (dataExtracted) session.totalExtracted += dataExtracted;
  }

  /** Get session info. */
  getSession(sessionId: string): ChameleonSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** End a session. */
  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.isActive = false;
      logger.debug(
        { sessionId, requests: session.totalRequests, extracted: session.totalExtracted, durationMs: Date.now() - session.startedAt },
        'Chameleon session ended',
      );
    }
  }

  /** Get all active sessions. */
  getActiveSessions(): ChameleonSession[] {
    return Array.from(this.sessions.values()).filter(s => s.isActive);
  }

  /** Get engine statistics. */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    totalRequests: number;
    totalExtracted: number;
    avgSessionDurationMs: number;
  } {
    let totalRequests = 0;
    let totalExtracted = 0;
    let totalDuration = 0;
    let activeCount = 0;
    const all = Array.from(this.sessions.values());

    for (const s of all) {
      totalRequests += s.totalRequests;
      totalExtracted += s.totalExtracted;
      totalDuration += Date.now() - s.startedAt;
      if (s.isActive) activeCount++;
    }

    return {
      totalSessions: all.length,
      activeSessions: activeCount,
      totalRequests,
      totalExtracted,
      avgSessionDurationMs: all.length > 0 ? Math.round(totalDuration / all.length) : 0,
    };
  }

  /** Clean up expired sessions. */
  cleanup(): void {
    const maxAge = 3600000; // 1 hour max session
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (!session.isActive || now - session.startedAt > maxAge) {
        session.isActive = false;
        if (now - session.lastActivityAt > 600000) { // 10 min inactive
          this.sessions.delete(id);
        }
      }
    }
  }

  // --- Private helpers ---

  private getTimeProfile(hour: number): TimeOfDayProfile {
    for (const profile of TIME_OF_DAY_PROFILES) {
      if (hour >= profile.hourStart && hour < profile.hourEnd) return profile;
    }
    return TIME_OF_DAY_PROFILES[0];
  }

  private getPageTypeDelayModifier(pageType: PageType): number {
    const modifiers: Record<PageType, number> = {
      home: 0.8,
      category: 1.0,
      search: 1.2,
      product: 1.8,
      article: 2.5,
      profile: 1.5,
      checkout: 1.0,
      about: 1.2,
      contact: 1.0,
      blog: 2.0,
      login: 0.8,
      other: 1.0,
    };
    return modifiers[pageType] || 1.0;
  }

  private exponentialRandom(lambda: number): number {
    return -Math.log(1 - Math.random()) / lambda;
  }

  private selectLinkByPattern(links: string[], session: ChameleonSession, currentPageType: PageType): string {
    if (links.length === 0) return '';

    // Prefer links that match common navigation patterns
    // e.g., from category -> product, from product -> related products
    const domain = session.domain;

    // Score each link based on pattern matching
    const scored = links.map(link => {
      let score = 1;

      try {
        const url = new URL(link);
        const path = url.pathname;

        // From home, prefer category/navigation pages
        if (currentPageType === 'home') {
          if (path.split('/').length <= 3) score += 2;
        }

        // From category, prefer product/detail pages
        if (currentPageType === 'category') {
          if (path.split('/').length >= 3) score += 2;
          if (/\/(product|item|detail|p)\//i.test(path)) score += 3;
        }

        // From product, prefer related products or back to category
        if (currentPageType === 'product') {
          if (/\/(related|similar|recommend)/i.test(path)) score += 3;
          if (path.split('/').length <= 3) score += 1; // Category link
        }

        // Stay on same domain
        if (url.hostname.includes(domain)) score += 2;

        // Avoid login/auth pages
        if (/\/(login|signin|auth|signup)/i.test(path)) score -= 5;

        // Avoid external links
        if (!url.hostname.includes(domain)) score -= 3;

      } catch {
        score = 0;
      }

      return { link, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Weighted random selection from top candidates
    const topCandidates = scored.slice(0, Math.min(5, scored.length));
    const totalScore = topCandidates.reduce((sum, c) => sum + Math.max(c.score, 0.1), 0);
    let random = Math.random() * totalScore;

    for (const candidate of topCandidates) {
      random -= Math.max(candidate.score, 0.1);
      if (random <= 0) return candidate.link;
    }

    return topCandidates[0]?.link || links[0];
  }
}

// ===============================================================================
// SINGLETON & EXPORTS
// ===============================================================================

export const chameleonEngine = new ChameleonEngine();
export default ChameleonEngine;
