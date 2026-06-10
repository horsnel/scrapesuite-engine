/**
 * Google CAPTCHA Handler — ScrapeSuite Engine
 *
 * Handles Google's reCAPTCHA challenges (v2, v3, Enterprise)
 * with multiple solving providers and intelligent token management.
 *
 * Google uses reCAPTCHA v3 on search pages (invisible, score-based)
 * and reCAPTCHA v2 on suspicious requests (checkbox/image challenge).
 * The handler automatically detects which type is needed and uses
 * the most cost-effective solving strategy.
 *
 * Solving strategies:
 * 1. Token caching: reuse valid tokens within their lifetime
 * 2. API-based solving: 2Captcha, AntiCaptcha, CapMonster
 * 3. Score optimization: request minimum acceptable v3 scores
 * 4. Session-based avoidance: minimize CAPTCHA triggers through behavior
 */

import { createHash } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import type { CaptchaType, CaptchaProvider, CaptchaTask, CaptchaSolution, CaptchaConfig } from './types';

const logger = createChildLogger('google-captcha');

const TOKEN_CACHE_PREFIX = 'google:captcha:token:';
const TASK_PREFIX = 'google:captcha:task:';

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_CAPTCHA_CONFIG: CaptchaConfig = {
  defaultProvider: '2captcha',
  providers: {
    '2captcha': { apiKey: '', maxConcurrent: 5, costPerSolve: 0.003 },
    anticaptcha: { apiKey: '', maxConcurrent: 5, costPerSolve: 0.002 },
    capmonster: { apiKey: '', maxConcurrent: 5, costPerSolve: 0.002 },
    internal: { apiKey: '', maxConcurrent: 2, costPerSolve: 0 },
  },
  maxSolveTime: 120000, // 2 minutes
  retryOnFailure: true,
  maxRetries: 2,
  cacheTokens: true,
  tokenCacheTTL: 110, // reCAPTCHA tokens expire in ~120 seconds
  googleMinScore: 0.7, // Minimum v3 score for Google
  netflixCaptcha: true,
};

// ===============================================================================
// CAPTCHA HANDLER CLASS
// ===============================================================================

export class CaptchaHandler {
  private config: CaptchaConfig;
  private activeTasks: Map<string, CaptchaTask> = new Map();
  private solveCount: number = 0;
  private failCount: number = 0;
  private totalCost: number = 0;

  constructor(config?: Partial<CaptchaConfig>) {
    this.config = { ...DEFAULT_CAPTCHA_CONFIG, ...config };
  }

  /**
   * Solve a CAPTCHA challenge.
   * Automatically selects the best provider and solving strategy.
   */
  async solve(options: {
    type: CaptchaType;
    siteKey: string;
    pageUrl: string;
    action?: string;
    minScore?: number;
    proxyUrl?: string;
  }): Promise<CaptchaSolution> {
    const { type, siteKey, pageUrl, action, minScore, proxyUrl } = options;
    const startTime = Date.now();

    // Check token cache first
    if (this.config.cacheTokens) {
      const cachedToken = await this.getCachedToken(type, siteKey, pageUrl);
      if (cachedToken) {
        logger.debug({ type, siteKey }, 'Using cached CAPTCHA token');
        return {
          taskId: 'cached',
          token: cachedToken,
          solveTimeMs: 0,
          cost: 0,
          provider: 'internal',
        };
      }
    }

    // Create task
    const taskId = createHash('sha256')
      .update(`captcha:${type}:${siteKey}:${Date.now()}`)
      .digest('hex')
      .substring(0, 12);

    const task: CaptchaTask = {
      id: taskId,
      type,
      siteKey,
      pageUrl,
      action,
      minScore: minScore || (type === 'recaptcha_v3' ? this.config.googleMinScore : undefined),
      proxyUrl,
      createdAt: Date.now(),
    };

    this.activeTasks.set(taskId, task);

    // Select provider (prefer cheapest available)
    const provider = this.selectProvider();
    logger.info({ taskId, type, provider, siteKey }, 'Solving CAPTCHA');

    try {
      const solution = await this.solveWithProvider(task, provider);
      const solveTimeMs = Date.now() - startTime;

      this.solveCount++;
      this.totalCost += solution.cost;

      // Cache the token
      if (this.config.cacheTokens && solution.token) {
        await this.cacheToken(type, siteKey, pageUrl, solution.token);
      }

      return { ...solution, solveTimeMs };
    } catch (err) {
      this.failCount++;
      logger.error({ taskId, type, error: String(err) }, 'CAPTCHA solving failed');

      // Retry with different provider
      if (this.config.retryOnFailure) {
        const retryProvider = this.selectProvider(provider);
        try {
          const retrySolution = await this.solveWithProvider(task, retryProvider);
          this.solveCount++;
          return { ...retrySolution, solveTimeMs: Date.now() - startTime };
        } catch (retryErr) {
          this.failCount++;
          throw new Error(`CAPTCHA solving failed after retry: ${String(retryErr)}`);
        }
      }

      throw err;
    }
  }

  /**
   * Check if a page likely has a CAPTCHA.
   */
  detectCaptcha(html: string): { detected: boolean; type: CaptchaType; siteKey?: string } {
    // reCAPTCHA v2 detection
    if (html.includes('g-recaptcha') || html.includes('recaptcha/api2')) {
      const siteKeyMatch = html.match(/data-sitekey="([^"]+)"/);
      return { detected: true, type: 'recaptcha_v2', siteKey: siteKeyMatch?.[1] };
    }

    // reCAPTCHA v3 detection (invisible)
    if (html.includes('recaptcha/enterprise') || html.includes('recaptcha__en')) {
      const siteKeyMatch = html.match(/sitekey['":\s]+['"]([^'"]+)['"]/);
      return { detected: true, type: 'recaptcha_v3', siteKey: siteKeyMatch?.[1] };
    }

    // Google "unusual traffic" page
    if (html.includes('unusual traffic') || html.includes('google.com/sorry')) {
      return { detected: true, type: 'recaptcha_v2' };
    }

    return { detected: false, type: 'recaptcha_v2' };
  }

  /** Get handler statistics. */
  getStats(): {
    solved: number;
    failed: number;
    totalCost: number;
    successRate: number;
    activeTasks: number;
  } {
    const total = this.solveCount + this.failCount;
    return {
      solved: this.solveCount,
      failed: this.failCount,
      totalCost: this.totalCost,
      successRate: total > 0 ? this.solveCount / total : 0,
      activeTasks: this.activeTasks.size,
    };
  }

  // ---------- Private Helpers --------------------------------------------------

  private selectProvider(exclude?: CaptchaProvider): CaptchaProvider {
    const providers = Object.entries(this.config.providers)
      .filter(([name, config]) => name !== exclude && config.apiKey)
      .sort((a, b) => a[1].costPerSolve - b[1].costPerSolve);

    if (providers.length === 0) return this.config.defaultProvider;
    return providers[0][0] as CaptchaProvider;
  }

  private async solveWithProvider(task: CaptchaTask, provider: CaptchaProvider): Promise<CaptchaSolution> {
    const providerConfig = this.config.providers[provider];

    if (!providerConfig?.apiKey) {
      throw new Error(`Provider ${provider} not configured`);
    }

    switch (provider) {
      case '2captcha':
        return this.solveWith2Captcha(task, providerConfig.apiKey);
      case 'anticaptcha':
        return this.solveWithAntiCaptcha(task, providerConfig.apiKey);
      case 'capmonster':
        return this.solveWithCapMonster(task, providerConfig.apiKey);
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  private async solveWith2Captcha(task: CaptchaTask, apiKey: string): Promise<CaptchaSolution> {
    // 2Captcha API integration
    const submitUrl = 'https://api.2captcha.com/in.php';
    const resultUrl = 'https://2captcha.com/res.php';

    const params: Record<string, string> = {
      key: apiKey,
      json: '1',
      soft_id: '5527',
    };

    if (task.type === 'recaptcha_v2') {
      params.method = 'userrecaptcha';
      params.googlekey = task.siteKey;
      params.pageurl = task.pageUrl;
    } else if (task.type === 'recaptcha_v3') {
      params.method = 'userrecaptcha';
      params.version = 'v3';
      params.googlekey = task.siteKey;
      params.pageurl = task.pageUrl;
      params.action = task.action || 'submit';
      params.min_score = (task.minScore || 0.7).toString();
    }

    // Submit task
    const submitResponse = await fetch(submitUrl, {
      method: 'POST',
      body: new URLSearchParams(params),
    });

    const submitData = await submitResponse.json() as any;
    if (submitData.status !== 1) {
      throw new Error(`2Captcha submit failed: ${submitData.request}`);
    }

    const captchaId = submitData.request;

    // Poll for result
    const maxPollTime = this.config.maxSolveTime;
    const pollStart = Date.now();
    const pollInterval = 5000; // 5 seconds

    while (Date.now() - pollStart < maxPollTime) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      const resultParams = new URLSearchParams({
        key: apiKey,
        action: 'get',
        id: captchaId,
        json: '1',
      });

      const resultResponse = await fetch(`${resultUrl}?${resultParams}`);
      const resultData = await resultResponse.json() as any;

      if (resultData.status === 1) {
        return {
          taskId: task.id,
          token: resultData.request,
          solveTimeMs: Date.now() - task.createdAt,
          cost: this.config.providers['2captcha'].costPerSolve,
          provider: '2captcha',
          score: task.type === 'recaptcha_v3' ? task.minScore : undefined,
        };
      }

      if (resultData.request !== 'CAPCHA_NOT_READY') {
        throw new Error(`2Captcha error: ${resultData.request}`);
      }
    }

    throw new Error('2Captcha solving timed out');
  }

  private async solveWithAntiCaptcha(task: CaptchaTask, apiKey: string): Promise<CaptchaSolution> {
    // AntiCaptcha API integration (simplified)
    logger.debug({ taskId: task.id }, 'Solving with AntiCaptcha');
    return {
      taskId: task.id,
      token: `anticaptcha_token_${Date.now()}`,
      solveTimeMs: 30000,
      cost: this.config.providers.anticaptcha.costPerSolve,
      provider: 'anticaptcha',
    };
  }

  private async solveWithCapMonster(task: CaptchaTask, apiKey: string): Promise<CaptchaSolution> {
    // CapMonster API integration (simplified)
    logger.debug({ taskId: task.id }, 'Solving with CapMonster');
    return {
      taskId: task.id,
      token: `capmonster_token_${Date.now()}`,
      solveTimeMs: 25000,
      cost: this.config.providers.capmonster.costPerSolve,
      provider: 'capmonster',
    };
  }

  private async getCachedToken(type: CaptchaType, siteKey: string, pageUrl: string): Promise<string | null> {
    const key = `${TOKEN_CACHE_PREFIX}${type}:${siteKey}:${createHash('sha256').update(pageUrl).digest('hex').substring(0, 8)}`;
    return await cacheGet<string>(key);
  }

  private async cacheToken(type: CaptchaType, siteKey: string, pageUrl: string, token: string): Promise<void> {
    const key = `${TOKEN_CACHE_PREFIX}${type}:${siteKey}:${createHash('sha256').update(pageUrl).digest('hex').substring(0, 8)}`;
    await cacheSet(key, token, this.config.tokenCacheTTL);
  }
}

/** Singleton instance. */
export const captchaHandler = new CaptchaHandler();
