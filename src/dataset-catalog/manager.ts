/**
 * Dataset Catalog Manager -- ScrapeSuite Engine
 *
 * Main orchestrator for the dataset catalog. Wires together
 * schema management, versioning, querying, and updating.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { v4 as uuid } from 'uuid';
import { SchemaManager } from './schema-manager';
import { VersionManager } from './versioning';
import { QueryEngine } from './query-engine';
import { DatasetUpdater } from './updater';
import {
  Dataset,
  DatasetEntry,
  DatasetExportFormat,
  DatasetQuery,
  DatasetSchema,
  DatasetStats,
  DatasetUpdateConfig,
  DatasetVersion,
  DatasetVisibility,
  QueryResult,
  UpdateResult,
} from './types';

const logger = createChildLogger('dataset-catalog:manager');

const DATASET_PREFIX = 'dataset:meta:';
const DATASET_LIST_KEY = 'dataset:list';

// ---------- Catalog Manager class ---------------------------------------------

export class DatasetCatalogManager {
  private schemaManager: SchemaManager;
  private versionManager: VersionManager;
  private queryEngine: QueryEngine;
  private updater: DatasetUpdater;

  constructor() {
    this.schemaManager = new SchemaManager();
    this.versionManager = new VersionManager();
    this.queryEngine = new QueryEngine();
    this.updater = new DatasetUpdater();
  }

  /** Create a new dataset. */
  async createDataset(
    name: string,
    description: string,
    schema: DatasetSchema,
    opts?: { category?: string; tags?: string[]; visibility?: DatasetVisibility; owner_id?: string },
  ): Promise<Dataset> {
    const validation = this.schemaManager.validateSchema(schema);
    if (!validation.valid) {
      throw new Error(`Invalid schema: ${validation.errors.join(', ')}`);
    }

    const dataset: Dataset = {
      id: uuid(),
      name,
      description,
      schema,
      category: opts?.category ?? 'general',
      tags: opts?.tags ?? [],
      visibility: opts?.visibility ?? 'private',
      owner_id: opts?.owner_id ?? 'system',
      created_at: Date.now(),
      updated_at: Date.now(),
      row_count: 0,
      size_bytes: 0,
      quality_score: 1.0,
      latest_version: 0,
    };

    // Store metadata
    await cacheSet(DATASET_PREFIX + dataset.id, dataset, 86400 * 30);

    // Add to list
    const list = await cacheGet<string[]>(DATASET_LIST_KEY) ?? [];
    list.push(dataset.id);
    await cacheSet(DATASET_LIST_KEY, list, 86400 * 30);

    logger.info({ id: dataset.id, name }, 'Dataset created');
    return dataset;
  }

  /** Get a dataset by ID. */
  async getDataset(id: string): Promise<Dataset | null> {
    return await cacheGet<Dataset>(DATASET_PREFIX + id);
  }

  /** List datasets with optional filters. */
  async listDatasets(filter?: { category?: string; visibility?: DatasetVisibility; owner_id?: string }): Promise<Dataset[]> {
    const list = await cacheGet<string[]>(DATASET_LIST_KEY) ?? [];
    const datasets: Dataset[] = [];

    for (const id of list) {
      const ds = await cacheGet<Dataset>(DATASET_PREFIX + id);
      if (ds) {
        if (filter?.category && ds.category !== filter.category) continue;
        if (filter?.visibility && ds.visibility !== filter.visibility) continue;
        if (filter?.owner_id && ds.owner_id !== filter.owner_id) continue;
        datasets.push(ds);
      }
    }

    return datasets;
  }

  /** Delete a dataset and all its data. */
  async deleteDataset(id: string): Promise<void> {
    // Remove from list
    const list = await cacheGet<string[]>(DATASET_LIST_KEY) ?? [];
    await cacheSet(DATASET_LIST_KEY, list.filter(i => i !== id), 86400 * 30);

    // Remove metadata (entries and versions will expire via TTL)
    logger.info({ id }, 'Dataset deleted');
  }

  /** Add entries to a dataset — validates, stores, and creates a version. */
  async addEntries(datasetId: string, entries: Omit<DatasetEntry, 'id' | 'hash_sha256' | 'validated' | 'validation_errors'>[]): Promise<{
    result: UpdateResult;
    version: DatasetVersion;
  }> {
    const dataset = await this.getDataset(datasetId);
    if (!dataset) throw new Error(`Dataset not found: ${datasetId}`);

    // Validate entries against schema
    const fullEntries: DatasetEntry[] = entries.map(e => {
      const validation = this.schemaManager.validateEntry(e.data, dataset.schema);
      return {
        ...e,
        id: uuid(),
        hash_sha256: '',
        validated: validation.valid,
        validation_errors: validation.errors,
      } as DatasetEntry;
    });

    // Store entries
    await this.updater.appendData(datasetId, fullEntries);

    // Create version
    const storedEntries = await this.queryEngine.getEntries(datasetId);
    const version = await this.versionManager.createVersion(
      datasetId,
      storedEntries,
      dataset.schema,
      `Added ${entries.length} entries`,
    );

    // Update dataset metadata
    const qualityScore = this.updater.calculateQualityScore(storedEntries);
    dataset.row_count = storedEntries.length;
    dataset.size_bytes = JSON.stringify(storedEntries).length;
    dataset.quality_score = qualityScore;
    dataset.updated_at = Date.now();
    dataset.latest_version = version.version_number;
    await cacheSet(DATASET_PREFIX + datasetId, dataset, 86400 * 30);

    return {
      result: {
        inserted: entries.length,
        updated: 0,
        duplicates_removed: 0,
        validation_errors: fullEntries.filter(e => e.validation_errors.length > 0).length,
        new_version: version.version_number,
      },
      version,
    };
  }

  /** Query a dataset. */
  async queryDataset(query: DatasetQuery): Promise<QueryResult> {
    return this.queryEngine.executeQuery(query);
  }

  /** Export a dataset. */
  async exportDataset(datasetId: string, format: DatasetExportFormat, query?: Partial<DatasetQuery>): Promise<Buffer> {
    return this.queryEngine.exportDataset(datasetId, format, query);
  }

  /** Update dataset configuration. */
  async updateDatasetConfig(datasetId: string, config: DatasetUpdateConfig): Promise<void> {
    const dataset = await this.getDataset(datasetId);
    if (!dataset) throw new Error(`Dataset not found: ${datasetId}`);
    // Store update config alongside dataset metadata
    await cacheSet(`dataset:update_config:${datasetId}`, config, 86400 * 30);
    logger.info({ datasetId, strategy: config.update_strategy }, 'Update config saved');
  }

  /** Get catalog-wide statistics. */
  async getStats(): Promise<DatasetStats> {
    const datasets = await this.listDatasets();
    const byCategory: Record<string, number> = {};
    let totalRows = 0;
    let totalSize = 0;
    let qualitySum = 0;

    for (const ds of datasets) {
      byCategory[ds.category] = (byCategory[ds.category] ?? 0) + 1;
      totalRows += ds.row_count;
      totalSize += ds.size_bytes;
      qualitySum += ds.quality_score;
    }

    return {
      total_datasets: datasets.length,
      total_rows: totalRows,
      total_size_bytes: totalSize,
      by_category: byCategory,
      avg_quality_score: datasets.length > 0 ? Math.round((qualitySum / datasets.length) * 100) / 100 : 0,
    };
  }

  /** Get the schema manager for direct access. */
  getSchemaManager(): SchemaManager {
    return this.schemaManager;
  }

  /** Get the version manager for direct access. */
  getVersionManager(): VersionManager {
    return this.versionManager;
  }

  /** Infer a schema from sample data. */
  inferSchema(samples: Record<string, unknown>[], name: string): DatasetSchema {
    return this.schemaManager.inferSchema(samples, name);
  }
}

// ---------- Singleton export --------------------------------------------------

export const datasetCatalogManager = new DatasetCatalogManager();
