import { CREDIT_COSTS, PLAN_CREDITS, type PlanTier, type JobStrategy } from '../types';

export function getCreditCost(operation: keyof typeof CREDIT_COSTS): number {
  return CREDIT_COSTS[operation];
}

export function calculateScrapeCredits(strategy: 'cache' | 'http' | 'browser' | 'stealth-browser', withExtraction: boolean): number {
  let credits = 0;
  switch (strategy) {
    case 'cache': credits = CREDIT_COSTS.CACHE_HIT; break;
    case 'http': credits = CREDIT_COSTS.HTTP_SCRAPE; break;
    case 'browser': credits = CREDIT_COSTS.BROWSER_RENDER; break;
    case 'stealth-browser': credits = CREDIT_COSTS.STEALTH_BROWSER; break;
  }
  if (withExtraction) credits += CREDIT_COSTS.NL_EXTRACTION;
  return credits;
}

export function calculateSuccessOnlyCredits(
  strategy: JobStrategy,
  withExtraction: boolean,
  statusCode: number,
): { estimated: number; actual: number } {
  const estimated = calculateScrapeCredits(
    strategy as 'cache' | 'http' | 'browser' | 'stealth-browser',
    withExtraction,
  );

  const isSuccess = statusCode >= 200 && statusCode < 400;
  const actual = isSuccess ? estimated : 0;

  return { estimated, actual };
}

export function getPlanCredits(plan: PlanTier): number {
  return PLAN_CREDITS[plan];
}

export function getJobPriority(plan: PlanTier): number {
  switch (plan) {
    case 'business': return 10;
    case 'pro': return 5;
    case 'starter': return 1;
  }
}

export function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function hashApiKey(key: string): string {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function generateApiKeyValue(): string {
  const crypto = require('crypto');
  const bytes = crypto.randomBytes(32).toString('hex');
  return `ss_live_${bytes}`;
}
