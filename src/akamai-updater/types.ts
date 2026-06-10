/**
 * Akamai Sensor Auto-Updater Types — ScrapeSuite Engine
 *
 * Type definitions for the Akamai sensor format monitoring and
 * auto-patching system. Akamai updates their sensor data collection
 * algorithms every 1-2 weeks, which breaks existing bypass implementations.
 *
 * This module continuously monitors for changes, diffs against known
 * formats, and auto-generates patches to keep the sensor generator
 * operational without manual reverse-engineering intervention.
 */

// ===============================================================================
// SENSOR FORMAT TYPES
// ===============================================================================

export type SensorFormatStatus = 'active' | 'deprecated' | 'broken' | 'unknown';
export type ChangeSeverity = 'trivial' | 'minor' | 'major' | 'breaking';
export type PatchStatus = 'pending' | 'testing' | 'deployed' | 'failed' | 'rolled_back';
export type MonitorSource = 'pixel_script' | 'network_traffic' | 'challenge_response' | 'community_feed' | 'canary_probe';

export interface SensorFormat {
  /** Unique format identifier (e.g., "akamai-sensor-v4.2.1") */
  id: string;
  /** Version string extracted from the pixel script */
  version: string;
  /** Hash of the pixel script content */
  scriptHash: string;
  /** Pixel script URL where this format was observed */
  pixelUrl: string;
  /** Known sensor data field structure */
  fieldSchema: SensorFieldSchema;
  /** Encoding method used (base64, custom, protobuf, etc.) */
  encodingMethod: string;
  /** Checksum algorithm used */
  checksumAlgorithm: string;
  /** Minimum required sensor events count */
  minEvents: number;
  /** Maximum allowed sensor events count */
  maxEvents: number;
  /** Timestamp when this format was first observed */
  firstObserved: number;
  /** Timestamp when this format was last seen active */
  lastSeen: number;
  /** Current operational status */
  status: SensorFormatStatus;
  /** Domains where this format is deployed */
  domains: string[];
  /** Success rate of our payloads with this format (0-1) */
  successRate: number;
}

export interface SensorFieldSchema {
  /** Top-level field names and their types */
  fields: Record<string, SensorFieldDef>;
  /** Required fields that must be present */
  required: string[];
  /** Field ordering (some Akamai versions check field order) */
  fieldOrder: string[];
  /** Checksum fields and their computation method */
  checksumFields: string[];
  /** Version-specific encoding parameters */
  encodingParams: Record<string, any>;
}

export interface SensorFieldDef {
  type: 'number' | 'string' | 'array' | 'object' | 'boolean';
  /** Sub-field definition for objects/arrays */
  items?: SensorFieldDef;
  /** Fields for object type */
  properties?: Record<string, SensorFieldDef>;
  /** Whether this field was added in a recent update */
  isNew?: boolean;
  /** Whether this field was removed in a recent update */
  isRemoved?: boolean;
  /** Validation constraints */
  constraints?: {
    min?: number;
    max?: number;
    pattern?: string;
    values?: string[];
  };
}

// ===============================================================================
// CHANGE DETECTION TYPES
// ===============================================================================

export interface SensorFormatChange {
  /** Unique change ID */
  id: string;
  /** Previous format version */
  fromVersion: string;
  /** New format version */
  toVersion: string;
  /** Severity of the change */
  severity: ChangeSeverity;
  /** When this change was detected */
  detectedAt: number;
  /** Source that detected the change */
  detectedBy: MonitorSource;
  /** Detailed diff of the changes */
  diff: FormatDiff;
  /** Domains affected by this change */
  affectedDomains: string[];
  /** Whether this change breaks our current implementation */
  breaksCurrentImpl: boolean;
  /** Estimated time to patch (hours) */
  estimatedPatchTime: number;
  /** Whether a patch has been generated */
  patchGenerated: boolean;
}

export interface FormatDiff {
  /** Fields that were added */
  addedFields: SensorFieldDef[];
  /** Fields that were removed */
  removedFields: string[];
  /** Fields whose type or constraints changed */
  modifiedFields: Array<{
    field: string;
    previousDef: SensorFieldDef;
    newDef: SensorFieldDef;
  }>;
  /** Changes to field ordering requirements */
  orderChanges: string[][];
  /** Changes to encoding method */
  encodingChanges: {
    previous: string;
    current: string;
  } | null;
  /** Changes to checksum algorithm */
  checksumChanges: {
    previous: string;
    current: string;
  } | null;
  /** Changes to event count constraints */
  eventCountChanges: {
    previousMin: number;
    previousMax: number;
    newMin: number;
    newMax: number;
  } | null;
  /** Raw diff summary text */
  summary: string;
}

// ===============================================================================
// PATCH TYPES
// ===============================================================================

export interface SensorPatch {
  /** Unique patch ID */
  id: string;
  /** The change this patch addresses */
  changeId: string;
  /** Target format version */
  targetVersion: string;
  /** Patch description */
  description: string;
  /** Current patch status */
  status: PatchStatus;
  /** Timestamp when patch was generated */
  generatedAt: number;
  /** Timestamp when patch was deployed */
  deployedAt: number | null;
  /** Configuration updates for the sensor generator */
  configUpdates: Partial<SensorGeneratorConfigUpdate>;
  /** Field schema updates */
  schemaUpdates: SensorFieldSchema;
  /** Success rate after patching (measured by canary tests) */
  measuredSuccessRate: number;
  /** Number of test requests made with this patch */
  testRequests: number;
  /** Number of successful test requests */
  testSuccesses: number;
  /** Automated test results */
  testResults: PatchTestResult[];
}

export interface SensorGeneratorConfigUpdate {
  /** Updated version string */
  version: string;
  /** Updated encoding method */
  encodingMethod: string;
  /** Updated checksum algorithm */
  checksumAlgorithm: string;
  /** Updated event count constraints */
  mouseEventCount: { min: number; max: number; default: number };
  keyboardEventCount: { min: number; max: number; default: number };
  /** Updated field order to match new requirements */
  fieldOrder: string[];
  /** New fields that must be included */
  newRequiredFields: string[];
  /** Fields that should be removed */
  deprecatedFields: string[];
  /** Domain-specific overrides */
  domainOverrides: Record<string, Partial<SensorGeneratorConfigUpdate>>;
}

export interface PatchTestResult {
  domain: string;
  success: boolean;
  responseCode: number;
  errorMessage?: string;
  timestamp: number;
  sensorVersion: string;
}

// ===============================================================================
// MONITORING TYPES
// ===============================================================================

export interface MonitorEndpoint {
  /** URL to monitor for sensor script changes */
  url: string;
  /** Domain this endpoint belongs to */
  domain: string;
  /** How often to check (ms) */
  checkInterval: number;
  /** Last time this endpoint was checked */
  lastChecked: number;
  /** Hash of the last known good script */
  lastKnownHash: string;
  /** Number of consecutive checks with no change */
  stableCheckCount: number;
  /** Whether this endpoint is active */
  active: boolean;
}

export interface CanaryProbeConfig {
  /** Domains to test patches against */
  testDomains: string[];
  /** Number of test requests per domain */
  requestsPerDomain: number;
  /** Minimum success rate to consider a patch valid */
  minSuccessRate: number;
  /** Maximum time to wait for test results (ms) */
  maxTestDuration: number;
  /** Whether to auto-deploy patches that pass testing */
  autoDeploy: boolean;
  /** Rollback threshold — if success rate drops below this after deploy, auto-rollback */
  rollbackThreshold: number;
}

export interface AlertConfig {
  /** Whether to send alerts on format changes */
  enabled: boolean;
  /** Minimum severity to alert on */
  minSeverity: ChangeSeverity;
  /** Webhook URLs for alerts */
  webhookUrls: string[];
  /** Email addresses for critical alerts */
  emailAddresses: string[];
  /** Rate limit for alerts (max per hour) */
  maxAlertsPerHour: number;
}

// ===============================================================================
// UPDATER CONFIG & STATS
// ===============================================================================

export interface AkamaiUpdaterConfig {
  /** Monitoring endpoints to watch */
  monitorEndpoints: MonitorEndpoint[];
  /** Canary probe configuration */
  canary: CanaryProbeConfig;
  /** Alert configuration */
  alerts: AlertConfig;
  /** How often to check all endpoints (ms) */
  globalCheckInterval: number;
  /** Known format versions (loaded from cache/DB) */
  knownFormats: SensorFormat[];
  /** Maximum number of patches to keep in history */
  maxPatchHistory: number;
  /** Whether to attempt auto-patching on detected changes */
  autoPatch: boolean;
  /** Minimum confidence in patch before auto-deploying */
  minPatchConfidence: number;
  /** Community feed URL for format updates */
  communityFeedUrl: string | null;
  /** Enable verbose logging for debugging */
  debugMode: boolean;
}

export interface AkamaiUpdaterStats {
  totalChecksPerformed: number;
  changesDetected: number;
  patchesGenerated: number;
  patchesDeployed: number;
  patchesRolledBack: number;
  currentFormatVersions: Record<string, string>;
  lastCheckTime: number;
  averageDetectionLatencyMs: number;
  averagePatchTimeMs: number;
  byDomain: Record<string, {
    checksPerformed: number;
    changesDetected: number;
    currentVersion: string;
    lastChangeTime: number;
  }>;
}
