/**
 * Query Engine -- ScrapeSuite Engine
 *
 * Queries and filters dataset entries with support for multiple
 * filter operators, sorting, pagination, field projection, and
 * export to JSON, CSV, and NDJSON formats.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import {
  DatasetEntry,
  DatasetQuery,
  DatasetExportFormat,
  QueryFilter,
  QueryResult,
} from './types';

const logger = createChildLogger('dataset-catalog:query-engine');

const ENTRIES_PREFIX = 'dataset:entries:';

// ---------- Query Engine class ------------------------------------------------

export class QueryEngine {

  /** Execute a query against a dataset. */
  async executeQuery(query: DatasetQuery): Promise<QueryResult> {
    const entries = await this.getEntries(query.dataset_id);
    let filtered = this.applyFilters(entries, query.filters);

    // Sort
    if (query.sort) {
      filtered = this.applySort(filtered, query.sort.field, query.sort.direction);
    }

    const total = filtered.length;

    // Paginate
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;
    const paged = filtered.slice(offset, offset + limit);

    // Field projection
    let projected = paged;
    if (query.fields?.length) {
      projected = this.applyProjection(paged, query.fields);
    }

    logger.info({ dataset_id: query.dataset_id, total, page_size: projected.length }, 'Query executed');

    return {
      rows: projected,
      total,
      page: Math.floor(offset / limit) + 1,
      page_size: limit,
    };
  }

  /** Count entries matching filters. */
  async countEntries(datasetId: string, filters?: QueryFilter[]): Promise<number> {
    const entries = await this.getEntries(datasetId);
    if (!filters?.length) return entries.length;
    return this.applyFilters(entries, filters).length;
  }

  /** Export dataset entries in the specified format. */
  async exportDataset(
    datasetId: string,
    format: DatasetExportFormat,
    query?: Partial<DatasetQuery>,
  ): Promise<Buffer> {
    let entries = await this.getEntries(datasetId);

    // Apply query filters if provided
    if (query?.filters?.length) {
      entries = this.applyFilters(entries, query.filters);
    }
    if (query?.sort) {
      entries = this.applySort(entries, query.sort.field, query.sort.direction);
    }
    if (query?.limit) {
      entries = entries.slice(query.offset ?? 0, (query.offset ?? 0) + query.limit);
    }

    switch (format) {
      case 'JSON':
        return Buffer.from(JSON.stringify(entries.map(e => e.data), null, 2));

      case 'CSV':
        return this.toCSV(entries);

      case 'NDJSON':
        return Buffer.from(entries.map(e => JSON.stringify(e.data)).join('\n'));

      case 'SQL':
        return this.toSQL(datasetId, entries);

      case 'PARQUET':
        // Parquet requires external library; return JSON as fallback
        logger.warn('Parquet export not natively supported, falling back to JSON');
        return Buffer.from(JSON.stringify(entries.map(e => e.data), null, 2));

      default:
        return Buffer.from(JSON.stringify(entries.map(e => e.data), null, 2));
    }
  }

  /** Store entries for a dataset (used by updater). */
  async storeEntries(datasetId: string, entries: DatasetEntry[]): Promise<void> {
    await cacheSet(ENTRIES_PREFIX + datasetId, entries, 86400 * 7);
  }

  /** Get all entries for a dataset. */
  async getEntries(datasetId: string): Promise<DatasetEntry[]> {
    return await cacheGet<DatasetEntry[]>(ENTRIES_PREFIX + datasetId) ?? [];
  }

  // ---------- Filter application ----------------------------------------------

  private applyFilters(entries: DatasetEntry[], filters: QueryFilter[]): DatasetEntry[] {
    return entries.filter(entry => {
      return filters.every(filter => this.matchFilter(entry.data, filter));
    });
  }

  private matchFilter(data: Record<string, unknown>, filter: QueryFilter): boolean {
    const value = data[filter.field];
    const filterValue = filter.value;

    switch (filter.operator) {
      case 'eq':
        return value === filterValue;
      case 'ne':
        return value !== filterValue;
      case 'gt':
        return typeof value === 'number' && typeof filterValue === 'number' && value > filterValue;
      case 'lt':
        return typeof value === 'number' && typeof filterValue === 'number' && value < filterValue;
      case 'gte':
        return typeof value === 'number' && typeof filterValue === 'number' && value >= filterValue;
      case 'lte':
        return typeof value === 'number' && typeof filterValue === 'number' && value <= filterValue;
      case 'contains':
        return typeof value === 'string' && typeof filterValue === 'string' && value.includes(filterValue);
      case 'starts_with':
        return typeof value === 'string' && typeof filterValue === 'string' && value.startsWith(filterValue);
      case 'in':
        return Array.isArray(filterValue) && filterValue.includes(value as never);
      default:
        return true;
    }
  }

  // ---------- Sort application ------------------------------------------------

  private applySort(entries: DatasetEntry[], field: string, direction: 'asc' | 'desc'): DatasetEntry[] {
    return [...entries].sort((a, b) => {
      const va = a.data[field];
      const vb = b.data[field];
      if (va === vb) return 0;
      if (va === undefined || va === null) return 1;
      if (vb === undefined || vb === null) return -1;
      const cmp = va < vb ? -1 : 1;
      return direction === 'asc' ? cmp : -cmp;
    });
  }

  // ---------- Field projection ------------------------------------------------

  private applyProjection(entries: DatasetEntry[], fields: string[]): DatasetEntry[] {
    return entries.map(entry => {
      const projectedData: Record<string, unknown> = {};
      for (const field of fields) {
        if (field in entry.data) {
          projectedData[field] = entry.data[field];
        }
      }
      return { ...entry, data: projectedData };
    });
  }

  // ---------- Export helpers --------------------------------------------------

  private toCSV(entries: DatasetEntry[]): Buffer {
    if (!entries.length) return Buffer.from('');
    const headers = Object.keys(entries[0].data);
    const rows = entries.map(e =>
      headers.map(h => {
        const val = e.data[h];
        const str = typeof val === 'object' ? JSON.stringify(val) : String(val ?? '');
        return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
      }).join(','),
    );
    return Buffer.from([headers.join(','), ...rows].join('\n'));
  }

  private toSQL(datasetId: string, entries: DatasetEntry[]): Buffer {
    if (!entries.length) return Buffer.from('-- No data');
    const tableName = `dataset_${datasetId.replace(/-/g, '_')}`;
    const headers = Object.keys(entries[0].data);
    const inserts = entries.map(e => {
      const values = headers.map(h => {
        const val = e.data[h];
        if (val === null || val === undefined) return 'NULL';
        if (typeof val === 'number') return String(val);
        if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
        return `'${String(val).replace(/'/g, "''")}'`;
      });
      return `INSERT INTO ${tableName} (${headers.join(', ')}) VALUES (${values.join(', ')});`;
    });
    return Buffer.from(inserts.join('\n'));
  }
}
