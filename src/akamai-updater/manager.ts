/**
 * Akamai Updater Manager — ScrapeSuite Engine
 *
 * Top-level orchestrator for the Akamai sensor auto-updater system.
 * Coordinates format monitoring, change detection, auto-patching,
 * canary testing, and alerting as a unified pipeline.
 *
 * This is the "immune system" for the Akamai bypass — it detects
 * when Akamai changes their sensor algorithms and automatically
 * adapts the engine to keep scraping operational.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { FormatMonitor, formatMonitor } from './format-monitor';
import { AutoPatcher, autoPatcher } from './auto-patcher';
import type {
  AkamaiUpdaterConfig, AkamaiUpdaterStats, SensorFormatChange,
  SensorPatch, SensorFormat, ChangeSeverity, AlertConfig,
} from './types';

const logger = createChildLogger('akamai-updater');

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_UPDATER_CONFIG: AkamaiUpdaterConfig = {
  monitorEndpoints: [
    {
      url: 'https://www.netflix.com/akamai/pixel',
      domain: 'netflix.com',
      checkInterval: 300000,
      lastChecked: 0,
      lastKnownHash: '',
      stableCheckCount: 0,
      active: true,
    },
    {
      url: 'https://www.netflix.com/akamai13/pixel',
      domain: 'netflix.com',
      checkInterval: 300000,
      lastChecked: 0,
      lastKnownHash: '',
      stableCheckCount: 0,
      active: true,
    },
    {
      url: 'https://www.google.com/akamai/pixel',
      domain: 'google.com',
      checkInterval: 600000,
      lastChecked: 0,
      lastKnownHash: '',
      stableCheckCount: 0,
      active: true,
    },
  ],
  canary: {
    testDomains: ['netflix.com', 'google.com'],
    requestsPerDomain: 5,
    minSuccessRate: 0.6,
    maxTestDuration: 120000,
    autoDeploy: true,
    rollbackThreshold: 0.4,
  },
  alerts: {
    enabled: true,
    minSeverity: 'minor',
    webhookUrls: [],
    emailAddresses: [],
    maxAlertsPerHour: 10,
  },
  globalCheckInterval: 300000,
  knownFormats: [],
  maxPatchHistory: 50,
  autoPatch: true,
  minPatchConfidence: 0.5,
  communityFeedUrl: null,
  debugMode: false,
};

// ===============================================================================
// AKAMAI UPDATER MANAGER CLASS
// ===============================================================================

export class AkamaiUpdaterManager {
  private monitor: FormatMonitor;
  private patcher: AutoPatcher;
  private config: AkamaiUpdaterConfig;
  private initialized = false;
  private changeHandlers: Array<(change: SensorFormatChange) => Promise<void>> = [];
  private alertCount = 0;
  private alertWindowStart = Date.now();

  constructor(config?: Partial<AkamaiUpdaterConfig>) {
    this.config = { ...DEFAULT_UPDATER_CONFIG, ...config };
    this.monitor = formatMonitor;
    this.patcher = autoPatcher;
  }

  /**
   * Initialize and start the auto-updater system.
   * Starts format monitoring and sets up change handlers.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing Akamai Auto-Updater');

    // Register change handler
    this.onChange(async (change) => {
      logger.info({
        changeId: change.id,
        severity: change.severity,
        fromVersion: change.fromVersion,
        toVersion: change.toVersion,
        breaksCurrent: change.breaksCurrentImpl,
      }, 'Format change detected — triggering auto-patcher');

      // Send alerts
      await this.sendAlerts(change);

      // Auto-patch if enabled and change is significant
      if (this.config.autoPatch && change.severity !== 'trivial') {
        const patch = await this.patcher.processChange(change);
        if (patch) {
          logger.info({
            patchId: patch.id,
            status: patch.status,
            successRate: patch.measuredSuccessRate,
          }, 'Auto-patch generated');
        }
      }
    });

    // Start monitoring
    await this.monitor.start();

    this.initialized = true;
    logger.info('Akamai Auto-Updater initialized and monitoring');
  }

  /** Stop all monitoring and patching. */
  async shutdown(): Promise<void> {
    this.monitor.stop();
    this.initialized = false;
    logger.info('Akamai Auto-Updater shut down');
  }

  /**
   * Register a handler to be called when format changes are detected.
   * This allows other modules (like the self-improver) to react to changes.
   */
  onChange(handler: (change: SensorFormatChange) => Promise<void>): void {
    this.changeHandlers.push(handler);
  }

  /**
   * Manually trigger a full check of all monitored endpoints.
   */
  async checkNow(): Promise<SensorFormatChange[]> {
    const changes = await this.monitor.checkAll();

    for (const change of changes) {
      for (const handler of this.changeHandlers) {
        try {
          await handler(change);
        } catch (err) {
          logger.error({ error: String(err), changeId: change.id }, 'Change handler error');
        }
      }
    }

    return changes;
  }

  /**
   * Register a known format version.
   */
  async registerFormat(format: SensorFormat): Promise<void> {
    await this.monitor.registerFormat(format);
  }

  /**
   * Get the current status of the updater.
   */
  getStatus(): {
    initialized: boolean;
    monitoring: boolean;
    knownFormats: number;
    recentChanges: number;
    activePatches: number;
  } {
    return {
      initialized: this.initialized,
      monitoring: this.initialized,
      knownFormats: this.monitor.getKnownFormats().length,
      recentChanges: this.monitor.getRecentChanges().length,
      activePatches: this.patcher.getPatches('deployed').length,
    };
  }

  /**
   * Get comprehensive statistics.
   */
  getStats(): AkamaiUpdaterStats {
    const monitorStats = this.monitor.getStats();
    const patcherStats = this.patcher.getStats();

    const byDomain: Record<string, any> = {};
    for (const change of this.monitor.getRecentChanges()) {
      for (const domain of change.affectedDomains) {
        if (!byDomain[domain]) {
          byDomain[domain] = {
            checksPerformed: 0,
            changesDetected: 0,
            currentVersion: change.toVersion,
            lastChangeTime: change.detectedAt,
          };
        }
        byDomain[domain].changesDetected++;
      }
    }

    return {
      totalChecksPerformed: monitorStats.totalChecks,
      changesDetected: monitorStats.changesDetected,
      patchesGenerated: patcherStats.patchesGenerated,
      patchesDeployed: patcherStats.patchesDeployed,
      patchesRolledBack: patcherStats.patchesRolledBack,
      currentFormatVersions: Object.fromEntries(
        this.monitor.getKnownFormats()
          .filter(f => f.status === 'active')
          .map(f => [f.domains.join(','), f.version])
      ),
      lastCheckTime: Date.now(),
      averageDetectionLatencyMs: monitorStats.averageDetectionLatencyMs,
      averagePatchTimeMs: patcherStats.averagePatchTimeMs,
      byDomain,
    };
  }

  /** Get the format monitor instance. */
  getMonitor(): FormatMonitor { return this.monitor; }

  /** Get the auto-patcher instance. */
  getPatcher(): AutoPatcher { return this.patcher; }

  // ---------- Internal Methods -------------------------------------------------

  private async sendAlerts(change: SensorFormatChange): Promise<void> {
    if (!this.config.alerts.enabled) return;

    const severityLevels: Record<ChangeSeverity, number> = {
      trivial: 0, minor: 1, major: 2, breaking: 3,
    };

    if (severityLevels[change.severity] < severityLevels[this.config.alerts.minSeverity]) {
      return;
    }

    // Rate limit alerts
    const now = Date.now();
    if (now - this.alertWindowStart > 3600000) {
      this.alertCount = 0;
      this.alertWindowStart = now;
    }

    if (this.alertCount >= this.config.alerts.maxAlertsPerHour) {
      logger.debug('Alert rate limit reached, skipping');
      return;
    }

    this.alertCount++;

    const alert = {
      type: 'akamai_format_change',
      severity: change.severity,
      fromVersion: change.fromVersion,
      toVersion: change.toVersion,
      breaksCurrent: change.breaksCurrentImpl,
      summary: change.diff.summary,
      affectedDomains: change.affectedDomains,
      detectedAt: new Date(change.detectedAt).toISOString(),
    };

    // Send webhook alerts
    for (const url of this.config.alerts.webhookUrls) {
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(alert),
          signal: AbortSignal.timeout(5000),
        });
      } catch (err) {
        logger.debug({ url, error: String(err) }, 'Failed to send alert webhook');
      }
    }

    logger.info({ alert, alertCount: this.alertCount }, 'Format change alert sent');
  }
}

/** Singleton instance. */
export const akamaiUpdaterManager = new AkamaiUpdaterManager();
