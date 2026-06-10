/**
 * Akamai Sensor Auto-Updater Module — ScrapeSuite Engine
 *
 * Automatically detects and adapts to Akamai sensor format changes.
 * Akamai updates their Bot Manager sensor algorithms every 1-2 weeks,
 * and this module ensures the engine stays operational by:
 *
 * 1. Monitoring pixel script endpoints for content changes
 * 2. Diffing format schemas to determine change severity
 * 3. Auto-generating patches for the sensor generator
 * 4. Canary testing patches before deployment
 * 5. Auto-rolling back patches that degrade success rates
 * 6. Alerting operators to breaking changes
 */

// Types
export type {
  SensorFormatStatus, ChangeSeverity, PatchStatus, MonitorSource,
  SensorFormat, SensorFieldSchema, SensorFieldDef,
  SensorFormatChange, FormatDiff,
  SensorPatch, SensorGeneratorConfigUpdate, PatchTestResult,
  MonitorEndpoint, CanaryProbeConfig, AlertConfig,
  AkamaiUpdaterConfig, AkamaiUpdaterStats,
} from './types';

// Format Monitor
export { FormatMonitor, formatMonitor } from './format-monitor';

// Auto Patcher
export { AutoPatcher, DEFAULT_CANARY_CONFIG, autoPatcher } from './auto-patcher';

// Manager
export { AkamaiUpdaterManager, DEFAULT_UPDATER_CONFIG, akamaiUpdaterManager } from './manager';
