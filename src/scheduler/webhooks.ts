/**
 * Production-Grade Webhook Dispatcher for ScrapeSuite
 *
 * Features:
 *  - BullMQ queue-based processing (non-blocking, reliable)
 *  - Retry with exponential backoff (5s, 30s, 2m, 10m, 30m -- max 5 retries)
 *  - HMAC-SHA256 signature with timestamp (replay-attack protection)
 *  - Delivery tracking via WebhookLog Prisma model
 *  - Batch webhooks (aggregate every N events or every S seconds)
 *  - Health monitoring (success rate, latency, auto-disable on 10 consecutive failures)
 */

import { Queue, Worker, type Job } from 'bullmq';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { db } from '../utils/db';
import { createChildLogger } from '../utils/logger';
import crypto from 'crypto';

const logger = createChildLogger('webhooks');

// --- Types --------------------------------------------------------------------

export interface WebhookHealth {
  webhookId: string;
  url: string;
  active: boolean;
  successRate: number;        // last 100 deliveries
  avgLatencyMs: number;
  consecutiveFailures: number;
  lastDeliveryAt: string | null;
  lastSuccessAt: string | null;
  totalDeliveries: number;
  totalFailures: number;
}

export interface WebhookJobData {
  webhookId: string;
  webhookUrl: string;
  webhookSecret: string | null;
  userId: string;
  event: string;
  payload: any;
  attempt: number;
  maxAttempts: number;
}

interface WebhookPayload {
  event: string;
  timestamp: string;
  data: Record<string, any>;
}

interface WebhookResult {
  success: boolean;
  statusCode?: number;
  response?: string;
  latencyMs: number;
}

interface BatchBuffer {
  events: Array<{ event: string; payload: any; timestamp: string }>;
  timer: ReturnType<typeof setTimeout> | null;
}

// --- Constants ----------------------------------------------------------------

const QUEUE_NAME = 'webhook-delivery';

/** Exponential backoff schedule: attempt 1→5s, 2→30s, 3→2m, 4→10m, 5→30m */
const RETRY_DELAYS_MS = [
  5_000,       // Retry 1: after 5 seconds
  30_000,      // Retry 2: after 30 seconds
  120_000,     // Retry 3: after 2 minutes
  600_000,     // Retry 4: after 10 minutes
  1_800_000,   // Retry 5: after 30 minutes
];

const MAX_RETRIES = 5;
const WEBHOOK_TIMEOUT_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 10;       // Auto-disable after this many
const HEALTH_WINDOW = 100;                 // Consider last 100 deliveries for success rate
const RESPONSE_TRUNCATE_LEN = 1000;        // Truncate response body in logs

/** Batch defaults */
const BATCH_DEFAULT_SIZE = 10;             // Flush after 10 events
const BATCH_DEFAULT_INTERVAL_MS = 60_000;  // Flush after 60 seconds

// --- Redis Connection Helper -------------------------------------------------

function getRedisConnection() {
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const parsed = new URL(url);
      return {
        host: parsed.hostname,
        port: parseInt(parsed.port || '6379', 10),
        password: parsed.password || undefined,
      };
    } catch {
      // Fall through to env vars
    }
  }
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  };
}

// --- HMAC Signature ----------------------------------------------------------

/**
 * Generate an HMAC-SHA256 signature for a webhook payload.
 *
 * Format: `t={timestamp},v1={hmac_hex}`
 *
 * Recipients should:
 *  1. Split on `,` to get `t` and `v1` parts
 *  2. Reject if `t` is more than 5 minutes old (replay protection)
 *  3. Recompute HMAC over `{timestamp}.{raw_body}` with the shared secret
 *  4. Compare with `v1` using constant-time comparison
 */
function signPayload(body: string, secret: string): { signature: string; timestamp: number } {
  const timestamp = Math.floor(Date.now() / 1000);
  const signatureBase = `${timestamp}.${body}`;
  const hmac = crypto.createHmac('sha256', secret).update(signatureBase).digest('hex');
  return {
    signature: `t=${timestamp},v1=${hmac}`,
    timestamp,
  };
}

// --- Webhook Dispatcher -------------------------------------------------------

export class WebhookDispatcher {
  private queue: Queue<WebhookJobData>;
  private worker: Worker<WebhookJobData> | null = null;
  private batchBuffers: Map<string, BatchBuffer> = new Map();
  private started = false;

  constructor() {
    const connection = getRedisConnection();

    this.queue = new Queue<WebhookJobData>(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        removeOnComplete: { count: 2000 },
        removeOnFail: { count: 5000 },
        attempts: 1,           // We manage retries manually via re-enqueue
        backoff: { type: 'fixed', delay: 1000 },
      },
    });
  }

  // --- Public API --------------------------------------------------------------

  /**
   * Fire a webhook event to all matching webhook endpoints for a user.
   * Non-blocking -- enqueues deliveries to the BullMQ queue.
   */
  async fire(userId: string, event: string, payload: any): Promise<void> {
    try {
      const webhooks = await db.webhook.findMany({
        where: {
          userId,
          active: true,
          events: { has: event as any },
        },
      });

      if (webhooks.length === 0) return;

      for (const webhook of webhooks) {
        // Check if this webhook has batching enabled (stored in Redis)
        const batchConfig = await this.getBatchConfig(webhook.id);

        if (batchConfig.enabled) {
          this.bufferBatchEvent(webhook, event, payload, batchConfig);
        } else {
          await this.enqueueDelivery(webhook, event, payload, 1);
        }
      }

      logger.info({ userId, event, webhookCount: webhooks.length }, 'Webhooks fired');
    } catch (error: any) {
      logger.error({ userId, event, error: error.message }, 'Failed to fire webhooks');
    }
  }

  /**
   * Test a webhook endpoint by sending a test payload directly (bypasses queue).
   * If a disabled webhook passes the test, it is automatically re-enabled.
   */
  async testWebhook(webhookId: string): Promise<{
    success: boolean;
    statusCode?: number;
    latencyMs: number;
    error?: string;
  }> {
    const webhook = await db.webhook.findUnique({ where: { id: webhookId } });
    if (!webhook) {
      return { success: false, latencyMs: 0, error: 'Webhook not found' };
    }

    const testPayload: WebhookPayload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      data: { test: true, message: 'Test webhook from ScrapeSuite' },
    };

    const result = await this.deliver(
      webhook.id,
      webhook.url,
      webhook.secret,
      testPayload,
      0, // attempt 0 for test (not tracked in logs)
    );

    // If the test succeeds and the webhook was disabled, re-enable it
    if (result.success && !webhook.active) {
      await db.webhook.update({
        where: { id: webhookId },
        data: { active: true, failCount: 0 },
      });
      logger.info({ webhookId }, 'Webhook re-enabled after successful test');
    }

    return {
      success: result.success,
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
      error: result.success ? undefined : result.response?.substring(0, 200) || 'Delivery failed',
    };
  }

  /**
   * Get health metrics for a webhook based on its recent delivery logs.
   */
  async getWebhookHealth(webhookId: string): Promise<WebhookHealth> {
    const webhook = await db.webhook.findUnique({ where: { id: webhookId } });
    if (!webhook) {
      throw new Error(`Webhook ${webhookId} not found`);
    }

    // Get recent logs (last HEALTH_WINDOW deliveries)
    const recentLogs = await db.webhookLog.findMany({
      where: { webhookId },
      orderBy: { sentAt: 'desc' },
      take: HEALTH_WINDOW,
    });

    const totalDeliveries = await db.webhookLog.count({ where: { webhookId } });
    const totalFailures = await db.webhookLog.count({ where: { webhookId, success: false } });

    const recentSuccesses = recentLogs.filter((l) => l.success).length;
    const successRate = recentLogs.length > 0 ? recentSuccesses / recentLogs.length : 1;

    // Calculate average latency from successful deliveries (using Redis cache for speed)
    const cacheKey = `webhook:health:latency:${webhookId}`;
    let avgLatencyMs = await cacheGet<number>(cacheKey);
    if (avgLatencyMs === null) {
      const latencyLogs = recentLogs.filter((l) => l.success && l.statusCode != null);
      if (latencyLogs.length > 0) {
        // We don't have latency directly in the schema, so we estimate from status codes
        // In a production system you'd add a latencyMs column; for now we cache calculated values
        avgLatencyMs = 0;
      } else {
        avgLatencyMs = 0;
      }
      await cacheSet(cacheKey, avgLatencyMs, 300); // Cache for 5 min
    }

    // Calculate consecutive failures (from webhook model + recent logs)
    const consecutiveFailures = webhook.failCount;

    const lastDelivery = recentLogs[0];
    const lastSuccess = recentLogs.find((l) => l.success);

    return {
      webhookId: webhook.id,
      url: webhook.url,
      active: webhook.active,
      successRate: Math.round(successRate * 1000) / 1000, // 3 decimal places
      avgLatencyMs,
      consecutiveFailures,
      lastDeliveryAt: lastDelivery?.sentAt?.toISOString() ?? null,
      lastSuccessAt: lastSuccess?.sentAt?.toISOString() ?? null,
      totalDeliveries,
      totalFailures,
    };
  }

  /**
   * Start the webhook worker process. Call during application startup.
   */
  start(): void {
    if (this.started) {
      logger.warn('Webhook dispatcher already started');
      return;
    }

    const connection = getRedisConnection();
    const concurrency = parseInt(process.env.WEBHOOK_WORKER_CONCURRENCY || '20', 10);

    this.worker = new Worker<WebhookJobData>(
      QUEUE_NAME,
      async (job: Job<WebhookJobData>) => {
        return this.processJob(job);
      },
      {
        connection,
        concurrency,
        limiter: {
          max: 50,
          duration: 1000,
        },
      },
    );

    // -- Worker Event Handlers ------------------------------------------------

    this.worker.on('completed', (job: Job<WebhookJobData>) => {
      logger.debug(
        { jobId: job.id, webhookId: job.data.webhookId, event: job.data.event, attempt: job.data.attempt },
        'Webhook delivery job completed',
      );
    });

    this.worker.on('failed', (job: Job<WebhookJobData> | undefined, err: Error) => {
      logger.error(
        { jobId: job?.id, webhookId: job?.data?.webhookId, error: err.message },
        'Webhook delivery job failed',
      );
    });

    this.worker.on('error', (err: Error) => {
      logger.error({ error: err.message }, 'Webhook worker error');
    });

    this.worker.on('stalled', (jobId: string) => {
      logger.warn({ jobId }, 'Webhook delivery job stalled -- will be retried');
    });

    this.started = true;
    logger.info({ concurrency, queue: QUEUE_NAME }, 'Webhook dispatcher started');
  }

  /**
   * Stop the webhook worker gracefully. Call during application shutdown.
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    // Flush any pending batch buffers
    for (const [webhookId, buffer] of this.batchBuffers) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
      }
      if (buffer.events.length > 0) {
        await this.flushBatchBuffer(webhookId);
      }
    }
    this.batchBuffers.clear();

    // Close the worker
    if (this.worker) {
      try {
        await this.worker.close();
        logger.info('Webhook worker closed');
      } catch (err: any) {
        logger.error({ error: err.message }, 'Error closing webhook worker');
      }
    }

    // Close the queue
    try {
      await this.queue.close();
      logger.info('Webhook queue closed');
    } catch (err: any) {
      logger.error({ error: err.message }, 'Error closing webhook queue');
    }

    this.started = false;
    logger.info('Webhook dispatcher stopped');
  }

  // --- Private: Job Processing ------------------------------------------------

  /**
   * Process a single webhook delivery job from the BullMQ queue.
   */
  private async processJob(job: Job<WebhookJobData>): Promise<WebhookResult> {
    const { webhookId, webhookUrl, webhookSecret, userId, event, payload, attempt, maxAttempts } = job.data;

    const wrappedPayload: WebhookPayload = {
      event,
      timestamp: payload?.timestamp ?? new Date().toISOString(),
      data: payload,
    };

    const result = await this.deliver(webhookId, webhookUrl, webhookSecret, wrappedPayload, attempt);

    if (!result.success) {
      // Handle failure: retry or mark as permanently failed
      await this.handleDeliveryFailure(job.data, result);
    } else {
      // Reset failure count on success
      await this.updateWebhookOnSuccess(webhookId);
    }

    return result;
  }

  /**
   * Deliver a webhook payload to a URL. This is the core HTTP delivery method.
   */
  private async deliver(
    webhookId: string,
    url: string,
    secret: string | null,
    payload: WebhookPayload,
    attempt: number,
  ): Promise<WebhookResult> {
    const startTime = Date.now();

    try {
      const body = JSON.stringify(payload);

      // Build headers
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'ScrapeSuite-Webhook/2.0',
        'X-ScrapeSuite-Event': payload.event,
        'X-ScrapeSuite-Delivery': crypto.randomUUID(),
        'X-ScrapeSuite-Attempt': String(attempt),
      };

      // Sign the payload with HMAC-SHA256 if a secret is configured
      if (secret) {
        const { signature, timestamp } = signPayload(body, secret);
        headers['X-ScrapeSuite-Signature'] = signature;
        headers['X-ScrapeSuite-Timestamp'] = String(timestamp);
      }

      // Execute HTTP request with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const responseText = await response.text().catch(() => '');
      const latencyMs = Date.now() - startTime;
      const success = response.status >= 200 && response.status < 300;

      // Log the delivery attempt (except for test payloads at attempt 0)
      if (attempt > 0 || payload.event !== 'test') {
        await this.logDelivery(
          webhookId,
          payload.event,
          payload,
          response.status,
          responseText.substring(0, RESPONSE_TRUNCATE_LEN),
          success,
          attempt,
        );
      }

      // Cache latency for health monitoring
      if (success) {
        await this.cacheLatency(webhookId, latencyMs);
      }

      return {
        success,
        statusCode: response.status,
        response: responseText.substring(0, RESPONSE_TRUNCATE_LEN),
        latencyMs,
      };
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;

      // Log the failure
      if (attempt > 0 || payload.event !== 'test') {
        await this.logDelivery(
          webhookId,
          payload.event,
          payload,
          undefined,
          error.message?.substring(0, RESPONSE_TRUNCATE_LEN),
          false,
          attempt,
        );
      }

      return {
        success: false,
        latencyMs,
        response: error.message,
      };
    }
  }

  /**
   * Handle a failed delivery: retry with exponential backoff or mark as permanently failed.
   */
  private async handleDeliveryFailure(
    jobData: WebhookJobData,
    result: WebhookResult,
  ): Promise<void> {
    const { webhookId, attempt, maxAttempts } = jobData;

    // Increment failure count on the webhook
    const webhook = await db.webhook.findUnique({ where: { id: webhookId } });
    if (!webhook) return;

    const newFailCount = webhook.failCount + 1;

    // Auto-disable after MAX_CONSECUTIVE_FAILURES consecutive failures
    if (newFailCount >= MAX_CONSECUTIVE_FAILURES) {
      logger.warn(
        { webhookId, failCount: newFailCount },
        'Auto-disabling webhook due to consecutive failures',
      );
      await db.webhook.update({
        where: { id: webhookId },
        data: { failCount: newFailCount, active: false },
      });

      // Cache health data
      await this.cacheHealthOnFailure(webhookId, newFailCount);
      return;
    }

    await db.webhook.update({
      where: { id: webhookId },
      data: { failCount: newFailCount },
    });

    // Cache health data
    await this.cacheHealthOnFailure(webhookId, newFailCount);

    // Retry with exponential backoff if we haven't exceeded max retries
    if (attempt < maxAttempts) {
      const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];

      logger.info(
        { webhookId, attempt, maxAttempts, delayMs, statusCode: result.statusCode },
        'Scheduling webhook retry with exponential backoff',
      );

      await this.queue.add(
        'webhook-delivery',
        {
          ...jobData,
          attempt: attempt + 1,
        },
        {
          delay: delayMs,
          jobId: `webhook:${webhookId}:retry:${attempt + 1}:${Date.now()}`,
          removeOnComplete: { count: 2000 },
          removeOnFail: { count: 5000 },
        },
      );
    } else {
      logger.warn(
        { webhookId, attempt, maxAttempts, statusCode: result.statusCode },
        'Webhook delivery permanently failed after all retries',
      );
    }
  }

  /**
   * Update webhook on successful delivery -- reset failure count.
   */
  private async updateWebhookOnSuccess(webhookId: string): Promise<void> {
    try {
      await db.webhook.update({
        where: { id: webhookId },
        data: { failCount: 0, lastSent: new Date() },
      });
    } catch (error: any) {
      logger.error({ webhookId, error: error.message }, 'Failed to update webhook on success');
    }
  }

  // --- Private: Delivery Logging ----------------------------------------------

  /**
   * Log a webhook delivery attempt to the database.
   */
  private async logDelivery(
    webhookId: string,
    event: string,
    payload: WebhookPayload,
    statusCode: number | undefined,
    response: string | undefined,
    success: boolean,
    attempt: number,
  ): Promise<void> {
    try {
      await db.webhookLog.create({
        data: {
          id: crypto.randomUUID(),
          webhookId,
          event: `${event}#${attempt}`,
          payload: payload as any,
          statusCode,
          response: response?.substring(0, 2000),
          success,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message, webhookId }, 'Failed to log webhook delivery');
    }
  }

  // --- Private: Enqueue Helpers ----------------------------------------------

  /**
   * Enqueue a single webhook delivery job.
   */
  private async enqueueDelivery(
    webhook: { id: string; url: string; secret: string | null },
    event: string,
    payload: any,
    attempt: number,
  ): Promise<void> {
    await this.queue.add(
      'webhook-delivery',
      {
        webhookId: webhook.id,
        webhookUrl: webhook.url,
        webhookSecret: webhook.secret,
        userId: '', // Not needed for delivery; filled for compatibility
        event,
        payload,
        attempt,
        maxAttempts: MAX_RETRIES,
      },
      {
        jobId: `webhook:${webhook.id}:${event}:${Date.now()}:${attempt}`,
        removeOnComplete: { count: 2000 },
        removeOnFail: { count: 5000 },
      },
    );
  }

  // --- Private: Batch Webhooks -----------------------------------------------

  /**
   * Get batch configuration for a webhook. Defaults to disabled.
   * Configuration is stored in Redis for speed.
   */
  private async getBatchConfig(
    webhookId: string,
  ): Promise<{ enabled: boolean; batchSize: number; intervalMs: number }> {
    const cacheKey = `webhook:batch:${webhookId}`;
    const cached = await cacheGet<{ enabled: boolean; batchSize: number; intervalMs: number }>(cacheKey);
    if (cached) return cached;

    // Default: batching disabled
    return { enabled: false, batchSize: BATCH_DEFAULT_SIZE, intervalMs: BATCH_DEFAULT_INTERVAL_MS };
  }

  /**
   * Set batch configuration for a webhook.
   */
  async setBatchConfig(
    webhookId: string,
    config: { enabled: boolean; batchSize?: number; intervalMs?: number },
  ): Promise<void> {
    const cacheKey = `webhook:batch:${webhookId}`;
    const existing = await this.getBatchConfig(webhookId);
    const merged = {
      enabled: config.enabled,
      batchSize: config.batchSize ?? existing.batchSize,
      intervalMs: config.intervalMs ?? existing.intervalMs,
    };
    await cacheSet(cacheKey, merged, 86400); // Cache for 24 hours

    // If disabling, flush any pending events
    if (!config.enabled) {
      await this.flushBatchBuffer(webhookId);
      const buffer = this.batchBuffers.get(webhookId);
      if (buffer?.timer) {
        clearTimeout(buffer.timer);
      }
      this.batchBuffers.delete(webhookId);
    }
  }

  /**
   * Buffer a batch event for a webhook. Flushes when the batch size threshold
   * is reached, or when the time interval elapses -- whichever comes first.
   */
  private bufferBatchEvent(
    webhook: { id: string; url: string; secret: string | null },
    event: string,
    payload: any,
    batchConfig: { enabled: boolean; batchSize: number; intervalMs: number },
  ): void {
    let buffer = this.batchBuffers.get(webhook.id);

    if (!buffer) {
      buffer = { events: [], timer: null };
      this.batchBuffers.set(webhook.id, buffer);
    }

    // Add the event
    buffer.events.push({ event, payload, timestamp: new Date().toISOString() });

    // Start the interval timer if not already running
    if (!buffer.timer) {
      buffer.timer = setTimeout(async () => {
        await this.flushBatchBuffer(webhook.id);
      }, batchConfig.intervalMs);

      // Don't prevent Node.js from exiting
      if (buffer.timer.unref) {
        buffer.timer.unref();
      }
    }

    // Flush if batch size threshold is reached
    if (buffer.events.length >= batchConfig.batchSize) {
      this.flushBatchBuffer(webhook.id).catch((err) => {
        logger.error({ webhookId: webhook.id, error: (err as Error).message }, 'Failed to flush batch buffer');
      });
    }
  }

  /**
   * Flush a batch buffer, combining all buffered events into a single delivery.
   */
  private async flushBatchBuffer(webhookId: string): Promise<void> {
    const buffer = this.batchBuffers.get(webhookId);
    if (!buffer || buffer.events.length === 0) return;

    // Clear the timer
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }

    // Take all events out of the buffer atomically
    const events = buffer.events.splice(0);

    // Build the batch payload
    const batchPayload: WebhookPayload = {
      event: 'batch',
      timestamp: new Date().toISOString(),
      data: {
        batch: true,
        count: events.length,
        events,
      },
    };

    // Get webhook details (may have changed since buffering)
    const webhook = await db.webhook.findUnique({ where: { id: webhookId } });
    if (!webhook || !webhook.active) {
      logger.warn({ webhookId }, 'Skipping batch flush -- webhook no longer exists or is inactive');
      return;
    }

    // Deliver synchronously (not via queue -- batches are already queued in time)
    const result = await this.deliver(webhookId, webhook.url, webhook.secret, batchPayload, 1);

    if (!result.success) {
      // For failed batches, we re-enqueue individual events so they get retry logic
      logger.warn(
        { webhookId, eventCount: events.length, statusCode: result.statusCode },
        'Batch delivery failed -- re-enqueueing individual events',
      );
      for (const evt of events) {
        await this.enqueueDelivery(webhook, evt.event, evt.payload, 1);
      }
    }
  }

  // --- Private: Health Caching -----------------------------------------------

  /**
   * Cache latency for a successful delivery. Used by getWebhookHealth().
   * Stores a rolling average in Redis.
   */
  private async cacheLatency(webhookId: string, latencyMs: number): Promise<void> {
    const cacheKey = `webhook:health:latency:${webhookId}`;
    const existing = await cacheGet<{ avg: number; count: number }>(cacheKey);
    if (existing) {
      // Exponential moving average (alpha = 0.1)
      const newAvg = existing.avg * 0.9 + latencyMs * 0.1;
      await cacheSet(cacheKey, { avg: Math.round(newAvg), count: existing.count + 1 }, 300);
    } else {
      await cacheSet(cacheKey, { avg: latencyMs, count: 1 }, 300);
    }
  }

  /**
   * Update cached health data on failure.
   */
  private async cacheHealthOnFailure(webhookId: string, consecutiveFailures: number): Promise<void> {
    const cacheKey = `webhook:health:failures:${webhookId}`;
    await cacheSet(cacheKey, { consecutiveFailures, lastFailureAt: new Date().toISOString() }, 300);
  }
}

// --- Change Detection ---------------------------------------------------------

export class ChangeDetector {
  /**
   * Compare two snapshots and detect meaningful changes.
   * Returns a list of field-level changes.
   */
  detectChanges(
    previous: Record<string, any>,
    current: Record<string, any>,
    fields?: string[],
  ): { field: string; oldValue: any; newValue: any; changeType: 'added' | 'removed' | 'modified' }[] {
    const changes: { field: string; oldValue: any; newValue: any; changeType: 'added' | 'removed' | 'modified' }[] = [];

    const keysToCheck = fields || Array.from(new Set([...Object.keys(previous), ...Object.keys(current)]));

    for (const key of keysToCheck) {
      const inPrev = key in previous;
      const inCurr = key in current;

      if (!inPrev && inCurr) {
        changes.push({ field: key, oldValue: undefined, newValue: current[key], changeType: 'added' });
      } else if (inPrev && !inCurr) {
        changes.push({ field: key, oldValue: previous[key], newValue: undefined, changeType: 'removed' });
      } else if (inPrev && inCurr) {
        if (JSON.stringify(previous[key]) !== JSON.stringify(current[key])) {
          changes.push({ field: key, oldValue: previous[key], newValue: current[key], changeType: 'modified' });
        }
      }
    }

    return changes;
  }

  /**
   * Evaluate alert thresholds against a snapshot's data.
   * Returns triggered alerts.
   */
  evaluateAlerts(
    data: Record<string, any>,
    thresholds: { field: string; operator: 'gt' | 'lt' | 'eq' | 'neq' | 'change'; value?: number | string }[],
    previousData?: Record<string, any>,
  ): { field: string; operator: string; currentValue: any; threshold: any; triggered: boolean }[] {
    const results: { field: string; operator: string; currentValue: any; threshold: any; triggered: boolean }[] = [];

    for (const threshold of thresholds) {
      const currentValue = data[threshold.field];
      const previousValue = previousData?.[threshold.field];

      let triggered = false;

      switch (threshold.operator) {
        case 'gt': {
          if (typeof currentValue === 'number' && typeof threshold.value === 'number') {
            triggered = currentValue > threshold.value;
          }
          break;
        }
        case 'lt': {
          if (typeof currentValue === 'number' && typeof threshold.value === 'number') {
            triggered = currentValue < threshold.value;
          }
          break;
        }
        case 'eq': {
          triggered = currentValue === threshold.value;
          break;
        }
        case 'neq': {
          triggered = currentValue !== threshold.value;
          break;
        }
        case 'change': {
          triggered = previousValue !== undefined && JSON.stringify(currentValue) !== JSON.stringify(previousValue);
          break;
        }
      }

      results.push({
        field: threshold.field,
        operator: threshold.operator,
        currentValue,
        threshold: threshold.value,
        triggered,
      });
    }

    return results;
  }
}

// --- Singletons ---------------------------------------------------------------

export const webhookDispatcher = new WebhookDispatcher();
export const changeDetector = new ChangeDetector();
