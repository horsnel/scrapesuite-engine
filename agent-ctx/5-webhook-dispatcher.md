# Task 5 — Production-Grade Webhook Dispatcher

## Agent: Webhook-Upgrader

## Summary

Replaced the existing fire-and-forget webhook dispatcher with a production-grade system featuring BullMQ queue processing, HMAC signature verification, exponential backoff retries, delivery tracking, batch webhooks, and health monitoring.

## Files Changed

1. **`src/scheduler/webhooks.ts`** — Complete rewrite (460+ lines)
   - Replaced `WebhookDispatcher` class with production-grade implementation
   - Added BullMQ queue (`webhook-delivery`) for reliable, non-blocking processing
   - Retry with exponential backoff: 5s → 30s → 2m → 10m → 30m (max 5 retries)
   - HMAC-SHA256 signature format: `t={timestamp},v1={hmac_hex}` in `X-ScrapeSuite-Signature` header
   - Timestamp in `X-ScrapeSuite-Timestamp` header (recipients reject if >5 min old)
   - Delivery tracking in `WebhookLog` Prisma model (status code, response, success, attempt)
   - Batch webhooks: buffer events, flush on batch size threshold or time interval
   - Health monitoring: success rate (last 100), avg latency, consecutive failures, auto-disable after 10
   - `start()` / `stop()` lifecycle for BullMQ worker and queue
   - `testWebhook()` — sends test payload directly, re-enables disabled webhooks on success
   - `getWebhookHealth()` — returns `WebhookHealth` metrics
   - `setBatchConfig()` — configure batching per webhook via Redis
   - Preserved `ChangeDetector` class unchanged
   - Preserved singleton exports: `webhookDispatcher`, `changeDetector`

2. **`src/api/index.ts`** — Integration hooks
   - Added `webhookDispatcher.start()` in server startup
   - Added `await webhookDispatcher.stop()` in graceful shutdown
   - Import: `import { webhookDispatcher } from '../scheduler/webhooks'`

3. **`src/index.ts`** — Worker mode integration
   - Added `webhookDispatcher.start()` in worker mode startup
   - Import: `import { webhookDispatcher } from './scheduler/webhooks'`

4. **`src/api/routes/webhooks.ts`** — Updated routes to use new dispatcher
   - Test endpoint now uses `webhookDispatcher.testWebhook()` instead of inline fetch
   - Added `GET /v1/webhooks/:id/health` endpoint for health metrics
   - List webhooks now enriches with health data (successRate, avgLatencyMs, consecutiveFailures)
   - Get webhook details now includes health metrics
   - Create/update webhooks now support `batch` configuration
   - Properly typed `health` variable using `WebhookHealth | null`

5. **`tsconfig.json`** — Reverted temporary test change (no net change)

## Architecture

```
fire() → find active webhooks → check batch config
  ├── batch enabled → bufferBatchEvent() → flush on size/time → deliver()
  └── batch disabled → enqueueDelivery() → BullMQ queue → worker → deliver()

deliver() → HMAC sign → HTTP POST → log result
  ├── success → reset failCount, cache latency
  └── failure → increment failCount, auto-disable at 10, re-enqueue with backoff

testWebhook() → direct deliver() → re-enable if success
getWebhookHealth() → query WebhookLog + Redis cache → return metrics
```

## Key Design Decisions

- **Manual retry via re-enqueue**: BullMQ `attempts` is set to 1; retries are managed by re-adding jobs with incremented `attempt` and calculated `delay`. This gives precise control over the backoff schedule.
- **HMAC signature includes timestamp**: Format `t={epoch_seconds},v1={hmac}` signed over `{timestamp}.{body}` prevents replay attacks.
- **Batch config in Redis**: Avoids schema migration for batch settings; cached for 24h.
- **Latency cached with EMA**: Exponential moving average (alpha=0.1) stored in Redis, 5-min TTL.
- **Health from DB + cache**: Success rate calculated from last 100 WebhookLog entries; latency from Redis cache; consecutive failures from Webhook.failCount.

## TypeScript

Zero new compilation errors introduced. `npx tsc --noEmit` passes cleanly.
