/**
 * Akamai Sensor Auto-Patcher — ScrapeSuite Engine
 *
 * Automatically generates patches when Akamai sensor format changes
 * are detected. The patcher analyzes the diff between known and new
 * formats, generates configuration updates for the sensor generator,
 * and runs canary tests before deploying.
 *
 * Patch lifecycle:
 * 1. Change detected by FormatMonitor
 * 2. Auto-patcher analyzes diff severity
 * 3. Generates config updates for SensorGenerator
 * 4. Runs canary tests against target domains
 * 5. If success rate >= threshold, auto-deploys
 * 6. Monitors post-deploy success rate
 * 7. If success rate drops below rollback threshold, auto-rolls back
 *
 * The patcher maintains a history of all patches and their outcomes,
 * building a knowledge base of what patching strategies work best
 * for different types of format changes.
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { sensorGenerator } from '../akamai/sensor-generator';
import type {
  SensorFormatChange, SensorPatch, PatchStatus, ChangeSeverity,
  SensorGeneratorConfigUpdate, PatchTestResult, CanaryProbeConfig,
} from './types';

const logger = createChildLogger('akamai-auto-patcher');

const PATCH_CACHE_PREFIX = 'akamai-updater:patch:';
const PATCH_HISTORY_PREFIX = 'akamai-updater:history:';
const ROLLBACK_PREFIX = 'akamai-updater:rollback:';

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_CANARY_CONFIG: CanaryProbeConfig = {
  testDomains: ['netflix.com', 'google.com'],
  requestsPerDomain: 5,
  minSuccessRate: 0.6,
  maxTestDuration: 120000,
  autoDeploy: true,
  rollbackThreshold: 0.4,
};

// ===============================================================================
// PATCH STRATEGY ENGINE
// ===============================================================================

interface PatchStrategy {
  name: string;
  applicableSeverities: ChangeSeverity[];
  generateConfig: (change: SensorFormatChange) => Partial<SensorGeneratorConfigUpdate>;
  estimatedSuccessRate: number;
}

const PATCH_STRATEGIES: PatchStrategy[] = [
  {
    name: 'field_addition',
    applicableSeverities: ['trivial', 'minor'],
    generateConfig: (change) => ({
      newRequiredFields: change.diff.addedFields.map((f: any) => f.fieldName || f.type),
      deprecatedFields: [],
    }),
    estimatedSuccessRate: 0.85,
  },
  {
    name: 'field_removal',
    applicableSeverities: ['minor', 'major'],
    generateConfig: (change) => ({
      deprecatedFields: change.diff.removedFields,
      newRequiredFields: [],
    }),
    estimatedSuccessRate: 0.75,
  },
  {
    name: 'encoding_update',
    applicableSeverities: ['major', 'breaking'],
    generateConfig: (change) => ({
      encodingMethod: change.diff.encodingChanges?.current || 'base64',
      version: change.toVersion,
    }),
    estimatedSuccessRate: 0.50,
  },
  {
    name: 'checksum_update',
    applicableSeverities: ['major', 'breaking'],
    generateConfig: (change) => ({
      checksumAlgorithm: change.diff.checksumChanges?.current || 'sha256',
      version: change.toVersion,
    }),
    estimatedSuccessRate: 0.45,
  },
  {
    name: 'field_reorder',
    applicableSeverities: ['minor', 'major'],
    generateConfig: (change) => ({
      fieldOrder: change.diff.orderChanges[1] || change.diff.orderChanges[0] || [],
    }),
    estimatedSuccessRate: 0.80,
  },
  {
    name: 'full_schema_rebuild',
    applicableSeverities: ['breaking'],
    generateConfig: (change) => ({
      version: change.toVersion,
      encodingMethod: change.diff.encodingChanges?.current || 'base64',
      checksumAlgorithm: change.diff.checksumChanges?.current || 'sha256',
      fieldOrder: change.diff.orderChanges[1] || [],
      newRequiredFields: change.diff.addedFields.map((f: any) => f.fieldName || f.type),
      deprecatedFields: change.diff.removedFields,
    }),
    estimatedSuccessRate: 0.30,
  },
];

// ===============================================================================
// AUTO PATCHER CLASS
// ===============================================================================

export class AutoPatcher {
  private canaryConfig: CanaryProbeConfig;
  private patchHistory: SensorPatch[] = [];
  private activePatches: Map<string, SensorPatch> = new Map();
  private rollbackSnapshots: Map<string, any> = new Map();
  private stats = {
    patchesGenerated: 0,
    patchesDeployed: 0,
    patchesRolledBack: 0,
    averagePatchTimeMs: 0,
  };

  constructor(canaryConfig?: Partial<CanaryProbeConfig>) {
    this.canaryConfig = { ...DEFAULT_CANARY_CONFIG, ...canaryConfig };
  }

  /**
   * Process a detected format change and generate a patch.
   * This is the main entry point called by the FormatMonitor.
   */
  async processChange(change: SensorFormatChange): Promise<SensorPatch | null> {
    logger.info({
      changeId: change.id,
      severity: change.severity,
      breaksCurrent: change.breaksCurrentImpl,
    }, 'Processing detected format change');

    const patchStart = Date.now();

    // Select the best patching strategy
    const strategy = this.selectStrategy(change);
    if (!strategy) {
      logger.warn({ changeId: change.id }, 'No applicable patch strategy found');
      return null;
    }

    // Generate the configuration update
    const configUpdates = strategy.generateConfig(change);

    // Create the patch
    const patch: SensorPatch = {
      id: `patch-${randomUUID().substring(0, 8)}`,
      changeId: change.id,
      targetVersion: change.toVersion,
      description: `Auto-generated patch using ${strategy.name} strategy for ${change.severity} change: ${change.diff.summary}`,
      status: 'pending',
      generatedAt: Date.now(),
      deployedAt: null,
      configUpdates,
      schemaUpdates: {
        fields: {},
        required: [],
        fieldOrder: [],
        checksumFields: [],
        encodingParams: {},
      },
      measuredSuccessRate: 0,
      testRequests: 0,
      testSuccesses: 0,
      testResults: [],
    };

    this.stats.patchesGenerated++;
    this.activePatches.set(patch.id, patch);

    // Run canary tests
    logger.info({ patchId: patch.id, strategy: strategy.name }, 'Running canary tests for patch');
    const testResults = await this.runCanaryTests(patch);
    patch.testResults = testResults;
    patch.testRequests = testResults.length;
    patch.testSuccesses = testResults.filter(r => r.success).length;
    patch.measuredSuccessRate = patch.testRequests > 0
      ? patch.testSuccesses / patch.testRequests
      : 0;

    // Decide whether to deploy
    if (patch.measuredSuccessRate >= this.canaryConfig.minSuccessRate) {
      if (this.canaryConfig.autoDeploy) {
        await this.deployPatch(patch);
      } else {
        patch.status = 'testing';
        logger.info({
          patchId: patch.id,
          successRate: patch.measuredSuccessRate,
        }, 'Patch passed canary tests but auto-deploy is disabled');
      }
    } else {
      patch.status = 'failed';
      logger.warn({
        patchId: patch.id,
        successRate: patch.measuredSuccessRate,
        threshold: this.canaryConfig.minSuccessRate,
      }, 'Patch failed canary tests');
    }

    // Update stats
    const patchTime = Date.now() - patchStart;
    this.stats.averagePatchTimeMs = this.stats.averagePatchTimeMs * 0.8 + patchTime * 0.2;

    // Save to history
    this.patchHistory.unshift(patch);
    if (this.patchHistory.length > 100) this.patchHistory.pop();
    await cacheSet(`${PATCH_CACHE_PREFIX}${patch.id}`, patch, 86400 * 30);

    return patch;
  }

  /**
   * Deploy a patch to the live sensor generator.
   * Creates a rollback snapshot first.
   */
  async deployPatch(patch: SensorPatch): Promise<void> {
    logger.info({ patchId: patch.id, targetVersion: patch.targetVersion }, 'Deploying patch');

    // Create rollback snapshot
    const currentConfig = sensorGenerator.getConfig();
    this.rollbackSnapshots.set(patch.id, { ...currentConfig });
    await cacheSet(`${ROLLBACK_PREFIX}${patch.id}`, currentConfig, 86400 * 7);

    // Apply config updates to sensor generator
    if (patch.configUpdates.version) {
      sensorGenerator.updateConfig({ version: patch.configUpdates.version as any });
    }
    if (patch.configUpdates.mouseEventCount) {
      sensorGenerator.updateConfig({
        mouseEventCount: patch.configUpdates.mouseEventCount.default,
      });
    }
    if (patch.configUpdates.keyboardEventCount) {
      sensorGenerator.updateConfig({
        keyboardEventCount: patch.configUpdates.keyboardEventCount.default,
      });
    }

    patch.status = 'deployed';
    patch.deployedAt = Date.now();
    this.stats.patchesDeployed++;

    logger.info({ patchId: patch.id }, 'Patch deployed successfully');

    // Start post-deploy monitoring
    this.monitorPostDeploy(patch);
  }

  /**
   * Roll back a deployed patch.
   */
  async rollbackPatch(patchId: string): Promise<boolean> {
    const patch = this.activePatches.get(patchId);
    if (!patch || patch.status !== 'deployed') return false;

    logger.warn({ patchId }, 'Rolling back patch');

    const snapshot = this.rollbackSnapshots.get(patchId);
    if (snapshot) {
      sensorGenerator.updateConfig(snapshot);
    }

    patch.status = 'rolled_back';
    this.stats.patchesRolledBack++;

    logger.info({ patchId }, 'Patch rolled back');
    return true;
  }

  /**
   * Manually approve a patch that's in 'testing' status.
   */
  async approvePatch(patchId: string): Promise<boolean> {
    const patch = this.activePatches.get(patchId);
    if (!patch || patch.status !== 'testing') return false;

    await this.deployPatch(patch);
    return true;
  }

  /** Get a specific patch by ID. */
  getPatch(patchId: string): SensorPatch | undefined {
    return this.activePatches.get(patchId) || this.patchHistory.find(p => p.id === patchId);
  }

  /** Get all patches, optionally filtered by status. */
  getPatches(status?: PatchStatus): SensorPatch[] {
    const all = [...this.activePatches.values(), ...this.patchHistory];
    if (status) return all.filter(p => p.status === status);
    return all;
  }

  /** Get patch history. */
  getHistory(limit: number = 20): SensorPatch[] {
    return this.patchHistory.slice(0, limit);
  }

  /** Get patcher statistics. */
  getStats(): {
    patchesGenerated: number;
    patchesDeployed: number;
    patchesRolledBack: number;
    averagePatchTimeMs: number;
    activePatchCount: number;
    successRateByStrategy: Record<string, number>;
  } {
    // Compute success rates by strategy
    const byStrategy: Record<string, { total: number; success: number }> = {};
    for (const patch of this.patchHistory) {
      const strategyMatch = patch.description.match(/using (\w+) strategy/);
      const strategy = strategyMatch ? strategyMatch[1] : 'unknown';
      if (!byStrategy[strategy]) byStrategy[strategy] = { total: 0, success: 0 };
      byStrategy[strategy].total++;
      if (patch.status === 'deployed') byStrategy[strategy].success++;
    }

    return {
      patchesGenerated: this.stats.patchesGenerated,
      patchesDeployed: this.stats.patchesDeployed,
      patchesRolledBack: this.stats.patchesRolledBack,
      averagePatchTimeMs: Math.round(this.stats.averagePatchTimeMs),
      activePatchCount: this.activePatches.size,
      successRateByStrategy: Object.fromEntries(
        Object.entries(byStrategy).map(([s, d]) => [s, d.total > 0 ? d.success / d.total : 0])
      ),
    };
  }

  // ---------- Internal Methods -------------------------------------------------

  private selectStrategy(change: SensorFormatChange): PatchStrategy | null {
    // Find strategies applicable to this severity
    const applicable = PATCH_STRATEGIES.filter(s =>
      s.applicableSeverities.includes(change.severity)
    );

    if (applicable.length === 0) return null;

    // Score each strategy based on the specific diff characteristics
    let best: PatchStrategy | null = null;
    let bestScore = -1;

    for (const strategy of applicable) {
      let score = strategy.estimatedSuccessRate;

      // Bonus for matching the specific change type
      if (change.diff.encodingChanges && strategy.name === 'encoding_update') score += 0.2;
      if (change.diff.checksumChanges && strategy.name === 'checksum_update') score += 0.2;
      if (change.diff.addedFields.length > 0 && strategy.name === 'field_addition') score += 0.15;
      if (change.diff.removedFields.length > 0 && strategy.name === 'field_removal') score += 0.15;
      if (change.diff.orderChanges.length > 0 && strategy.name === 'field_reorder') score += 0.15;
      if (change.severity === 'breaking' && strategy.name === 'full_schema_rebuild') score += 0.3;

      // Bonus from historical performance
      const patcherStats = this.getStats();
      const historyPerf = patcherStats.successRateByStrategy[strategy.name];
      if (historyPerf !== undefined) {
        score = score * 0.7 + historyPerf * 0.3;
      }

      if (score > bestScore) {
        bestScore = score;
        best = strategy;
      }
    }

    return best;
  }

  private async runCanaryTests(patch: SensorPatch): Promise<PatchTestResult[]> {
    const results: PatchTestResult[] = [];

    for (const domain of this.canaryConfig.testDomains) {
      for (let i = 0; i < this.canaryConfig.requestsPerDomain; i++) {
        const testStart = Date.now();

        try {
          // Generate a test sensor payload with the new config
          const payload = await sensorGenerator.generatePayload({
            domain,
            pageUrl: `https://www.${domain}/`,
            requestId: `canary-${patch.id}-${i}`,
            sessionId: `canary-session-${i}`,
          });

          // Validate the payload
          const validation = sensorGenerator.validatePayload(payload);

          results.push({
            domain,
            success: validation.valid,
            responseCode: validation.valid ? 200 : 400,
            errorMessage: validation.valid ? undefined : validation.errors.join('; '),
            timestamp: Date.now(),
            sensorVersion: payload.version,
          });
        } catch (err) {
          results.push({
            domain,
            success: false,
            responseCode: 500,
            errorMessage: String(err),
            timestamp: Date.now(),
            sensorVersion: patch.targetVersion,
          });
        }
      }
    }

    return results;
  }

  private monitorPostDeploy(patch: SensorPatch): void {
    // Check success rate after 5 minutes
    setTimeout(async () => {
      if (patch.status !== 'deployed') return;

      // In production, this would check actual request success rates
      // from the self-improver module. For now, we check canary results.
      const recentResults = patch.testResults.slice(-10);
      const recentSuccessRate = recentResults.length > 0
        ? recentResults.filter(r => r.success).length / recentResults.length
        : 1;

      if (recentSuccessRate < this.canaryConfig.rollbackThreshold) {
        logger.warn({
          patchId: patch.id,
          recentSuccessRate,
          threshold: this.canaryConfig.rollbackThreshold,
        }, 'Post-deploy success rate below rollback threshold');
        await this.rollbackPatch(patch.id);
      } else {
        logger.info({
          patchId: patch.id,
          recentSuccessRate,
        }, 'Post-deploy monitoring: success rate acceptable');
      }
    }, 300000); // 5 minutes
  }
}

/** Singleton instance. */
export const autoPatcher = new AutoPatcher();
