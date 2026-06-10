/**
 * Collector / Dataset System -- Recurring structured data collection jobs.
 *
 * Inspired by Bright Data's Collector feature: users define recurring data
 * collection tasks that automatically scrape, parse, and store structured
 * data from one or more URLs using pre-built templates.
 *
 * Key features
 * ------------
 *  • Collector CRUD -- define, update, delete, list collection tasks
 *  • Pagination support -- URL-param, offset, and next-link based pagination
 *  • Synchronous pipeline -- runs a collector end-to-end via the orchestrator
 *  • Template-driven extraction -- applies registered templates to scraped HTML
 *  • Dataset management -- each run produces a dataset stored in Redis
 *  • Delta detection -- compares consecutive datasets for new/changed/removed
 *  • Dataset querying -- get by ID, get latest, list, export as JSON or CSV
 *  • Webhook notifications -- fires webhooks on collector run completion
 *  • Full JSDoc on all public methods and interfaces
 *
 * Usage
 * -----
 *   import { collectorManager } from './collector';
 *
 *   // Create a collector
 *   const collector = await collectorManager.createCollector({
 *     userId: 'user-123',
 *     name: 'Amazon Products Daily',
 *     templateId: 'amazon_product',
 *     urls: ['https://www.amazon.com/dp/B0BSHF7WHW'],
 *     schedule: '0 8 * * *',
 *     active: true,
 *   });
 *
 *   // Run it
 *   const result = await collectorManager.runCollector(collector.id!);
 *
 *   // Get the delta vs the previous run
 *   const delta = await collectorManager.getDelta(collector.id!);
 */

import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';
import { templateRegistry } from '../templates';
import { randomUUID } from 'crypto';

const logger = createChildLogger('collector');

// --- Public Types --------------------------------------------------------------

/**
 * Definition of a structured data collection task.
 *
 * A collector specifies what to scrape (URLs + template), how often
 * (schedule), and where to send results (webhook).  Each execution
 * produces a {@link Dataset}.
 */
export interface CollectorDefinition {
  id?: string;
  userId: string;
  name: string;
  description?: string;
  templateId: string;
  urls: string[];
  pagination?: {
    type: 'url_param' | 'offset' | 'next_link';
    param: string;
    startValue: number;
    maxValue: number;
    step?: number;
  };
  schedule?: string;
  outputFormat?: 'json' | 'csv';
  webhookUrl?: string;
  maxConcurrency?: number;
  proxyTier?: 'residential' | 'mobile' | 'datacenter' | 'isp';
  proxyCountry?: string;
  active: boolean;
}

/**
 * A single record within a dataset, representing one URL's extraction result.
 */
export interface DatasetRecord {
  url: string;
  data: Record<string, any>;
  success: boolean;
  error?: string;
  scrapedAt: string;
}

/**
 * The result of a single collector run -- an array of records plus stats.
 */
export interface Dataset {
  id: string;
  collectorId: string;
  userId: string;
  records: DatasetRecord[];
  totalRecords: number;
  successCount: number;
  failureCount: number;
  runAt: string;
  completedAt: string;
  durationMs: number;
}

/**
 * Delta between two consecutive datasets for the same collector.
 */
export interface DatasetDelta {
  collectorId: string;
  previousRunAt: string;
  currentRunAt: string;
  newRecords: DatasetRecord[];
  changedRecords: Array<{ previous: DatasetRecord; current: DatasetRecord }>;
  removedRecords: DatasetRecord[];
  unchangedCount: number;
}

/**
 * Summary result returned after a collector run completes.
 */
export interface CollectorRunResult {
  collectorId: string;
  datasetId: string;
  totalUrls: number;
  successful: number;
  failed: number;
  durationMs: number;
}

// --- Redis Key Helpers ---------------------------------------------------------

const COLLECTOR_KEY = (id: string) => `collector:${id}`;
const COLLECTOR_USER_SET_KEY = (userId: string) => `collector:user:${userId}`;
const DATASET_KEY = (id: string) => `dataset:${id}`;
const COLLECTOR_DATASETS_KEY = (collectorId: string) => `collector:${collectorId}:datasets`;

/** TTL for collector definitions -- 30 days */
const COLLECTOR_TTL = 30 * 24 * 3600;
/** TTL for datasets -- 90 days */
const DATASET_TTL = 90 * 24 * 3600;
/** Default max concurrency for a collector run */
const DEFAULT_MAX_CONCURRENCY = 3;
/** Max records per dataset to prevent memory issues */
const MAX_DATASET_RECORDS = 10_000;

// --- CollectorManager ----------------------------------------------------------

/**
 * Manages the lifecycle of collectors and their datasets.
 *
 * Collectors are stored in Redis (keyed by ID) with a per-user set for
 * fast listing.  Datasets are stored separately in Redis and referenced
 * by an ordered list per collector.
 */
export class CollectorManager {
  // --- Collector CRUD ------------------------------------------------------

  /**
   * Create a new collector definition.
   *
   * Validates that the referenced template exists, assigns a UUID,
   * persists to Redis, and adds the ID to the user's collector set.
   *
   * @param definition - The collector definition (without `id`).
   * @returns The created collector with `id` populated.
   * @throws Error if the template does not exist.
   */
  async createCollector(definition: CollectorDefinition): Promise<CollectorDefinition> {
    // Validate template exists
    const template = templateRegistry.getTemplate(definition.templateId);
    if (!template) {
      throw new Error(`Template not found: ${definition.templateId}`);
    }

    const id = randomUUID();
    const collector: CollectorDefinition = {
      ...definition,
      id,
      maxConcurrency: definition.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      outputFormat: definition.outputFormat ?? 'json',
      active: definition.active ?? true,
    };

    try {
      await cacheSet(COLLECTOR_KEY(id), collector, COLLECTOR_TTL);
      await redis.sadd(COLLECTOR_USER_SET_KEY(collector.userId), id);

      logger.info(
        { collectorId: id, userId: collector.userId, name: collector.name, templateId: collector.templateId },
        'Collector created',
      );

      return collector;
    } catch (err) {
      logger.error({ err: (err as Error).message, collectorId: id }, 'Failed to create collector');
      throw err;
    }
  }

  /**
   * Retrieve a collector definition by ID.
   *
   * @param collectorId - The collector UUID.
   * @returns The collector definition, or `null` if not found.
   */
  async getCollector(collectorId: string): Promise<CollectorDefinition | null> {
    try {
      const collector = await cacheGet<CollectorDefinition>(COLLECTOR_KEY(collectorId));
      return collector;
    } catch (err) {
      logger.error({ err: (err as Error).message, collectorId }, 'Failed to get collector');
      return null;
    }
  }

  /**
   * List all collectors belonging to a user.
   *
   * Reads the user's collector set from Redis, then fetches each
   * definition.  Skips entries that have expired or been deleted.
   *
   * @param userId - The user UUID.
   * @returns Array of collector definitions (may be empty).
   */
  async listCollectors(userId: string): Promise<CollectorDefinition[]> {
    try {
      const ids = await redis.smembers(COLLECTOR_USER_SET_KEY(userId));
      if (!ids || ids.length === 0) return [];

      const collectors: CollectorDefinition[] = [];
      const expiredIds: string[] = [];

      for (const id of ids) {
        const collector = await cacheGet<CollectorDefinition>(COLLECTOR_KEY(id));
        if (collector) {
          collectors.push(collector);
        } else {
          expiredIds.push(id);
        }
      }

      // Clean up expired IDs from the user set
      if (expiredIds.length > 0) {
        await redis.srem(COLLECTOR_USER_SET_KEY(userId), ...expiredIds);
        logger.debug({ userId, removedCount: expiredIds.length }, 'Cleaned expired collector IDs from user set');
      }

      return collectors;
    } catch (err) {
      logger.error({ err: (err as Error).message, userId }, 'Failed to list collectors');
      return [];
    }
  }

  /**
   * Update a collector definition with partial changes.
   *
   * If `templateId` is being changed, validates the new template exists.
   * Merges the updates into the existing definition and persists.
   *
   * @param collectorId - The collector UUID.
   * @param updates - Partial fields to update.
   * @returns The updated collector definition.
   * @throws Error if the collector does not exist or the template is invalid.
   */
  async updateCollector(collectorId: string, updates: Partial<CollectorDefinition>): Promise<CollectorDefinition> {
    const existing = await this.getCollector(collectorId);
    if (!existing) {
      throw new Error(`Collector not found: ${collectorId}`);
    }

    // Validate new template if being changed
    if (updates.templateId && updates.templateId !== existing.templateId) {
      const template = templateRegistry.getTemplate(updates.templateId);
      if (!template) {
        throw new Error(`Template not found: ${updates.templateId}`);
      }
    }

    const updated: CollectorDefinition = {
      ...existing,
      ...updates,
      id: collectorId, // Ensure ID is never overwritten
    };

    await cacheSet(COLLECTOR_KEY(collectorId), updated, COLLECTOR_TTL);

    logger.info(
      { collectorId, updatedFields: Object.keys(updates) },
      'Collector updated',
    );

    return updated;
  }

  /**
   * Delete a collector and all associated dataset references.
   *
   * Removes the collector definition from Redis, removes it from the
   * user's collector set, and deletes the dataset reference list.
   * Individual datasets are NOT deleted (they may still be queried by ID).
   *
   * @param collectorId - The collector UUID.
   */
  async deleteCollector(collectorId: string): Promise<void> {
    const collector = await this.getCollector(collectorId);

    try {
      await redis.del(`cache:${COLLECTOR_KEY(collectorId)}`);

      if (collector) {
        await redis.srem(COLLECTOR_USER_SET_KEY(collector.userId), collectorId);
      }

      // Delete the dataset reference list (not the datasets themselves)
      await redis.del(`cache:${COLLECTOR_DATASETS_KEY(collectorId)}`);

      logger.info({ collectorId }, 'Collector deleted');
    } catch (err) {
      logger.error({ err: (err as Error).message, collectorId }, 'Failed to delete collector');
      throw err;
    }
  }

  // --- Collector Execution -------------------------------------------------

  /**
   * Execute a collector run synchronously.
   *
   * Pipeline:
   *  1. Resolve all URLs (including pagination)
   *  2. For each URL, use the orchestrator to scrape
   *  3. Apply the template to extract structured data
   *  4. Collect all results into a dataset
   *  5. Store the dataset in Redis
   *  6. Fire a webhook notification if configured
   *
   * @param collectorId - The collector UUID.
   * @returns Summary of the run result.
   * @throws Error if the collector does not exist.
   */
  async runCollector(collectorId: string): Promise<CollectorRunResult> {
    const startTime = Date.now();

    const collector = await this.getCollector(collectorId);
    if (!collector) {
      throw new Error(`Collector not found: ${collectorId}`);
    }

    logger.info(
      { collectorId, name: collector.name, templateId: collector.templateId },
      'Starting collector run',
    );

    // 1. Resolve all URLs (including pagination)
    const urls = await this.resolveUrls(collector);
    logger.info({ collectorId, totalUrls: urls.length }, 'URLs resolved');

    // 2-3. Scrape each URL and apply template
    const records: DatasetRecord[] = [];
    const maxConcurrency = collector.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    let successful = 0;
    let failed = 0;

    // Process URLs in batches respecting maxConcurrency
    for (let i = 0; i < urls.length; i += maxConcurrency) {
      const batch = urls.slice(i, i + maxConcurrency);
      const results = await Promise.allSettled(
        batch.map((url) => this.scrapeAndExtract(url, collector)),
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          records.push(result.value);
          if (result.value.success) {
            successful++;
          } else {
            failed++;
          }
        } else {
          // Promise rejected or returned null -- create a failed record
          const failedUrl = batch[results.indexOf(result)];
          records.push({
            url: failedUrl || 'unknown',
            data: {},
            success: false,
            error: result.status === 'rejected' ? result.reason?.message || 'Unknown error' : 'Scrape failed',
            scrapedAt: new Date().toISOString(),
          });
          failed++;
        }
      }

      // Enforce max dataset size
      if (records.length >= MAX_DATASET_RECORDS) {
        logger.warn(
          { collectorId, recordsCount: records.length, max: MAX_DATASET_RECORDS },
          'Dataset record limit reached, truncating',
        );
        break;
      }
    }

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startTime;

    // 4. Build the dataset
    const datasetId = randomUUID();
    const dataset: Dataset = {
      id: datasetId,
      collectorId,
      userId: collector.userId,
      records,
      totalRecords: records.length,
      successCount: successful,
      failureCount: failed,
      runAt: new Date(startTime).toISOString(),
      completedAt,
      durationMs,
    };

    // 5. Store the dataset in Redis
    await this.storeDataset(dataset);

    // 6. Fire webhook if configured
    if (collector.webhookUrl) {
      this.fireWebhook(collector.webhookUrl, dataset).catch(() => {
        // Webhook failures are non-blocking -- logged internally
      });
    }

    logger.info(
      {
        collectorId,
        datasetId,
        totalUrls: urls.length,
        successful,
        failed,
        durationMs,
      },
      'Collector run completed',
    );

    return {
      collectorId,
      datasetId,
      totalUrls: urls.length,
      successful,
      failed,
      durationMs,
    };
  }

  // --- Dataset Querying ----------------------------------------------------

  /**
   * Retrieve a specific dataset by its ID.
   *
   * @param datasetId - The dataset UUID.
   * @returns The dataset, or `null` if not found.
   */
  async getDataset(datasetId: string): Promise<Dataset | null> {
    try {
      const dataset = await cacheGet<Dataset>(DATASET_KEY(datasetId));
      return dataset;
    } catch (err) {
      logger.error({ err: (err as Error).message, datasetId }, 'Failed to get dataset');
      return null;
    }
  }

  /**
   * Get the most recent dataset for a collector.
   *
   * Reads the collector's dataset reference list (stored as a Redis list
   * with newest entries at the head) and returns the first entry.
   *
   * @param collectorId - The collector UUID.
   * @returns The latest dataset, or `null` if no datasets exist.
   */
  async getLatestDataset(collectorId: string): Promise<Dataset | null> {
    try {
      const datasetIds = await redis.lrange(`cache:${COLLECTOR_DATASETS_KEY(collectorId)}`, 0, 0);
      if (!datasetIds || datasetIds.length === 0) return null;

      const dataset = await cacheGet<Dataset>(DATASET_KEY(datasetIds[0]));
      return dataset;
    } catch (err) {
      logger.error({ err: (err as Error).message, collectorId }, 'Failed to get latest dataset');
      return null;
    }
  }

  /**
   * Compare the two most recent datasets for a collector and compute the delta.
   *
   * Delta detection matches records by URL and compares their extracted data.
   * Three categories of change are identified:
   *  - **New records**: URLs present in the current dataset but not the previous.
   *  - **Changed records**: Same URL but different extracted data.
   *  - **Removed records**: URLs present in the previous dataset but not the current.
   *
   * @param collectorId - The collector UUID.
   * @returns The delta, or `null` if fewer than two datasets exist.
   */
  async getDelta(collectorId: string): Promise<DatasetDelta | null> {
    try {
      const datasetIds = await redis.lrange(`cache:${COLLECTOR_DATASETS_KEY(collectorId)}`, 0, 1);
      if (!datasetIds || datasetIds.length < 2) {
        logger.debug({ collectorId }, 'Not enough datasets to compute delta');
        return null;
      }

      const [currentDataset, previousDataset] = await Promise.all([
        cacheGet<Dataset>(DATASET_KEY(datasetIds[0])),
        cacheGet<Dataset>(DATASET_KEY(datasetIds[1])),
      ]);

      if (!currentDataset || !previousDataset) {
        logger.warn({ collectorId }, 'One or both datasets missing for delta computation');
        return null;
      }

      return this.computeDelta(collectorId, previousDataset, currentDataset);
    } catch (err) {
      logger.error({ err: (err as Error).message, collectorId }, 'Failed to compute delta');
      return null;
    }
  }

  /**
   * List datasets for a collector, ordered from most recent to oldest.
   *
   * @param collectorId - The collector UUID.
   * @param limit - Maximum number of datasets to return (default 20).
   * @returns Array of datasets.
   */
  async listDatasets(collectorId: string, limit: number = 20): Promise<Dataset[]> {
    try {
      const datasetIds = await redis.lrange(`cache:${COLLECTOR_DATASETS_KEY(collectorId)}`, 0, limit - 1);
      if (!datasetIds || datasetIds.length === 0) return [];

      const datasets: Dataset[] = [];
      for (const id of datasetIds) {
        const dataset = await cacheGet<Dataset>(DATASET_KEY(id));
        if (dataset) datasets.push(dataset);
      }

      return datasets;
    } catch (err) {
      logger.error({ err: (err as Error).message, collectorId }, 'Failed to list datasets');
      return [];
    }
  }

  /**
   * Export a dataset as a formatted string in the specified format.
   *
   * Supports JSON (pretty-printed) and CSV (with headers derived from
   * the first successful record's data keys).  Nested objects are
   * serialised as JSON strings within CSV cells.
   *
   * @param datasetId - The dataset UUID.
   * @param format - Export format: `'json'` or `'csv'`.
   * @returns The exported string, or an error message if the dataset is not found.
   */
  async exportDataset(datasetId: string, format: 'json' | 'csv'): Promise<string> {
    const dataset = await this.getDataset(datasetId);
    if (!dataset) {
      return JSON.stringify({ error: 'Dataset not found' });
    }

    if (format === 'csv') {
      return this.datasetToCsv(dataset);
    }

    // Default: JSON
    return JSON.stringify(dataset, null, 2);
  }

  // --- Private Helpers -----------------------------------------------------

  /**
   * Resolve all URLs for a collector, expanding pagination if configured.
   *
   * Three pagination strategies are supported:
   *  - **url_param**: Appends `?{param}={value}` (or `&{param}={value}`)
   *    to each base URL, iterating from `startValue` to `maxValue` by `step`.
   *  - **offset**: Similar to url_param but the parameter represents an
   *    offset (e.g., `offset=0`, `offset=20`, `offset=40`).
   *  - **next_link**: Not expanded upfront -- the orchestrator will follow
   *    "next page" links during scraping.  Only the base URLs are returned
   *    and the `maxValue` is used as the maximum number of pages to follow.
   *
   * @param collector - The collector definition.
   * @returns Array of fully resolved URLs.
   */
  private async resolveUrls(collector: CollectorDefinition): Promise<string[]> {
    const baseUrls = collector.urls;
    const pagination = collector.pagination;

    if (!pagination) {
      return [...baseUrls];
    }

    const step = pagination.step ?? 1;
    const maxPages = pagination.maxValue;
    const resolved: string[] = [];

    switch (pagination.type) {
      case 'url_param': {
        for (const baseUrl of baseUrls) {
          for (let value = pagination.startValue; value <= maxPages; value += step) {
            const url = this.appendQueryParam(baseUrl, pagination.param, String(value));
            resolved.push(url);
          }
        }
        break;
      }

      case 'offset': {
        for (const baseUrl of baseUrls) {
          for (let offset = pagination.startValue; offset < maxPages * (step || 1); offset += (step || 1)) {
            const url = this.appendQueryParam(baseUrl, pagination.param, String(offset));
            resolved.push(url);
            // Safety: limit total resolved URLs
            if (resolved.length >= MAX_DATASET_RECORDS) break;
          }
          if (resolved.length >= MAX_DATASET_RECORDS) break;
        }
        break;
      }

      case 'next_link': {
        // For next_link pagination, we return the base URLs and let the
        // scraping pipeline handle link-following.  The maxValue is stored
        // as metadata so the scraper can limit page-following depth.
        // We attach it as a special query param for tracking purposes.
        for (const baseUrl of baseUrls) {
          const url = this.appendQueryParam(baseUrl, '_maxPages', String(maxPages));
          resolved.push(url);
        }
        break;
      }

      default: {
        logger.warn(
          { type: (pagination as any).type },
          'Unknown pagination type, using base URLs only',
        );
        resolved.push(...baseUrls);
      }
    }

    // Enforce global limit
    if (resolved.length > MAX_DATASET_RECORDS) {
      logger.warn(
        { total: resolved.length, limit: MAX_DATASET_RECORDS },
        'Resolved URL count exceeds limit, truncating',
      );
      resolved.length = MAX_DATASET_RECORDS;
    }

    return resolved;
  }

  /**
   * Append a query parameter to a URL, handling existing query strings.
   */
  private appendQueryParam(baseUrl: string, param: string, value: string): string {
    try {
      const url = new URL(baseUrl);
      url.searchParams.set(param, value);
      return url.toString();
    } catch {
      // If URL parsing fails, append naively
      const separator = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${separator}${param}=${encodeURIComponent(value)}`;
    }
  }

  /**
   * Scrape a single URL and apply the collector's template to extract data.
   *
   * Uses the orchestrator directly (synchronous pipeline) to fetch the page,
   * then applies the template's `extract()` function to the returned HTML.
   *
   * @param url - The URL to scrape.
   * @param collector - The collector definition (for template and proxy config).
   * @returns A dataset record, or `null` if scraping fails entirely.
   */
  private async scrapeAndExtract(
    url: string,
    collector: CollectorDefinition,
  ): Promise<DatasetRecord | null> {
    const scrapeStart = Date.now();

    try {
      // Import orchestrator lazily to avoid circular dependency at module load
      const { orchestrator } = await import('../orchestrator');

      // Build job data for the orchestrator
      let domain = '';
      try {
        domain = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        domain = 'unknown';
      }

      const jobData = {
        jobId: `collector-${collector.id}-${randomUUID()}`,
        url,
        domain,
        userId: collector.userId,
        apiKeyId: 'collector-system', // System-level API key for collector runs
        strategy: 'auto' as const,
        proxyTier: collector.proxyTier,
        proxyCountry: collector.proxyCountry,
        structured: false,
        renderJs: true,
        solveCaptcha: true,
        respectRobotsTxt: true,
        priority: 5,
      };

      const result = await orchestrator.processJob(jobData);

      // Extract HTML from result
      const html = result.html || (result as any).result?.html || '';

      if (!html) {
        return {
          url,
          data: {},
          success: false,
          error: result.error || `HTTP ${result.statusCode}: Empty response`,
          scrapedAt: new Date(scrapeStart).toISOString(),
        };
      }

      // Apply the template to extract structured data
      let extractedData: Record<string, any>;
      try {
        const templateResult = templateRegistry.extractWithTemplate(collector.templateId, html, url);
        extractedData = templateResult ?? {};
      } catch (templateErr) {
        logger.warn(
          { err: (templateErr as Error).message, url, templateId: collector.templateId },
          'Template extraction failed',
        );
        extractedData = {};
      }

      const success = result.status === 'done' && result.statusCode !== undefined &&
        result.statusCode >= 200 && result.statusCode < 400;

      return {
        url,
        data: extractedData,
        success,
        error: success ? undefined : result.error || `HTTP ${result.statusCode}`,
        scrapedAt: new Date(scrapeStart).toISOString(),
      };
    } catch (err) {
      logger.error(
        { err: (err as Error).message, url, collectorId: collector.id },
        'Scrape and extract failed',
      );

      return {
        url,
        data: {},
        success: false,
        error: (err as Error).message || 'Unknown error',
        scrapedAt: new Date(scrapeStart).toISOString(),
      };
    }
  }

  /**
   * Store a dataset in Redis and register it in the collector's dataset list.
   *
   * The dataset list is stored as a Redis list with the newest dataset ID
   * pushed to the left (LPUSH), so index 0 is always the latest.
   */
  private async storeDataset(dataset: Dataset): Promise<void> {
    try {
      // Store the dataset itself
      await cacheSet(DATASET_KEY(dataset.id), dataset, DATASET_TTL);

      // Add to the collector's dataset list (newest first)
      await redis.lpush(`cache:${COLLECTOR_DATASETS_KEY(dataset.collectorId)}`, dataset.id);

      // Trim the list to keep at most 100 dataset references per collector
      await redis.ltrim(`cache:${COLLECTOR_DATASETS_KEY(dataset.collectorId)}`, 0, 99);

      logger.debug(
        { datasetId: dataset.id, collectorId: dataset.collectorId, records: dataset.totalRecords },
        'Dataset stored',
      );
    } catch (err) {
      logger.error({ err: (err as Error).message, datasetId: dataset.id }, 'Failed to store dataset');
      throw err;
    }
  }

  /**
   * Compute the delta between two datasets for the same collector.
   *
   * Records are matched by URL.  Two records are considered "changed" if
   * they share the same URL but their `data` objects differ (compared via
   * JSON serialisation).
   */
  private computeDelta(
    collectorId: string,
    previousDataset: Dataset,
    currentDataset: Dataset,
  ): DatasetDelta {
    const previousByUrls = new Map<string, DatasetRecord>();
    for (const record of previousDataset.records) {
      previousByUrls.set(record.url, record);
    }

    const currentByUrls = new Map<string, DatasetRecord>();
    for (const record of currentDataset.records) {
      currentByUrls.set(record.url, record);
    }

    const newRecords: DatasetRecord[] = [];
    const changedRecords: Array<{ previous: DatasetRecord; current: DatasetRecord }> = [];
    let unchangedCount = 0;

    // Walk current dataset -- find new and changed records
    for (const [url, current] of currentByUrls) {
      const previous = previousByUrls.get(url);
      if (!previous) {
        newRecords.push(current);
      } else {
        // Compare data objects via JSON serialisation
        const previousDataJson = JSON.stringify(current.data);
        const currentDataJson = JSON.stringify(previous.data);

        if (previousDataJson !== currentDataJson) {
          // Deep comparison failed -- check more carefully
          // Re-serialise both with sorted keys for deterministic comparison
          const prevNormalised = this.normaliseForComparison(previous.data);
          const currNormalised = this.normaliseForComparison(current.data);

          if (prevNormalised !== currNormalised) {
            changedRecords.push({ previous, current });
          } else {
            unchangedCount++;
          }
        } else {
          unchangedCount++;
        }
      }
    }

    // Find removed records -- present in previous but not in current
    const removedRecords: DatasetRecord[] = [];
    for (const [url, previous] of previousByUrls) {
      if (!currentByUrls.has(url)) {
        removedRecords.push(previous);
      }
    }

    return {
      collectorId,
      previousRunAt: previousDataset.runAt,
      currentRunAt: currentDataset.runAt,
      newRecords,
      changedRecords,
      removedRecords,
      unchangedCount,
    };
  }

  /**
   * Normalise a data object for deterministic comparison.
   *
   * Recursively sorts object keys and serialises to JSON.
   * Handles null, undefined, and primitive values.
   */
  private normaliseForComparison(data: Record<string, any>): string {
    const sortKeys = (obj: any): any => {
      if (obj === null || obj === undefined) return obj;
      if (typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(sortKeys);
      const sorted: Record<string, any> = {};
      for (const key of Object.keys(obj).sort()) {
        sorted[key] = sortKeys(obj[key]);
      }
      return sorted;
    };

    return JSON.stringify(sortKeys(data));
  }

  /**
   * Convert a dataset to a CSV string.
   *
   * Headers are derived from the keys of the first successful record's
   * data object.  Nested objects and arrays are serialised as JSON strings.
   * A `url` and `success` column are always prepended.
   */
  private datasetToCsv(dataset: Dataset): string {
    if (dataset.records.length === 0) {
      return 'url,success\n';
    }

    // Collect all unique data keys across all successful records for comprehensive headers
    const dataKeySet = new Set<string>();
    for (const record of dataset.records) {
      if (record.success) {
        for (const key of Object.keys(record.data)) {
          dataKeySet.add(key);
        }
      }
    }
    const dataKeys = Array.from(dataKeySet).sort();

    // Build header row
    const headers = ['url', 'success', ...dataKeys];
    const rows: string[] = [headers.map(this.csvEscape).join(',')];

    // Build data rows
    for (const record of dataset.records) {
      const row = [
        this.csvEscape(record.url),
        this.csvEscape(String(record.success)),
        ...dataKeys.map((key) => {
          const value = record.data[key];
          if (value === undefined || value === null) return '';
          if (typeof value === 'object') return this.csvEscape(JSON.stringify(value));
          return this.csvEscape(String(value));
        }),
      ];
      rows.push(row.join(','));
    }

    return rows.join('\n');
  }

  /**
   * Escape a value for safe inclusion in a CSV cell.
   *
   * Wraps the value in double quotes if it contains a comma, newline,
   * or double quote.  Internal double quotes are escaped by doubling.
   */
  private csvEscape(value: string): string {
    if (!value) return '""';
    if (value.includes(',') || value.includes('\n') || value.includes('"')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  /**
   * Fire a webhook notification for a completed collector run.
   *
   * Sends a POST request with a JSON payload summarising the dataset.
   * Includes an HMAC-SHA256 signature header for verification.
   * Failures are logged but do not block the collector run.
   */
  private async fireWebhook(webhookUrl: string, dataset: Dataset): Promise<void> {
    try {
      const payload = {
        event: 'collector_run_completed',
        datasetId: dataset.id,
        collectorId: dataset.collectorId,
        userId: dataset.userId,
        totalRecords: dataset.totalRecords,
        successCount: dataset.successCount,
        failureCount: dataset.failureCount,
        durationMs: dataset.durationMs,
        runAt: dataset.runAt,
        completedAt: dataset.completedAt,
      };

      const body = JSON.stringify(payload);
      const timestamp = Date.now().toString();

      // Compute HMAC-SHA256 signature
      const crypto = await import('crypto');
      const secret = process.env.WEBHOOK_SECRET || 'scrapesuite-webhook-secret';
      const signature = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.${body}`)
        .digest('hex');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-ScrapeSuite-Signature': `t=${timestamp},v1=${signature}`,
            'X-ScrapeSuite-Timestamp': timestamp,
            'User-Agent': 'ScrapeSuite-Collector/1.0',
          },
          body,
          signal: controller.signal,
        });

        if (response.ok) {
          logger.info(
            { webhookUrl, datasetId: dataset.id, statusCode: response.status },
            'Collector webhook delivered',
          );
        } else {
          logger.warn(
            { webhookUrl, datasetId: dataset.id, statusCode: response.status },
            'Collector webhook returned non-OK status',
          );
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, webhookUrl, datasetId: dataset.id },
        'Collector webhook delivery failed',
      );
    }
  }
}

// --- Singleton Export ----------------------------------------------------------

export const collectorManager = new CollectorManager();
