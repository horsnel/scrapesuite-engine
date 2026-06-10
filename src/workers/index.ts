import { Worker, type Job } from 'bullmq';
import { createChildLogger } from '../utils/logger';
import { db } from '../utils/db';
import { orchestrator } from '../orchestrator';
import { QUEUE_NAMES, type ScrapeJobData, type ScrapeJobResult } from '../types';

const logger = createChildLogger('workers');

// --- Concurrency Configuration ------------------------------------------------

const HTTP_CONCURRENCY = parseInt(process.env.HTTP_WORKER_CONCURRENCY || '50', 10);
const BROWSER_CONCURRENCY = parseInt(process.env.BROWSER_WORKER_CONCURRENCY || '10', 10);
const MONITOR_CONCURRENCY = parseInt(process.env.MONITOR_WORKER_CONCURRENCY || '20', 10);
const ENRICH_CONCURRENCY = parseInt(process.env.ENRICH_WORKER_CONCURRENCY || '15', 10);

// --- Shared Redis Connection --------------------------------------------------

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
    } catch {}
  }
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0', 10),
  };
}

const connection = getRedisConnection();

// --- Scrape Worker ------------------------------------------------------------

const scrapeWorker = new Worker<ScrapeJobData, ScrapeJobResult>(
  QUEUE_NAMES.SCRAPE,
  async (job: Job<ScrapeJobData, ScrapeJobResult>) => {
    const { jobId, url } = job.data;

    logger.info({ jobId, url }, 'Processing scrape job');

    // Mark job as running
    await db.scrapeJob.update({
      where: { id: jobId },
      data: { status: 'running' },
    });

    // Process through orchestrator
    const result = await orchestrator.processJob(job.data);

    // Update final status (single source of truth for status)
    // The orchestrator no longer updates status -- only data fields
    await db.scrapeJob.update({
      where: { id: jobId },
      data: {
        status: result.status,
        strategy: result.strategy,
        creditsUsed: result.creditsUsed,
        creditsCharged: result.creditsCharged,
        result: result.html ? { html: result.html } : undefined,
        extractedData: result.extracted ?? undefined,
        statusCode: result.statusCode,
        responseMs: result.responseMs,
        proxyId: result.proxyId,
        proxyCountry: result.proxyCountry,
        captchaSolved: result.captchaSolved ?? false,
        completedAt: new Date(),
      },
    });

    // Update batch tracking if this is a batch job
    if (job.data.batchId) {
      await updateBatchProgress(job.data.batchId, result.status === 'done');
    }

    return result;
  },
  {
    connection,
    concurrency: HTTP_CONCURRENCY,
    limiter: {
      max: 100,
      duration: 1000,
    },
  },
);

// --- Monitor Worker -----------------------------------------------------------

const monitorWorker = new Worker(
  QUEUE_NAMES.MONITOR,
  async (job: Job) => {
    const { jobId, monitorId, url } = job.data;

    logger.info({ jobId, monitorId, url }, 'Processing monitor job');

    const scrapeResult = await orchestrator.processJob({
      jobId,
      url,
      domain: job.data.domain,
      userId: job.data.userId,
      apiKeyId: job.data.apiKeyId,
      strategy: 'auto',
      priority: 3,
    });

    if (scrapeResult.extracted) {
      await db.snapshot.create({
        data: {
          monitorId,
          data: scrapeResult.extracted,
        },
      });
    }

    await db.monitor.update({
      where: { id: monitorId },
      data: { lastRun: new Date() },
    });

    await db.scrapeJob.update({
      where: { id: jobId },
      data: {
        status: scrapeResult.status,
        strategy: scrapeResult.strategy,
        creditsUsed: scrapeResult.creditsUsed,
        responseMs: scrapeResult.responseMs,
        completedAt: new Date(),
      },
    });

    return scrapeResult;
  },
  {
    connection,
    concurrency: MONITOR_CONCURRENCY,
    limiter: {
      max: 50,
      duration: 1000,
    },
  },
);

// --- Enrich Worker ------------------------------------------------------------

const enrichWorker = new Worker(
  QUEUE_NAMES.ENRICH,
  async (job: Job) => {
    const { jobId, url, enrichType } = job.data;

    logger.info({ jobId, url, enrichType }, 'Processing enrich job');

    const result = await orchestrator.processJob({
      jobId,
      url,
      domain: job.data.domain,
      userId: job.data.userId,
      apiKeyId: job.data.apiKeyId,
      strategy: 'auto',
      priority: 2,
      extract: job.data.enrichType,
    });

    await db.scrapeJob.update({
      where: { id: jobId },
      data: {
        status: result.status,
        creditsUsed: result.creditsUsed,
        extractedData: result.extracted ?? undefined,
        responseMs: result.responseMs,
        completedAt: new Date(),
      },
    });

    return result;
  },
  {
    connection,
    concurrency: ENRICH_CONCURRENCY,
    limiter: {
      max: 30,
      duration: 1000,
    },
  },
);

// --- Batch Progress Tracking --------------------------------------------------

async function updateBatchProgress(batchId: string, isSuccess: boolean): Promise<void> {
  try {
    const updateData = isSuccess
      ? { completedJobs: { increment: 1 } }
      : { failedJobs: { increment: 1 } };

    const batch = await db.batch.update({
      where: { id: batchId },
      data: updateData,
    });

    // Check if batch is complete
    if (batch.completedJobs + batch.failedJobs >= batch.totalJobs) {
      await db.batch.update({
        where: { id: batchId },
        data: {
          status: 'done',
          completedAt: new Date(),
        },
      });
      logger.info({ batchId, completed: batch.completedJobs, failed: batch.failedJobs }, 'Batch completed');
    }
  } catch (err: any) {
    logger.error({ batchId, error: err.message }, 'Failed to update batch progress');
  }
}

// --- Scrape Worker Event Handlers ---------------------------------------------

scrapeWorker.on('completed', (job: Job<ScrapeJobData, ScrapeJobResult>, result: ScrapeJobResult) => {
  logger.info(
    { jobId: job.id, url: job.data.url, strategy: result.strategy, status: result.status, creditsUsed: result.creditsUsed, responseMs: result.responseMs },
    'Job completed',
  );
});

scrapeWorker.on('failed', (job: Job<ScrapeJobData, ScrapeJobResult> | undefined, err: Error) => {
  logger.error({ jobId: job?.id, url: job?.data?.url, error: err.message, stack: err.stack }, 'Job failed');

  if (job?.data?.jobId) {
    db.scrapeJob
      .update({
        where: { id: job.data.jobId },
        data: {
          status: 'failed',
          error: err.message,
          completedAt: new Date(),
        },
      })
      .catch((e) =>
        logger.error({ error: e, jobId: job.data!.jobId }, 'Failed to update job error in DB'),
      );

    // Update batch tracking
    if (job.data.batchId) {
      updateBatchProgress(job.data.batchId, false).catch(() => {});
    }
  }
});

scrapeWorker.on('error', (err: Error) => {
  logger.error({ error: err }, 'Scrape worker error');
});

scrapeWorker.on('stalled', (jobId: string) => {
  logger.warn({ jobId }, 'Scrape job stalled -- will be retried');
});

// --- Monitor Worker Event Handlers --------------------------------------------

monitorWorker.on('completed', (job: Job) => {
  logger.info({ jobId: job.id, monitorId: job.data.monitorId }, 'Monitor job completed');
});

monitorWorker.on('failed', (job: Job | undefined, err: Error) => {
  logger.error({ jobId: job?.id, monitorId: job?.data?.monitorId, error: err.message }, 'Monitor job failed');

  if (job?.data?.jobId) {
    db.scrapeJob
      .update({
        where: { id: job.data.jobId },
        data: { status: 'failed', error: err.message, completedAt: new Date() },
      })
      .catch((e) =>
        logger.error({ error: e, jobId: job.data!.jobId }, 'Failed to update monitor job error in DB'),
      );
  }
});

monitorWorker.on('error', (err: Error) => {
  logger.error({ error: err }, 'Monitor worker error');
});

// --- Enrich Worker Event Handlers ---------------------------------------------

enrichWorker.on('completed', (job: Job) => {
  logger.info({ jobId: job.id, enrichType: job.data.enrichType }, 'Enrich job completed');
});

enrichWorker.on('failed', (job: Job | undefined, err: Error) => {
  logger.error({ jobId: job?.id, enrichType: job?.data?.enrichType, error: err.message }, 'Enrich job failed');

  if (job?.data?.jobId) {
    db.scrapeJob
      .update({
        where: { id: job.data.jobId },
        data: { status: 'failed', error: err.message, completedAt: new Date() },
      })
      .catch((e) =>
        logger.error({ error: e, jobId: job.data!.jobId }, 'Failed to update enrich job error in DB'),
      );
  }
});

enrichWorker.on('error', (err: Error) => {
  logger.error({ error: err }, 'Enrich worker error');
});

// --- Graceful Shutdown --------------------------------------------------------

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Shutdown signal received, closing workers...');

  try {
    await Promise.all([
      scrapeWorker.close(),
      monitorWorker.close(),
      enrichWorker.close(),
    ]);
    logger.info('All workers closed successfully');
  } catch (err) {
    logger.error({ error: err }, 'Error closing workers during shutdown');
  }

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// --- Startup Log --------------------------------------------------------------

logger.info(
  { httpConcurrency: HTTP_CONCURRENCY, browserConcurrency: BROWSER_CONCURRENCY, monitorConcurrency: MONITOR_CONCURRENCY, enrichConcurrency: ENRICH_CONCURRENCY },
  'Workers started',
);

// --- Exports ------------------------------------------------------------------

export { scrapeWorker, monitorWorker, enrichWorker };
