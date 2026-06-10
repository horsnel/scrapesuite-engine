import 'dotenv/config';
import { startServer } from './api';
import { createChildLogger } from './utils/logger';
import { db } from './utils/db';
import { browserPool } from './browser-pool';
import { statsTracker } from './stats';
import { webhookDispatcher } from './scheduler/webhooks';
import { adaptiveRateLimiter } from './rate-limiter';
import { sessionManager } from './session';

const logger = createChildLogger('main');

async function connectWithRetry(maxRetries = 10, baseDelayMs = 2000): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await db.$connect();
      logger.info('Database connected');
      return;
    } catch (error) {
      const delay = Math.min(baseDelayMs * Math.pow(1.5, attempt - 1), 30000);
      logger.warn(
        { attempt, maxRetries, delayMs: Math.round(delay), error: (error as Error).message },
        'Database connection failed, retrying...',
      );
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
}

async function main() {
  const mode = process.env.MODE || 'all';
  logger.info({ mode, nodeEnv: process.env.NODE_ENV }, 'Starting ScrapeSuite Engine v3.0');

  // Verify database connection with retry
  try {
    await connectWithRetry();
  } catch (error) {
    logger.error(error, 'Failed to connect to database after all retries');
    process.exit(1);
  }

  if (mode === 'api' || mode === 'all') {
    await startServer();
  }

  if (mode === 'worker' || mode === 'all') {
    // Workers auto-start when their module is imported
    const { scrapeWorker, monitorWorker, enrichWorker } = await import('./workers');
    logger.info({
      scrapeConcurrency: scrapeWorker.concurrency,
      monitorConcurrency: monitorWorker.concurrency,
      enrichConcurrency: enrichWorker.concurrency,
    }, 'Workers started');

    // Start the monitor scheduler in worker mode
    const { monitorScheduler } = await import('./scheduler/monitor');
    monitorScheduler.start();
    logger.info('Monitor scheduler started');

    // Initialize browser pool for worker mode
    try {
      await browserPool.initialize();
      logger.info('Browser pool initialized for worker mode');
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Browser pool initialization failed -- will launch on demand');
    }

    // Start stats tracker
    statsTracker.start();
    logger.info('Stats tracker started');

    // Start webhook dispatcher for worker mode
    webhookDispatcher.start();
    logger.info('Webhook dispatcher started');

    // Start adaptive rate limiter cleanup
    adaptiveRateLimiter.startCleanup();
    logger.info('Adaptive rate limiter started');

    // Start session manager cleanup
    sessionManager.startCleanup();
    logger.info('Session manager started');
  }

  logger.info({ mode }, 'ScrapeSuite Engine v3.0 ready -- Bright Data competitor mode');
}

main().catch((error) => {
  logger.error(error, 'Fatal error starting ScrapeSuite Engine');
  process.exit(1);
});

// Graceful shutdown for standalone worker mode
const standaloneShutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutdown signal received...');
  try {
    adaptiveRateLimiter.stopCleanup();
    sessionManager.stopCleanup();
    await webhookDispatcher.stop();
    await browserPool.shutdown();
    statsTracker.stop();
    logger.info('All modules shut down gracefully');
    process.exit(0);
  } catch (err) {
    logger.error(err, 'Error during graceful shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => standaloneShutdown('SIGTERM'));
process.on('SIGINT', () => standaloneShutdown('SIGINT'));
