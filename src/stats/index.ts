import { db } from '../utils/db';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('stats-tracker');

// --- Usage Stats Tracker -----------------------------------------------------

export class StatsTracker {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.timer) return;

    this.generateSnapshots().catch((err) =>
      logger.error({ error: err.message }, 'Initial snapshot generation failed'),
    );

    this.timer = setInterval(
      () => {
        this.generateSnapshots().catch((err) =>
          logger.error({ error: err.message }, 'Periodic snapshot generation failed'),
        );
      },
      60 * 60 * 1000,
    );

    logger.info('Stats tracker started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async generateSnapshots(): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    logger.info({ date: today.toISOString() }, 'Generating usage snapshots');

    try {
      const activeUsers = await db.scrapeJob.findMany({
        where: { createdAt: { gte: today } },
        select: { userId: true },
        distinct: ['userId'],
      });

      for (const { userId } of activeUsers) {
        await this.generateUserSnapshot(userId, today);
      }

      logger.info({ userCount: activeUsers.length }, 'Usage snapshots generated');
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to generate usage snapshots');
    }
  }

  async generateUserSnapshot(userId: string, date: Date): Promise<void> {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    try {
      const [
        strategyBreakdown,
        creditTotals,
        avgResponseTime,
        uniqueDomains,
        totalJobs,
        successfulJobs,
      ] = await Promise.all([
        db.scrapeJob.groupBy({
          by: ['strategy'],
          where: { userId, createdAt: { gte: startOfDay, lte: endOfDay } },
          _count: { strategy: true },
        }),
        db.scrapeJob.aggregate({
          _sum: { creditsUsed: true, creditsCharged: true },
          where: { userId, createdAt: { gte: startOfDay, lte: endOfDay } },
        }),
        db.scrapeJob.aggregate({
          _avg: { responseMs: true },
          where: { userId, status: 'done', createdAt: { gte: startOfDay, lte: endOfDay } },
        }),
        db.scrapeJob.groupBy({
          by: ['domain'],
          where: { userId, createdAt: { gte: startOfDay, lte: endOfDay } },
        }),
        db.scrapeJob.count({
          where: { userId, createdAt: { gte: startOfDay, lte: endOfDay } },
        }),
        db.scrapeJob.count({
          where: { userId, status: 'done', createdAt: { gte: startOfDay, lte: endOfDay } },
        }),
      ]);

      const successRate = totalJobs > 0 ? successfulJobs / totalJobs : 0;

      const httpRequests = strategyBreakdown.find((s) => s.strategy === 'http')?._count.strategy || 0;
      const browserRequests =
        (strategyBreakdown.find((s) => s.strategy === 'browser')?._count.strategy || 0) +
        (strategyBreakdown.find((s) => s.strategy === 'stealth-browser')?._count.strategy || 0);
      const cacheHits = strategyBreakdown.find((s) => s.strategy === 'cache')?._count.strategy || 0;

      const nlExtractions = await db.scrapeJob.count({
        where: {
          userId,
          extractedData: { not: null as any },
          createdAt: { gte: startOfDay, lte: endOfDay },
        },
      });

      const serpRequests = await db.serpResult.count({
        where: { userId, createdAt: { gte: startOfDay, lte: endOfDay } },
      });

      const captchaSolves = await db.captchaLog.count({
        where: { solved: true, createdAt: { gte: startOfDay, lte: endOfDay } },
      });

      await db.usageSnapshot.upsert({
        where: { userId_date: { userId, date: startOfDay } },
        update: {
          httpRequests,
          browserRequests,
          cacheHits,
          nlExtractions,
          serpRequests,
          captchaSolves,
          creditsUsed: creditTotals._sum.creditsUsed ?? 0,
          creditsCharged: creditTotals._sum.creditsCharged ?? 0,
          successRate: Math.round(successRate * 1000) / 1000,
          avgResponseMs: Math.round(avgResponseTime._avg.responseMs || 0),
          uniqueDomains: uniqueDomains.length,
        },
        create: {
          id: crypto.randomUUID(),
          userId,
          date: startOfDay,
          httpRequests,
          browserRequests,
          cacheHits,
          nlExtractions,
          serpRequests,
          captchaSolves,
          creditsUsed: creditTotals._sum.creditsUsed ?? 0,
          creditsCharged: creditTotals._sum.creditsCharged ?? 0,
          successRate: Math.round(successRate * 1000) / 1000,
          avgResponseMs: Math.round(avgResponseTime._avg.responseMs || 0),
          uniqueDomains: uniqueDomains.length,
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message, userId }, 'Failed to generate user snapshot');
    }
  }

  async getRealTimeStats(): Promise<{
    jobsLastHour: number;
    successRateLastHour: number;
    avgResponseMsLastHour: number;
    activeUsers: number;
    topDomains: { domain: string; count: number }[];
  }> {
    const oneHourAgo = new Date(Date.now() - 3600_000);

    const [jobsLastHour, successJobs, avgResponse, activeUsers, topDomains] = await Promise.all([
      db.scrapeJob.count({ where: { createdAt: { gte: oneHourAgo } } }),
      db.scrapeJob.count({ where: { status: 'done', createdAt: { gte: oneHourAgo } } }),
      db.scrapeJob.aggregate({
        _avg: { responseMs: true },
        where: { status: 'done', createdAt: { gte: oneHourAgo } },
      }),
      db.scrapeJob.findMany({
        where: { createdAt: { gte: oneHourAgo } },
        select: { userId: true },
        distinct: ['userId'],
      }),
      db.scrapeJob.groupBy({
        by: ['domain'],
        where: { createdAt: { gte: oneHourAgo } },
        _count: { domain: true },
        orderBy: { _count: { domain: 'desc' } },
        take: 10,
      }),
    ]);

    return {
      jobsLastHour,
      successRateLastHour: jobsLastHour > 0 ? Math.round((successJobs / jobsLastHour) * 1000) / 1000 : 0,
      avgResponseMsLastHour: Math.round(avgResponse._avg.responseMs || 0),
      activeUsers: activeUsers.length,
      topDomains: topDomains.map((d) => ({ domain: d.domain, count: d._count.domain })),
    };
  }
}

export const statsTracker = new StatsTracker();
