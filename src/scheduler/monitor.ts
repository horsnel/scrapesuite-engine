import { db } from '../utils/db';
import { addMonitorJob } from '../workers/queue';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('scheduler');

// --- Cron Parser -------------------------------------------------------------

interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

function parseCronExpression(expr: string): CronFields | null {
  try {
    const parts = expr.trim().split(/\s+/);
    if (parts.length < 5) return null;

    const parseField = (field: string, min: number, max: number): number[] => {
      if (field === '*') {
        const values: number[] = [];
        for (let i = min; i <= max; i++) values.push(i);
        return values;
      }

      if (field.includes('/')) {
        const [range, stepStr] = field.split('/');
        const step = parseInt(stepStr, 10);
        const start = range === '*' ? min : parseInt(range, 10);
        const values: number[] = [];
        for (let i = start; i <= max; i += step) values.push(i);
        return values;
      }

      if (field.includes(',')) {
        return field.split(',').map((v) => parseInt(v, 10)).filter((v) => v >= min && v <= max);
      }

      if (field.includes('-')) {
        const [startStr, endStr] = field.split('-');
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        const values: number[] = [];
        for (let i = start; i <= end; i++) values.push(i);
        return values;
      }

      const val = parseInt(field, 10);
      return val >= min && val <= max ? [val] : [];
    };

    return {
      minute: parseField(parts[0], 0, 59),
      hour: parseField(parts[1], 0, 23),
      dayOfMonth: parseField(parts[2], 1, 31),
      month: parseField(parts[3], 1, 12),
      dayOfWeek: parseField(parts[4], 0, 6),
    };
  } catch {
    return null;
  }
}

function shouldRunNow(cron: CronFields, date: Date): boolean {
  return cron.minute.includes(date.getMinutes())
    && cron.hour.includes(date.getHours())
    && cron.dayOfMonth.includes(date.getDate())
    && cron.month.includes(date.getMonth() + 1)
    && cron.dayOfWeek.includes(date.getDay());
}

// --- Monitor Scheduler --------------------------------------------------------

export class MonitorScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  /**
   * Start the scheduler. Checks every minute for monitors that need to run.
   */
  start(intervalMs: number = 60_000): void {
    if (this.timer) {
      logger.warn('Scheduler already running');
      return;
    }

    logger.info({ intervalMs }, 'Monitor scheduler started');

    // Run immediately on start
    this.tick().catch((err) => {
      logger.error({ err }, 'Initial scheduler tick failed');
    });

    this.timer = setInterval(async () => {
      await this.tick();
    }, intervalMs);
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Monitor scheduler stopped');
    }
  }

  /**
   * Run one tick of the scheduler: check all active monitors and enqueue jobs
   * for any that are due to run.
   */
  private async tick(): Promise<void> {
    if (this.isRunning) {
      logger.debug('Scheduler tick skipped -- previous tick still running');
      return;
    }

    this.isRunning = true;

    try {
      const now = new Date();

      // Get all active monitors
      const monitors = await db.monitor.findMany({
        where: { active: true },
        include: { apiKey: true },
      });

      let enqueued = 0;
      let skipped = 0;

      for (const monitor of monitors) {
        // Check if the monitor should run now based on its cron schedule
        const cronFields = parseCronExpression(monitor.schedule);
        if (!cronFields) {
          logger.warn({ monitorId: monitor.id, schedule: monitor.schedule }, 'Invalid cron expression');
          continue;
        }

        if (!shouldRunNow(cronFields, now)) {
          skipped++;
          continue;
        }

        // Check if the monitor has already run in this minute window
        if (monitor.lastRun) {
          const timeSinceLastRun = now.getTime() - monitor.lastRun.getTime();
          if (timeSinceLastRun < 55_000) { // Within the same minute
            skipped++;
            continue;
          }
        }

        // Enqueue a monitor job
        const jobId = crypto.randomUUID();
        try {
          await addMonitorJob({
            jobId,
            monitorId: monitor.id,
            url: monitor.url,
            domain: new URL(monitor.url).hostname.replace(/^www\./, ''),
            userId: monitor.userId,
            apiKeyId: monitor.apiKeyId,
            fields: monitor.fields,
          });

          enqueued++;
        } catch (error: any) {
          logger.error({ monitorId: monitor.id, error: error.message }, 'Failed to enqueue monitor job');
        }
      }

      if (enqueued > 0 || skipped > 0) {
        logger.info({ total: monitors.length, enqueued, skipped }, 'Scheduler tick completed');
      }
    } catch (error: any) {
      logger.error({ error: error.message }, 'Scheduler tick failed');
    } finally {
      this.isRunning = false;
    }
  }
}

export const monitorScheduler = new MonitorScheduler();
