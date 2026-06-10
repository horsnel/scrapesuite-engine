/**
 * Fusion Reactor Module -- ScrapeSuite Engine
 *
 * Real-Time Nuclear Fusion Chain Reaction System for Anti-Bot Counter-Measures.
 *
 * Exports:
 *  - fusionReactor: Main manager singleton
 *  - signalDetector: Signal detection engine
 *  - reactionEngine: Reaction generation engine
 *  - All types for external consumption
 */

export { FusionReactorManager, fusionReactor } from './manager';
export { SignalDetectorEngine, signalDetector, type ResponseContext } from './signal-detector';
export { ReactionEngine, reactionEngine } from './reaction-engine';

export type {
  DetectionSignal,
  SignalCategory,
  SignalSeverity,
  SignalConfidence,
  Reaction,
  ReactionType,
  ReactionPriority,
  ReactionStatus,
  ReactionParams,
  ChainReactionRule,
  CascadeRule,
  PropagationWave,
  PlasmaRule,
  PlasmaState,
  FusionReactorStatus,
  FusionReactorConfig,
  NeutronEconomy,
  AntiBotPlatform,
} from './types';

export { DEFAULT_FUSION_REACTOR_CONFIG } from './types';
