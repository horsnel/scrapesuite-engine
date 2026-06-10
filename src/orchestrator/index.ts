import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';
import { calculateScrapeCredits } from '../utils/credits';
import { domainIntelligence } from '../intelligence/domain';
import { proxyManager } from '../proxy/manager';
import { stealthEngine } from '../anti-bot/stealth';
import { humanBehavior } from '../anti-bot/human-behavior';
import { robotsParser } from '../robots/parser';
import { webhookDispatcher } from '../scheduler/webhooks';
import { genericParser } from '../structured/generic';
import { amazonParser } from '../structured/amazon';
import { googleSerpParser } from '../structured/google';
import { browserPool, type BrowserLease } from '../browser-pool';
import { captchaSolver } from '../captcha';
import { proxyFetch, testProxy } from '../utils/proxy-fetch';
import { tlsFingerprintFetcher } from '../anti-bot/tls-fingerprint';
import { adaptiveRateLimiter } from '../rate-limiter';
import { sessionManager } from '../session';
import { templateRegistry } from '../templates';
import { outputPipeline, type OutputFormat } from '../output';
import type { ScrapeJobData, ScrapeJobResult, JobStrategy, AntiBotDetection } from '../types';
import { deductCredits } from '../api/middleware/credits';

const logger = createChildLogger('orchestrator');

// --- Constants ----------------------------------------------------------------

const DEFAULT_TIMEOUT = 30_000;
const RATE_LIMIT_WINDOW_SECONDS = 1;
const MAX_RETRIES = 3;  // Increased from 2 to support new retry scenarios
const PROXY_RETRY_DELAY_MS = 2_000;  // Short delay before proxy rotation retry on 503
const CAPTCHA_ROTATE_RETRY_DELAY_MS = 1_000;

// --- Request Deduplication ----------------------------------------------------

interface PendingRequest {
  promise: Promise<ScrapeJobResult>;
  resolve: (result: ScrapeJobResult) => void;
  reject: (error: Error) => void;
}

const inflightRequests = new Map<string, PendingRequest>();

function getDedupeKey(data: ScrapeJobData): string {
  // Dedupe by URL + strategy + extraction instruction + session
  return `${data.url}:${data.strategy || 'auto'}:${data.extract || ''}:${data.proxyTier || ''}:${data.proxyCountry || ''}:${data.proxyCity || ''}:${data.sessionId || ''}`;
}

// --- Orchestrator -------------------------------------------------------------

export class Orchestrator {
  /**
   * Process a scrape job through the full pipeline:
   *   dedupe → robots → cache → session → intelligence → adaptive rate limit →
   *   proxy → stealth → fetch → smart retry → record → cache →
   *   template extraction → structured → NL extract → captcha →
   *   output pipeline → bill → persist
   */
  async processJob(data: ScrapeJobData): Promise<ScrapeJobResult> {
    // -- Request Deduplication --------------------------------------------
    const dedupeKey = getDedupeKey(data);
    const existing = inflightRequests.get(dedupeKey);
    if (existing) {
      logger.info({ jobId: data.jobId, url: data.url }, 'Deduped -- waiting for identical in-flight request');
      return existing.promise;
    }

    const pending: Partial<PendingRequest> = {};
    pending.promise = new Promise<ScrapeJobResult>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    inflightRequests.set(dedupeKey, pending as PendingRequest);

    try {
      const result = await this._processJob(data);
      pending.resolve!(result);
      return result;
    } catch (err: any) {
      const result: ScrapeJobResult = {
        jobId: data.jobId,
        status: 'failed',
        strategy: 'http',
        creditsUsed: 0,
        creditsCharged: 0,
        statusCode: 502,
        responseMs: 0,
        error: err.message,
        cached: false,
      };
      pending.resolve!(result);
      return result;
    } finally {
      inflightRequests.delete(dedupeKey);
    }
  }

  private async _processJob(data: ScrapeJobData): Promise<ScrapeJobResult> {
    const startTime = Date.now();
    const domain = data.domain;
    let strategy: JobStrategy = 'http';
    let creditsUsed = 0;
    let creditsCharged = 0;
    let cached = false;
    let html = '';
    let statusCode = 200;
    let extracted: Record<string, any> | undefined;
    let structuredData: Record<string, any> | undefined;
    let proxyId: string | undefined;
    let proxyCountry: string | undefined;
    let proxyUrl: string | undefined;
    let captchaSolved = false;
    let error: string | undefined;
    let retryCount = 0;
    let bandwidthBytes = 0;
    let responseHeaders: Record<string, string> = {};
    let finalUrl = data.url;
    let outputCompressionRatio: number | undefined;
    let appliedOutputFormat: OutputFormat | undefined;

    // Session state -- populated when sessionId is provided
    let sessionState: import('../session').SessionState | null = null;

    try {
      // -- Step 1: Check robots.txt --------------------------------------
      if (data.respectRobotsTxt !== false) {
        const robotsCheck = await robotsParser.isAllowed(data.url, 'ScrapeSuite');
        if (!robotsCheck.allowed) {
          logger.info({ jobId: data.jobId, url: data.url }, 'Blocked by robots.txt');
          return {
            jobId: data.jobId,
            status: 'failed',
            strategy: 'cache',
            creditsUsed: 0,
            creditsCharged: 0,
            statusCode: 403,
            responseMs: Date.now() - startTime,
            error: 'URL disallowed by robots.txt',
            cached: false,
          };
        }
      }

      // -- Step 2: Check Redis cache -------------------------------------
      const cachedResult = await this.checkCache(data.url);
      if (cachedResult) {
        cached = true;
        creditsUsed = 0;
        creditsCharged = 0;
        html = cachedResult.html;
        statusCode = cachedResult.statusCode;
        strategy = 'cache';
        logger.info({ jobId: data.jobId, url: data.url, strategy: 'cache' }, 'Cache hit');
      }

      if (!cached) {
        // -- Step 3: Session Manager Integration -------------------------
        // If a sessionId is provided, retrieve or create the session state
        // to reuse the same proxy and fingerprint for geo-consistency.
        if (data.sessionId) {
          try {
            sessionState = await sessionManager.getSession(data.sessionId);
            if (sessionState) {
              // Refresh the session TTL on use (sliding window)
              sessionState = await sessionManager.refreshSession(data.sessionId);
              if (sessionState) {
                logger.info(
                  { jobId: data.jobId, sessionId: data.sessionId, proxyId: sessionState.proxyId, proxyCountry: sessionState.proxyCountry },
                  'Session found -- using session proxy and fingerprint',
                );
                // Use the session's proxy and fingerprint
                proxyUrl = sessionState.proxyUrl;
                proxyId = sessionState.proxyId;
                proxyCountry = sessionState.proxyCountry;
              }
            } else {
              // Session doesn't exist or expired -- create a new one
              logger.info(
                { jobId: data.jobId, sessionId: data.sessionId },
                'Session not found or expired -- creating new session',
              );
              try {
                sessionState = await sessionManager.createSession({
                  userId: data.userId,
                  proxyTier: (data.proxyTier as any) || 'residential',
                  proxyCountry: data.proxyCountry,
                  proxyCity: data.proxyCity,
                  proxyAsn: data.proxyAsn,
                  domain,
                });
                proxyUrl = sessionState.proxyUrl;
                proxyId = sessionState.proxyId;
                proxyCountry = sessionState.proxyCountry;
                logger.info(
                  { jobId: data.jobId, sessionId: sessionState.sessionId, proxyId, proxyCountry },
                  'New session created with proxy',
                );
              } catch (sessionErr: any) {
                logger.warn(
                  { jobId: data.jobId, sessionId: data.sessionId, error: sessionErr.message },
                  'Failed to create session -- proceeding without session',
                );
              }
            }
          } catch (sessionErr: any) {
            logger.warn(
              { jobId: data.jobId, sessionId: data.sessionId, error: sessionErr.message },
              'Session manager error -- proceeding without session',
            );
          }
        }

        // -- Step 4: Consult Domain Intelligence -------------------------
        const recommendation = await domainIntelligence.recommendStrategy(domain);

        // -- Step 5: Acquire adaptive rate limit token -------------------
        // Uses the new AdaptiveRateLimiter instead of the simple Redis counter.
        try {
          const rateResult = await adaptiveRateLimiter.acquireToken(domain);
          if (!rateResult.allowed) {
            logger.info(
              { jobId: data.jobId, domain, waitMs: rateResult.waitMs, currentRps: rateResult.currentRps },
              'Rate limited -- waiting before proceeding',
            );
            await this.sleep(rateResult.waitMs);
            // Try one more time after waiting
            const retryResult = await adaptiveRateLimiter.acquireToken(domain);
            if (!retryResult.allowed) {
              logger.warn(
                { jobId: data.jobId, domain, waitMs: retryResult.waitMs },
                'Rate limit token still not available after wait -- proceeding anyway',
              );
            }
          }
        } catch (rateErr: any) {
          logger.warn(
            { jobId: data.jobId, domain, error: rateErr.message },
            'Adaptive rate limiter error -- falling back to simple rate limit',
          );
          // Fallback to the old simple rate limiter
          await this.acquireSimpleRateLimitToken(domain, recommendation.safeRps);
        }

        // -- Step 6: Get proxy from Smart IP Pool (v3.1+) -----------------
        // Uses the unified mega-pool with reputation tracking, IP cooling,
        // auto-scaling, and multi-provider aggregation. Falls back to
        // legacy getProxy() if the smart pool fails.
        // If session already provided a proxy, skip this step.
        if (!proxyUrl) {
          const proxySelection = await proxyManager.getSmartProxy(
            domain,
            (data.proxyTier as any) || recommendation.proxyTier,
            data.proxyCountry,
            {
              city: data.proxyCity,
              asn: data.proxyAsn,
              sessionId: data.sessionId,
              // For domains known to have anti-bot, require IPs with good reputation
              requireReputation: recommendation.strategy === 'stealth-browser',
            },
          );

          proxyUrl = proxySelection?.proxyUrl;
          proxyId = proxySelection?.proxyId;
          proxyCountry = proxySelection?.country;
        }

        // -- Step 7: Execute fetch (with smart retry logic) --------------
        const effectiveStrategy: JobStrategy =
          data.strategy === 'auto' || !data.strategy
            ? recommendation.strategy
            : (data.strategy as JobStrategy);

        // If renderJs is requested, force browser strategy
        const forceBrowser = data.renderJs === true;
        let actualStrategy: JobStrategy = forceBrowser && effectiveStrategy === 'http'
          ? 'browser'
          : effectiveStrategy;

        // If session has a fingerprint profile, use it for stealth browser requests
        // (handled inside fetchViaStealthBrowser / fetchViaHttp via stealthEngine.getRandomProfile())

        let fetchResult = await this.executeFetch(
          actualStrategy, data.url, domain, proxyUrl,
          data.waitForSelector, data.timeout, data.headers,
        );

        html = fetchResult.html;
        statusCode = fetchResult.statusCode;
        strategy = fetchResult.strategy;
        bandwidthBytes = Buffer.byteLength(html, 'utf8');
        responseHeaders = fetchResult.headers || {};
        finalUrl = fetchResult.finalUrl || data.url;

        // Record the initial response to the adaptive rate limiter
        const isSuccess = statusCode >= 200 && statusCode < 400;
        try {
          await adaptiveRateLimiter.recordResponse(domain, {
            success: isSuccess,
            statusCode,
            responseMs: Date.now() - startTime,
          });
        } catch (rateErr: any) {
          logger.debug({ domain, error: rateErr.message }, 'Failed to record response to adaptive rate limiter');
        }

        // -- Step 8: Smart Retry -- Empty HTML → browser -----------------
        if (strategy === 'http' && this.isEmptyHtml(html) && retryCount < MAX_RETRIES) {
          retryCount++;
          logger.info({ jobId: data.jobId, url: data.url, retry: retryCount }, 'Empty HTML -- escalating to browser');

          // Rotate fingerprint before retry
          const rotatedProfile = stealthEngine.getRandomProfile();
          logger.debug(
            { jobId: data.jobId, userAgent: rotatedProfile.userAgent },
            'Rotated fingerprint profile for retry',
          );

          fetchResult = await this.executeFetch(
            'browser', data.url, domain, proxyUrl,
            data.waitForSelector, data.timeout, data.headers,
          );
          html = fetchResult.html;
          statusCode = fetchResult.statusCode;
          strategy = fetchResult.strategy;
          bandwidthBytes = Buffer.byteLength(html, 'utf8');
          responseHeaders = fetchResult.headers || {};

          // Record retry outcome
          try {
            await adaptiveRateLimiter.recordResponse(domain, {
              success: statusCode >= 200 && statusCode < 400,
              statusCode,
              responseMs: Date.now() - startTime,
            });
          } catch {}
        }

        // -- Step 9: Smart Retry -- 429 Rate Limited ---------------------
        if (statusCode === 429 && retryCount < MAX_RETRIES) {
          retryCount++;
          logger.info(
            { jobId: data.jobId, url: data.url, retry: retryCount, currentRps: (await adaptiveRateLimiter.getDomainStatus(domain)).currentRps },
            '429 rate-limited -- waiting cooldown then retrying with different proxy',
          );

          // Wait based on adaptive rate limiter's cooldown
          const domainStatus = await adaptiveRateLimiter.getDomainStatus(domain).catch(() => null);
          const cooldownMs = domainStatus?.cooldownRemainingMs || 5_000;
          logger.info({ jobId: data.jobId, domain, cooldownMs }, 'Waiting for rate limit cooldown');
          await this.sleep(cooldownMs + 500); // Add small buffer

          // Get a DIFFERENT proxy for the retry
          const retryProxy = await proxyManager.getProxy(domain, 'residential', data.proxyCountry, 'random');
          const retryProxyUrl = retryProxy?.proxyUrl || proxyUrl;

          // Rotate fingerprint
          stealthEngine.getRandomProfile();

          // Re-acquire rate limit token after cooldown
          try {
            const retryToken = await adaptiveRateLimiter.acquireToken(domain);
            if (!retryToken.allowed) {
              await this.sleep(retryToken.waitMs);
            }
          } catch {}

          // Retry with stealth browser (more resilient to rate limits)
          fetchResult = await this.executeFetch(
            'stealth-browser', data.url, domain, retryProxyUrl,
            data.waitForSelector, data.timeout, data.headers,
          );

          if (fetchResult.statusCode >= 200 && fetchResult.statusCode < 400) {
            html = fetchResult.html;
            statusCode = fetchResult.statusCode;
            strategy = fetchResult.strategy;
            bandwidthBytes = Buffer.byteLength(html, 'utf8');
            responseHeaders = fetchResult.headers || {};
            if (retryProxy) {
              proxyId = retryProxy.proxyId;
              proxyCountry = retryProxy.country;
              proxyUrl = retryProxyUrl;
            }
          }

          // Record retry outcome
          try {
            await adaptiveRateLimiter.recordResponse(domain, {
              success: fetchResult.statusCode >= 200 && fetchResult.statusCode < 400,
              statusCode: fetchResult.statusCode,
              responseMs: Date.now() - startTime,
            });
          } catch {}
        }

        // -- Step 10: Smart Retry -- 403 with Anti-bot -------------------
        const antiBot = this.detectAntiBot(html);
        if (
          (statusCode === 403 && (antiBot.confidenceScore > 0.3 || antiBot.cloudflare || antiBot.datadome || antiBot.akamai)) &&
          retryCount < MAX_RETRIES
        ) {
          retryCount++;
          logger.info(
            { jobId: data.jobId, url: data.url, retry: retryCount, antiBotScore: antiBot.confidenceScore },
            '403 with anti-bot detected -- rotating proxy AND fingerprint, retrying with stealth',
          );

          // Rotate BOTH proxy AND fingerprint
          const retryProxy = await proxyManager.getProxy(domain, 'residential', data.proxyCountry, 'random');
          const retryProxyUrl = retryProxy?.proxyUrl || proxyUrl;
          const rotatedProfile = stealthEngine.getRandomProfile();
          logger.debug(
            { jobId: data.jobId, rotatedUserAgent: rotatedProfile.userAgent, rotatedPlatform: rotatedProfile.platform },
            'Rotated fingerprint profile for anti-bot retry',
          );

          fetchResult = await this.executeFetch(
            'stealth-browser', data.url, domain, retryProxyUrl,
            data.waitForSelector, data.timeout, data.headers,
          );

          if (fetchResult.statusCode >= 200 && fetchResult.statusCode < 400) {
            html = fetchResult.html;
            statusCode = fetchResult.statusCode;
            strategy = fetchResult.strategy;
            bandwidthBytes = Buffer.byteLength(html, 'utf8');
            responseHeaders = fetchResult.headers || {};
            if (retryProxy) {
              proxyId = retryProxy.proxyId;
              proxyCountry = retryProxy.country;
              proxyUrl = retryProxyUrl;
            }
          }

          // Record retry outcome
          try {
            await adaptiveRateLimiter.recordResponse(domain, {
              success: fetchResult.statusCode >= 200 && fetchResult.statusCode < 400,
              statusCode: fetchResult.statusCode,
              responseMs: Date.now() - startTime,
              hadAntiBot: true,
            });
          } catch {}
        }

        // -- Step 11: Smart Retry -- 503 Service Unavailable --------------
        if (statusCode === 503 && retryCount < MAX_RETRIES) {
          retryCount++;
          logger.info(
            { jobId: data.jobId, url: data.url, retry: retryCount },
            '503 service unavailable -- retrying with different proxy after delay',
          );

          // Short delay before retry
          await this.sleep(PROXY_RETRY_DELAY_MS);

          // Get a different proxy
          const retryProxy = await proxyManager.getProxy(domain, 'residential', data.proxyCountry, 'random');
          const retryProxyUrl = retryProxy?.proxyUrl || proxyUrl;

          // Rotate fingerprint
          stealthEngine.getRandomProfile();

          fetchResult = await this.executeFetch(
            actualStrategy, data.url, domain, retryProxyUrl,
            data.waitForSelector, data.timeout, data.headers,
          );

          if (fetchResult.statusCode >= 200 && fetchResult.statusCode < 400) {
            html = fetchResult.html;
            statusCode = fetchResult.statusCode;
            strategy = fetchResult.strategy;
            bandwidthBytes = Buffer.byteLength(html, 'utf8');
            responseHeaders = fetchResult.headers || {};
            if (retryProxy) {
              proxyId = retryProxy.proxyId;
              proxyCountry = retryProxy.country;
              proxyUrl = retryProxyUrl;
            }
          }

          // Record retry outcome
          try {
            await adaptiveRateLimiter.recordResponse(domain, {
              success: fetchResult.statusCode >= 200 && fetchResult.statusCode < 400,
              statusCode: fetchResult.statusCode,
              responseMs: Date.now() - startTime,
            });
          } catch {}
        }

        // -- Step 12: Anti-bot detected (existing escalation) ------------
        // Kept as a fallback for cases where status is 403 but no anti-bot was
        // specifically detected, or anti-bot is detected on other status codes.
        const recheckAntiBot = this.detectAntiBot(html);
        if (
          (statusCode === 403 || recheckAntiBot.confidenceScore > 0.5) &&
          strategy !== 'stealth-browser' &&
          retryCount < MAX_RETRIES &&
          // Don't double-retry if we already handled 403+anti-bot above
          !(statusCode === 403 && (antiBot.confidenceScore > 0.3 || antiBot.cloudflare || antiBot.datadome || antiBot.akamai))
        ) {
          retryCount++;
          logger.info({ jobId: data.jobId, url: data.url, retry: retryCount }, 'Anti-bot detected -- escalating to stealth');

          // Try getting a different proxy for the retry
          const retryProxy = retryCount > 1
            ? await proxyManager.getProxy(domain, 'residential', data.proxyCountry, 'random')
            : null;
          const retryProxyUrl = retryProxy?.proxyUrl || proxyUrl;

          // Rotate fingerprint
          stealthEngine.getRandomProfile();

          fetchResult = await this.executeFetch(
            'stealth-browser', data.url, domain, retryProxyUrl,
            data.waitForSelector, data.timeout, data.headers,
          );
          if (fetchResult.statusCode >= 200 && fetchResult.statusCode < 400) {
            html = fetchResult.html;
            statusCode = fetchResult.statusCode;
            strategy = fetchResult.strategy;
            bandwidthBytes = Buffer.byteLength(html, 'utf8');
            responseHeaders = fetchResult.headers || {};
            if (retryProxy) {
              proxyId = retryProxy.proxyId;
              proxyCountry = retryProxy.country;
              proxyUrl = retryProxyUrl;
            }
          }

          // Record retry outcome
          try {
            await adaptiveRateLimiter.recordResponse(domain, {
              success: fetchResult.statusCode >= 200 && fetchResult.statusCode < 400,
              statusCode: fetchResult.statusCode,
              responseMs: Date.now() - startTime,
              hadAntiBot: true,
            });
          } catch {}
        }

        // -- Step 13: CAPTCHA solving (with fallback to proxy rotation) --
        const finalAntiBot = this.detectAntiBot(html);
        const hasCaptcha = finalAntiBot.reCaptcha || finalAntiBot.hCaptcha || finalAntiBot.cloudflareVariant === 'turnstile';

        if (
          hasCaptcha &&
          data.solveCaptcha !== false &&
          captchaSolver.isConfigured
        ) {
          try {
            const captchaType = finalAntiBot.reCaptcha ? 'recaptcha_v2'
              : finalAntiBot.hCaptcha ? 'hcaptcha'
              : 'turnstile';

            // Extract site key from HTML
            const siteKey = this.extractCaptchaSiteKey(html, captchaType);
            if (siteKey) {
              logger.info({ jobId: data.jobId, type: captchaType, siteKey }, 'Attempting CAPTCHA solve');

              const solveResult = await captchaSolver.solve({
                url: data.url,
                siteKey,
                type: captchaType as any,
                proxyUrl,
              });

              if (solveResult.success) {
                captchaSolved = true;
                creditsUsed += 3; // CAPTCHA_SOLVE cost

                // Retry with the CAPTCHA token -- inject it into the page
                if (strategy === 'browser' || strategy === 'stealth-browser') {
                  const retryResult = await this.retryWithCaptchaToken(
                    data.url, domain, proxyUrl, solveResult.token,
                    captchaType, data.waitForSelector, data.timeout,
                  );
                  if (retryResult.statusCode >= 200 && retryResult.statusCode < 400) {
                    html = retryResult.html;
                    statusCode = retryResult.statusCode;
                    bandwidthBytes = Buffer.byteLength(html, 'utf8');
                  }
                }
              } else {
                // -- CAPTCHA solving failed -- rotate proxy and retry with stealth --
                if (retryCount < MAX_RETRIES) {
                  retryCount++;
                  logger.info(
                    { jobId: data.jobId, retry: retryCount },
                    'CAPTCHA solving failed -- rotating proxy and retrying with stealth',
                  );

                  await this.sleep(CAPTCHA_ROTATE_RETRY_DELAY_MS);

                  const retryProxy = await proxyManager.getProxy(domain, 'residential', data.proxyCountry, 'random');
                  const retryProxyUrl = retryProxy?.proxyUrl || proxyUrl;
                  stealthEngine.getRandomProfile(); // Rotate fingerprint

                  fetchResult = await this.executeFetch(
                    'stealth-browser', data.url, domain, retryProxyUrl,
                    data.waitForSelector, data.timeout, data.headers,
                  );

                  if (fetchResult.statusCode >= 200 && fetchResult.statusCode < 400) {
                    html = fetchResult.html;
                    statusCode = fetchResult.statusCode;
                    strategy = fetchResult.strategy;
                    bandwidthBytes = Buffer.byteLength(html, 'utf8');
                    responseHeaders = fetchResult.headers || {};
                    if (retryProxy) {
                      proxyId = retryProxy.proxyId;
                      proxyCountry = retryProxy.country;
                      proxyUrl = retryProxyUrl;
                    }
                  }
                }
              }
            }
          } catch (captchaErr: any) {
            logger.warn({ jobId: data.jobId, error: captchaErr.message }, 'CAPTCHA solving failed');

            // On CAPTCHA error, try proxy rotation + stealth as last resort
            if (retryCount < MAX_RETRIES) {
              retryCount++;
              logger.info(
                { jobId: data.jobId, retry: retryCount },
                'CAPTCHA error -- rotating proxy and retrying with stealth',
              );

              try {
                const retryProxy = await proxyManager.getProxy(domain, 'residential', data.proxyCountry, 'random');
                const retryProxyUrl = retryProxy?.proxyUrl || proxyUrl;
                stealthEngine.getRandomProfile();

                fetchResult = await this.executeFetch(
                  'stealth-browser', data.url, domain, retryProxyUrl,
                  data.waitForSelector, data.timeout, data.headers,
                );

                if (fetchResult.statusCode >= 200 && fetchResult.statusCode < 400) {
                  html = fetchResult.html;
                  statusCode = fetchResult.statusCode;
                  strategy = fetchResult.strategy;
                  bandwidthBytes = Buffer.byteLength(html, 'utf8');
                  responseHeaders = fetchResult.headers || {};
                  if (retryProxy) {
                    proxyId = retryProxy.proxyId;
                    proxyCountry = retryProxy.country;
                    proxyUrl = retryProxyUrl;
                  }
                }
              } catch (rotateErr: any) {
                logger.warn(
                  { jobId: data.jobId, error: rotateErr.message },
                  'Post-CAPTCHA proxy rotation also failed',
                );
              }
            }
          }
        }

        // -- Step 14: Record anti-bot detection --------------------------
        if (finalAntiBot.cloudflare || finalAntiBot.datadome || finalAntiBot.akamai) {
          logger.warn(
            { jobId: data.jobId, url: data.url, ...finalAntiBot },
            'Anti-bot protection detected',
          );
        }

        // -- Step 15: Record proxy outcome -------------------------------
        if (proxyId) {
          await proxyManager.recordOutcome({
            proxyId,
            domain,
            success: statusCode >= 200 && statusCode < 400,
            statusCode,
            latencyMs: Date.now() - startTime,
          });
        }

        // -- Step 16: Record outcome to domain intelligence --------------
        await domainIntelligence.recordOutcome(domain, {
          success: statusCode >= 200 && statusCode < 400,
          statusCode,
          responseMs: Date.now() - startTime,
          strategy: strategy === 'stealth-browser' ? 'browser' : strategy as 'http' | 'browser',
          usedBrowser: strategy === 'browser' || strategy === 'stealth-browser',
          detectedCloudflare: finalAntiBot.cloudflare,
          detectedDataDome: finalAntiBot.datadome,
          pageSizeKb: Math.round(bandwidthBytes / 1024),
          hadEmptyHtml: this.isEmptyHtml(html),
        });

        // -- Step 17: Record session request (if session is active) ------
        if (data.sessionId && sessionState) {
          try {
            await sessionManager.recordSessionRequest(data.sessionId, {
              success: statusCode >= 200 && statusCode < 400,
              responseMs: Date.now() - startTime,
              bandwidthBytes,
              creditsUsed: 0, // Will be updated after billing
            });
          } catch (sessionErr: any) {
            logger.debug(
              { jobId: data.jobId, sessionId: data.sessionId, error: sessionErr.message },
              'Failed to record session request',
            );
          }
        }

        // -- Step 18: Cache successful results ---------------------------
        if (statusCode >= 200 && statusCode < 400) {
          const profile = await domainIntelligence.getProfile(domain);
          const ttl = data.cacheTtl || profile.cacheTtlSeconds;
          await cacheSet(`scrape:${data.url}`, { html, statusCode, responseMs: Date.now() - startTime }, ttl);
        }
      }

      // -- Step 19: Template-based extraction -------------------------------
      // If templateId is specified, or extract is "auto", use the template registry
      // to detect and extract structured data using pre-built templates.
      if (html) {
        try {
          let templateId = data.templateId;
          let templateMatch: import('../templates').TemplateMatch | null = null;

          // Auto-detect template if templateId not specified but extract is "auto"
          if (!templateId && data.extract === 'auto') {
            templateMatch = templateRegistry.detectTemplate(data.url);
            if (templateMatch && templateMatch.confidence >= 0.5) {
              templateId = templateMatch.templateId;
              logger.info(
                { jobId: data.jobId, url: data.url, templateId, confidence: templateMatch.confidence },
                'Auto-detected template for extraction',
              );
            }
          }

          // If a template is specified or auto-detected, extract with it
          if (templateId) {
            const templateResult = templateRegistry.extractWithTemplate(templateId, html, data.url);
            if (templateResult && Object.keys(templateResult).length > 0) {
              structuredData = {
                ...(structuredData || {}),
                template: {
                  templateId,
                  data: templateResult,
                },
              };
              logger.info(
                { jobId: data.jobId, templateId, fieldsExtracted: Object.keys(templateResult).length },
                'Template extraction successful',
              );
            }
          }
        } catch (templateErr: any) {
          logger.warn(
            { jobId: data.jobId, templateId: data.templateId, error: templateErr.message },
            'Template extraction failed -- falling back to standard extraction',
          );
        }
      }

      // -- Step 20: Structured data parsing (existing logic) ---------------
      if (data.structured && html) {
        try {
          const existingStructured = structuredData || {};
          const parsedStructured = this.parseStructuredData(html, data.url);
          structuredData = { ...existingStructured, ...parsedStructured };
          creditsUsed += 2;
        } catch (err: any) {
          logger.warn({ jobId: data.jobId, error: err.message }, 'Structured data parsing failed');
        }
      }

      // -- Step 21: NL Extraction ------------------------------------------
      if (data.extract && data.extract !== 'auto' && html) {
        try {
          const { nlExtractor } = await import('../extractor/nl-extractor');
          const extractResult = await nlExtractor.extract({
            html,
            url: data.url,
            instruction: data.extract,
          });
          extracted = extractResult.data ?? undefined;
          creditsUsed += 3;
        } catch (extractErr: any) {
          logger.error(
            { jobId: data.jobId, url: data.url, error: extractErr.message },
            'NL extraction failed',
          );
        }
      }

      // -- Step 22: Output Pipeline Integration ----------------------------
      // If outputFormat is specified, process the HTML through the output pipeline.
      let processedHtml = html;
      if (data.outputFormat && html && data.outputFormat !== 'raw') {
        try {
          const outputResult = outputPipeline.process(html, data.url, {
            format: data.outputFormat as OutputFormat,
          });

          processedHtml = typeof outputResult.content === 'string'
            ? outputResult.content
            : JSON.stringify(outputResult.content);
          appliedOutputFormat = data.outputFormat;
          outputCompressionRatio = outputResult.compressionRatio;

          logger.info(
            {
              jobId: data.jobId,
              format: data.outputFormat,
              originalSizeBytes: outputResult.originalSizeBytes,
              outputSizeBytes: outputResult.outputSizeBytes,
              compressionRatio: outputResult.compressionRatio,
              processingMs: outputResult.processingMs,
            },
            'Output pipeline processing completed',
          );
        } catch (outputErr: any) {
          logger.warn(
            { jobId: data.jobId, format: data.outputFormat, error: outputErr.message },
            'Output pipeline processing failed -- returning raw HTML',
          );
          // Gracefully fall back to raw HTML
          appliedOutputFormat = data.outputFormat;
          outputCompressionRatio = 1;
        }
      }

      // -- Step 23: Calculate credits -------------------------------------
      const isSuccess = statusCode >= 200 && statusCode < 400;
      creditsUsed += calculateScrapeCredits(strategy as 'cache' | 'http' | 'browser', !!data.extract);

      // -- Step 24: Success-Only Billing ----------------------------------
      if (isSuccess && creditsUsed > 0) {
        const deducted = await deductCredits(data.userId, data.apiKeyId, creditsUsed);
        creditsCharged = deducted ? creditsUsed : 0;
      } else {
        creditsCharged = 0;
      }

      const responseMs = Date.now() - startTime;

      // NOTE: Do NOT update job status here -- the worker handles it.
      // This fixes the double-update race condition.
      // Only update non-status fields (result data, credits, etc.)
      await db.scrapeJob.update({
        where: { id: data.jobId },
        data: {
          strategy,
          creditsUsed,
          creditsCharged,
          bandwidthBytes,
          result: { html: processedHtml.substring(0, 50000) },
          extractedData: extracted ?? undefined,
          structuredData: structuredData ?? undefined,
          statusCode,
          responseMs,
          proxyId,
          proxyCountry,
          captchaSolved,
          retryCount,
        },
      });

      // Update API key bandwidth tracking
      try {
        await db.apiKey.update({
          where: { id: data.apiKeyId },
          data: { bandwidthBytes: { increment: bandwidthBytes } },
        });
      } catch {}

      // -- Step 25: Fire webhooks -----------------------------------------
      webhookDispatcher.fire(data.userId, 'job_completed', {
        jobId: data.jobId,
        url: data.url,
        strategy,
        statusCode,
        responseMs,
        creditsCharged,
        cached,
        captchaSolved,
        bandwidthBytes,
        outputFormat: appliedOutputFormat,
        outputCompressionRatio,
      }).catch(() => {});

      logger.info(
        { jobId: data.jobId, url: data.url, strategy, statusCode, responseMs, creditsUsed, creditsCharged, cached, captchaSolved, bandwidthBytes, retryCount, outputFormat: appliedOutputFormat, outputCompressionRatio },
        'Scrape job completed',
      );

      return {
        jobId: data.jobId,
        status: 'done',
        strategy,
        html: cached ? undefined : processedHtml,
        extracted,
        structuredData,
        statusCode,
        responseMs,
        creditsUsed,
        creditsCharged,
        proxyId,
        proxyCountry,
        captchaSolved,
        cached,
        bandwidthBytes,
        finalUrl,
        outputFormat: appliedOutputFormat,
        outputCompressionRatio,
      };
    } catch (err: any) {
      error = err.message || String(err);
      const responseMs = Date.now() - startTime;

      logger.error({ jobId: data.jobId, url: data.url, error, responseMs }, 'Scrape job failed');

      // Fire failure webhook
      webhookDispatcher.fire(data.userId, 'job_failed', {
        jobId: data.jobId,
        url: data.url,
        error,
        statusCode,
      }).catch(() => {});

      return {
        jobId: data.jobId,
        status: 'failed',
        strategy,
        creditsUsed: 0,
        creditsCharged: 0,
        statusCode,
        responseMs,
        error,
        cached: false,
      };
    }
  }

  // --- Private Methods ------------------------------------------------------

  private async executeFetch(
    strategy: JobStrategy,
    url: string,
    domain: string,
    proxyUrl?: string,
    waitForSelector?: string,
    timeout?: number,
    headers?: Record<string, string>,
  ): Promise<{ html: string; statusCode: number; strategy: JobStrategy; headers?: Record<string, string>; finalUrl?: string }> {
    if (strategy === 'stealth-browser') {
      return this.fetchViaStealthBrowser(url, domain, proxyUrl, waitForSelector, timeout);
    } else if (strategy === 'browser') {
      return this.fetchViaBrowser(url, domain, proxyUrl, waitForSelector, timeout);
    } else {
      return this.fetchViaHttp(url, domain, proxyUrl, headers, timeout);
    }
  }

  private async checkCache(
    url: string,
  ): Promise<{ html: string; statusCode: number; responseMs: number } | null> {
    try {
      const cached = await cacheGet<{ html: string; statusCode: number; responseMs: number }>(
        `scrape:${url}`,
      );
      return cached;
    } catch (err: any) {
      logger.warn({ url, error: err.message }, 'Cache lookup failed');
      return null;
    }
  }

  /**
   * HTTP fetch with TLS fingerprint randomization via got-scraping.
   * Uses tlsFingerprintFetcher first (randomizes JA3/JA4 fingerprints),
   * then falls back to proxyFetch if got-scraping is unavailable or fails.
   *
   * This is the #1 most impactful fix for bypassing Cloudflare, Akamai, and DataDome,
   * which use TLS fingerprinting to instantly identify automated traffic.
   */
  private async fetchViaHttp(
    url: string,
    _domain: string,
    proxyUrl?: string,
    headers?: Record<string, string>,
    timeout?: number,
  ): Promise<{ html: string; statusCode: number; strategy: JobStrategy; headers: Record<string, string>; finalUrl: string }> {
    const requestTimeout = timeout || DEFAULT_TIMEOUT;

    // Build fallback headers for proxyFetch (used when got-scraping is unavailable)
    const profile = stealthEngine.getRandomProfile();
    const fallbackHeaders: Record<string, string> = {
      'User-Agent': profile.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': `${profile.locale},en;q=0.9`,
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Sec-Ch-Ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': `"${profile.platform}"`,
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      ...headers,
    };

    // Define the fallback function that uses proxyFetch
    const fallbackFn = async (
      fbUrl: string,
      fbProxyUrl?: string,
      fbOpts?: any,
    ): Promise<{ text: string; status: number; headers: Record<string, string>; url: string; ok: boolean }> => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), requestTimeout);
      try {
        return await proxyFetch(fbUrl, fbProxyUrl, {
          headers: fallbackHeaders,
          signal: controller.signal,
          redirect: 'follow',
        });
      } finally {
        clearTimeout(timeoutId);
      }
    };

    try {
      // Try TLS-fingerprint-aware fetch first (got-scraping)
      // This randomizes JA3/JA4 fingerprints to mimic real browsers
      const response = await tlsFingerprintFetcher.fetch(
        url,
        proxyUrl,
        {
          headers,
          timeout: requestTimeout,
        },
        fallbackFn, // Fallback to proxyFetch if got-scraping fails
      );

      const html = response.text;

      // Extract useful response headers
      const responseHeaders: Record<string, string> = {};
      const headerWhitelist = [
        'content-type', 'server', 'x-powered-by', 'cf-ray',
        'x-cache', 'content-encoding', 'content-length',
        'x-request-id', 'strict-transport-security',
      ];
      for (const [key, value] of Object.entries(response.headers)) {
        if (headerWhitelist.includes(key.toLowerCase())) {
          responseHeaders[key] = value;
        }
      }

      const finalUrl = response.url || url;

      return { html, statusCode: response.status, strategy: 'http', headers: responseHeaders, finalUrl };
    } catch (err: any) {
      if (err.name === 'AbortError') return { html: '', statusCode: 408, strategy: 'http', headers: {}, finalUrl: url };
      return { html: '', statusCode: 502, strategy: 'http', headers: {}, finalUrl: url };
    }
  }

  private async fetchViaBrowser(
    url: string,
    _domain: string,
    proxyUrl?: string,
    waitForSelector?: string,
    timeout?: number,
  ): Promise<{ html: string; statusCode: number; strategy: JobStrategy; headers?: Record<string, string>; finalUrl?: string }> {
    const requestTimeout = timeout || DEFAULT_TIMEOUT;
    let lease: BrowserLease | undefined;

    try {
      lease = await browserPool.acquire(proxyUrl, false);

      const response = await lease.page.goto(url, { waitUntil: 'networkidle', timeout: requestTimeout });
      const statusCode = response ? response.status() : 200;

      if (waitForSelector) {
        try { await lease.page.waitForSelector(waitForSelector, { timeout: 10_000 }); } catch {}
      }

      // Simulate human behavior for anti-bot evasion
      if (statusCode < 400) {
        try {
          await humanBehavior.simulatePageInteraction(lease.page);
        } catch (behaviorErr: any) {
          logger.debug({ error: behaviorErr.message }, 'Human behavior simulation failed (non-critical)');
        }
      }

      const html = await lease.page.content();
      const finalUrl = lease.page.url();

      return { html, statusCode, strategy: 'browser', finalUrl };
    } catch (err: any) {
      if (err.message?.includes('Timeout') || err.name === 'TimeoutError') {
        return { html: '', statusCode: 408, strategy: 'browser' };
      }
      return { html: '', statusCode: 502, strategy: 'browser' };
    } finally {
      if (lease) await browserPool.release(lease);
    }
  }

  private async fetchViaStealthBrowser(
    url: string,
    _domain: string,
    proxyUrl?: string,
    waitForSelector?: string,
    timeout?: number,
  ): Promise<{ html: string; statusCode: number; strategy: JobStrategy; headers?: Record<string, string>; finalUrl?: string }> {
    const requestTimeout = timeout || DEFAULT_TIMEOUT;
    let lease: BrowserLease | undefined;

    try {
      lease = await browserPool.acquire(proxyUrl, true);

      const response = await lease.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: requestTimeout,
      });
      const statusCode = response ? response.status() : 200;

      if (waitForSelector) {
        try { await lease.page.waitForSelector(waitForSelector, { timeout: 15_000 }); } catch {}
      } else {
        try {
          await lease.page.waitForFunction(() => document.body?.innerText?.length > 100, { timeout: 10_000 });
        } catch {}
      }

      // Simulate human behavior for anti-bot evasion
      if (statusCode < 400) {
        try {
          await humanBehavior.simulatePageInteraction(lease.page);
        } catch (behaviorErr: any) {
          logger.debug({ error: behaviorErr.message }, 'Human behavior simulation failed (non-critical)');
        }
      }

      const html = await lease.page.content();
      const finalUrl = lease.page.url();

      return { html, statusCode, strategy: 'stealth-browser', finalUrl };
    } catch (err: any) {
      if (err.message?.includes('Timeout') || err.name === 'TimeoutError') {
        return { html: '', statusCode: 408, strategy: 'stealth-browser' };
      }
      return { html: '', statusCode: 502, strategy: 'stealth-browser' };
    } finally {
      if (lease) await browserPool.release(lease);
    }
  }

  /**
   * Take a screenshot of the current page (used by the screenshot API).
   */
  async takeScreenshot(
    url: string,
    domain: string,
    options: {
      proxyUrl?: string;
      stealth?: boolean;
      fullPage?: boolean;
      waitForSelector?: string;
      timeout?: number;
    } = {},
  ): Promise<{ screenshot: Buffer; statusCode: number; responseMs: number }> {
    const startTime = Date.now();
    const requestTimeout = options.timeout || DEFAULT_TIMEOUT;
    let lease: BrowserLease | undefined;

    try {
      lease = await browserPool.acquire(options.proxyUrl, options.stealth ?? true);

      const response = await lease.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: requestTimeout,
      });
      const statusCode = response ? response.status() : 200;

      if (options.waitForSelector) {
        try { await lease.page.waitForSelector(options.waitForSelector, { timeout: 10_000 }); } catch {}
      } else {
        try {
          await lease.page.waitForFunction(() => document.body?.innerText?.length > 50, { timeout: 8_000 });
        } catch {}
      }

      const screenshot = await lease.page.screenshot({
        fullPage: options.fullPage ?? false,
        type: 'png',
      });

      return {
        screenshot: Buffer.from(screenshot),
        statusCode,
        responseMs: Date.now() - startTime,
      };
    } finally {
      if (lease) await browserPool.release(lease);
    }
  }

  /**
   * Retry a page load with a CAPTCHA token injected.
   */
  private async retryWithCaptchaToken(
    url: string,
    _domain: string,
    proxyUrl: string | undefined,
    token: string,
    captchaType: string,
    waitForSelector?: string,
    timeout?: number,
  ): Promise<{ html: string; statusCode: number }> {
    const requestTimeout = timeout || DEFAULT_TIMEOUT;
    let lease: BrowserLease | undefined;

    try {
      lease = await browserPool.acquire(proxyUrl, true);

      const response = await lease.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: requestTimeout,
      });
      const statusCode = response ? response.status() : 200;

      // Inject the CAPTCHA token
      if (captchaType === 'recaptcha_v2' || captchaType === 'recaptcha_v3') {
        await lease.page.evaluate((t) => {
          const el = document.querySelector('#g-recaptcha-response') as HTMLTextAreaElement;
          if (el) el.value = t;
          // Trigger callback if available
          try {
            const cfg = (window as any).___grecaptcha_cfg;
            if (cfg?.clients) {
              for (const client of Object.values(cfg.clients) as any[]) {
                for (const [, value] of Object.entries(client)) {
                  const v = value as any;
                  if (typeof v?.callback === 'function') {
                    v.callback(t);
                  }
                }
              }
            }
          } catch {}
        }, token);
      } else if (captchaType === 'hcaptcha') {
        await lease.page.evaluate((t) => {
          const el = document.querySelector('[name="h-captcha-response"]') as HTMLTextAreaElement;
          if (el) el.value = t;
          if ((window as any).hcaptcha) {
            (window as any).hcaptcha.setResponse(t);
          }
        }, token);
      } else if (captchaType === 'turnstile') {
        await lease.page.evaluate((t) => {
          const el = document.querySelector('[name="cf-turnstile-response"]') as HTMLTextAreaElement;
          if (el) el.value = t;
          if ((window as any).turnstile) {
            (window as any).turnstile.getResponse = () => t;
          }
        }, token);
      }

      // Wait for navigation/content after CAPTCHA
      try {
        await lease.page.waitForFunction(
          () => document.body?.innerText?.length > 200,
          { timeout: 10_000 },
        );
      } catch {}

      if (waitForSelector) {
        try { await lease.page.waitForSelector(waitForSelector, { timeout: 10_000 }); } catch {}
      }

      const html = await lease.page.content();
      return { html, statusCode };
    } catch (err: any) {
      return { html: '', statusCode: 502 };
    } finally {
      if (lease) await browserPool.release(lease);
    }
  }

  private detectAntiBot(html: string): AntiBotDetection {
    return stealthEngine.detectAntiBot(html);
  }

  private parseStructuredData(html: string, url?: string): Record<string, any> {
    const result: Record<string, any> = {};
    const generic = genericParser.parse(html, url);
    result.generic = generic;

    if (url) {
      try {
        const domain = new URL(url).hostname.replace(/^www\./, '');
        if (domain.includes('amazon.')) {
          result.amazon = amazonParser.parse(html);
        } else if (domain.includes('google.')) {
          result.google = googleSerpParser.parse(html);
        }
      } catch {}
    }

    return result;
  }

  private extractCaptchaSiteKey(html: string, type: string): string | null {
    try {
      switch (type) {
        case 'recaptcha_v2':
        case 'recaptcha_v3': {
          const match = html.match(/data-sitekey="([^"]+)"/);
          return match ? match[1] : null;
        }
        case 'hcaptcha': {
          const match = html.match(/data-sitekey="([^"]+)"/);
          return match ? match[1] : null;
        }
        case 'turnstile': {
          const match = html.match(/sitekey["\s:=]+["']([^"']+)["']/);
          return match ? match[1] : null;
        }
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  private isEmptyHtml(html: string): boolean {
    if (!html || html.length < 50) return true;
    const lowerHtml = html.toLowerCase();
    if (!lowerHtml.includes('<body')) return true;
    const textOnly = html.replace(/<[^>]*>/g, '').trim();
    if (textOnly.length < 100) return true;
    const tagCount = (html.match(/<[a-zA-Z][^>]*>/g) || []).length;
    if (tagCount < 5) return true;
    return false;
  }

  /**
   * Simple rate limiter -- fallback used when the adaptive rate limiter
   * encounters an error. This preserves the original Redis-counter approach.
   */
  private async acquireSimpleRateLimitToken(domain: string, safeRps: number): Promise<void> {
    const key = `ratelimit:${domain}`;
    const maxRetries = 50;
    const retryDelayMs = 100;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const current = await redis.incr(key);
      if (current === 1) await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
      if (current <= Math.max(1, Math.ceil(safeRps))) return;
      await this.sleep(retryDelayMs);
    }

    logger.warn({ domain, safeRps }, 'Rate limit token acquisition timed out');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// --- Singleton export ---------------------------------------------------------

export const orchestrator = new Orchestrator();
