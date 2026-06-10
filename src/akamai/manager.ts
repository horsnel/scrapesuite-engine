/**
 * Akamai Manager — ScrapeSuite Engine
 *
 * Top-level orchestrator for all Akamai bypass components.
 * Coordinates sensor generation, Hydra solving, and Bot Manager evasion
 * as a unified system for Netflix and other Akamai-protected sites.
 */

import { createChildLogger } from '../utils/logger';
import { SensorGenerator, sensorGenerator } from './sensor-generator';
import { HydraSolver, hydraSolver } from './hydra-solver';
import { BotManagerEvader, botManagerEvader } from './bot-manager-evader';
import type { AkamaiConfig, AkamaiStats, SensorPayload, HydraSolution, EvasionResult, HydraChallenge } from './types';

const logger = createChildLogger('akamai-manager');

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_AKAMAI_CONFIG: AkamaiConfig = {
  sensorData: {
    pixelUrl: '',
    version: '4.0',
    includeMouseData: true,
    includeKeyboardData: true,
    includeTouchData: false,
    includeOrientationData: false,
    mouseEventCount: 47,
    keyboardEventCount: 23,
    simulatedSessionDuration: 45000,
    pageLoadOffset: 1200,
  },
  hydra: {
    maxSolveTime: 30000,
    maxRetries: 3,
    aiAssisted: true,
    challengeSuccessRates: {
      script_generation: 0.75,
      image_classification: 0.60,
      proof_of_work: 0.95,
      behavioral: 0.70,
    },
    fallbackToBrowser: true,
  },
  evader: {
    priorityMethods: ['sensor_analysis', 'behavioral_ml', 'fingerprint_mismatch', 'tls_analysis'],
    detectionConfidenceThreshold: 0.5,
    proactiveEvasion: true,
    maxEvasionsPerRequest: 3,
    learningMode: true,
    domainProfiles: {
      'netflix.com': ['sensor_spoofing', 'behavior_mimicry', 'fingerprint_consistency', 'tls_matching', 'rate_adaptation'],
      'google.com': ['header_normalization', 'rate_adaptation', 'cookie_simulation', 'ip_rotation'],
    },
  },
  cachePayloads: true,
  payloadCacheTTL: 600,
  debugMode: false,
};

// ===============================================================================
// AKAMAI MANAGER CLASS
// ===============================================================================

export class AkamaiManager {
  private sensor: SensorGenerator;
  private hydra: HydraSolver;
  private evader: BotManagerEvader;
  private config: AkamaiConfig;
  private initialized = false;

  constructor(config?: Partial<AkamaiConfig>) {
    this.config = { ...DEFAULT_AKAMAI_CONFIG, ...config };
    this.sensor = sensorGenerator;
    this.hydra = hydraSolver;
    this.evader = botManagerEvader;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    logger.info('Initializing Akamai Manager');
    this.initialized = true;
    logger.info('Akamai Manager initialized');
  }

  /**
   * Full anti-Akamai pipeline for a request.
   * 1. Generate sensor data payload
   * 2. Apply proactive evasions
   * 3. Handle Hydra challenges if present
   * 4. Return all components needed for the request
   */
  async prepareRequest(options: {
    domain: string;
    url: string;
    requestId: string;
    sessionId: string;
  }): Promise<{
    sensorPayload: SensorPayload;
    evasions: EvasionResult[];
    headers: Record<string, string>;
    cookies: Record<string, string>;
  }> {
    const { domain, url, requestId, sessionId } = options;

    // 1. Generate sensor data
    const sensorPayload = await this.sensor.generatePayload({
      domain,
      pageUrl: url,
      requestId,
      sessionId,
    });

    // 2. Apply proactive evasions
    const evasions = await this.evader.proactiveEvade(domain, url, requestId, sessionId);

    // 3. Build headers from evasion results
    const headers: Record<string, string> = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    };

    // 4. Build cookies from evasion results
    const cookies: Record<string, string> = {};
    if (domain.includes('netflix')) {
      cookies['nfvdid'] = `BQFmAAAB${Math.random().toString(36).substring(2, 14)}`;
    }

    return { sensorPayload, evasions, headers, cookies };
  }

  /** Handle a Hydra challenge received from Akamai. */
  async handleHydraChallenge(challenge: HydraChallenge): Promise<HydraSolution> {
    return this.hydra.solve(challenge);
  }

  /** Handle detected bot detection reactively. */
  async handleDetection(detections: Array<{ method: any; confidence: number; indicators: string[] }>, domain: string, url: string, requestId: string, sessionId: string): Promise<EvasionResult[]> {
    return this.evader.reactiveEvade(detections as any, domain, url, requestId, sessionId);
  }

  /** Get comprehensive statistics. */
  getStats(): AkamaiStats {
    const hydraStats = this.hydra.getStats();
    const evaderStats = this.evader.getStats();

    return {
      sensorPayloadsGenerated: 0, // Tracked by sensor generator
      sensorPayloadsSucceeded: 0,
      hydraChallengesReceived: hydraStats.totalChallenges,
      hydraChallengesSolved: hydraStats.solved,
      hydraChallengesFailed: hydraStats.failed,
      evasionsApplied: evaderStats.totalEvasionsApplied,
      evasionsSucceeded: evaderStats.totalEvasionsApplied, // Approximation
      detectionAvoided: 0,
      detectionEncountered: 0,
      byDomain: {},
    };
  }

  // Component accessors
  getSensorGenerator(): SensorGenerator { return this.sensor; }
  getHydraSolver(): HydraSolver { return this.hydra; }
  getBotManagerEvader(): BotManagerEvader { return this.evader; }
}

/** Singleton instance. */
export const akamaiManager = new AkamaiManager();
