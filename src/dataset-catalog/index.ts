/**
 * Dataset Catalog Builder -- ScrapeSuite Engine
 *
 * Manages structured datasets with versioning, validation, querying,
 * and export. Supports multiple update strategies and quality scoring.
 */

export { SchemaManager } from './schema-manager';
export { VersionManager } from './versioning';
export { QueryEngine } from './query-engine';
export { DatasetUpdater } from './updater';
export { DatasetCatalogManager, datasetCatalogManager } from './manager';
export * from './types';
