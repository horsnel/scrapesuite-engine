/**
 * Google Account Warming Engine — ScrapeSuite Engine
 *
 * Executes the behavioral warming process for Google accounts.
 * Warming means gradually building up realistic browsing history
 * so that Google's anti-bot systems assign higher trust scores.
 *
 * The warming process follows a phased approach:
 * 1. Creation — account created with realistic signup behavior
 * 2. Verification — email verified, phone optionally added
 * 3. Initial Browsing — casual Google Search and YouTube visits
 * 4. Service Onboarding — sign up for Gmail, Maps, Drive
 * 5. Depth Building — use 5+ services with 5+ interactions each
 * 6. Trust Earning — achieve reCAPTCHA scores of 0.7+
 * 7. Operational — account is ready for production scraping
 *
 * Each phase has realistic timing, behavior patterns, and
 * escalation rules to avoid detection.
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import type {
  GoogleAccount, WarmupPhase, WarmupPlan, WarmupSchedule, WarmupActivity,
  ServiceType, ActivityType, HealthAssessment, HealthIssue, RiskLevel,
} from './types';

const logger = createChildLogger('warming-engine');

const WARMUP_CACHE_PREFIX = 'account-warmer:warmup:';
const HEALTH_CACHE_PREFIX = 'account-warmer:health:';

// ===============================================================================
// DEFAULT WARMUP PLAN
// ===============================================================================

export const DEFAULT_WARMUP_PLAN: WarmupPlan = {
  id: 'default-warmup-plan',
  targetTier: 'aged',
  totalDays: 30,
  phases: [
    {
      phase: 'initial_browsing',
      startDay: 0,
      durationDays: 5,
      activities: [
        {
          type: 'search_query',
          service: 'search',
          frequency: 2,
          timeOfDayRange: [9, 22],
          durationRange: [120000, 600000], // 2-10 minutes
          highRisk: false,
          parameters: { queryTypes: ['informational', 'navigational'] },
        },
        {
          type: 'page_visit',
          service: 'youtube',
          frequency: 1,
          timeOfDayRange: [12, 23],
          durationRange: [300000, 1800000], // 5-30 minutes
          highRisk: false,
          parameters: { videoCategories: ['entertainment', 'education', 'music'] },
        },
      ],
      minActivityGap: 1800000, // 30 minutes
      maxActivitiesPerDay: 4,
      sessionDurationRange: [600000, 1800000], // 10-30 minutes
      includeCaptchaRisk: false,
    },
    {
      phase: 'service_onboarding',
      startDay: 5,
      durationDays: 7,
      activities: [
        {
          type: 'search_query',
          service: 'search',
          frequency: 3,
          timeOfDayRange: [8, 23],
          durationRange: [120000, 600000],
          highRisk: false,
          parameters: { queryTypes: ['informational', 'transactional', 'navigational'] },
        },
        {
          type: 'page_visit',
          service: 'gmail',
          frequency: 1,
          timeOfDayRange: [9, 21],
          durationRange: [180000, 600000],
          highRisk: false,
          parameters: { actions: ['read', 'compose_draft', 'organize'] },
        },
        {
          type: 'page_visit',
          service: 'maps',
          frequency: 1,
          timeOfDayRange: [10, 20],
          durationRange: [120000, 600000],
          highRisk: false,
          parameters: { searchTypes: ['directions', 'nearby', 'explore'] },
        },
        {
          type: 'page_visit',
          service: 'youtube',
          frequency: 2,
          timeOfDayRange: [12, 23],
          durationRange: [300000, 1800000],
          highRisk: false,
          parameters: { videoCategories: ['entertainment', 'education', 'howto'] },
        },
      ],
      minActivityGap: 900000, // 15 minutes
      maxActivitiesPerDay: 6,
      sessionDurationRange: [900000, 2700000], // 15-45 minutes
      includeCaptchaRisk: false,
    },
    {
      phase: 'depth_building',
      startDay: 12,
      durationDays: 10,
      activities: [
        {
          type: 'search_query',
          service: 'search',
          frequency: 4,
          timeOfDayRange: [7, 23],
          durationRange: [120000, 900000],
          highRisk: false,
          parameters: { queryTypes: ['all'] },
        },
        {
          type: 'video_watch',
          service: 'youtube',
          frequency: 2,
          timeOfDayRange: [11, 23],
          durationRange: [600000, 3600000], // 10-60 minutes
          highRisk: false,
          parameters: { engagement: ['like', 'subscribe', 'comment'] },
        },
        {
          type: 'map_search',
          service: 'maps',
          frequency: 1,
          timeOfDayRange: [9, 20],
          durationRange: [180000, 900000],
          highRisk: false,
          parameters: { searchTypes: ['all'] },
        },
        {
          type: 'email_read',
          service: 'gmail',
          frequency: 1,
          timeOfDayRange: [8, 22],
          durationRange: [120000, 600000],
          highRisk: false,
          parameters: {},
        },
        {
          type: 'page_visit',
          service: 'shopping',
          frequency: 1,
          timeOfDayRange: [10, 22],
          durationRange: [180000, 900000],
          highRisk: false,
          parameters: { browseCategories: ['electronics', 'clothing', 'home'] },
        },
        {
          type: 'page_visit',
          service: 'scholar',
          frequency: 1,
          timeOfDayRange: [9, 18],
          durationRange: [120000, 600000],
          highRisk: false,
          parameters: {},
        },
      ],
      minActivityGap: 600000, // 10 minutes
      maxActivitiesPerDay: 10,
      sessionDurationRange: [1200000, 3600000], // 20-60 minutes
      includeCaptchaRisk: true,
    },
    {
      phase: 'trust_earning',
      startDay: 22,
      durationDays: 8,
      activities: [
        {
          type: 'search_query',
          service: 'search',
          frequency: 5,
          timeOfDayRange: [7, 23],
          durationRange: [180000, 1200000],
          highRisk: false,
          parameters: { queryTypes: ['all'], includeComplex: true },
        },
        {
          type: 'video_watch',
          service: 'youtube',
          frequency: 2,
          timeOfDayRange: [10, 23],
          durationRange: [600000, 3600000],
          highRisk: false,
          parameters: { engagement: ['all'] },
        },
        {
          type: 'review_post',
          service: 'maps',
          frequency: 1,
          timeOfDayRange: [12, 20],
          durationRange: [300000, 1200000],
          highRisk: true,
          parameters: {},
        },
        {
          type: 'file_upload',
          service: 'drive',
          frequency: 1,
          timeOfDayRange: [9, 18],
          durationRange: [180000, 600000],
          highRisk: false,
          parameters: {},
        },
        {
          type: 'app_install',
          service: 'play_store',
          frequency: 1,
          timeOfDayRange: [14, 22],
          durationRange: [120000, 600000],
          highRisk: false,
          parameters: {},
        },
      ],
      minActivityGap: 300000, // 5 minutes
      maxActivitiesPerDay: 12,
      sessionDurationRange: [1800000, 5400000], // 30-90 minutes
      includeCaptchaRisk: true,
    },
  ],
  completionCriteria: {
    minAgeDays: 14,
    minHealthScore: 60,
    minRecaptchaScore: 0.7,
    minServicesUsed: 4,
    minDeepServiceCount: 2,
    minTotalSessions: 20,
  },
};

// ===============================================================================
// HEALTH ASSESSOR
// ===============================================================================

function assessAccountHealth(account: GoogleAccount): HealthAssessment {
  const issues: HealthIssue[] = [];
  const recommendations: string[] = [];

  // Age score (0-100)
  let ageScore = Math.min(100, account.ageDays * 2);

  // Activity score (0-100)
  const sessionsPerDay = account.ageDays > 0 ? account.totalSessions / account.ageDays : 0;
  let activityScore = Math.min(100, sessionsPerDay * 30);
  if (sessionsPerDay < 1) {
    issues.push({ severity: 'warning', category: 'activity', description: 'Low activity frequency', remediation: 'Increase daily session count' });
  }

  // Diversity score (0-100)
  let diversityScore = Math.min(100, account.servicesUsed.length * 15 + account.deepServiceCount * 10);
  if (account.servicesUsed.length < 3) {
    issues.push({ severity: 'warning', category: 'diversity', description: 'Low service diversity', remediation: 'Visit more Google services' });
  }

  // Consistency score (0-100)
  let consistencyScore = 70;
  if (account.emailVerified) consistencyScore += 10;
  if (account.hasPhoneNumber) consistencyScore += 10;
  if (account.sessionHistory.length > 10) {
    const recentSessions = account.sessionHistory.slice(-10);
    const sameRegion = recentSessions.every(s => true); // Would check proxy region consistency
    if (sameRegion) consistencyScore += 10;
  }
  consistencyScore = Math.min(100, consistencyScore);

  // reCAPTCHA score (0-100)
  let recaptchaScoreVal = account.recaptchaScore * 100;
  if (account.recaptchaScore < 0.5) {
    issues.push({ severity: 'critical', category: 'recaptcha', description: `Low reCAPTCHA score: ${account.recaptchaScore.toFixed(2)}`, remediation: 'Continue warming with more diverse activities' });
  } else if (account.recaptchaScore < 0.7) {
    issues.push({ severity: 'warning', category: 'recaptcha', description: `Moderate reCAPTCHA score: ${account.recaptchaScore.toFixed(2)}`, remediation: 'Add more depth activities before operational use' });
  }

  // Risk score (inverse of risk, 0-100)
  const riskScoreMap: Record<RiskLevel, number> = { low: 90, medium: 50, high: 20, critical: 5 };
  let riskScoreVal = riskScoreMap[account.riskLevel];
  if (account.riskLevel === 'high' || account.riskLevel === 'critical') {
    issues.push({ severity: 'critical', category: 'risk', description: `Account risk level: ${account.riskLevel}`, remediation: 'Cool down account, reduce activity frequency' });
  }

  // Overall health score (weighted average)
  const healthScore = Math.round(
    ageScore * 0.15 +
    activityScore * 0.15 +
    diversityScore * 0.15 +
    consistencyScore * 0.20 +
    recaptchaScoreVal * 0.25 +
    riskScoreVal * 0.10
  );

  // Risk level
  let riskLevel: RiskLevel = 'low';
  if (healthScore < 30) riskLevel = 'critical';
  else if (healthScore < 50) riskLevel = 'high';
  else if (healthScore < 70) riskLevel = 'medium';

  // Recommendations
  if (ageScore < 50) recommendations.push('Account needs more aging — avoid high-risk activities');
  if (diversityScore < 50) recommendations.push('Expand service usage to improve diversity score');
  if (recaptchaScoreVal < 70) recommendations.push('Focus on depth activities to improve reCAPTCHA score');
  if (consistencyScore < 60) recommendations.push('Verify email and add phone number for consistency');
  if (account.servicesUsed.length < 4) recommendations.push('Use at least 4 different Google services');

  return {
    accountId: account.id,
    healthScore,
    components: {
      ageScore: Math.round(ageScore),
      activityScore: Math.round(activityScore),
      diversityScore: Math.round(diversityScore),
      consistencyScore: Math.round(consistencyScore),
      recaptchaScore: Math.round(recaptchaScoreVal),
      riskScore: Math.round(riskScoreVal),
    },
    riskLevel,
    issues,
    recommendations,
    assessedAt: Date.now(),
  };
}

// ===============================================================================
// WARMING ENGINE CLASS
// ===============================================================================

export class WarmingEngine {
  private plan: WarmupPlan;
  private activeWarming: Map<string, { accountId: string; phase: WarmupPhase; startedAt: number }> = new Map();
  private stats = {
    accountsWarmed: 0,
    accountsCompleted: 0,
    accountsFailed: 0,
    averageWarmupDays: 0,
    activitiesExecuted: 0,
  };

  constructor(plan?: WarmupPlan) {
    this.plan = plan || DEFAULT_WARMUP_PLAN;
  }

  /**
   * Start the warming process for an account.
   * Determines the appropriate phase based on account age and status.
   */
  async startWarming(account: GoogleAccount): Promise<WarmupPhase> {
    // Determine current phase based on account state
    const phase = this.determinePhase(account);

    logger.info({
      accountId: account.id,
      email: account.email,
      ageDays: account.ageDays,
      phase,
      healthScore: account.healthScore,
    }, 'Starting account warming');

    this.activeWarming.set(account.id, {
      accountId: account.id,
      phase,
      startedAt: Date.now(),
    });

    return phase;
  }

  /**
   * Get the next activity to execute for a warming account.
   * Returns an activity that's appropriate for the current phase
   * and hasn't been done too recently.
   */
  getNextActivity(account: GoogleAccount): WarmupActivity | null {
    const warming = this.activeWarming.get(account.id);
    if (!warming) return null;

    const schedule = this.plan.phases.find(p => p.phase === warming.phase);
    if (!schedule || schedule.activities.length === 0) return null;

    // Filter activities based on time of day
    const currentHour = new Date().getHours();
    const suitable = schedule.activities.filter(a => {
      const [start, end] = a.timeOfDayRange;
      return currentHour >= start && currentHour <= end;
    });

    if (suitable.length === 0) return null;

    // Select activity (weighted random based on frequency)
    const totalWeight = suitable.reduce((sum, a) => sum + a.frequency, 0);
    let rand = Math.random() * totalWeight;

    for (const activity of suitable) {
      rand -= activity.frequency;
      if (rand <= 0) return activity;
    }

    return suitable[suitable.length - 1];
  }

  /**
   * Advance an account to the next warmup phase if eligible.
   */
  async advancePhase(account: GoogleAccount): Promise<WarmupPhase | null> {
    const warming = this.activeWarming.get(account.id);
    if (!warming) return null;

    const currentPhaseIndex = this.plan.phases.findIndex(p => p.phase === warming.phase);
    if (currentPhaseIndex === -1 || currentPhaseIndex >= this.plan.phases.length - 1) {
      // Account has completed all phases
      if (this.checkCompletionCriteria(account)) {
        warming.phase = 'operational';
        this.stats.accountsCompleted++;
        logger.info({ accountId: account.id }, 'Account warming completed');
        return 'operational';
      }
      return null;
    }

    // Check if account is ready for next phase
    const currentSchedule = this.plan.phases[currentPhaseIndex];
    const daysInPhase = account.ageDays - currentSchedule.startDay;
    if (daysInPhase >= currentSchedule.durationDays) {
      const nextPhase = this.plan.phases[currentPhaseIndex + 1];
      warming.phase = nextPhase.phase;
      logger.info({
        accountId: account.id,
        newPhase: nextPhase.phase,
      }, 'Account advanced to next warmup phase');
      return nextPhase.phase;
    }

    return null;
  }

  /**
   * Assess the health of an account.
   */
  assessHealth(account: GoogleAccount): HealthAssessment {
    const assessment = assessAccountHealth(account);

    // Update account health score
    account.healthScore = assessment.healthScore;
    account.riskLevel = assessment.riskLevel;

    return assessment;
  }

  /**
   * Check if an account meets the completion criteria.
   */
  checkCompletionCriteria(account: GoogleAccount): boolean {
    const criteria = this.plan.completionCriteria;
    return (
      account.ageDays >= criteria.minAgeDays &&
      account.healthScore >= criteria.minHealthScore &&
      account.recaptchaScore >= criteria.minRecaptchaScore &&
      account.servicesUsed.length >= criteria.minServicesUsed &&
      account.deepServiceCount >= criteria.minDeepServiceCount &&
      account.totalSessions >= criteria.minTotalSessions
    );
  }

  /**
   * Stop warming an account.
   */
  stopWarming(accountId: string): void {
    this.activeWarming.delete(accountId);
  }

  /**
   * Get the warmup plan.
   */
  getPlan(): WarmupPlan {
    return this.plan;
  }

  /**
   * Get the default warmup plan.
   */
  getDefaultPlan(): WarmupPlan {
    return DEFAULT_WARMUP_PLAN;
  }

  /**
   * Get warming statistics.
   */
  getStats(): {
    accountsWarmed: number;
    accountsCompleted: number;
    accountsFailed: number;
    averageWarmupDays: number;
    activitiesExecuted: number;
    activeWarmingCount: number;
  } {
    return {
      ...this.stats,
      activeWarmingCount: this.activeWarming.size,
    };
  }

  // ---------- Internal Methods -------------------------------------------------

  private determinePhase(account: GoogleAccount): WarmupPhase {
    if (account.status === 'created') return 'initial_browsing';
    if (account.ageDays < 5) return 'initial_browsing';
    if (account.ageDays < 12) return 'service_onboarding';
    if (account.ageDays < 22) return 'depth_building';
    if (account.ageDays < 30) return 'trust_earning';
    if (this.checkCompletionCriteria(account)) return 'operational';
    return 'trust_earning';
  }
}

/** Singleton instance. */
export const warmingEngine = new WarmingEngine();
