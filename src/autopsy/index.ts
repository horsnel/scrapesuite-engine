/**
 * Self-Healing Parser System (Autopsy) -- ScrapeSuite Engine
 *
 * Barrel exports for the Autopsy module.
 */

export {
  autopsyEngine,
  default as AutopsyEngine,
  ParserRegistry,
  HealthMonitor,
  HeuristicRepairEngine,
  DEFAULT_AUTOPSY_CONFIG,
} from './engine';

export type {
  ParserHealth,
  ParserHealthCheck,
  AutopsyReport,
  StructuralChange,
  AffectedField,
  SuggestedRepair,
  RepairStrategy,
  DataTransform,
  RepairResult,
  ParserDefinition,
  FieldSelector,
  ParserVersion,
  AutopsyConfig,
  AutopsyStats,
} from './types';
