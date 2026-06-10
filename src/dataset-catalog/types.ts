/**
 * Dataset Catalog Builder Types -- ScrapeSuite Engine
 *
 * Type definitions for the dataset catalog that manages structured
 * datasets with versioning, validation, querying, and export.
 */

/** Supported field types in a dataset schema. */
export type DatasetFieldType = 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object' | 'json';

/** A single field definition in a dataset schema. */
export interface DatasetField {
  name: string;
  type: DatasetFieldType;
  description: string;
  required: boolean;
  nullable: boolean;
  default_value?: unknown;
  validation_regex?: string;
}

/** Schema that defines the structure of a dataset. */
export interface DatasetSchema {
  name: string;
  version: number;
  fields: DatasetField[];
}

/** Dataset visibility level. */
export type DatasetVisibility = 'public' | 'private' | 'shared';

/** A structured dataset with metadata. */
export interface Dataset {
  id: string;
  name: string;
  description: string;
  schema: DatasetSchema;
  category: string;
  tags: string[];
  visibility: DatasetVisibility;
  owner_id: string;
  created_at: number;
  updated_at: number;
  row_count: number;
  size_bytes: number;
  quality_score: number;
  latest_version: number;
}

/** A snapshot of a dataset at a point in time. */
export interface DatasetVersion {
  version_number: number;
  schema_snapshot: DatasetSchema;
  row_count: number;
  size_bytes: number;
  checksum_sha256: string;
  created_at: number;
  changelog: string;
  parent_version: number | null;
}

/** A single row/entry in a dataset. */
export interface DatasetEntry {
  id: string;
  dataset_id: string;
  data: Record<string, unknown>;
  hash_sha256: string;
  source_url: string;
  scraped_at: number;
  validated: boolean;
  validation_errors: string[];
}

/** Supported query filter operators. */
export type FilterOperator = 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'starts_with' | 'in';

/** A single filter in a dataset query. */
export interface QueryFilter {
  field: string;
  operator: FilterOperator;
  value: unknown;
}

/** A query against a dataset. */
export interface DatasetQuery {
  dataset_id: string;
  filters: QueryFilter[];
  sort?: { field: string; direction: 'asc' | 'desc' };
  limit: number;
  offset: number;
  fields?: string[];
}

/** Strategy for updating a dataset. */
export type UpdateStrategy = 'append' | 'replace' | 'upsert' | 'merge';

/** Configuration for automated dataset updates. */
export interface DatasetUpdateConfig {
  dataset_id: string;
  update_strategy: UpdateStrategy;
  dedup_key_fields: string[];
  schedule_cron?: string;
  source_urls: string[];
}

/** Supported export formats. */
export type DatasetExportFormat = 'JSON' | 'CSV' | 'NDJSON' | 'PARQUET' | 'SQL';

/** Aggregate statistics about the catalog. */
export interface DatasetStats {
  total_datasets: number;
  total_rows: number;
  total_size_bytes: number;
  by_category: Record<string, number>;
  avg_quality_score: number;
}

/** Result of a dataset query. */
export interface QueryResult {
  rows: DatasetEntry[];
  total: number;
  page: number;
  page_size: number;
}

/** Result of a dataset update operation. */
export interface UpdateResult {
  inserted: number;
  updated: number;
  duplicates_removed: number;
  validation_errors: number;
  new_version: number;
}

/** Diff between two schemas. */
export interface SchemaDiff {
  added_fields: DatasetField[];
  removed_fields: string[];
  modified_fields: { name: string; old: DatasetField; new: DatasetField }[];
}

/** Diff between two dataset versions. */
export interface VersionDiff {
  rows_added: number;
  rows_removed: number;
  rows_modified: number;
  schema_changes: SchemaDiff;
  size_delta_bytes: number;
}
