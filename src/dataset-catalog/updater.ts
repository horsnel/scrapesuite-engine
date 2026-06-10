/**
 * Dataset Updater -- ScrapeSuite Engine
 *
 * Handles dataset updates with multiple strategies: append, replace,
 * upsert, and merge. Supports deduplication and quality scoring.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import {
  DatasetEntry,
  DatasetUpdateConfig,
  UpdateResult,
  UpdateStrategy,
} from './types';

const logger = createChildLogger('dataset-catalog:updater');

const ENTRIES_PREFIX = 'dataset:entries:';

// ---------- Dataset Updater class ---------------------------------------------

export class DatasetUpdater {

  /** Update a dataset using the configured strategy. */
  async updateDataset(
    config: DatasetUpdateConfig,
    newEntries: DatasetEntry[],
  ): Promise<UpdateResult> {
    switch (config.update_strategy) {
      case 'append': return this.appendData(config.dataset_id, newEntries);
      case 'replace': return this.replaceData(config.dataset_id, newEntries);
      case 'upsert': return this.upsertData(config.dataset_id, newEntries, config.dedup_key_fields);
      case 'merge': return this.mergeData(config.dataset_id, newEntries, config.dedup_key_fields);
      default: throw new Error(`Unknown update strategy: ${config.update_strategy}`);
    }
  }

  /** Append entries to a dataset. */
  async appendData(datasetId: string, newEntries: DatasetEntry[]): Promise<UpdateResult> {
    const existing = await this.getEntries(datasetId);
    const enriched = this.enrichEntries(newEntries);
    const combined = [...existing, ...enriched];

    await this.storeEntries(datasetId, combined);

    logger.info({ datasetId, added: enriched.length, total: combined.length }, 'Data appended');
    return {
      inserted: enriched.length,
      updated: 0,
      duplicates_removed: 0,
      validation_errors: 0,
      new_version: 0, // Version bump handled by manager
    };
  }

  /** Replace all data in a dataset. */
  async replaceData(datasetId: string, newEntries: DatasetEntry[]): Promise<UpdateResult> {
    const enriched = this.enrichEntries(newEntries);
    await this.storeEntries(datasetId, enriched);

    logger.info({ datasetId, total: enriched.length }, 'Data replaced');
    return {
      inserted: enriched.length,
      updated: 0,
      duplicates_removed: 0,
      validation_errors: 0,
      new_version: 0,
    };
  }

  /** Upsert entries by key fields — insert new, update existing. */
  async upsertData(
    datasetId: string,
    newEntries: DatasetEntry[],
    keyFields: string[],
  ): Promise<UpdateResult> {
    const existing = await this.getEntries(datasetId);
    const enriched = this.enrichEntries(newEntries);

    if (!keyFields.length) {
      // No key fields specified — fall back to append
      return this.appendData(datasetId, enriched);
    }

    let inserted = 0;
    let updated = 0;

    // Build index by key hash
    const existingByKey = new Map<string, DatasetEntry>();
    for (const entry of existing) {
      const key = this.computeKeyHash(entry.data, keyFields);
      existingByKey.set(key, entry);
    }

    for (const entry of enriched) {
      const key = this.computeKeyHash(entry.data, keyFields);
      if (existingByKey.has(key)) {
        // Update existing entry
        const existingEntry = existingByKey.get(key)!;
        entry.id = existingEntry.id; // Preserve ID
        existingByKey.set(key, entry);
        updated++;
      } else {
        existingByKey.set(key, entry);
        inserted++;
      }
    }

    const combined = [...existingByKey.values()];
    await this.storeEntries(datasetId, combined);

    logger.info({ datasetId, inserted, updated, total: combined.length }, 'Data upserted');
    return {
      inserted,
      updated,
      duplicates_removed: 0,
      validation_errors: 0,
      new_version: 0,
    };
  }

  /** Merge entries with deep merge strategy. */
  async mergeData(
    datasetId: string,
    newEntries: DatasetEntry[],
    keyFields: string[],
  ): Promise<UpdateResult> {
    const existing = await this.getEntries(datasetId);
    const enriched = this.enrichEntries(newEntries);

    if (!keyFields.length) {
      return this.appendData(datasetId, enriched);
    }

    let inserted = 0;
    let updated = 0;

    const existingByKey = new Map<string, DatasetEntry>();
    for (const entry of existing) {
      const key = this.computeKeyHash(entry.data, keyFields);
      existingByKey.set(key, entry);
    }

    for (const entry of enriched) {
      const key = this.computeKeyHash(entry.data, keyFields);
      if (existingByKey.has(key)) {
        // Deep merge
        const existingEntry = existingByKey.get(key)!;
        const merged = this.deepMerge(existingEntry.data, entry.data);
        existingByKey.set(key, { ...existingEntry, data: merged });
        updated++;
      } else {
        existingByKey.set(key, entry);
        inserted++;
      }
    }

    const combined = [...existingByKey.values()];
    await this.storeEntries(datasetId, combined);

    logger.info({ datasetId, inserted, updated, total: combined.length }, 'Data merged');
    return {
      inserted,
      updated,
      duplicates_removed: 0,
      validation_errors: 0,
      new_version: 0,
    };
  }

  /** Deduplicate entries by key fields. */
  async deduplicate(datasetId: string, keyFields: string[]): Promise<number> {
    const entries = await this.getEntries(datasetId);
    const seen = new Map<string, DatasetEntry>();
    let removed = 0;

    for (const entry of entries) {
      const key = this.computeKeyHash(entry.data, keyFields);
      if (seen.has(key)) {
        removed++;
      } else {
        seen.set(key, entry);
      }
    }

    if (removed > 0) {
      await this.storeEntries(datasetId, [...seen.values()]);
    }

    logger.info({ datasetId, removed, remaining: seen.size }, 'Deduplication complete');
    return removed;
  }

  /** Calculate a quality score for a dataset based on completeness and validity. */
  calculateQualityScore(entries: DatasetEntry[]): number {
    if (!entries.length) return 0;

    let totalScore = 0;
    for (const entry of entries) {
      let fieldScore = 0;
      const fields = Object.keys(entry.data);
      for (const field of fields) {
        const value = entry.data[field];
        if (value !== null && value !== undefined && value !== '') {
          fieldScore++;
        }
      }
      totalScore += fields.length > 0 ? fieldScore / fields.length : 0;
    }

    const baseScore = totalScore / entries.length;

    // Penalize validation errors
    const errorCount = entries.filter(e => e.validation_errors.length > 0).length;
    const errorPenalty = (errorCount / entries.length) * 0.3;

    return Math.round((baseScore - errorPenalty) * 100) / 100;
  }

  // ---------- Internal helpers ------------------------------------------------

  private enrichEntries(entries: DatasetEntry[]): DatasetEntry[] {
    return entries.map(entry => ({
      ...entry,
      id: entry.id || uuid(),
      hash_sha256: entry.hash_sha256 || this.computeEntryHash(entry.data),
      scraped_at: entry.scraped_at || Date.now(),
      validated: entry.validated ?? false,
      validation_errors: entry.validation_errors ?? [],
    }));
  }

  private computeEntryHash(data: Record<string, unknown>): string {
    return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }

  private computeKeyHash(data: Record<string, unknown>, keyFields: string[]): string {
    const keyData = keyFields.map(f => JSON.stringify(data[f])).join('|');
    return crypto.createHash('sha256').update(keyData).digest('hex');
  }

  private deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const result = { ...target };
    for (const [key, value] of Object.entries(source)) {
      if (value === null || value === undefined) continue;
      if (
        typeof value === 'object' && value !== null && !Array.isArray(value) &&
        typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])
      ) {
        result[key] = this.deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private async getEntries(datasetId: string): Promise<DatasetEntry[]> {
    return await cacheGet<DatasetEntry[]>(ENTRIES_PREFIX + datasetId) ?? [];
  }

  private async storeEntries(datasetId: string, entries: DatasetEntry[]): Promise<void> {
    await cacheSet(ENTRIES_PREFIX + datasetId, entries, 86400 * 7);
  }
}
