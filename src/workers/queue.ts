import { Queue, QueueEvents } from 'bullmq';
import { createChildLogger } from '../utils/logger';
import { QUEUE_NAMES, type ScrapeJobData, type PlanTier } from '../types';

const logger = createChildLogger('queue');

// --- Redis connection config (shared across all queues) ------------------------

// Parse REDIS_URL or fall back to individual env vars
function getRedisConnection(): { host: string; port: number; password?: string; db?: number } {
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const parsed = new URL(url);
      return {
        host: parsed.hostname,
        port: parseInt(parsed.port || '6379', 10),
        password: parsed.password || undefined,
        db: parseInt(parsed.pathname?.slice(1) || '0', 10) || undefined,
      };
    } catch {
      // Fall through to env vars
    }
  }
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0', 10),
  };
}

const connection = getRedisConnection();

// --- Queue Instances ----------------------------------------------------------

/** Primary scrape queue -- processes all incoming scrape requests */
export const scrapeQueue = new Queue(QUEUE_NAMES.SCRAPE, {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
    attempts: 2,
    backoff: { type: 'exponential', delay: 1000 },
  },
});

/** Monitor queue -- scheduled re-scrapes for URL monitoring */
export const monitorQueue = new Queue(QUEUE_NAMES.MONITOR, {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 2000 },
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
});

/** Enrichment queue -- lead enrichment & data augmentation jobs */
export const enrichQueue = new Queue(QUEUE_NAMES.ENRICH, {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 2000 },
    attempts: 2,
    backoff: { type: 'exponential', delay: 2000 },
  },
});

// --- Queue Events -------------------------------------------------------------

/** Scrape queue events -- used for real-time job status monitoring */
export const scrapeQueueEvents = new QueueEvents(QUEUE_NAMES.SCRAPE, { connection });

/** Monitor queue events */
export const monitorQueueEvents = new QueueEvents(QUEUE_NAMES.MONITOR, { connection });

/** Enrich queue events */
export const enrichQueueEvents = new QueueEvents(QUEUE_NAMES.ENRICH, { connection });

// --- Priority Mapping ---------------------------------------------------------

const PLAN_PRIORITY: Record<PlanTier, number> = {
  business: 10,
  pro: 5,
  starter: 1,
};

// --- Job Addition Helpers -----------------------------------------------------

/**
 * Add a scrape job to the queue with plan-based priority.
 * Business tier jobs are processed before pro, which are processed before starter.
 *
 * @returns The BullMQ job ID (same as data.jobId)
 */
export async function addScrapeJob(
  data: ScrapeJobData,
  plan: PlanTier,
): Promise<string> {
  const priority = PLAN_PRIORITY[plan] ?? 1;

  const job = await scrapeQueue.add(
    'scrape',
    { ...data, priority },
    {
      priority,
      jobId: data.jobId,
    },
  );

  logger.info(
    { jobId: data.jobId, url: data.url, plan, priority },
    'Scrape job queued',
  );

  return job.id!;
}

/**
 * Add a monitor check job to the queue.
 * Monitor jobs run on a schedule and re-scrape monitored URLs.
 */
export async function addMonitorJob(
  data: {
    jobId: string;
    monitorId: string;
    url: string;
    domain: string;
    userId: string;
    apiKeyId: string;
    fields: string[];
  },
): Promise<string> {
  const job = await monitorQueue.add('monitor-check', data, {
    jobId: data.jobId,
    priority: 3,
  });

  logger.info(
    { jobId: data.jobId, monitorId: data.monitorId, url: data.url },
    'Monitor job queued',
  );

  return job.id!;
}

/**
 * Add an enrichment job to the queue.
 * Enrichment jobs augment scraped data with additional intelligence.
 */
export async function addEnrichJob(
  data: {
    jobId: string;
    url: string;
    domain: string;
    userId: string;
    apiKeyId: string;
    enrichType: string;
    payload: Record<string, any>;
  },
): Promise<string> {
  const job = await enrichQueue.add('enrich', data, {
    jobId: data.jobId,
    priority: 2,
  });

  logger.info(
    { jobId: data.jobId, url: data.url, enrichType: data.enrichType },
    'Enrich job queued',
  );

  return job.id!;
}

// --- Job Status Helpers -------------------------------------------------------

/**
 * Retrieve the current status of a scrape job from the BullMQ queue.
 * Returns null if the job is no longer in the queue (expired or completed beyond retention).
 */
export async function getJobStatus(jobId: string): Promise<{
  status: string;
  progress: number;
  result?: any;
  error?: string;
} | null> {
  const job = await scrapeQueue.getJob(jobId);
  if (!job) return null;

  const state = await job.getState();

  return {
    status: state,
    progress: (job.progress as number) || 0,
    result: job.returnvalue,
    error: job.failedReason,
  };
}

type QueueMetrics = {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
};

/**
 * Get aggregate queue metrics for monitoring dashboards.
 */
export async function getQueueMetrics(): Promise<{
  scrape: QueueMetrics;
  monitor: QueueMetrics;
  enrich: QueueMetrics;
}> {
  const [scrapeCounts, monitorCounts, enrichCounts] = await Promise.all([
    scrapeQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    monitorQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    enrichQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
  ]);

  return {
    scrape: scrapeCounts as unknown as QueueMetrics,
    monitor: monitorCounts as unknown as QueueMetrics,
    enrich: enrichCounts as unknown as QueueMetrics,
  };
}

// --- Queue Lifecycle ----------------------------------------------------------

/**
 * Gracefully close all queue connections. Call during shutdown.
 */
export async function closeQueues(): Promise<void> {
  logger.info('Closing all queue connections...');

  await Promise.all([
    scrapeQueueEvents.close(),
    monitorQueueEvents.close(),
    enrichQueueEvents.close(),
    scrapeQueue.close(),
    monitorQueue.close(),
    enrichQueue.close(),
  ]);

  logger.info('All queue connections closed');
}
