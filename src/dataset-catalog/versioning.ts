/**
 * Version Manager -- ScrapeSuite Engine
 *
 * Manages dataset versioning with checksum integrity,
 * rollback support, and version diffing.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import crypto from 'crypto';
import { DatasetVersion, DatasetEntry, DatasetSchema, VersionDiff, SchemaDiff } from './types';

const logger = createChildLogger('dataset-catalog:versioning');

const VERSION_PREFIX = 'dataset:versions:';
const LATEST_VERSION_KEY = (datasetId: string) => `dataset:latest_version:${datasetId}`;

// ---------- Version Manager class ---------------------------------------------

export class VersionManager {

  /** Create a new version snapshot for a dataset. */
  async createVersion(
    datasetId: string,
    entries: DatasetEntry[],
    schema: DatasetSchema,
    changelog = '',
    parentVersion?: number,
  ): Promise<DatasetVersion> {
    // Get current latest version
    const latestVersion = await this.getLatestVersionNumber(datasetId);
    const versionNumber = latestVersion + 1;

    // Compute checksum of all entry data
    const dataHash = this.computeEntriesChecksum(entries);

    // Estimate size
    const sizeBytes = JSON.stringify(entries).length;

    const version: DatasetVersion = {
      version_number: versionNumber,
      schema_snapshot: { ...schema },
      row_count: entries.length,
      size_bytes: sizeBytes,
      checksum_sha256: dataHash,
      created_at: Date.now(),
      changelog,
      parent_version: parentVersion ?? (latestVersion > 0 ? latestVersion : null),
    };

    // Store version metadata
    const versionsKey = VERSION_PREFIX + datasetId;
    const versions = await cacheGet<DatasetVersion[]>(versionsKey) ?? [];
    versions.push(version);
    await cacheSet(versionsKey, versions, 86400 * 365);

    // Update latest version pointer
    await cacheSet(LATEST_VERSION_KEY(datasetId), versionNumber, 86400 * 365);

    logger.info({ datasetId, version: versionNumber, rows: entries.length, checksum: dataHash.slice(0, 12) }, 'Version created');
    return version;
  }

  /** Get a specific version or the latest. */
  async getVersion(datasetId: string, version?: number): Promise<DatasetVersion | null> {
    const versions = await this.listVersions(datasetId);
    if (!versions.length) return null;

    if (version === undefined) {
      return versions[versions.length - 1];
    }
    return versions.find(v => v.version_number === version) ?? null;
  }

  /** List all versions of a dataset. */
  async listVersions(datasetId: string): Promise<DatasetVersion[]> {
    const versions = await cacheGet<DatasetVersion[]>(VERSION_PREFIX + datasetId);
    return versions ?? [];
  }

  /** Rollback a dataset to a specific version. */
  async rollback(datasetId: string, targetVersion: number): Promise<DatasetVersion> {
    const versions = await this.listVersions(datasetId);
    const target = versions.find(v => v.version_number === targetVersion);
    if (!target) {
      throw new Error(`Version ${targetVersion} not found for dataset ${datasetId}`);
    }

    // Create a new version that is a copy of the target
    const rollbackVersion = await this.createVersion(
      datasetId,
      [], // Entries will be re-populated by the caller
      target.schema_snapshot,
      `Rollback to version ${targetVersion}`,
      targetVersion,
    );

    logger.info({ datasetId, targetVersion, newVersion: rollbackVersion.version_number }, 'Rollback performed');
    return rollbackVersion;
  }

  /** Compute the diff between two versions. */
  async diffVersions(datasetId: string, v1: number, v2: number): Promise<VersionDiff> {
    const ver1 = await this.getVersion(datasetId, v1);
    const ver2 = await this.getVersion(datasetId, v2);
    if (!ver1 || !ver2) {
      throw new Error('One or both versions not found');
    }

    // Compute row diffs from metadata
    const rowsAdded = Math.max(0, ver2.row_count - ver1.row_count);
    const rowsRemoved = Math.max(0, ver1.row_count - ver2.row_count);
    const rowsModified = 0; // Would need full data comparison

    // Schema diff
    const schemaChanges = this.diffSchemas(ver1.schema_snapshot, ver2.schema_snapshot);

    return {
      rows_added: rowsAdded,
      rows_removed: rowsRemoved,
      rows_modified: rowsModified,
      schema_changes: schemaChanges,
      size_delta_bytes: ver2.size_bytes - ver1.size_bytes,
    };
  }

  /** Get the latest version number for a dataset. */
  async getLatestVersionNumber(datasetId: string): Promise<number> {
    const latest = await cacheGet<number>(LATEST_VERSION_KEY(datasetId));
    return latest ?? 0;
  }

  // ---------- Internal helpers ------------------------------------------------

  private computeEntriesChecksum(entries: DatasetEntry[]): string {
    const data = entries
      .map(e => e.hash_sha256 || JSON.stringify(e.data))
      .sort()
      .join('|');
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  private diffSchemas(schema1: DatasetSchema, schema2: DatasetSchema): SchemaDiff {
    const map1 = new Map(schema1.fields.map(f => [f.name, f]));
    const map2 = new Map(schema2.fields.map(f => [f.name, f]));

    const added = [...map2.values()].filter(f => !map1.has(f.name));
    const removed = [...map1.keys()].filter(k => !map2.has(k));
    const modified: SchemaDiff['modified_fields'] = [];

    for (const [name, field2] of map2) {
      const field1 = map1.get(name);
      if (field1 && JSON.stringify(field1) !== JSON.stringify(field2)) {
        modified.push({ name, old: field1, new: field2 });
      }
    }

    return { added_fields: added, removed_fields: removed, modified_fields: modified };
  }
}
