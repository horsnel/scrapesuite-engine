/**
 * Akamai Module — ScrapeSuite Engine
 *
 * Enterprise-grade Akamai Bot Manager bypass for Netflix and other
 * Akamai-protected targets. Handles sensor data generation, Hydra
 * challenge solving, and multi-vector evasion strategies.
 */

// Types
export type {
  SensorType, SensorVersion, SensorDataConfig, SensorPayload,
  MouseEventData, KeyboardEventData,
  HydraChallengeType, HydraPhase, HydraChallenge, HydraSolution, HydraConfig,
  BotDetectionMethod, EvasionStrategy, BotDetection, EvasionResult, BotManagerEvaderConfig,
  AkamaiConfig, AkamaiStats,
} from './types';

// Sensor Generator
export { SensorGenerator, DEFAULT_SENSOR_CONFIG, sensorGenerator } from './sensor-generator';

// Hydra Solver
export { HydraSolver, DEFAULT_HYDRA_CONFIG, hydraSolver } from './hydra-solver';

// Bot Manager Evader
export { BotManagerEvader, DEFAULT_EVADER_CONFIG, botManagerEvader } from './bot-manager-evader';

// Akamai Manager
export { AkamaiManager, DEFAULT_AKAMAI_CONFIG, akamaiManager } from './manager';
