// --- ScrapeSuite Pricing Engine -----------------------------------------------
// Centralized bandwidth-based credit calculations and pricing tiers.
// Handles billing, credit deduction, overage, invoice generation,
// plan upgrades/downgrades, and alert thresholds.
// ------------------------------------------------------------------------------

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { db } from '../utils/db';

const logger = createChildLogger('pricing-engine');

// --- Constants ----------------------------------------------------------------

const BYTES_PER_GB = 1073741824;
const BALANCE_CACHE_TTL = 60;       // 1 minute
const AGGREGATE_CACHE_TTL = 300;     // 5 minutes
const OVERAGE_GRACE_PERCENT = 0.05;  // 5 % grace before overage kicks in

const ALERT_THRESHOLDS = {
  WARNING: 0.20,   // 20 %
  CRITICAL: 0.10,  // 10 %
  URGENT: 0.05,    // 5 %
} as const;

// --- Pricing Tiers ------------------------------------------------------------

export const PRICING_TIERS = {
  starter: {
    name: 'Starter',
    monthlyPrice: 0,
    includedCredits: 10_000,
    overagePerCredit: 0.001,
    bandwidthOveragePerGB: 0.50,
    maxConcurrent: 5,
    supportLevel: 'community' as const,
  },
  pro: {
    name: 'Pro',
    monthlyPrice: 49,
    includedCredits: 100_000,
    overagePerCredit: 0.0008,
    bandwidthOveragePerGB: 0.50,
    maxConcurrent: 25,
    supportLevel: 'email' as const,
  },
  business: {
    name: 'Business',
    monthlyPrice: 199,
    includedCredits: 500_000,
    overagePerCredit: 0.0005,
    bandwidthOveragePerGB: 0.50,
    maxConcurrent: 100,
    supportLevel: 'priority' as const,
  },
  enterprise: {
    name: 'Enterprise',
    monthlyPrice: -1,
    includedCredits: -1,
    overagePerCredit: -1,
    bandwidthOveragePerGB: -1,
    maxConcurrent: -1,
    supportLevel: 'dedicated' as const,
  },
} as const;

export type PricingTierKey = keyof typeof PRICING_TIERS;

// --- Credit Costs per Operation -----------------------------------------------

export const CREDIT_COST_MAP = {
  HTTP_SCRAPE: 1,
  BROWSER_SCRAPE: 5,
  SERP_API: 2,
  CAPTCHA_SOLVE: 10,
  AI_EXTRACTION: 3,
  PDF_CAPTURE_PER_PAGE: 2,
  CDP_SESSION_PER_HOUR: 3,
} as const;

export type CreditOperation = keyof typeof CREDIT_COST_MAP;

// --- Proxy Tier Pricing -------------------------------------------------------

export const PROXY_TIER_PRICING = {
  residential: 5.00,  // $5/GB
  mobile: 8.00,       // $8/GB
  datacenter: 1.00,   // $1/GB
  isp: 3.00,          // $3/GB
} as const;

export type ProxyTier = keyof typeof PROXY_TIER_PRICING;

// --- Bandwidth Volume Discounts -----------------------------------------------

export const BANDWIDTH_VOLUME_DISCOUNTS: ReadonlyArray<{ thresholdGB: number; discount: number }> = [
  { thresholdGB: 0, discount: 0 },
  { thresholdGB: 10, discount: 0.05 },
  { thresholdGB: 50, discount: 0.10 },
  { thresholdGB: 200, discount: 0.15 },
  { thresholdGB: 500, discount: 0.20 },
  { thresholdGB: 1000, discount: 0.25 },
];

// --- Types --------------------------------------------------------------------

export type AlertLevel = 'none' | 'warning' | 'critical' | 'urgent';

export interface UserBalance {
  userId: string;
  creditsRemaining: number;
  creditsUsed: number;
  totalCredits: number;
  bandwidthBytes: number;
  plan: PricingTierKey;
  overageCredits: number;
  alertLevel: AlertLevel;
}

export interface CreditDeductionResult {
  success: boolean;
  creditsDeducted: number;
  creditsRemaining: number;
  overageApplied: number;
  alertLevel: AlertLevel;
}

export interface OverageCalculation {
  includedCredits: number;
  usedCredits: number;
  graceCredits: number;
  overageCredits: number;
  overageCostUsd: number;
  bandwidthOverageGB: number;
  bandwidthOverageCostUsd: number;
  totalOverageCostUsd: number;
}

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
  category: 'subscription' | 'credits' | 'bandwidth' | 'proxy' | 'overage' | 'discount';
}

export interface Invoice {
  id: string;
  userId: string;
  periodStart: Date;
  periodEnd: Date;
  lineItems: InvoiceLineItem[];
  subtotal: number;
  discount: number;
  total: number;
  currency: string;
  status: 'draft' | 'final' | 'paid' | 'void';
  generatedAt: Date;
}

export interface UsageAggregate {
  userId: string;
  period: 'daily' | 'weekly' | 'monthly';
  periodStart: Date;
  periodEnd: Date;
  httpScrapes: number;
  browserScrapes: number;
  serpApiCalls: number;
  captchaSolves: number;
  aiExtractions: number;
  pdfPages: number;
  cdpHours: number;
  totalCredits: number;
  bandwidthBytes: number;
  proxyBandwidthBytes: Record<ProxyTier, number>;
  successRate: number;
}

export interface PlanChangeResult {
  fromPlan: PricingTierKey;
  toPlan: PricingTierKey;
  proratedCredits: number;
  creditAdjustment: number;
  priceDifference: number;
  effectiveDate: Date;
}

export interface AlertCheckResult {
  userId: string;
  previousLevel: AlertLevel;
  currentLevel: AlertLevel;
  creditsRemaining: number;
  totalCredits: number;
  percentRemaining: number;
  shouldNotify: boolean;
}

export interface MonthlyEstimate {
  subscription: number;
  creditOverage: number;
  bandwidthOverage: number;
  proxyCost: number;
  discount: number;
  total: number;
}

// --- PricingEngine ------------------------------------------------------------

export class PricingEngine {

  // -- Credit Cost Lookups -----------------------------------------------------

  /** Get the credit cost for a given operation type. */
  getCreditCost(operation: CreditOperation): number {
    return CREDIT_COST_MAP[operation];
  }

  /** Calculate credits for a PDF capture based on page count. */
  calculatePdfCredits(pageCount: number): number {
    return pageCount * CREDIT_COST_MAP.PDF_CAPTURE_PER_PAGE;
  }

  /** Calculate credits for a CDP session. Fractional hours rounded up to nearest quarter. */
  calculateCdpCredits(hours: number): number {
    const quarterHours = Math.ceil(hours * 4) / 4;
    return quarterHours * CREDIT_COST_MAP.CDP_SESSION_PER_HOUR;
  }

  /** Calculate total credits for a composite scrape with optional add-ons. */
  calculateCompositeCredits(params: {
    baseOperation: CreditOperation;
    withCaptcha?: boolean;
    withAiExtraction?: boolean;
    pdfPages?: number;
    cdpHours?: number;
  }): number {
    let total = this.getCreditCost(params.baseOperation);
    if (params.withCaptcha) total += CREDIT_COST_MAP.CAPTCHA_SOLVE;
    if (params.withAiExtraction) total += CREDIT_COST_MAP.AI_EXTRACTION;
    if (params.pdfPages && params.pdfPages > 0) total += this.calculatePdfCredits(params.pdfPages);
    if (params.cdpHours && params.cdpHours > 0) total += this.calculateCdpCredits(params.cdpHours);
    return total;
  }

  // -- Plan & Tier Lookups ----------------------------------------------------

  /** Get the pricing tier configuration for a plan. */
  getTierConfig(plan: PricingTierKey) {
    return PRICING_TIERS[plan];
  }

  /** Get the included credits for a plan. */
  getIncludedCredits(plan: PricingTierKey): number {
    return PRICING_TIERS[plan].includedCredits;
  }

  /** Get the monthly price for a plan. */
  getMonthlyPrice(plan: PricingTierKey): number {
    return PRICING_TIERS[plan].monthlyPrice;
  }

  // -- Bandwidth Pricing ------------------------------------------------------

  /** Calculate bandwidth overage cost for a given plan and usage. */
  calculateBandwidthOverage(
    plan: PricingTierKey,
    bandwidthBytesUsed: number,
    bandwidthBytesIncluded: number = 0,
  ): { overageGB: number; costUsd: number; discountApplied: number } {
    const overageBytes = Math.max(0, bandwidthBytesUsed - bandwidthBytesIncluded);
    const overageGB = overageBytes / BYTES_PER_GB;
    if (overageGB <= 0) return { overageGB: 0, costUsd: 0, discountApplied: 0 };

    const basePricePerGB = PRICING_TIERS[plan].bandwidthOveragePerGB;
    if (basePricePerGB < 0) {
      logger.warn({ plan }, 'Enterprise bandwidth overage requires custom pricing');
      return { overageGB, costUsd: 0, discountApplied: 0 };
    }

    const discount = this.getBandwidthDiscount(overageGB);
    const costUsd = overageGB * basePricePerGB * (1 - discount);
    return { overageGB, costUsd, discountApplied: discount };
  }

  /** Get volume discount fraction (0-1) for a given bandwidth usage in GB. */
  getBandwidthDiscount(usageGB: number): number {
    let discount = 0;
    for (const tier of BANDWIDTH_VOLUME_DISCOUNTS) {
      if (usageGB >= tier.thresholdGB) discount = tier.discount;
    }
    return discount;
  }

  /** Calculate proxy bandwidth cost for a specific proxy tier. */
  calculateProxyBandwidthCost(proxyTier: ProxyTier, bandwidthBytes: number): number {
    const usageGB = bandwidthBytes / BYTES_PER_GB;
    const discount = this.getBandwidthDiscount(usageGB);
    return usageGB * PROXY_TIER_PRICING[proxyTier] * (1 - discount);
  }

  // -- Overage Calculation ----------------------------------------------------

  /** Calculate full overage breakdown including grace period. */
  calculateOverage(
    plan: PricingTierKey,
    creditsUsed: number,
    bandwidthBytesUsed: number,
    bandwidthBytesIncluded: number = 0,
  ): OverageCalculation {
    const tier = PRICING_TIERS[plan];
    const includedCredits = tier.includedCredits;
    const graceCredits = Math.floor(includedCredits * OVERAGE_GRACE_PERCENT);
    const overageCredits = Math.max(0, creditsUsed - includedCredits - graceCredits);

    let overageCostUsd = 0;
    if (tier.overagePerCredit >= 0 && overageCredits > 0) {
      overageCostUsd = overageCredits * tier.overagePerCredit;
    }

    const bwResult = this.calculateBandwidthOverage(plan, bandwidthBytesUsed, bandwidthBytesIncluded);

    return {
      includedCredits,
      usedCredits: creditsUsed,
      graceCredits,
      overageCredits,
      overageCostUsd,
      bandwidthOverageGB: bwResult.overageGB,
      bandwidthOverageCostUsd: bwResult.costUsd,
      totalOverageCostUsd: overageCostUsd + bwResult.costUsd,
    };
  }

  // -- Balance Checks (with Redis caching) ------------------------------------

  /** Get the current balance for a user, caching the result in Redis. */
  async getUserBalance(userId: string): Promise<UserBalance | null> {
    const cacheKey = `pricing:balance:${userId}`;
    try {
      const cached = await cacheGet<UserBalance>(cacheKey);
      if (cached) return cached;
    } catch (err) {
      logger.debug({ userId, err: (err as Error).message }, 'Balance cache miss');
    }

    try {
      const user = await db.user.findUnique({
        where: { id: userId },
        include: { apiKeys: { select: { creditsRemaining: true, creditsUsed: true, bandwidthBytes: true } } },
      });
      if (!user) return null;

      const plan = (user.plan as PricingTierKey) || 'starter';
      const totalCredits = this.getIncludedCredits(plan);

      let creditsRemaining = 0;
      let creditsUsed = 0;
      let bandwidthBytes = 0;
      for (const key of user.apiKeys) {
        creditsRemaining += key.creditsRemaining;
        creditsUsed += key.creditsUsed;
        bandwidthBytes += key.bandwidthBytes;
      }

      const balance: UserBalance = {
        userId,
        creditsRemaining,
        creditsUsed,
        totalCredits,
        bandwidthBytes,
        plan,
        overageCredits: Math.max(0, creditsUsed - totalCredits),
        alertLevel: this.determineAlertLevel(creditsRemaining, totalCredits),
      };

      try { await cacheSet(cacheKey, balance, BALANCE_CACHE_TTL); } catch { /* ignore */ }
      return balance;
    } catch (err) {
      logger.error({ userId, err: (err as Error).message }, 'Failed to fetch user balance');
      return null;
    }
  }

  /** Invalidate the cached balance for a user after credit-modifying operations. */
  async invalidateBalanceCache(userId: string): Promise<void> {
    try {
      const { redis } = await import('../utils/redis');
      await redis.del(`cache:pricing:balance:${userId}`);
    } catch (err) {
      logger.debug({ userId, err: (err as Error).message }, 'Failed to invalidate balance cache');
    }
  }

  // -- Credit Deduction -------------------------------------------------------

  /** Deduct credits from a specific API key atomically. Returns success=false if insufficient. */
  async deductCredits(userId: string, apiKeyId: string, amount: number): Promise<CreditDeductionResult> {
    const empty = { success: false as const, creditsDeducted: 0, creditsRemaining: 0, overageApplied: 0, alertLevel: 'none' as AlertLevel };
    if (amount <= 0) return empty;

    try {
      const result = await db.$transaction(async (tx) => {
        const key = await tx.apiKey.findUnique({
          where: { id: apiKeyId },
          select: { creditsRemaining: true, creditsUsed: true },
        });
        if (!key) return null;
        if (key.creditsRemaining < amount) {
          return { insufficient: true as const, remaining: key.creditsRemaining };
        }
        const updated = await tx.apiKey.update({
          where: { id: apiKeyId },
          data: { creditsRemaining: { decrement: amount }, creditsUsed: { increment: amount } },
        });
        return { insufficient: false as const, remaining: updated.creditsRemaining };
      });

      if (!result) {
        logger.error({ apiKeyId, amount }, 'API key not found for credit deduction');
        return { ...empty, alertLevel: 'urgent' };
      }

      if (result.insufficient) {
        logger.warn({ apiKeyId, amount, remaining: result.remaining }, 'Insufficient credits');
        return { ...empty, creditsRemaining: result.remaining, alertLevel: 'urgent' };
      }

      await this.invalidateBalanceCache(userId);
      const balance = await this.getUserBalance(userId);
      const alertLevel = balance?.alertLevel ?? this.determineAlertLevel(result.remaining, 0);

      logger.info({ apiKeyId, amount, remaining: result.remaining, alertLevel }, 'Credits deducted');
      return { success: true, creditsDeducted: amount, creditsRemaining: result.remaining, overageApplied: 0, alertLevel };
    } catch (err) {
      logger.error({ userId, apiKeyId, amount, err: (err as Error).message }, 'Credit deduction failed');
      return empty;
    }
  }

  /** Pre-flight check: does the user have enough credits? */
  async hasSufficientCredits(userId: string, amount: number): Promise<boolean> {
    const balance = await this.getUserBalance(userId);
    return balance !== null && balance.creditsRemaining >= amount;
  }

  // -- Alert Thresholds -------------------------------------------------------

  /** Determine alert level based on remaining vs total credits. */
  determineAlertLevel(creditsRemaining: number, totalCredits: number): AlertLevel {
    if (totalCredits <= 0) return 'none';
    const fraction = creditsRemaining / totalCredits;
    if (fraction <= ALERT_THRESHOLDS.URGENT) return 'urgent';
    if (fraction <= ALERT_THRESHOLDS.CRITICAL) return 'critical';
    if (fraction <= ALERT_THRESHOLDS.WARNING) return 'warning';
    return 'none';
  }

  /** Check if a user crossed an alert threshold since last check. Returns shouldNotify on upgrade. */
  async checkAlertThreshold(userId: string): Promise<AlertCheckResult> {
    const balance = await this.getUserBalance(userId);
    if (!balance) {
      return { userId, previousLevel: 'none', currentLevel: 'none', creditsRemaining: 0, totalCredits: 0, percentRemaining: 0, shouldNotify: false };
    }

    let previousLevel: AlertLevel = 'none';
    try {
      const cached = await cacheGet<AlertLevel>(`pricing:alert:${userId}`);
      if (cached) previousLevel = cached;
    } catch { /* ignore */ }

    const currentLevel = balance.alertLevel;
    const percentRemaining = balance.totalCredits > 0 ? balance.creditsRemaining / balance.totalCredits : 0;
    const shouldNotify = this.isAlertUpgrade(previousLevel, currentLevel);

    try { await cacheSet(`pricing:alert:${userId}`, currentLevel, 86400); } catch { /* ignore */ }

    if (shouldNotify) {
      logger.warn({ userId, previousLevel, currentLevel, creditsRemaining: balance.creditsRemaining, percentRemaining: Math.round(percentRemaining * 100) }, 'Credit alert threshold crossed');
    }

    return { userId, previousLevel, currentLevel, creditsRemaining: balance.creditsRemaining, totalCredits: balance.totalCredits, percentRemaining, shouldNotify };
  }

  private isAlertUpgrade(previous: AlertLevel, current: AlertLevel): boolean {
    const severity: Record<AlertLevel, number> = { none: 0, warning: 1, critical: 2, urgent: 3 };
    return severity[current] > severity[previous];
  }

  // -- Plan Upgrade / Downgrade -----------------------------------------------

  /** Calculate prorated credit adjustment when changing plans. */
  calculatePlanChange(
    fromPlan: PricingTierKey,
    toPlan: PricingTierKey,
    creditsUsed: number,
    billingCycleStart: Date,
    billingCycleEnd: Date,
  ): PlanChangeResult {
    const fromTier = PRICING_TIERS[fromPlan];
    const toTier = PRICING_TIERS[toPlan];
    const now = new Date();
    const totalDays = Math.max(1, Math.ceil((billingCycleEnd.getTime() - billingCycleStart.getTime()) / 86400000));
    const elapsedDays = Math.max(0, Math.ceil((now.getTime() - billingCycleStart.getTime()) / 86400000));
    const remainingFraction = Math.max(0, 1 - elapsedDays / totalDays);

    const oldCreditsRemaining = Math.max(0, fromTier.includedCredits - creditsUsed);
    const proratedOldCredits = Math.floor(oldCreditsRemaining * remainingFraction);
    const proratedNewCredits = Math.floor(toTier.includedCredits * remainingFraction);
    const creditAdjustment = proratedNewCredits - proratedOldCredits;

    const fromPrice = fromTier.monthlyPrice >= 0 ? fromTier.monthlyPrice : 0;
    const toPrice = toTier.monthlyPrice >= 0 ? toTier.monthlyPrice : 0;
    const priceDifference = Math.round((toPrice - fromPrice) * remainingFraction * 100) / 100;

    return { fromPlan, toPlan, proratedCredits: proratedNewCredits, creditAdjustment, priceDifference, effectiveDate: now };
  }

  /** Execute a plan change: update plan and adjust credits across all API keys. */
  async changePlan(
    userId: string,
    toPlan: PricingTierKey,
    billingCycleStart: Date,
    billingCycleEnd: Date,
  ): Promise<PlanChangeResult | null> {
    try {
      const user = await db.user.findUnique({
        where: { id: userId },
        include: { apiKeys: { select: { id: true, creditsUsed: true, creditsRemaining: true } } },
      });
      if (!user) { logger.error({ userId }, 'User not found for plan change'); return null; }

      const fromPlan = (user.plan as PricingTierKey) || 'starter';
      const totalUsed = user.apiKeys.reduce((sum, k) => sum + k.creditsUsed, 0);
      const change = this.calculatePlanChange(fromPlan, toPlan, totalUsed, billingCycleStart, billingCycleEnd);

      // Enterprise is a custom tier not in the Prisma Plan enum; store as 'business'
      // with a separate metadata flag for enterprise features.
      const dbPlan = toPlan === 'enterprise' ? 'business' : toPlan;
      await db.user.update({ where: { id: userId }, data: { plan: dbPlan } });

      if (change.creditAdjustment !== 0 && user.apiKeys.length > 0) {
        for (const key of user.apiKeys) {
          const keyShare = key.creditsRemaining > 0
            ? Math.ceil(change.creditAdjustment / user.apiKeys.length)
            : 0;
          if (keyShare !== 0) {
            const adjustment = change.creditAdjustment > 0
              ? { creditsRemaining: { increment: Math.abs(keyShare) } }
              : { creditsRemaining: { decrement: Math.min(Math.abs(keyShare), key.creditsRemaining) } };
            await db.apiKey.update({ where: { id: key.id }, data: adjustment });
          }
        }
      }

      await this.invalidateBalanceCache(userId);
      logger.info({ userId, fromPlan, toPlan, creditAdjustment: change.creditAdjustment, priceDifference: change.priceDifference }, 'Plan changed');
      return change;
    } catch (err) {
      logger.error({ userId, toPlan, err: (err as Error).message }, 'Plan change failed');
      return null;
    }
  }

  // -- Usage Aggregation ------------------------------------------------------

  /** Aggregate usage for a user over a given period with Redis caching. */
  async aggregateUsage(
    userId: string,
    period: 'daily' | 'weekly' | 'monthly',
    periodStart?: Date,
    periodEnd?: Date,
  ): Promise<UsageAggregate | null> {
    const now = new Date();
    const pStart = periodStart ?? this.getPeriodStart(period, now);
    const pEnd = periodEnd ?? now;

    const cacheKey = `pricing:aggregate:${userId}:${period}:${pStart.toISOString().slice(0, 10)}`;
    try {
      const cached = await cacheGet<UsageAggregate>(cacheKey);
      if (cached) return cached;
    } catch { /* ignore */ }

    try {
      const jobs = await db.scrapeJob.findMany({
        where: { userId, createdAt: { gte: pStart, lte: pEnd } },
        select: { strategy: true, creditsUsed: true, bandwidthBytes: true, status: true, extractedData: true },
      });

      let httpScrapes = 0;
      let browserScrapes = 0;
      let totalCredits = 0;
      let bandwidthBytes = 0;
      let successCount = 0;
      let aiExtractions = 0;

      for (const job of jobs) {
        totalCredits += job.creditsUsed ?? 0;
        bandwidthBytes += job.bandwidthBytes ?? 0;
        if (job.status === 'done') successCount++;
        if (job.strategy === 'http' || job.strategy === 'cache') httpScrapes++;
        else if (job.strategy === 'browser' || job.strategy === 'stealth-browser') browserScrapes++;
        if (job.extractedData) aiExtractions++;
      }

      let serpApiCalls = 0;
      try { serpApiCalls = await db.serpResult.count({ where: { userId, createdAt: { gte: pStart, lte: pEnd } } }); } catch { /* table may not exist */ }
      let captchaSolves = 0;
      try { captchaSolves = await db.captchaLog.count({ where: { solved: true, createdAt: { gte: pStart, lte: pEnd } } }); } catch { /* table may not exist */ }

      const successRate = jobs.length > 0 ? Math.round((successCount / jobs.length) * 1000) / 1000 : 0;

      const aggregate: UsageAggregate = {
        userId, period, periodStart: pStart, periodEnd: pEnd,
        httpScrapes, browserScrapes, serpApiCalls, captchaSolves, aiExtractions,
        pdfPages: 0, cdpHours: 0, totalCredits, bandwidthBytes,
        proxyBandwidthBytes: { residential: 0, mobile: 0, datacenter: 0, isp: 0 },
        successRate,
      };

      try { await cacheSet(cacheKey, aggregate, AGGREGATE_CACHE_TTL); } catch { /* ignore */ }
      return aggregate;
    } catch (err) {
      logger.error({ userId, period, err: (err as Error).message }, 'Usage aggregation failed');
      return null;
    }
  }

  private getPeriodStart(period: 'daily' | 'weekly' | 'monthly', now: Date): Date {
    const start = new Date(now);
    switch (period) {
      case 'daily': start.setHours(0, 0, 0, 0); break;
      case 'weekly': start.setDate(start.getDate() - 7); start.setHours(0, 0, 0, 0); break;
      case 'monthly': start.setDate(1); start.setHours(0, 0, 0, 0); break;
    }
    return start;
  }

  // -- Invoice Generation -----------------------------------------------------

  /** Generate an invoice for a user's billing period with line items for each service type. */
  async generateInvoice(userId: string, periodStart: Date, periodEnd: Date): Promise<Invoice | null> {
    try {
      const balance = await this.getUserBalance(userId);
      if (!balance) { logger.error({ userId }, 'Cannot generate invoice: balance not found'); return null; }

      const tier = PRICING_TIERS[balance.plan];
      const lineItems: InvoiceLineItem[] = [];

      // Subscription fee
      if (tier.monthlyPrice > 0) {
        lineItems.push({ description: `${tier.name} Plan - Monthly Subscription`, quantity: 1, unitPrice: tier.monthlyPrice, total: tier.monthlyPrice, category: 'subscription' });
      }

      // Credit overage
      const overage = this.calculateOverage(balance.plan, balance.creditsUsed, balance.bandwidthBytes);
      if (overage.overageCredits > 0) {
        const unitPrice = tier.overagePerCredit >= 0 ? tier.overagePerCredit : 0;
        lineItems.push({ description: `Credit Overage (${overage.overageCredits.toLocaleString()} credits)`, quantity: overage.overageCredits, unitPrice, total: overage.overageCostUsd, category: 'overage' });
      }

      // Bandwidth overage
      if (overage.bandwidthOverageGB > 0) {
        lineItems.push({ description: `Bandwidth Overage (${overage.bandwidthOverageGB.toFixed(2)} GB)`, quantity: Math.round(overage.bandwidthOverageGB * 100) / 100, unitPrice: tier.bandwidthOveragePerGB >= 0 ? tier.bandwidthOveragePerGB : 0, total: overage.bandwidthOverageCostUsd, category: 'bandwidth' });
      }

      // Proxy bandwidth charges
      const usage = await this.aggregateUsage(userId, 'monthly', periodStart, periodEnd);
      if (usage) {
        for (const [proxyTier, bytes] of Object.entries(usage.proxyBandwidthBytes)) {
          if (bytes > 0) {
            const tierKey = proxyTier as ProxyTier;
            const usageGB = bytes / BYTES_PER_GB;
            const cost = this.calculateProxyBandwidthCost(tierKey, bytes);
            lineItems.push({ description: `${tierKey.charAt(0).toUpperCase() + tierKey.slice(1)} Proxy (${usageGB.toFixed(2)} GB)`, quantity: Math.round(usageGB * 100) / 100, unitPrice: PROXY_TIER_PRICING[tierKey], total: cost, category: 'proxy' });
          }
        }
      }

      // Volume discount
      const totalBandwidthGB = balance.bandwidthBytes / BYTES_PER_GB;
      const discountRate = this.getBandwidthDiscount(totalBandwidthGB);
      let discountAmount = 0;
      if (discountRate > 0) {
        const discountableTotal = lineItems
          .filter((item) => item.category === 'bandwidth' || item.category === 'proxy')
          .reduce((sum, item) => sum + item.total, 0);
        discountAmount = discountableTotal * discountRate;
        lineItems.push({ description: `Volume Discount (${Math.round(discountRate * 100)}% off bandwidth)`, quantity: 1, unitPrice: discountAmount, total: -discountAmount, category: 'discount' });
      }

      const subtotal = lineItems.reduce((sum, item) => sum + (item.category === 'discount' ? 0 : item.total), 0);
      const total = subtotal - discountAmount;

      const invoice: Invoice = {
        id: `inv-${crypto.randomUUID()}`, userId, periodStart, periodEnd, lineItems,
        subtotal: Math.round(subtotal * 100) / 100,
        discount: Math.round(discountAmount * 100) / 100,
        total: Math.round(total * 100) / 100,
        currency: 'USD', status: 'draft', generatedAt: new Date(),
      };

      logger.info({ invoiceId: invoice.id, userId, total: invoice.total, lineItemCount: lineItems.length }, 'Invoice generated');
      return invoice;
    } catch (err) {
      logger.error({ userId, err: (err as Error).message }, 'Invoice generation failed');
      return null;
    }
  }

  // -- Quick Estimate ---------------------------------------------------------

  /** Estimate monthly cost for a given plan and expected usage (for pricing page). */
  estimateMonthlyCost(params: {
    plan: PricingTierKey;
    expectedCredits: number;
    expectedBandwidthGB: number;
    proxyTier?: ProxyTier;
    expectedProxyBandwidthGB?: number;
  }): MonthlyEstimate {
    const tier = PRICING_TIERS[params.plan];
    const subscription = tier.monthlyPrice >= 0 ? tier.monthlyPrice : 0;
    const overageCredits = Math.max(0, params.expectedCredits - tier.includedCredits);
    const creditOverage = tier.overagePerCredit >= 0 ? overageCredits * tier.overagePerCredit : 0;
    const bwPrice = tier.bandwidthOveragePerGB >= 0 ? tier.bandwidthOveragePerGB : 0;
    const bwDiscount = this.getBandwidthDiscount(params.expectedBandwidthGB);
    const bandwidthOverage = params.expectedBandwidthGB * bwPrice * (1 - bwDiscount);

    let proxyCost = 0;
    if (params.proxyTier && params.expectedProxyBandwidthGB) {
      proxyCost = this.calculateProxyBandwidthCost(params.proxyTier, params.expectedProxyBandwidthGB * BYTES_PER_GB);
    }

    const discount = (bandwidthOverage + proxyCost) * bwDiscount;
    const total = subscription + creditOverage + bandwidthOverage + proxyCost - discount;

    return {
      subscription: Math.round(subscription * 100) / 100,
      creditOverage: Math.round(creditOverage * 100) / 100,
      bandwidthOverage: Math.round(bandwidthOverage * 100) / 100,
      proxyCost: Math.round(proxyCost * 100) / 100,
      discount: Math.round(discount * 100) / 100,
      total: Math.round(total * 100) / 100,
    };
  }

  // -- Reset Billing Cycle ----------------------------------------------------

  /** Reset credits for a new billing cycle across all API keys. */
  async resetBillingCycle(userId: string): Promise<void> {
    try {
      const user = await db.user.findUnique({
        where: { id: userId },
        include: { apiKeys: { select: { id: true } } },
      });
      if (!user) { logger.error({ userId }, 'User not found for billing cycle reset'); return; }

      const plan = (user.plan as PricingTierKey) || 'starter';
      const includedCredits = this.getIncludedCredits(plan);

      for (const key of user.apiKeys) {
        await db.apiKey.update({ where: { id: key.id }, data: { creditsRemaining: includedCredits, creditsUsed: 0, bandwidthBytes: 0 } });
      }

      await this.invalidateBalanceCache(userId);
      logger.info({ userId, plan, includedCredits, keyCount: user.apiKeys.length }, 'Billing cycle reset');
    } catch (err) {
      logger.error({ userId, err: (err as Error).message }, 'Billing cycle reset failed');
    }
  }
}

// --- Singleton ----------------------------------------------------------------

/** Shared singleton instance -- safe to import from any module. */
export const pricingEngine = new PricingEngine();
