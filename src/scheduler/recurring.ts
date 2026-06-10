/**
 * Recurring Job Scheduler for ScrapeSuite
 *
 * Production-grade cron-based job scheduling system with:
 *  - cron-parser for precise schedule calculation with timezone support
 *  - BullMQ queue for reliable job dispatch and execution
 *  - Auto-disable after 10 consecutive failures
 *  - Redis-based distributed locking to prevent duplicate execution
 *  - Full CRUD lifecycle management (create, update, delete, pause, resume, trigger)
 *  - Execution history via ScrapeJob records
 *  - Webhook notifications on success/failure
 */

import { parseExpression } from 'cron-parser';
import { Queue, type Job } from 'bullmq';
import { db } from '../utils/db';
import { createChildLogger } from '../utils/logger';
import { redis, cacheGet, cacheSet, cacheDelete } from '../utils/redis';
import { addScrapeJob } from '../workers/queue';
import { webhookDispatcher } from './webhooks';
import type { PlanTier } from '../types';

const logger = createChildLogger('recurring-scheduler');

// --- Exported Types -----------------------------------------------------------

export interface CreateRecurringJobInput {
  userId: string;
  apiKeyId: string;
  name: string;
  url: string;
  domain: string;
  cronSchedule: string;
  timezone?: string;
  strategy?: string;
  proxyTier?: string;
  proxyCountry?: string;
  templateId?: string;
  outputFormat?: string;
  webhookUrl?: string;
  maxRetries?: number;
}

export interface UpdateRecurringJobInput {
  name?: string;
  url?: string;
  domain?: string;
  cronSchedule?: string;
  timezone?: string;
  strategy?: string | null;
  proxyTier?: string | null;
  proxyCountry?: string | null;
  templateId?: string | null;
  outputFormat?: string | null;
  webhookUrl?: string | null;
  maxRetries?: number;
  active?: boolean;
}

export interface RecurringJobFilters {
  active?: boolean;
  domain?: string;
  strategy?: string;
  search?: string;
  page?: number;
  pageSize?: number;
  sortBy?: 'createdAt' | 'nextRunAt' | 'name' | 'runCount';
  sortOrder?: 'asc' | 'desc';
}

export interface RecurringJobHistoryEntry {
  id: string;
  status: string;
  strategy: string | null;
  statusCode: number | null;
  responseMs: number | null;
  error: string | null;
  creditsUsed: number;
  createdAt: Date;
  completedAt: Date | null;
}

// --- Internal Types -----------------------------------------------------------

interface RecurringJobExecutionData {
  recurringJobId: string;
  userId: string;
  apiKeyId: string;
  url: string;
  domain: string;
  strategy?: string;
  proxyTier?: string;
  proxyCountry?: string;
  templateId?: string;
  outputFormat?: string;
  maxRetries: number;
  triggerType: 'scheduled' | 'manual';
}

interface RecurringJobResult {
  success: boolean;
  scrapeJobId: string;
  error?: string;
}

// --- Constants ----------------------------------------------------------------

const RECURRING_QUEUE_NAME = 'recurring-job-execution';

/** Polling interval for checking due jobs (30 seconds) */
const POLL_INTERVAL_MS = 30_000;

/** Redis lock TTL to prevent duplicate execution across instances */
const LOCK_TTL_SECONDS = 120;

/** Maximum consecutive failures before auto-disabling a job */
const MAX_CONSECUTIVE_FAILURES = 10;

/** Default page size for listJobs pagination */
const DEFAULT_PAGE_SIZE = 25;

/** Maximum page size allowed */
const MAX_PAGE_SIZE = 100;

/** Cache TTL for job statistics (5 minutes) */
const STATS_CACHE_TTL = 300;

/** Supported timezones for validation */
const VALID_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

// --- Redis Connection Helper --------------------------------------------------

function getRedisConnection(): { host: string; port: number; password?: string } {
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

// --- Cron Utilities -----------------------------------------------------------

/**
 * Validate a cron expression by attempting to parse it.
 * Returns true if the expression is valid, false otherwise.
 */
function isValidCronExpression(expression: string): boolean {
  try {
    parseExpression(expression, { iterator: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a timezone string against the IANA timezone database.
 * Returns true if the timezone is valid, false otherwise.
 */
function isValidTimezone(tz: string): boolean {
  if (tz === 'UTC') return true;
  try {
    return VALID_TIMEZONES.has(tz);
  } catch {
    return false;
  }
}

// --- RecurringJobScheduler ----------------------------------------------------

/**
 * Manages the CRUD lifecycle of recurring jobs.
 *
 * Provides methods for creating, reading, updating, deleting, pausing,
 * resuming, and manually triggering recurring jobs. Each mutation
 * recalculates the `nextRunAt` timestamp based on the cron schedule
 * and timezone.
 */
export class RecurringJobScheduler {
  // --- Create ----------------------------------------------------------------

  /**
   * Create a new recurring job.
   *
   * Validates the cron expression and timezone, calculates the first
   * `nextRunAt`, and persists the job to the database.
   *
   * @throws {Error} If the cron expression is invalid or timezone is unrecognized
   */
  async createJob(data: CreateRecurringJobInput) {
    // Validate cron expression
    if (!isValidCronExpression(data.cronSchedule)) {
      throw new Error(`Invalid cron expression: "${data.cronSchedule}"`);
    }

    // Validate timezone
    const timezone = data.timezone ?? 'UTC';
    if (!isValidTimezone(timezone)) {
      throw new Error(`Invalid timezone: "${timezone}"`);
    }

    // Calculate the first nextRunAt
    const nextRunAt = this.calculateNextRun(data.cronSchedule, timezone);

    const job = await db.recurringJob.create({
      data: {
        userId: data.userId,
        apiKeyId: data.apiKeyId,
        name: data.name,
        url: data.url,
        domain: data.domain,
        cronSchedule: data.cronSchedule,
        timezone,
        strategy: data.strategy ?? null,
        proxyTier: data.proxyTier ?? null,
        proxyCountry: data.proxyCountry ?? null,
        templateId: data.templateId ?? null,
        outputFormat: data.outputFormat ?? null,
        webhookUrl: data.webhookUrl ?? null,
        maxRetries: data.maxRetries ?? 3,
        active: true,
        nextRunAt,
      },
    });

    // Invalidate cached stats for this user
    await this.invalidateUserStatsCache(data.userId);

    logger.info(
      {
        jobId: job.id,
        userId: data.userId,
        name: data.name,
        cronSchedule: data.cronSchedule,
        timezone,
        nextRunAt: nextRunAt?.toISOString(),
      },
      'Recurring job created',
    );

    // Fire webhook event
    await webhookDispatcher.fire(data.userId, 'recurring_job_created', {
      recurringJobId: job.id,
      name: job.name,
      url: job.url,
      cronSchedule: job.cronSchedule,
      nextRunAt: job.nextRunAt?.toISOString(),
    });

    return job;
  }

  // --- Read ------------------------------------------------------------------

  /**
   * Get a single recurring job by ID.
   * Returns null if the job does not exist.
   */
  async getJob(id: string) {
    return db.recurringJob.findUnique({
      where: { id },
    });
  }

  /**
   * List recurring jobs for a user with optional filters and pagination.
   *
   * Supports filtering by active status, domain, strategy, and name search.
   * Results are paginated and sortable by createdAt, nextRunAt, name, or runCount.
   */
  async listJobs(userId: string, filters: RecurringJobFilters = {}) {
    const {
      active,
      domain,
      strategy,
      search,
      page = 1,
      pageSize = DEFAULT_PAGE_SIZE,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = filters;

    const clampedPage = Math.max(1, page);
    const clampedPageSize = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE);
    const skip = (clampedPage - 1) * clampedPageSize;

    // Build where clause
    const where: any = { userId };

    if (active !== undefined) {
      where.active = active;
    }

    if (domain) {
      where.domain = domain;
    }

    if (strategy) {
      where.strategy = strategy;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { url: { contains: search, mode: 'insensitive' } },
        { domain: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Build order by
    const sortFieldMap: Record<string, string> = {
      createdAt: 'createdAt',
      nextRunAt: 'nextRunAt',
      name: 'name',
      runCount: 'runCount',
    };

    const sortField = sortFieldMap[sortBy] ?? 'createdAt';
    const orderDirection = sortOrder === 'asc' ? 'asc' : 'desc';

    const [jobs, total] = await Promise.all([
      db.recurringJob.findMany({
        where,
        orderBy: { [sortField]: orderDirection },
        skip,
        take: clampedPageSize,
      }),
      db.recurringJob.count({ where }),
    ]);

    return {
      jobs,
      total,
      page: clampedPage,
      pageSize: clampedPageSize,
      totalPages: Math.ceil(total / clampedPageSize),
    };
  }

  // --- Update ----------------------------------------------------------------

  /**
   * Update a recurring job's configuration.
   *
   * If the cron schedule or timezone changes, recalculates `nextRunAt`.
   * Supports partial updates -- only specified fields are modified.
   *
   * @throws {Error} If the job does not exist or cron expression is invalid
   */
  async updateJob(id: string, data: UpdateRecurringJobInput) {
    const existing = await db.recurringJob.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Recurring job not found: ${id}`);
    }

    // Validate cron expression if being updated
    const newCron = data.cronSchedule ?? existing.cronSchedule;
    if (data.cronSchedule && !isValidCronExpression(data.cronSchedule)) {
      throw new Error(`Invalid cron expression: "${data.cronSchedule}"`);
    }

    // Validate timezone if being updated
    const newTimezone = data.timezone ?? existing.timezone;
    if (data.timezone && !isValidTimezone(data.timezone)) {
      throw new Error(`Invalid timezone: "${data.timezone}"`);
    }

    // Build update data
    const updateData: any = {};

    if (data.name !== undefined) updateData.name = data.name;
    if (data.url !== undefined) updateData.url = data.url;
    if (data.domain !== undefined) updateData.domain = data.domain;
    if (data.cronSchedule !== undefined) updateData.cronSchedule = data.cronSchedule;
    if (data.timezone !== undefined) updateData.timezone = data.timezone;
    if (data.active !== undefined) updateData.active = data.active;
    if (data.maxRetries !== undefined) updateData.maxRetries = data.maxRetries;

    // Handle nullable fields -- null explicitly clears them
    if (data.strategy !== undefined) updateData.strategy = data.strategy;
    if (data.proxyTier !== undefined) updateData.proxyTier = data.proxyTier;
    if (data.proxyCountry !== undefined) updateData.proxyCountry = data.proxyCountry;
    if (data.templateId !== undefined) updateData.templateId = data.templateId;
    if (data.outputFormat !== undefined) updateData.outputFormat = data.outputFormat;
    if (data.webhookUrl !== undefined) updateData.webhookUrl = data.webhookUrl;

    // Recalculate nextRunAt if schedule or timezone changed, or if job was reactivated
    const scheduleChanged = data.cronSchedule !== undefined || data.timezone !== undefined;
    const reactivated = data.active === true && !existing.active;

    if (scheduleChanged || reactivated) {
      updateData.nextRunAt = this.calculateNextRun(newCron, newTimezone);
    }

    const updated = await db.recurringJob.update({
      where: { id },
      data: updateData,
    });

    // Invalidate cached stats
    await this.invalidateUserStatsCache(existing.userId);

    logger.info(
      {
        jobId: id,
        userId: existing.userId,
        scheduleChanged,
        reactivated,
        nextRunAt: updated.nextRunAt?.toISOString(),
      },
      'Recurring job updated',
    );

    // Fire webhook event
    await webhookDispatcher.fire(existing.userId, 'recurring_job_updated', {
      recurringJobId: id,
      name: updated.name,
      changes: Object.keys(data),
    });

    return updated;
  }

  // --- Delete ----------------------------------------------------------------

  /**
   * Soft-delete a recurring job by setting `active = false`.
   *
   * The job record is retained for historical reference, but it will
   * no longer be considered for scheduled execution.
   */
  async deleteJob(id: string) {
    const existing = await db.recurringJob.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Recurring job not found: ${id}`);
    }

    const updated = await db.recurringJob.update({
      where: { id },
      data: {
        active: false,
        nextRunAt: null,
      },
    });

    // Invalidate cached stats
    await this.invalidateUserStatsCache(existing.userId);

    logger.info({ jobId: id, userId: existing.userId }, 'Recurring job soft-deleted');

    // Fire webhook event
    await webhookDispatcher.fire(existing.userId, 'recurring_job_deleted', {
      recurringJobId: id,
      name: existing.name,
    });

    return updated;
  }

  // --- Pause -----------------------------------------------------------------

  /**
   * Pause a recurring job.
   *
   * Clears `nextRunAt` so the runner will not pick it up.
   * The job can be resumed later with `resumeJob()`.
   */
  async pauseJob(id: string) {
    const existing = await db.recurringJob.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Recurring job not found: ${id}`);
    }

    if (!existing.active) {
      throw new Error(`Recurring job is already inactive: ${id}`);
    }

    const updated = await db.recurringJob.update({
      where: { id },
      data: {
        active: false,
        nextRunAt: null,
      },
    });

    // Invalidate cached stats
    await this.invalidateUserStatsCache(existing.userId);

    logger.info({ jobId: id, userId: existing.userId }, 'Recurring job paused');

    // Fire webhook event
    await webhookDispatcher.fire(existing.userId, 'recurring_job_paused', {
      recurringJobId: id,
      name: existing.name,
    });

    return updated;
  }

  // --- Resume ----------------------------------------------------------------

  /**
   * Resume a paused recurring job.
   *
   * Recalculates `nextRunAt` based on the current time and the job's
   * cron schedule, then sets `active = true`.
   */
  async resumeJob(id: string) {
    const existing = await db.recurringJob.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Recurring job not found: ${id}`);
    }

    if (existing.active) {
      throw new Error(`Recurring job is already active: ${id}`);
    }

    // Check if job was auto-disabled due to failures
    if (existing.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      // Reset consecutive failures on manual resume
      logger.info(
        { jobId: id, consecutiveFailures: existing.consecutiveFailures },
        'Resetting consecutive failures on manual resume',
      );
    }

    const nextRunAt = this.calculateNextRun(existing.cronSchedule, existing.timezone);

    const updated = await db.recurringJob.update({
      where: { id },
      data: {
        active: true,
        nextRunAt,
        consecutiveFailures: 0,
      },
    });

    // Invalidate cached stats
    await this.invalidateUserStatsCache(existing.userId);

    logger.info(
      { jobId: id, userId: existing.userId, nextRunAt: nextRunAt?.toISOString() },
      'Recurring job resumed',
    );

    // Fire webhook event
    await webhookDispatcher.fire(existing.userId, 'recurring_job_resumed', {
      recurringJobId: id,
      name: existing.name,
      nextRunAt: nextRunAt?.toISOString(),
    });

    return updated;
  }

  // --- Manual Trigger --------------------------------------------------------

  /**
   * Manually trigger a recurring job to run immediately.
   *
   * This enqueues a ScrapeJob via BullMQ without waiting for the
   * scheduled time. The job's `lastRunAt` and `nextRunAt` are updated
   * accordingly, but the execution counts are only incremented after
   * the job completes (handled by the runner).
   *
   * @returns The BullMQ job ID of the enqueued recurring execution job
   */
  async triggerJob(id: string): Promise<string> {
    const existing = await db.recurringJob.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Recurring job not found: ${id}`);
    }

    // Ensure the job is active (don't trigger paused/deleted jobs)
    if (!existing.active) {
      throw new Error(`Cannot trigger inactive recurring job: ${id}`);
    }

    // Acquire a Redis lock to prevent duplicate triggers
    const lockKey = `recurring:trigger:${id}`;
    const lockAcquired = await redis.set(
      lockKey,
      Date.now().toString(),
      'PX',
      LOCK_TTL_SECONDS * 1000,
      'NX',
    );

    if (!lockAcquired) {
      throw new Error(
        `Recurring job is already being triggered or executing: ${id}`,
      );
    }

    try {
      // Build execution data
      const executionData: RecurringJobExecutionData = {
        recurringJobId: existing.id,
        userId: existing.userId,
        apiKeyId: existing.apiKeyId,
        url: existing.url,
        domain: existing.domain,
        strategy: existing.strategy ?? undefined,
        proxyTier: existing.proxyTier ?? undefined,
        proxyCountry: existing.proxyCountry ?? undefined,
        templateId: existing.templateId ?? undefined,
        outputFormat: existing.outputFormat ?? undefined,
        maxRetries: existing.maxRetries,
        triggerType: 'manual',
      };

      // Enqueue the execution via BullMQ
      const queue = this.getQueue();
      const bullJob = await queue.add(
        'recurring-execute',
        executionData,
        {
          jobId: `recurring:${existing.id}:manual:${Date.now()}`,
          removeOnComplete: { count: 500 },
          removeOnFail: { count: 2000 },
          attempts: 1, // We handle retries ourselves
        },
      );

      // Update lastRunAt and nextRunAt
      const nextRunAt = this.calculateNextRun(existing.cronSchedule, existing.timezone);
      await db.recurringJob.update({
        where: { id },
        data: {
          lastRunAt: new Date(),
          nextRunAt,
        },
      });

      logger.info(
        {
          jobId: id,
          userId: existing.userId,
          bullJobId: bullJob.id,
          nextRunAt: nextRunAt?.toISOString(),
        },
        'Recurring job manually triggered',
      );

      // Fire webhook event
      await webhookDispatcher.fire(existing.userId, 'recurring_job_triggered', {
        recurringJobId: id,
        name: existing.name,
        url: existing.url,
        triggerType: 'manual',
      });

      return bullJob.id!;
    } finally {
      // Release the lock
      await redis.del(lockKey);
    }
  }

  // --- History ---------------------------------------------------------------

  /**
   * Get execution history for a recurring job.
   *
   * Looks up ScrapeJob records that match the recurring job's URL
   * and were created after the recurring job itself. Results are
   * paginated and ordered by creation time (newest first).
   */
  async getJobHistory(
    id: string,
    page: number = 1,
    pageSize: number = DEFAULT_PAGE_SIZE,
  ): Promise<{
    entries: RecurringJobHistoryEntry[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const job = await db.recurringJob.findUnique({ where: { id } });
    if (!job) {
      throw new Error(`Recurring job not found: ${id}`);
    }

    const clampedPage = Math.max(1, page);
    const clampedPageSize = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE);
    const skip = (clampedPage - 1) * clampedPageSize;

    // Find ScrapeJobs matching this recurring job's URL and userId,
    // created after the recurring job itself
    const where = {
      userId: job.userId,
      url: job.url,
      domain: job.domain,
      createdAt: { gte: job.createdAt },
    };

    const [scrapeJobs, total] = await Promise.all([
      db.scrapeJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: clampedPageSize,
        select: {
          id: true,
          status: true,
          strategy: true,
          statusCode: true,
          responseMs: true,
          error: true,
          creditsUsed: true,
          createdAt: true,
          completedAt: true,
        },
      }),
      db.scrapeJob.count({ where }),
    ]);

    const entries: RecurringJobHistoryEntry[] = scrapeJobs.map((sj) => ({
      id: sj.id,
      status: sj.status,
      strategy: sj.strategy,
      statusCode: sj.statusCode,
      responseMs: sj.responseMs,
      error: sj.error,
      creditsUsed: sj.creditsUsed,
      createdAt: sj.createdAt,
      completedAt: sj.completedAt,
    }));

    return {
      entries,
      total,
      page: clampedPage,
      pageSize: clampedPageSize,
    };
  }

  // --- Statistics ------------------------------------------------------------

  /**
   * Get aggregate statistics for a user's recurring jobs.
   * Results are cached in Redis for 5 minutes.
   */
  async getUserStats(userId: string): Promise<{
    totalJobs: number;
    activeJobs: number;
    pausedJobs: number;
    totalRuns: number;
    totalFailures: number;
    autoDisabledJobs: number;
  }> {
    const cacheKey = `recurring:stats:${userId}`;
    const cached = await cacheGet<{
      totalJobs: number;
      activeJobs: number;
      pausedJobs: number;
      totalRuns: number;
      totalFailures: number;
      autoDisabledJobs: number;
    }>(cacheKey);

    if (cached) return cached;

    const [totalJobs, activeJobs, pausedJobs, autoDisabledJobs, aggResult] =
      await Promise.all([
        db.recurringJob.count({ where: { userId } }),
        db.recurringJob.count({ where: { userId, active: true } }),
        db.recurringJob.count({ where: { userId, active: false } }),
        db.recurringJob.count({
          where: { userId, active: false, consecutiveFailures: { gte: MAX_CONSECUTIVE_FAILURES } },
        }),
        db.recurringJob.aggregate({
          where: { userId },
          _sum: { runCount: true, failCount: true },
        }),
      ]);

    const stats = {
      totalJobs,
      activeJobs,
      pausedJobs,
      totalRuns: aggResult._sum.runCount ?? 0,
      totalFailures: aggResult._sum.failCount ?? 0,
      autoDisabledJobs,
    };

    await cacheSet(cacheKey, stats, STATS_CACHE_TTL);

    return stats;
  }

  // --- Helpers ---------------------------------------------------------------

  /**
   * Calculate the next run time for a cron expression in a given timezone.
   *
   * Uses cron-parser to compute the next occurrence after the current time.
   * Returns null if the cron expression cannot be parsed.
   */
  calculateNextRun(cronExpression: string, timezone: string): Date | null {
    try {
      const interval = parseExpression(cronExpression, {
        currentDate: new Date(),
        tz: timezone,
      });
      return interval.next().toDate();
    } catch (error: any) {
      logger.error(
        { cronExpression, timezone, error: error.message },
        'Failed to calculate next run time',
      );
      return null;
    }
  }

  /**
   * Invalidate the cached statistics for a user.
   */
  private async invalidateUserStatsCache(userId: string): Promise<void> {
    try {
      await cacheDelete(`recurring:stats:${userId}`);
    } catch (error: any) {
      logger.debug({ userId, error: error.message }, 'Failed to invalidate user stats cache');
    }
  }

  /**
   * Get or create the BullMQ queue for recurring job execution.
   * Lazily initialized to avoid creating Redis connections on module import.
   */
  private _queue: Queue<RecurringJobExecutionData> | null = null;

  private getQueue(): Queue<RecurringJobExecutionData> {
    if (!this._queue) {
      const connection = getRedisConnection();
      this._queue = new Queue<RecurringJobExecutionData>(RECURRING_QUEUE_NAME, {
        connection,
        defaultJobOptions: {
          removeOnComplete: { count: 500 },
          removeOnFail: { count: 2000 },
          attempts: 1,
        },
      });
    }
    return this._queue;
  }
}

// --- RecurringJobRunner -------------------------------------------------------

/**
 * Executes recurring jobs on schedule.
 *
 * Runs a polling loop that checks every 30 seconds for jobs whose
 * `nextRunAt` is in the past. For each due job, it:
 *  1. Acquires a distributed lock (via Redis) to prevent duplicate execution
 *  2. Enqueues a ScrapeJob via BullMQ
 *  3. Updates the job's `lastRunAt`, `nextRunAt`, and `runCount`
 *  4. Handles success/failure results, tracking consecutive failures
 *  5. Auto-disables jobs after 10 consecutive failures
 *
 * Designed for multi-instance deployment -- the Redis lock ensures only
 * one instance processes a given job at a time.
 */
export class RecurringJobRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private queue: Queue<RecurringJobExecutionData>;
  private running = false;
  private processing = false;

  constructor() {
    const connection = getRedisConnection();
    this.queue = new Queue<RecurringJobExecutionData>(RECURRING_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 2000 },
        attempts: 1,
      },
    });
  }

  // --- Lifecycle --------------------------------------------------------------

  /**
   * Start the polling loop.
   *
   * Checks for due jobs every 30 seconds. An initial tick is fired
   * immediately on start.
   */
  start(): void {
    if (this.running) {
      logger.warn('Recurring job runner is already running');
      return;
    }

    this.running = true;

    // Fire initial tick
    this.tick().catch((err) => {
      logger.error({ err }, 'Initial recurring job runner tick failed');
    });

    this.timer = setInterval(async () => {
      await this.tick();
    }, POLL_INTERVAL_MS);

    logger.info(
      { pollIntervalMs: POLL_INTERVAL_MS, queue: RECURRING_QUEUE_NAME },
      'Recurring job runner started',
    );
  }

  /**
   * Gracefully stop the polling loop.
   *
   * Waits for any in-progress tick to complete before returning.
   * Closes the BullMQ queue connection.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Wait for in-progress processing to finish (with timeout)
    const maxWait = 30_000;
    const startWait = Date.now();
    while (this.processing && Date.now() - startWait < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Close the queue
    try {
      await this.queue.close();
      logger.info('Recurring job runner queue closed');
    } catch (error: any) {
      logger.error({ error: error.message }, 'Error closing recurring job runner queue');
    }

    logger.info('Recurring job runner stopped');
  }

  // --- Polling ----------------------------------------------------------------

  /**
   * Run one tick of the polling loop.
   *
   * Finds all active recurring jobs where `nextRunAt <= now`,
   * then processes each one.
   */
  private async tick(): Promise<void> {
    if (this.processing) {
      logger.debug('Skipping recurring job runner tick -- previous tick still running');
      return;
    }

    this.processing = true;

    try {
      await this.processDueJobs();
    } catch (error: any) {
      logger.error({ error: error.message }, 'Recurring job runner tick failed');
    } finally {
      this.processing = false;
    }
  }

  /**
   * Find and process all recurring jobs that are due for execution.
   *
   * A job is considered "due" if:
   *  - It is active
   *  - Its `nextRunAt` is less than or equal to the current time
   *  - A Redis lock can be acquired for the job (prevents duplicate execution)
   *
   * Processes jobs in batches of 50 to avoid overwhelming the database.
   */
  async processDueJobs(): Promise<{
    processed: number;
    skipped: number;
    failed: number;
  }> {
    const now = new Date();
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    // Find all active jobs that are due
    const dueJobs = await db.recurringJob.findMany({
      where: {
        active: true,
        nextRunAt: { lte: now },
      },
      take: 50, // Process in batches
    });

    if (dueJobs.length === 0) {
      return { processed, skipped, failed };
    }

    logger.info({ dueCount: dueJobs.length }, 'Processing due recurring jobs');

    for (const job of dueJobs) {
      try {
        // Attempt to acquire a distributed lock
        const lockKey = `recurring:lock:${job.id}`;
        const lockAcquired = await redis.set(
          lockKey,
          `${process.pid}:${Date.now()}`,
          'PX',
          LOCK_TTL_SECONDS * 1000,
          'NX',
        );

        if (!lockAcquired) {
          logger.debug(
            { jobId: job.id },
            'Skipping recurring job -- lock already held by another instance',
          );
          skipped++;
          continue;
        }

        try {
          await this.executeJob(job);
          processed++;
        } finally {
          // Release the lock
          await redis.del(lockKey);
        }
      } catch (error: any) {
        logger.error(
          { jobId: job.id, error: error.message },
          'Failed to process due recurring job',
        );
        failed++;
      }
    }

    if (processed > 0 || skipped > 0 || failed > 0) {
      logger.info(
        { processed, skipped, failed, total: dueJobs.length },
        'Recurring job runner tick completed',
      );
    }

    return { processed, skipped, failed };
  }

  // --- Execution --------------------------------------------------------------

  /**
   * Execute a single recurring job.
   *
   * 1. Enqueues a ScrapeJob via BullMQ with the job's configuration
   * 2. Updates `lastRunAt`, `nextRunAt`, and increments `runCount`
   * 3. Registers a completion callback to handle the result
   *
   * @param job - The RecurringJob record from the database
   */
  async executeJob(job: {
    id: string;
    userId: string;
    apiKeyId: string;
    url: string;
    domain: string;
    cronSchedule: string;
    timezone: string;
    strategy: string | null;
    proxyTier: string | null;
    proxyCountry: string | null;
    templateId: string | null;
    outputFormat: string | null;
    maxRetries: number;
    webhookUrl: string | null;
  }): Promise<void> {
    const now = new Date();
    const nextRunAt = this.calculateNextRun(job.cronSchedule, job.timezone);

    // Build the ScrapeJob data
    const scrapeJobData = {
      jobId: `recurring:${job.id}:${Date.now()}`,
      url: job.url,
      domain: job.domain,
      userId: job.userId,
      apiKeyId: job.apiKeyId,
      strategy: (job.strategy as any) ?? undefined,
      proxyTier: job.proxyTier ?? undefined,
      proxyCountry: job.proxyCountry ?? undefined,
      templateId: job.templateId ?? undefined,
      outputFormat: (job.outputFormat as any) ?? undefined,
      priority: 3, // Medium priority for recurring jobs
    };

    // Enqueue the ScrapeJob
    let scrapeJobId: string;
    try {
      scrapeJobId = await addScrapeJob(scrapeJobData, 'starter' as PlanTier);
    } catch (error: any) {
      logger.error(
        { jobId: job.id, error: error.message },
        'Failed to enqueue ScrapeJob for recurring job',
      );

      // Treat as a failure
      await this.handleJobResult(job.id, {
        success: false,
        scrapeJobId: scrapeJobData.jobId,
        error: `Failed to enqueue: ${error.message}`,
      });

      return;
    }

    // Update the recurring job metadata
    await db.recurringJob.update({
      where: { id: job.id },
      data: {
        lastRunAt: now,
        nextRunAt,
        runCount: { increment: 1 },
      },
    });

    logger.info(
      {
        recurringJobId: job.id,
        scrapeJobId,
        nextRunAt: nextRunAt?.toISOString(),
      },
      'Recurring job executed -- ScrapeJob enqueued',
    );

    // Store the mapping in Redis so we can correlate ScrapeJob results back
    const mappingKey = `recurring:mapping:${scrapeJobId}`;
    await cacheSet(
      mappingKey,
      {
        recurringJobId: job.id,
        userId: job.userId,
        webhookUrl: job.webhookUrl,
      },
      3600, // 1 hour TTL
    );
  }

  // --- Result Handling --------------------------------------------------------

  /**
   * Handle the result of a recurring job execution.
   *
   * On success: resets `consecutiveFailures` to 0.
   * On failure: increments `failCount` and `consecutiveFailures`.
   *             If `consecutiveFailures >= 10`, auto-disables the job.
   *
   * This method should be called by the ScrapeJob worker when a job
   * started by the recurring scheduler completes or fails.
   */
  async handleJobResult(
    jobId: string,
    result: RecurringJobResult,
  ): Promise<void> {
    const job = await db.recurringJob.findUnique({ where: { id: jobId } });
    if (!job) {
      logger.warn({ jobId }, 'Recurring job not found when handling result');
      return;
    }

    if (result.success) {
      // Reset consecutive failures on success
      await db.recurringJob.update({
        where: { id: jobId },
        data: {
          consecutiveFailures: 0,
        },
      });

      logger.info(
        { jobId, scrapeJobId: result.scrapeJobId },
        'Recurring job execution succeeded',
      );

      // Fire webhook event
      await webhookDispatcher.fire(job.userId, 'recurring_job_succeeded', {
        recurringJobId: jobId,
        name: job.name,
        url: job.url,
        scrapeJobId: result.scrapeJobId,
      });
    } else {
      // Increment failure counters
      const newConsecutiveFailures = job.consecutiveFailures + 1;
      const updateData: any = {
        failCount: { increment: 1 },
        consecutiveFailures: newConsecutiveFailures,
      };

      // Check if the job should be auto-disabled
      const shouldDisable = this.shouldDisableJob({
        ...job,
        consecutiveFailures: newConsecutiveFailures,
      });

      if (shouldDisable) {
        updateData.active = false;
        updateData.nextRunAt = null;

        logger.warn(
          {
            jobId,
            consecutiveFailures: newConsecutiveFailures,
            threshold: MAX_CONSECUTIVE_FAILURES,
          },
          'Auto-disabling recurring job due to consecutive failures',
        );

        // Fire webhook event for auto-disable
        await webhookDispatcher.fire(job.userId, 'recurring_job_auto_disabled', {
          recurringJobId: jobId,
          name: job.name,
          url: job.url,
          consecutiveFailures: newConsecutiveFailures,
          lastError: result.error,
        });
      }

      await db.recurringJob.update({
        where: { id: jobId },
        data: updateData,
      });

      logger.warn(
        {
          jobId,
          scrapeJobId: result.scrapeJobId,
          consecutiveFailures: newConsecutiveFailures,
          error: result.error,
          autoDisabled: shouldDisable,
        },
        'Recurring job execution failed',
      );

      // Fire failure webhook only if not already auto-disabled
      if (!shouldDisable) {
        await webhookDispatcher.fire(job.userId, 'recurring_job_failed', {
          recurringJobId: jobId,
          name: job.name,
          url: job.url,
          scrapeJobId: result.scrapeJobId,
          error: result.error,
          consecutiveFailures: newConsecutiveFailures,
        });
      }
    }

    // Invalidate user stats cache
    try {
      await cacheDelete(`recurring:stats:${job.userId}`);
    } catch {
      // Non-critical
    }
  }

  // --- Cron Calculation -------------------------------------------------------

  /**
   * Calculate the next run time for a cron expression in a given timezone.
   *
   * Uses cron-parser with timezone support. Returns null if the
   * expression cannot be parsed or the timezone is invalid.
   */
  calculateNextRun(cronExpression: string, timezone: string): Date | null {
    try {
      const interval = parseExpression(cronExpression, {
        currentDate: new Date(),
        tz: timezone,
      });
      return interval.next().toDate();
    } catch (error: any) {
      logger.error(
        { cronExpression, timezone, error: error.message },
        'Failed to calculate next run time',
      );
      return null;
    }
  }

  // --- Auto-Disable Check ----------------------------------------------------

  /**
   * Determine if a recurring job should be auto-disabled.
   *
   * A job is disabled when its `consecutiveFailures` count reaches
   * the threshold of 10. This prevents resource waste on persistently
   * failing jobs.
   */
  shouldDisableJob(job: { consecutiveFailures: number; active: boolean }): boolean {
    return job.active && job.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
  }

  // --- ScrapeJob Result Correlation ------------------------------------------

  /**
   * Look up the recurring job mapping for a completed ScrapeJob.
   *
   * This is called by the ScrapeJob worker after a job completes or fails,
   * so the recurring scheduler can update its counters and fire webhooks.
   *
   * @returns The recurring job ID, or null if the ScrapeJob was not from a recurring schedule
   */
  async lookupRecurringMapping(scrapeJobId: string): Promise<{
    recurringJobId: string;
    userId: string;
    webhookUrl: string | null;
  } | null> {
    const mappingKey = `recurring:mapping:${scrapeJobId}`;
    const mapping = await cacheGet<{
      recurringJobId: string;
      userId: string;
      webhookUrl: string | null;
    }>(mappingKey);

    return mapping;
  }
}

// --- Health Check -------------------------------------------------------------

/**
 * Health check for the recurring job system.
 * Returns the status of the runner, queue, and recent processing metrics.
 */
export async function getRecurringSystemHealth(): Promise<{
  status: 'healthy' | 'degraded' | 'unhealthy';
  runnerActive: boolean;
  queueName: string;
  activeJobs: number;
  autoDisabledJobs: number;
  totalJobs: number;
}> {
  try {
    const [activeJobs, autoDisabledJobs, totalJobs] = await Promise.all([
      db.recurringJob.count({ where: { active: true } }),
      db.recurringJob.count({
        where: { active: false, consecutiveFailures: { gte: MAX_CONSECUTIVE_FAILURES } },
      }),
      db.recurringJob.count(),
    ]);

    const autoDisableRate = totalJobs > 0 ? autoDisabledJobs / totalJobs : 0;

    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (autoDisableRate > 0.3) {
      status = 'unhealthy';
    } else if (autoDisableRate > 0.1) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    return {
      status,
      runnerActive: recurringJobRunner['running'],
      queueName: RECURRING_QUEUE_NAME,
      activeJobs,
      autoDisabledJobs,
      totalJobs,
    };
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to get recurring system health');
    return {
      status: 'unhealthy',
      runnerActive: false,
      queueName: RECURRING_QUEUE_NAME,
      activeJobs: 0,
      autoDisabledJobs: 0,
      totalJobs: 0,
    };
  }
}

// --- Bulk Operations ----------------------------------------------------------

/**
 * Bulk pause all recurring jobs for a user.
 * Useful when a user's subscription is downgraded or credits are exhausted.
 */
export async function pauseAllJobsForUser(userId: string): Promise<number> {
  const result = await db.recurringJob.updateMany({
    where: { userId, active: true },
    data: { active: false, nextRunAt: null },
  });

  if (result.count > 0) {
    logger.info({ userId, count: result.count }, 'Bulk paused all recurring jobs for user');
    await cacheDelete(`recurring:stats:${userId}`);
  }

  return result.count;
}

/**
 * Bulk resume all recurring jobs for a user.
 * Resets consecutive failures for all jobs being resumed.
 */
export async function resumeAllJobsForUser(userId: string): Promise<number> {
  // First, get all paused jobs that weren't auto-disabled
  const jobsToResume = await db.recurringJob.findMany({
    where: {
      userId,
      active: false,
      consecutiveFailures: { lt: MAX_CONSECUTIVE_FAILURES },
    },
    select: { id: true, cronSchedule: true, timezone: true },
  });

  let resumed = 0;

  for (const job of jobsToResume) {
    const nextRunAt = parseExpression(job.cronSchedule, {
      currentDate: new Date(),
      tz: job.timezone,
    })
      .next()
      .toDate();

    await db.recurringJob.update({
      where: { id: job.id },
      data: { active: true, nextRunAt, consecutiveFailures: 0 },
    });

    resumed++;
  }

  if (resumed > 0) {
    logger.info({ userId, resumed }, 'Bulk resumed recurring jobs for user');
    await cacheDelete(`recurring:stats:${userId}`);
  }

  return resumed;
}

/**
 * Get all domains that have active recurring jobs.
 * Useful for rate-limiting and proxy planning.
 */
export async function getActiveDomains(): Promise<
  { domain: string; jobCount: number }[]
> {
  const results = await db.recurringJob.groupBy({
    by: ['domain'],
    where: { active: true },
    _count: { domain: true },
    orderBy: { _count: { domain: 'desc' } },
  });

  return results.map((r) => ({
    domain: r.domain,
    jobCount: r._count.domain,
  }));
}

/**
 * Cleanup stale Redis locks and mappings.
 * Should be called periodically (e.g., every hour) to ensure
 * that orphaned locks from crashed instances don't block execution.
 */
export async function cleanupStaleLocks(): Promise<number> {
  let cleaned = 0;

  try {
    // Find all recurring lock keys
    const r = redis;
    const keys = await r.keys('recurring:lock:*');

    for (const key of keys) {
      const ttl = await r.pttl(key);
      // If TTL is -1 (no expiry) or -2 (key doesn't exist), clean up
      if (ttl === -1 || ttl === -2) {
        await r.del(key);
        cleaned++;
      }
      // If TTL is very low (< 1 second), also clean up
      if (ttl >= 0 && ttl < 1000) {
        await r.del(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned, totalKeys: keys.length }, 'Cleaned up stale recurring job locks');
    }
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to cleanup stale locks');
  }

  return cleaned;
}

// --- Singletons ---------------------------------------------------------------

export const recurringJobScheduler = new RecurringJobScheduler();
export const recurringJobRunner = new RecurringJobRunner();
