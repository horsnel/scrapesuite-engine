# Task 2 — Adaptive Rate Limiter

## Agent
Rate-Limiter

## Summary
Created `/home/z/my-project/scrapesuite/scrapesuite-engine/src/rate-limiter/index.ts` — a production-quality Adaptive Rate Limiter (642 lines).

## What was implemented

All 7 requirements from the task spec:

1. **Per-Domain Adaptive Backoff** — 429→halve RPS, 403/503/anti-bot→-30% + protected flag, timeout→-20%, fast success→+2%
2. **EMA-based Rate Calculation** — alpha=0.15 smoothing, tracks safeRps/emaRps/consecutiveFailures/cooldownLevel per domain
3. **Token Bucket with Burst** — capacity=2×safeRps, refill=safeRps/sec, burst after 10+ consecutive successes
4. **Cross-Domain Throttling** — root domain extraction, sub-domain failures propagate to root, acquireToken inherits root cooldowns
5. **Smart Cooldown** — escalating 429 cooldowns (5s/30s/60s), anti-bot=30s, CAPTCHA=15s, decay after 5 min of success
6. **Redis-backed state** — cacheGet/cacheSet for `ratelimit:state:{domain}` and `ratelimit:bucket:{domain}`, 6h TTL, periodic cleanup
7. **Real-time Metrics** — `getDomainStatus` returns full `DomainRateStatus`, `getAllThrottledDomains` scans Redis for throttled/protected domains

## Exports
- `AdaptiveRateLimiter` class with 6 public methods: `acquireToken`, `recordResponse`, `getDomainStatus`, `getAllThrottledDomains`, `startCleanup`, `stopCleanup`
- `DomainRateStatus` and `AcquireResult` interfaces
- `adaptiveRateLimiter` singleton instance

## Type checking
Zero new TypeScript errors — all pre-existing errors are from missing type declarations in other modules (fastify, cheerio, etc.)
