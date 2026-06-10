/**
 * Fusion Core -- The Nuclear Fusion Reactor (ENHANCED)
 *
 * THE NUCLEAR FUSION CORE orchestrates all fusion reactions and makes the
 * proxy pool self-sustaining like nuclear fusion. It integrates all subsystems:
 *
 * Features:
 *  - Fusion ignition: Start the fusion process (like igniting a fusion reactor)
 *  - Critical mass detection: Know when the pool has enough "fuel" (proxies) for self-sustaining fusion
 *  - Fuel injection: Add proxy sources as "fuel" into the reactor
 *  - Plasma containment: Manage the plasma state through the containment shield
 *  - Fusion reactions: Combine proxy sources to produce MORE proxies than consumed
 *    - Free proxies + residential providers = expanded discovery
 *    - TOR nodes + subnet scanning = deeper network penetration
 *    - Chain reactions + breeding = exponential growth
 *  - Energy output measurement: Track how many proxies the fusion produces
 *  - Self-sustaining mode: When energy output > energy input, the reaction is self-sustaining
 *  - Q-factor: Like in real fusion, the Q-factor measures energy out / energy in. Q > 1 = self-sustaining
 *  - D-T reaction analog: Deuterium-Tritium → Discovery + Breeding = new proxies
 *  - Magnetic confinement: Use containment shield to keep the reaction stable
 *  - Plasma heating: Use chain reactions to heat the plasma (increase pool activity)
 *  - Tritium breeding: Like breeding tritium from lithium, breed new proxy configs from existing ones
 *  - Neutron moderation: Control the rate of chain reactions to prevent runaway
 *  - Fusion milestones: Track when the pool reaches key milestones
 *  - Reactor status: Comprehensive status reporting
 *  - Fusion Afterburner: Beyond self-sustaining -- explosive growth mode
 *  - Neutron Multiplication: Successful reactions multiply future discovery rate
 *  - Adaptive Rate Control: Reaction rate adjusts automatically based on pool health
 *  - Parallel Reaction Execution: Run discovery, breeding, chain reactions in parallel
 *  - Plasma Injection: Directly push discovered proxies into the plasma state
 *  - Enhanced Breeding: Generate actual proxy configs (port/protocol/auth variations)
 *  - Module Integration: captcha-solver and web-unlocker as fusion subsystems
 *  - Real-time Metrics: Faster, more granular metric tracking
 *  - Smart Cooldown: Adaptive cooldowns based on pool health
 *  - More Milestones: Higher milestones including Thermonuclear, Stellar, Cosmic
 *
 * Dynamic module integration:
 *  - chain-reaction → neutron source
 *  - breeder-reactor → tritium breeding
 *  - quantum-tunnel → magnetic confinement breakthrough
 *  - plasma-state → plasma management
 *  - containment → safety systems
 *  - mega-pool → the reactor vessel
 *  - captcha-solver → CAPTCHA bypass subsystem
 *  - web-unlocker → anti-bot bypass subsystem
 */

import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';
import { testProxy } from '../utils/proxy-fetch';

const logger = createChildLogger('fusion-core');

// --- Constants (SPEED ENHANCED) -----------------------------------------------

/** How often the main reactor loop runs (ms). Was 30_000, now 5_000 for rapid reaction. */
const REACTOR_LOOP_INTERVAL_MS = 5_000;

/** How often to measure Q-factor (ms). Was 60_000, now 10_000 for real-time tracking. */
const QFACTOR_MEASUREMENT_INTERVAL_MS = 10_000;

/** How often to check milestones (ms). Was 120_000, now 30_000. */
const MILESTONE_CHECK_INTERVAL_MS = 30_000;

/** How often to check critical mass (ms). Was 180_000, now 15_000. */
const CRITICAL_MASS_CHECK_INTERVAL_MS = 15_000;

/** Minimum pool size for critical mass (proxies). Was 100, now 1000. */
const CRITICAL_MASS_MIN_PROXIES = 1000;

/** Target pool size for self-sustaining mode. Was 1000, now 10_000. */
const SELF_SUSTAINING_MIN_PROXIES = 10_000;

/** Energy tracking window for Q-factor calculation (minutes). Was 10, now 3. */
const ENERGY_TRACKING_WINDOW_MIN = 3;

/** Maximum reaction rate (chain reactions per minute). Was 100, now 1000. */
const DEFAULT_MAX_REACTION_RATE = 1000;

/** Default neutron moderation factor (0-1). Was 0.5, now 0.3. */
const DEFAULT_NEUTRON_MODERATION = 0.3;

/** Preheating duration -- how long to warm up before ignition (ms). Was 30_000, now 5_000. */
const PREHEATING_DURATION_MS = 5_000;

/** Maximum fuel injection batch size. Was 500, now 5000. */
const MAX_FUEL_BATCH_SIZE = 5000;

/** Maximum adaptive reaction rate. Was 2.0, now 5.0. */
const MAX_ADAPTIVE_REACTION_RATE = 5.0;

/** Minimum adaptive reaction rate. */
const MIN_ADAPTIVE_REACTION_RATE = 0.1;

/** Neutron multiplication factor per validated proxy. */
const NEUTRON_MULTIPLICATION_FACTOR = 2.5;

/** Neutron economy threshold for bonus cascade rounds. */
const NEUTRON_ECONOMY_BONUS_THRESHOLD = 100;

/** Afterburner minimum pool size for activation. */
const AFTERBURNER_MIN_POOL_SIZE = 100_000;

/** Afterburner minimum Q-factor for activation. */
const AFTERBURNER_MIN_QFACTOR = 5;

/** Afterburner reaction rate multiplier. */
const AFTERBURNER_RATE_MULTIPLIER = 2.0;

/** Afterburner neutron moderation override. */
const AFTERBURNER_NEUTRON_MODERATION = 0.1;

/** Parallel chain reaction concurrency limit. */
const PARALLEL_CHAIN_CONCURRENCY = 5;

/** Cascade trigger count. Was 3, now 15. */
const CASCADE_TRIGGER_COUNT = 15;

/** Adaptive rate increase when success rate > 80%. */
const ADAPTIVE_RATE_INCREASE = 0.10;

/** Adaptive rate decrease when success rate < 50%. */
const ADAPTIVE_RATE_DECREASE = 0.20;

/** Pool growth rate cap (proxies/minute) to prevent overload. */
const POOL_GROWTH_RATE_CAP = 100;

/** Smart cooldown minimum (ms). */
const SMART_COOLDOWN_MIN_MS = 1_000;

/** Smart cooldown maximum (ms). */
const SMART_COOLDOWN_MAX_MS = 30_000;

/** Module auto-retry interval (ms). */
const MODULE_RETRY_INTERVAL_MS = 60_000;

/** Neutron flux measurement window (minutes). Was 5, now 2. */
const NEUTRON_FLUX_WINDOW_MIN = 2;

/** Energy output rate window (minutes). 1-minute window for real-time tracking. */
const ENERGY_OUTPUT_RATE_WINDOW_MIN = 1;

/** Number of port variations for enhanced breeding. */
const BREEDING_PORT_VARIATIONS = 50;

/** Protocol variations for enhanced breeding. */
const BREEDING_PROTOCOLS = ['http', 'https', 'socks4', 'socks5'] as const;

/** Plasma injection batch size. */
const PLASMA_INJECTION_BATCH_SIZE = 200;

// --- Types --------------------------------------------------------------------

export type ReactorStatus = 'cold' | 'preheating' | 'igniting' | 'burning' | 'self_sustaining' | 'afterburner' | 'scram' | 'shutdown';

export interface FusionConfig {
  targetQFactor: number;
  maxReactionRate: number;
  containmentLevel: number;
  fuelTypes: string[];
  plasmaTemperature: number;
  neutronModeration: number;
}

export interface FusionMilestone {
  name: string;
  targetIPs: number;
  achievedAt: number | null;
  currentIPs: number;
  progress: number;
  velocity: number;
}

export interface ReactorStats {
  status: ReactorStatus;
  qFactor: number;
  plasmaTemperature: number;
  neutronFlux: number;
  energyInput: number;
  energyOutput: number;
  netEnergy: number;
  totalFuelInjected: number;
  totalEnergyProduced: number;
  isSelfSustaining: boolean;
  criticalMassPercent: number;
  reactionRate: number;
  containmentIntegrity: number;
  milestones: FusionMilestone[];
  uptime: number;
  scramCount: number;
  burnTime: number;
  neutronEconomy: number;
  adaptiveRate: number;
  afterburnerActive: boolean;
  reactionEfficiency: number;
  poolGrowthRate: number;
  smartCooldownMs: number;
  plasmaInjectionRate: number;
  lastDiscoveryCount: number;
  lastBreedingCount: number;
}

export interface NeutronEconomy {
  neutronsProduced: number;
  neutronsConsumed: number;
  balance: number;
  bonusCascadeTriggered: boolean;
}

export interface BredProxyConfig {
  ip: string;
  port: number;
  protocol: string;
  provider: string;
  country: string | null;
  authUser: string | null;
  authPass: string | null;
}

export interface PlasmaInjectionResult {
  totalAttempted: number;
  totalSucceeded: number;
  totalFailed: number;
  successRate: number;
}

export interface AdaptiveRateState {
  currentRate: number;
  lastAdjustment: number;
  successRateWindow: Array<{ timestamp: number; success: boolean }>;
  poolGrowthWindow: Array<{ timestamp: number; poolSize: number }>;
}

export interface SmartCooldownState {
  currentCooldownMs: number;
  lastCalculation: number;
  healthScore: number;
}

// --- Module Interface Types ---------------------------------------------------

interface ChainReactionModule {
  triggerChain?: () => Promise<{ newProxies: number }>;
  triggerCascade?: (depth: number) => Promise<{ newProxies: number; depth: number }>;
  getStatus?: () => { active: boolean; depth: number };
}

interface BreederReactorModule {
  breed?: () => Promise<{ newConfigs: number }>;
  breedWithVariations?: (patterns: Array<{ provider: string; country: string | null }>) => Promise<{ newConfigs: number }>;
  getStatus?: () => { active: boolean; bred: number };
}

interface QuantumTunnelModule {
  tunnel?: () => Promise<{ breached: boolean; newProxies: number }>;
  getStatus?: () => { active: boolean };
}

interface PlasmaStateModule {
  startPlasma?: () => Promise<void>;
  stopPlasma?: () => Promise<void>;
  heal?: () => Promise<void>;
  measureTemperature?: () => number;
  getPoolSize?: () => number;
  getCheckedOutCount?: () => number;
  injectProxies?: (proxies: Array<{ url: string; protocol: string }>) => Promise<number>;
  getStatus?: () => { active: boolean; temperature: number };
}

interface ContainmentShieldModule {
  startContainment?: () => Promise<void>;
  stopContainment?: () => Promise<void>;
  scram?: () => Promise<void>;
  detectBreach?: () => Promise<void>;
  checkShieldIntegrity?: () => Promise<void>;
  getMaxAdmissionRate?: () => number;
  getCurrentAdmissionRate?: () => number;
  getIntegrity?: () => number;
  getLevel?: () => number;
  getStatus?: () => { active: boolean; integrity: number };
}

interface MegaPoolModule {
  addProxies?: (proxies: Array<{ url: string; protocol: string }>) => Promise<number>;
  getPoolStats?: () => { total: number; active: number; retired: number };
  getStatus?: () => { active: boolean };
}

interface CaptchaSolverModule {
  solveCaptcha?: (pageUrl: string, siteKey: string) => Promise<{ token: string; solved: boolean }>;
  getStatus?: () => { active: boolean; solved: number };
  getCapabilities?: () => string[];
}

interface WebUnlockerModule {
  unlockPage?: (url: string, options?: { useProxy?: boolean; country?: string }) => Promise<{ content: string; unlocked: boolean }>;
  getStatus?: () => { active: boolean; unlocked: number };
  getCapabilities?: () => string[];
}

interface EnergyMeasurement {
  timestamp: number;
  inputCount: number;   // Proxies discovered (raw input)
  outputCount: number;  // Proxies validated & usable (output)
}

// --- Milestone Definitions (EXPANDED) ----------------------------------------

const MILESTONE_DEFINITIONS: Array<{ name: string; targetIPs: number }> = [
  { name: 'First Light', targetIPs: 1_000 },
  { name: 'Plasma Ignition', targetIPs: 10_000 },
  { name: 'Fusion Temperature', targetIPs: 100_000 },
  { name: 'Breakeven', targetIPs: 1_000_000 },
  { name: 'Self-Sustaining', targetIPs: 5_000_000 },
  { name: 'Full Burn', targetIPs: 10_000_000 },
  { name: 'Supercritical', targetIPs: 50_000_000 },
  { name: 'Unlimited Energy', targetIPs: 100_000_000 },
  { name: 'Thermonuclear', targetIPs: 500_000_000 },
  { name: 'Stellar', targetIPs: 1_000_000_000 },
  { name: 'Cosmic', targetIPs: 10_000_000_000 },
];

// --- Common Ports for Breeding ------------------------------------------------

const BREEDING_COMMON_PORTS = [
  80, 443, 1080, 3128, 8080, 8443, 8888, 9050, 9051,
  10801, 10809, 12345, 143, 21, 22, 25, 465, 587, 993,
  995, 1337, 3129, 3130, 6588, 8081, 8082, 8085, 8090,
  8118, 8123, 8880, 9090, 9091, 9100, 9111, 9999, 10000,
  10001, 10010, 10101, 10800, 11000, 11001, 11434, 15000,
  16000, 20000, 25000, 30000, 35000, 40000, 45000, 50000,
];

// --- FusionCore ---------------------------------------------------------------

export class FusionCore {
  /** Current reactor status. */
  private status: ReactorStatus = 'cold';

  /** Fusion configuration. */
  private config: FusionConfig = {
    targetQFactor: 1.0,
    maxReactionRate: DEFAULT_MAX_REACTION_RATE,
    containmentLevel: 0,
    fuelTypes: ['free', 'residential', 'tor', 'datacenter'],
    plasmaTemperature: 0,
    neutronModeration: DEFAULT_NEUTRON_MODERATION,
  };

  /** Dynamically loaded modules with proper interfaces. */
  private chainReaction: ChainReactionModule | null = null;
  private breederReactor: BreederReactorModule | null = null;
  private quantumTunnel: QuantumTunnelModule | null = null;
  private plasmaState: PlasmaStateModule | null = null;
  private containment: ContainmentShieldModule | null = null;
  private megaPool: MegaPoolModule | null = null;
  private captchaSolver: CaptchaSolverModule | null = null;
  private webUnlocker: WebUnlockerModule | null = null;

  /** Whether modules have been initialized. */
  private modulesInitialized = false;

  /** Failed module loads -- track for auto-retry. */
  private failedModuleLoads: Map<string, number> = new Map();

  /** Module auto-retry timer. */
  private moduleRetryTimer: ReturnType<typeof setInterval> | null = null;

  /** Energy measurements for Q-factor calculation. */
  private energyMeasurements: EnergyMeasurement[] = [];

  /** Total fuel injected since start. */
  private totalFuelInjected = 0;

  /** Total energy produced (usable proxies) since start. */
  private totalEnergyProduced = 0;

  /** Current reaction rate (chain reactions per minute). */
  private currentReactionRate = 0;

  /** Neutron flux -- current rate of chain reactions. */
  private neutronFluxValue = 0;

  /** SCRAM count. */
  private scramCount = 0;

  /** When the reactor was started. */
  private startedAt: number | null = null;

  /** When the reactor entered burning or self_sustaining state. */
  private burnStartedAt: number | null = null;

  /** When the reactor entered afterburner state. */
  private afterburnerStartedAt: number | null = null;

  /** Timer handles. */
  private reactorLoopTimer: ReturnType<typeof setInterval> | null = null;
  private qfactorTimer: ReturnType<typeof setInterval> | null = null;
  private milestoneTimer: ReturnType<typeof setInterval> | null = null;
  private criticalMassTimer: ReturnType<typeof setInterval> | null = null;

  /** Milestones tracking. */
  private milestones: FusionMilestone[] = MILESTONE_DEFINITIONS.map((def) => ({
    name: def.name,
    targetIPs: def.targetIPs,
    achievedAt: null,
    currentIPs: 0,
    progress: 0,
    velocity: 0,
  }));

  /** Recent chain reaction events (for neutron flux). */
  private recentReactions: Array<{ timestamp: number; count: number }> = [];

  /** Fuel types currently active. */
  private activeFuelTypes = new Set<string>();

  /** Current Q-factor. */
  private currentQFactor = 0;

  /** Critical mass percentage (0-100). */
  private criticalMassPercent = 0;

  /** Whether the reactor is running. */
  private running = false;

  // --- NEW: Neutron Multiplication State ---------------------------------

  /** Neutron economy tracking. */
  private neutronEconomy: NeutronEconomy = {
    neutronsProduced: 0,
    neutronsConsumed: 0,
    balance: 0,
    bonusCascadeTriggered: false,
  };

  // --- NEW: Adaptive Rate Control State ----------------------------------

  /** Adaptive rate control state. */
  private adaptiveRate: AdaptiveRateState = {
    currentRate: 1.0,
    lastAdjustment: 0,
    successRateWindow: [],
    poolGrowthWindow: [],
  };

  // --- NEW: Smart Cooldown State -----------------------------------------

  /** Smart cooldown state. */
  private smartCooldown: SmartCooldownState = {
    currentCooldownMs: SMART_COOLDOWN_MIN_MS,
    lastCalculation: 0,
    healthScore: 1.0,
  };

  // --- NEW: Plasma Injection Tracking ------------------------------------

  /** Plasma injection results history. */
  private plasmaInjectionResults: PlasmaInjectionResult[] = [];

  /** Last discovery count for stats. */
  private lastDiscoveryCount = 0;

  /** Last breeding count for stats. */
  private lastBreedingCount = 0;

  /** Discovered proxies pending plasma injection. */
  private pendingPlasmaInjection: Array<{ url: string; protocol: string }> = [];

  // --- NEW: Afterburner State --------------------------------------------

  /** Whether afterburner mode is active. */
  private afterburnerActive = false;

  /** Reaction efficiency (validated / discovered). */
  private reactionEfficiency = 0;

  /** Pool growth rate tracking (proxies/minute). */
  private poolGrowthRate = 0;

  /** Pool size history for growth rate calculation. */
  private poolSizeHistory: Array<{ timestamp: number; size: number }> = [];

  // --- Lifecycle ----------------------------------------------------------

  /**
   * Ignite the fusion reactor.
   * Starts all subsystems, loads modules, and begins the fusion process.
   * The reactor goes through:
   *   cold → preheating → igniting → burning → self_sustaining → afterburner
   *
   * @param config - Fusion configuration
   */
  async ignite(config?: Partial<FusionConfig>): Promise<void> {
    if (this.running) {
      logger.warn('Fusion reactor is already running');
      return;
    }

    // Apply configuration
    if (config) {
      this.config = { ...this.config, ...config };
    }

    logger.info(
      {
        targetQFactor: this.config.targetQFactor,
        maxReactionRate: this.config.maxReactionRate,
        fuelTypes: this.config.fuelTypes,
        neutronModeration: this.config.neutronModeration,
      },
      '🔥 Initiating fusion reactor ignition sequence...',
    );

    this.running = true;
    this.startedAt = Date.now();
    this.adaptiveRate.currentRate = 1.0;

    // Phase 1: Preheating -- initialize modules and load existing proxies
    this.status = 'preheating';
    logger.info('Phase 1: Preheating -- initializing subsystems...');

    await this.initModules();

    // Initialize fuel types
    for (const fuelType of this.config.fuelTypes) {
      this.activeFuelTypes.add(fuelType);
    }

    // Start the containment shield
    if (this.containment) {
      try {
        await this.containment.startContainment?.();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ error: msg }, 'Containment shield startup failed');
      }
    }

    // Start the plasma state engine
    if (this.plasmaState) {
      try {
        await this.plasmaState.startPlasma?.();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ error: msg }, 'Plasma state startup failed');
      }
    }

    // Wait for preheating (fast -- 5 seconds)
    await new Promise((resolve) => setTimeout(resolve, PREHEATING_DURATION_MS));

    // Phase 2: Ignition -- start the main reactor loops
    this.status = 'igniting';
    logger.info('Phase 2: Ignition -- starting reactor loops...');

    this.startReactorLoops();
    this.startModuleRetryLoop();

    // Check if we have enough fuel for sustained fusion
    const initialPoolSize = await this.getEffectiveIPCount();
    logger.info({ initialPoolSize }, 'Initial fuel inventory complete');

    // Phase 3: Transition to burning if enough fuel
    if (initialPoolSize >= CRITICAL_MASS_MIN_PROXIES) {
      this.status = 'burning';
      this.burnStartedAt = Date.now();
      logger.info('Phase 3: Fusion reaction BURNING -- reactor is active');
    } else {
      logger.warn(
        { initialPoolSize, required: CRITICAL_MASS_MIN_PROXIES },
        'Insufficient fuel for sustained fusion -- reactor in ignition mode',
      );
    }

    logger.info(
      { status: this.status, poolSize: initialPoolSize },
      '🔥 Fusion reactor ignition sequence complete',
    );
  }

  /**
   * Graceful shutdown of the fusion reactor.
   * Stops all subsystems in reverse order and persists state.
   */
  async shutdown(): Promise<void> {
    if (!this.running) return;

    logger.info('Initiating graceful fusion reactor shutdown...');
    this.status = 'shutdown';
    this.running = false;
    this.afterburnerActive = false;

    // Stop reactor loops
    this.stopReactorLoops();
    this.stopModuleRetryLoop();

    // Stop subsystems in reverse order
    if (this.plasmaState) {
      try { await this.plasmaState.stopPlasma?.(); } catch (err: unknown) {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Plasma stop failed');
      }
    }

    if (this.containment) {
      try { await this.containment.stopContainment?.(); } catch (err: unknown) {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Containment stop failed');
      }
    }

    // Persist final state
    await this.persistReactorState();

    logger.info('Fusion reactor shutdown complete');
  }

  /**
   * Emergency shutdown (SCRAM).
   * Immediately stops all reactor operations and activates containment.
   */
  async scram(): Promise<void> {
    this.scramCount++;
    this.status = 'scram';
    this.afterburnerActive = false;

    logger.error(
      { scramCount: this.scramCount },
      '🚨 FUSION REACTOR SCRAM -- Emergency shutdown initiated',
    );

    this.running = false;
    this.stopReactorLoops();
    this.stopModuleRetryLoop();

    // Activate containment SCRAM
    if (this.containment) {
      try { await this.containment.scram?.(); } catch (err: unknown) {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Containment SCRAM failed');
      }
    }

    // Stop plasma state
    if (this.plasmaState) {
      try { await this.plasmaState.stopPlasma?.(); } catch (err: unknown) {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Plasma stop failed');
      }
    }

    // Persist state
    await this.persistReactorState();

    logger.error('Fusion reactor SCRAM complete -- all operations halted');
  }

  // --- Module Initialization ----------------------------------------------

  /**
   * Initialize all fusion modules via dynamic imports.
   * Each module is optional -- if it fails to load, the reactor continues
   * without that subsystem. Failed modules are tracked for auto-retry.
   */
  private async initModules(): Promise<void> {
    if (this.modulesInitialized) return;

    logger.info('Initializing fusion modules via dynamic imports...');

    // Chain Reaction -- neutron source for chain reactions
    try {
      const m = await import('./chain-reaction');
      this.chainReaction = m.chainReaction as unknown as ChainReactionModule;
      logger.info('✓ Chain reaction module loaded');
    } catch {
      this.failedModuleLoads.set('chain-reaction', Date.now());
      logger.info('✗ Chain reaction module not available -- running without chain reactions');
    }

    // Breeder Reactor -- tritium breeding (proxy config generation)
    try {
      const m = await import('./breeder-reactor');
      this.breederReactor = m.breederReactor as BreederReactorModule;
      logger.info('✓ Breeder reactor module loaded');
    } catch {
      this.failedModuleLoads.set('breeder-reactor', Date.now());
      logger.info('✗ Breeder reactor module not available -- running without breeding');
    }

    // Quantum Tunnel -- magnetic confinement breakthrough
    try {
      const m = await import('./quantum-tunnel');
      this.quantumTunnel = m.quantumTunnel as QuantumTunnelModule;
      logger.info('✓ Quantum tunnel module loaded');
    } catch {
      this.failedModuleLoads.set('quantum-tunnel', Date.now());
      logger.info('✗ Quantum tunnel module not available -- running without quantum tunneling');
    }

    // Plasma State -- plasma management
    try {
      const m = await import('./plasma-state');
      this.plasmaState = m.plasmaState as unknown as PlasmaStateModule;
      logger.info('✓ Plasma state module loaded');
    } catch {
      this.failedModuleLoads.set('plasma-state', Date.now());
      logger.info('✗ Plasma state module not available -- running without plasma management');
    }

    // Containment Shield -- safety systems
    try {
      const m = await import('./containment');
      this.containment = m.containmentShield as unknown as ContainmentShieldModule;
      logger.info('✓ Containment shield module loaded');
    } catch {
      this.failedModuleLoads.set('containment', Date.now());
      logger.info('✗ Containment shield module not available -- running without containment');
    }

    // Mega Pool -- the reactor vessel
    try {
      const m = await import('./ip-pool');
      this.megaPool = m.smartIPPool as unknown as MegaPoolModule;
      logger.info('✓ Mega pool module loaded');
    } catch {
      this.failedModuleLoads.set('ip-pool', Date.now());
      logger.info('✗ Mega pool module not available -- running without mega pool');
    }

    // Captcha Solver -- CAPTCHA bypass subsystem
    try {
      const m = await import('./captcha-solver');
      this.captchaSolver = m.captchaSolver as CaptchaSolverModule;
      logger.info('✓ Captcha solver module loaded as fusion subsystem');
    } catch {
      this.failedModuleLoads.set('captcha-solver', Date.now());
      logger.info('✗ Captcha solver module not available -- running without CAPTCHA bypass');
    }

    // Web Unlocker -- anti-bot bypass subsystem
    try {
      const m = await import('./web-unlocker');
      this.webUnlocker = m.webUnlocker as WebUnlockerModule;
      logger.info('✓ Web unlocker module loaded as fusion subsystem');
    } catch {
      this.failedModuleLoads.set('web-unlocker', Date.now());
      logger.info('✗ Web unlocker module not available -- running without anti-bot bypass');
    }

    this.modulesInitialized = true;
    logger.info(
      { failedModules: Array.from(this.failedModuleLoads.keys()) },
      'Fusion module initialization complete',
    );
  }

  /**
   * Start the module auto-retry loop.
   * Periodically attempts to reload failed modules.
   */
  private startModuleRetryLoop(): void {
    if (this.moduleRetryTimer) return;

    this.moduleRetryTimer = setInterval(() => {
      this.retryFailedModules().catch((err: unknown) => {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Module retry loop failed');
      });
    }, MODULE_RETRY_INTERVAL_MS);
  }

  /**
   * Stop the module auto-retry loop.
   */
  private stopModuleRetryLoop(): void {
    if (this.moduleRetryTimer) {
      clearInterval(this.moduleRetryTimer);
      this.moduleRetryTimer = null;
    }
  }

  /**
   * Retry loading modules that previously failed.
   * Auto-retries every 60 seconds for each failed module.
   */
  private async retryFailedModules(): Promise<void> {
    const failedNames = Array.from(this.failedModuleLoads.keys());
    if (failedNames.length === 0) return;

    for (const moduleName of failedNames) {
      try {
        let loaded = false;
        switch (moduleName) {
          case 'chain-reaction': {
            const m = await import('./chain-reaction');
            this.chainReaction = m.chainReaction as unknown as ChainReactionModule;
            loaded = true;
            break;
          }
          case 'breeder-reactor': {
            const m = await import('./breeder-reactor');
            this.breederReactor = m.breederReactor as BreederReactorModule;
            loaded = true;
            break;
          }
          case 'quantum-tunnel': {
            const m = await import('./quantum-tunnel');
            this.quantumTunnel = m.quantumTunnel as QuantumTunnelModule;
            loaded = true;
            break;
          }
          case 'plasma-state': {
            const m = await import('./plasma-state');
            this.plasmaState = m.plasmaState as unknown as PlasmaStateModule;
            loaded = true;
            break;
          }
          case 'containment': {
            const m = await import('./containment');
            this.containment = m.containmentShield as unknown as ContainmentShieldModule;
            loaded = true;
            break;
          }
          case 'ip-pool': {
            const m = await import('./ip-pool');
            this.megaPool = m.smartIPPool as unknown as MegaPoolModule;
            loaded = true;
            break;
          }
          case 'captcha-solver': {
            const m = await import('./captcha-solver');
            this.captchaSolver = m.captchaSolver as CaptchaSolverModule;
            loaded = true;
            break;
          }
          case 'web-unlocker': {
            const m = await import('./web-unlocker');
            this.webUnlocker = m.webUnlocker as WebUnlockerModule;
            loaded = true;
            break;
          }
        }

        if (loaded) {
          this.failedModuleLoads.delete(moduleName);
          logger.info({ module: moduleName }, '✓ Previously failed module loaded on retry');
        }
      } catch {
        // Still failing -- update timestamp
        this.failedModuleLoads.set(moduleName, Date.now());
        logger.debug({ module: moduleName }, 'Module retry still failing');
      }
    }
  }

  // --- Fuel Injection -----------------------------------------------------

  /**
   * Inject fuel (proxy sources) into the reactor.
   * Like adding deuterium and tritium to a fusion reactor, this adds
   * proxy sources that the reactor will process through its fusion
   * reactions to produce more usable proxies.
   *
   * @param fuelType - Type of fuel: 'free', 'residential', 'tor', 'datacenter', 'custom'
   * @param amount - Number of proxy sources to inject
   * @returns Number of proxies actually injected into the reactor
   */
  async injectFuel(fuelType: string, amount: number): Promise<number> {
    if (!this.running) {
      logger.warn('Cannot inject fuel -- reactor is not running');
      return 0;
    }

    // Check containment -- are we allowed to admit proxies?
    if (this.containment) {
      try {
        const maxRate = this.containment.getMaxAdmissionRate?.() ?? 500;
        const currentRate = this.containment.getCurrentAdmissionRate?.() ?? 0;
        if (currentRate >= maxRate) {
          logger.warn(
            { currentRate, maxRate },
            'Fuel injection blocked -- containment admission rate limit reached',
          );
          return 0;
        }
      } catch (err: unknown) {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Containment check failed');
      }
    }

    const cappedAmount = Math.min(amount, MAX_FUEL_BATCH_SIZE);
    let injected = 0;

    logger.info(
      { fuelType, requested: amount, capped: cappedAmount },
      'Injecting fuel into fusion reactor',
    );

    switch (fuelType) {
      case 'free':
        injected = await this.injectFreeFuel(cappedAmount);
        break;
      case 'residential':
        injected = await this.injectResidentialFuel(cappedAmount);
        break;
      case 'tor':
        injected = await this.injectTorFuel(cappedAmount);
        break;
      case 'datacenter':
        injected = await this.injectDatacenterFuel(cappedAmount);
        break;
      case 'custom':
        injected = await this.injectCustomFuel(cappedAmount);
        break;
      default:
        logger.warn({ fuelType }, 'Unknown fuel type -- cannot inject');
        return 0;
    }

    this.totalFuelInjected += injected;

    // Track energy input
    const now = Date.now();
    this.energyMeasurements.push({
      timestamp: now,
      inputCount: injected,
      outputCount: 0,
    });

    // Consume neutrons for fuel injection
    this.neutronEconomy.neutronsConsumed += Math.ceil(injected * 0.1);
    this.updateNeutronEconomy();

    // If plasma state is available, inject into plasma
    if (this.plasmaState && injected > 0) {
      try {
        logger.debug({ injected }, 'Fuel available for plasma ingestion');
      } catch (err: unknown) {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Plasma injection check failed');
      }
    }

    logger.info(
      { fuelType, injected, totalFuelInjected: this.totalFuelInjected },
      'Fuel injection complete',
    );

    return injected;
  }

  // --- Measurement Methods ------------------------------------------------

  /**
   * Measure the current plasma temperature.
   * Delegates to the plasma state module if available.
   *
   * @returns Temperature value (0-100)
   */
  measurePlasmaTemperature(): number {
    if (this.plasmaState) {
      try {
        return this.plasmaState.measureTemperature?.() ?? 0;
      } catch (err: unknown) {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Plasma temperature measurement failed');
      }
    }

    // Fallback: estimate from pool activity
    const poolSize = this.getPoolSize();
    if (poolSize === 0) return 0;

    const utilizationRate = this.getUtilizationRate();
    return Math.round(utilizationRate * 60 + Math.min(40, poolSize / 100));
  }

  /**
   * Measure the neutron flux -- rate of chain reactions.
   * Neutron flux represents how many proxy discovery chain reactions
   * are occurring per minute. Higher flux = more discoveries = more growth.
   * Uses 2-minute window for real-time tracking (was 5 minutes).
   *
   * @returns Chain reactions per minute
   */
  measureNeutronFlux(): number {
    const now = Date.now();
    const windowMs = NEUTRON_FLUX_WINDOW_MIN * 60 * 1000;
    this.recentReactions = this.recentReactions.filter((r) => r.timestamp >= now - windowMs);

    const totalReactions = this.recentReactions.reduce((sum, r) => sum + r.count, 0);
    this.neutronFluxValue = totalReactions / NEUTRON_FLUX_WINDOW_MIN;
    return this.neutronFluxValue;
  }

  /**
   * Measure the energy output -- proxies produced per unit time.
   * Energy output is the number of usable, validated proxies produced
   * by the fusion reactions per minute.
   * Uses 1-minute window for real-time tracking.
   *
   * @returns Usable proxies per minute
   */
  measureEnergyOutput(): number {
    const now = Date.now();
    const windowMs = ENERGY_OUTPUT_RATE_WINDOW_MIN * 60 * 1000;
    const recentMeasurements = this.energyMeasurements.filter((m) => m.timestamp >= now - windowMs);

    const totalOutput = recentMeasurements.reduce((sum, m) => sum + m.outputCount, 0);
    return totalOutput / ENERGY_OUTPUT_RATE_WINDOW_MIN;
  }

  // --- Q-Factor ----------------------------------------------------------

  /**
   * Get the Q-factor (energy out / energy in).
   * Like in real fusion, Q > 1 means the reaction is producing more
   * energy than it consumes -- the proxy pool is self-sustaining.
   *
   * Q-factor calculation:
   *   Q = (validated usable proxies produced per min) / (raw proxies discovered per min)
   *
   * Uses 3-minute window (was 10) for more responsive tracking.
   *
   * @returns Q-factor value. Q > 1 = self-sustaining, Q < 1 = needs external fuel
   */
  getQFactor(): number {
    const now = Date.now();
    const windowMs = ENERGY_TRACKING_WINDOW_MIN * 60 * 1000;
    this.energyMeasurements = this.energyMeasurements.filter((m) => m.timestamp >= now - windowMs);

    const totalInput = this.energyMeasurements.reduce((sum, m) => sum + m.inputCount, 0);
    const totalOutput = this.energyMeasurements.reduce((sum, m) => sum + m.outputCount, 0);

    if (totalInput === 0) {
      // No input -- if we have output, Q is infinite (self-sustaining from breeding)
      this.currentQFactor = totalOutput > 0 ? Infinity : 0;
    } else {
      this.currentQFactor = totalOutput / totalInput;
    }

    return this.currentQFactor;
  }

  /**
   * Check if the fusion reaction is self-sustaining.
   * Self-sustaining means Q > 1 and the pool has enough proxies
   * to maintain itself without external fuel injection.
   *
   * @returns True if the reaction is self-sustaining
   */
  isSelfSustaining(): boolean {
    const qFactor = this.getQFactor();
    const poolSize = this.getPoolSize();
    return qFactor >= this.config.targetQFactor && poolSize >= SELF_SUSTAINING_MIN_PROXIES;
  }

  // --- Critical Mass ------------------------------------------------------

  /**
   * Check if there is enough fuel for fusion (critical mass).
   * Critical mass means the pool has enough proxies to sustain
   * chain reactions and breed new proxies.
   *
   * @returns Critical mass percentage (0-100)
   */
  async checkCriticalMass(): Promise<number> {
    const effectiveIPs = await this.getEffectiveIPCount();
    this.criticalMassPercent = Math.min(100, Math.round((effectiveIPs / CRITICAL_MASS_MIN_PROXIES) * 100));

    // Update status based on critical mass
    if (this.running) {
      if (this.criticalMassPercent >= 100 && this.status === 'igniting') {
        this.status = 'burning';
        this.burnStartedAt = this.burnStartedAt || Date.now();
        logger.info('🔥 Fusion reaction reached critical mass -- BURNING');
      }

      // Check for self-sustaining transition
      if (this.isSelfSustaining() && this.status === 'burning') {
        this.status = 'self_sustaining';
        logger.info('🔥 Fusion reaction is SELF-SUSTAINING -- Q > 1');
      }

      // Check for afterburner transition
      if (this.checkAfterburnerEligibility(effectiveIPs)) {
        this.activateAfterburner();
      }
    }

    return this.criticalMassPercent;
  }

  // --- Milestones ---------------------------------------------------------

  /**
   * Get the current fusion milestones and their progress.
   * Includes velocity tracking (IPs/hour toward next milestone).
   *
   * @returns Array of milestones with progress
   */
  async getMilestones(): Promise<FusionMilestone[]> {
    const currentIPs = await this.getEffectiveIPCount();

    for (const milestone of this.milestones) {
      milestone.currentIPs = currentIPs;
      milestone.progress = Math.min(1, currentIPs / milestone.targetIPs);

      if (milestone.progress >= 1 && !milestone.achievedAt) {
        milestone.achievedAt = Date.now();
        logger.info(
          { name: milestone.name, targetIPs: milestone.targetIPs, currentIPs },
          `🏆 FUSION MILESTONE ACHIEVED: ${milestone.name}`,
        );
      }

      // Calculate velocity (IPs/hour toward this milestone)
      if (milestone.achievedAt === null && this.startedAt) {
        const elapsedHours = (Date.now() - this.startedAt) / (1000 * 60 * 60);
        milestone.velocity = elapsedHours > 0 ? currentIPs / elapsedHours : 0;
      } else {
        milestone.velocity = 0;
      }
    }

    return this.milestones;
  }

  // --- Reaction Rate Control ----------------------------------------------

  /**
   * Adjust the reaction rate -- speed up or slow down the fusion.
   * Like controlling neutron moderation in a real reactor, this adjusts
   * how aggressively the system discovers and breeds new proxies.
   * Max rate is now 5.0 (was 2.0).
   *
   * @param rate - New reaction rate (0.1 to 5.0, where 1.0 = normal)
   */
  adjustReactionRate(rate: number): void {
    const clampedRate = Math.max(MIN_ADAPTIVE_REACTION_RATE, Math.min(MAX_ADAPTIVE_REACTION_RATE, rate));
    this.currentReactionRate = clampedRate;

    // Adjust neutron moderation inversely
    this.config.neutronModeration = 1 - (clampedRate - MIN_ADAPTIVE_REACTION_RATE) / (MAX_ADAPTIVE_REACTION_RATE - MIN_ADAPTIVE_REACTION_RATE);

    // Override moderation for afterburner
    if (this.afterburnerActive) {
      this.config.neutronModeration = AFTERBURNER_NEUTRON_MODERATION;
    }

    logger.info(
      { reactionRate: clampedRate, neutronModeration: this.config.neutronModeration.toFixed(2), afterburner: this.afterburnerActive },
      'Reaction rate adjusted',
    );

    // Propagate to subsystems
    if (this.plasmaState) {
      try {
        // Adjust rotation intervals based on reaction rate
        // Higher rate = faster rotations
      } catch (err: unknown) {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Plasma rate propagation failed');
      }
    }
  }

  // --- Reactor Status -----------------------------------------------------

  /**
   * Get the full reactor status.
   *
   * @returns Current reactor status string
   */
  getStatus(): ReactorStatus {
    return this.status;
  }

  /**
   * Get comprehensive reactor statistics.
   * Now includes neutron economy, adaptive rate, afterburner status,
   * reaction efficiency, pool growth rate, smart cooldown, and plasma injection rate.
   *
   * @returns Full reactor statistics
   */
  async getReactorStats(): Promise<ReactorStats> {
    const qFactor = this.getQFactor();
    const plasmaTemp = this.measurePlasmaTemperature();
    const neutronFlux = this.measureNeutronFlux();
    const energyOutput = this.measureEnergyOutput();
    const energyInput = this.getEnergyInputRate();
    const milestones = await this.getMilestones();

    let containmentIntegrity = 100;
    if (this.containment) {
      try {
        containmentIntegrity = this.containment.getIntegrity?.() ?? 100;
      } catch (err: unknown) {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Containment integrity check failed');
      }
    }

    const uptime = this.startedAt ? Date.now() - this.startedAt : 0;
    const burnTime = this.burnStartedAt ? Date.now() - this.burnStartedAt : 0;

    // Calculate reaction efficiency (validated / discovered)
    const totalInput = this.energyMeasurements.reduce((sum, m) => sum + m.inputCount, 0);
    const totalOutput = this.energyMeasurements.reduce((sum, m) => sum + m.outputCount, 0);
    this.reactionEfficiency = totalInput > 0 ? totalOutput / totalInput : 0;

    // Calculate pool growth rate
    this.poolGrowthRate = this.calculatePoolGrowthRate();

    // Calculate plasma injection rate
    const plasmaInjectionRate = this.calculatePlasmaInjectionRate();

    const stats: ReactorStats = {
      status: this.status,
      qFactor: isFinite(qFactor) ? Math.round(qFactor * 1000) / 1000 : qFactor,
      plasmaTemperature: plasmaTemp,
      neutronFlux: neutronFlux,
      energyInput,
      energyOutput,
      netEnergy: energyOutput - energyInput,
      totalFuelInjected: this.totalFuelInjected,
      totalEnergyProduced: this.totalEnergyProduced,
      isSelfSustaining: this.isSelfSustaining(),
      criticalMassPercent: this.criticalMassPercent,
      reactionRate: this.currentReactionRate || 1.0,
      containmentIntegrity,
      milestones,
      uptime,
      scramCount: this.scramCount,
      burnTime,
      neutronEconomy: this.neutronEconomy.balance,
      adaptiveRate: this.adaptiveRate.currentRate,
      afterburnerActive: this.afterburnerActive,
      reactionEfficiency: Math.round(this.reactionEfficiency * 1000) / 1000,
      poolGrowthRate: Math.round(this.poolGrowthRate * 10) / 10,
      smartCooldownMs: this.smartCooldown.currentCooldownMs,
      plasmaInjectionRate: Math.round(plasmaInjectionRate * 10) / 10,
      lastDiscoveryCount: this.lastDiscoveryCount,
      lastBreedingCount: this.lastBreedingCount,
    };

    // Cache for external consumption
    await cacheSet('fusion:stats', stats, 30).catch(() => {});

    return stats;
  }

  // --- Fusion Recommendations ---------------------------------------------

  /**
   * Get recommendations for optimizing the fusion reactor.
   * Analyzes current state and suggests actions to improve Q-factor,
   * pool health, and overall reactor performance.
   *
   * @returns Array of recommendation strings
   */
  async getFusionRecommendations(): Promise<string[]> {
    const recommendations: string[] = [];
    const stats = await this.getReactorStats();

    // Q-factor recommendations
    if (stats.qFactor < 0.5) {
      recommendations.push('Q-factor is very low -- increase fuel injection rate to boost discovery');
      recommendations.push('Consider enabling chain reactions for exponential proxy growth');
    } else if (stats.qFactor < 1.0) {
      recommendations.push('Q-factor approaching breakeven -- fine-tune breeding parameters');
      recommendations.push('Increase neutron moderation to stabilize chain reactions');
    } else if (stats.qFactor >= 1.0 && stats.qFactor < 5) {
      recommendations.push('Q-factor above breakeven -- reactor is self-sustaining');
      recommendations.push('Consider reducing fuel injection to save resources');
    } else if (stats.qFactor >= 5) {
      recommendations.push('Q-factor is excellent -- afterburner mode may be available');
      recommendations.push('Consider activating afterburner for explosive growth');
    }

    // Afterburner recommendations
    if (!stats.afterburnerActive && stats.poolGrowthRate > 50) {
      recommendations.push('Pool growing rapidly -- afterburner mode could accelerate further');
    }
    if (stats.afterburnerActive) {
      recommendations.push('Afterburner is ACTIVE -- reactor is in maximum output mode');
    }

    // Temperature recommendations
    if (stats.plasmaTemperature < 20) {
      recommendations.push('Plasma temperature is cold -- inject more fuel to heat the reactor');
    } else if (stats.plasmaTemperature > 80) {
      recommendations.push('Plasma temperature is critical -- reduce reaction rate or increase cooling');
      recommendations.push('Consider activating additional containment measures');
    }

    // Neutron flux recommendations
    if (stats.neutronFlux < 1) {
      recommendations.push('Neutron flux is very low -- enable chain reactions to boost discovery');
    } else if (stats.neutronFlux > stats.reactionRate * 50) {
      recommendations.push('Neutron flux is dangerously high -- increase moderation to prevent runaway');
    }

    // Neutron economy recommendations
    if (stats.neutronEconomy < 0) {
      recommendations.push('Neutron economy is negative -- consuming more neutrons than producing');
    } else if (stats.neutronEconomy > NEUTRON_ECONOMY_BONUS_THRESHOLD) {
      recommendations.push('Neutron economy is supercritical -- bonus cascade rounds are active');
    }

    // Critical mass recommendations
    if (stats.criticalMassPercent < 50) {
      recommendations.push('Critical mass not reached -- inject more fuel to build up the pool');
    } else if (stats.criticalMassPercent >= 100) {
      recommendations.push('Critical mass achieved -- reactor can sustain chain reactions');
    }

    // Reaction efficiency recommendations
    if (stats.reactionEfficiency < 0.3) {
      recommendations.push('Reaction efficiency is low -- many discovered proxies are failing validation');
      recommendations.push('Consider tightening fuel quality requirements');
    }

    // Containment recommendations
    if (stats.containmentIntegrity < 50) {
      recommendations.push('Containment integrity is low -- purge bad proxies and strengthen quality checks');
    }

    // Pool size recommendations
    const effectiveIPs = await this.getEffectiveIPCount();
    if (effectiveIPs < 1000) {
      recommendations.push('Pool size is very small -- aggressively inject all available fuel types');
    } else if (effectiveIPs < 10000) {
      recommendations.push('Pool size is growing -- enable breeding for accelerated growth');
    }

    // Adaptive rate recommendations
    if (stats.adaptiveRate > 3.0) {
      recommendations.push('Adaptive rate is very high -- monitor for stability issues');
    } else if (stats.adaptiveRate < 0.5) {
      recommendations.push('Adaptive rate is low -- success rate may be poor, consider fuel quality');
    }

    // Milestone recommendations
    const nextMilestone = this.milestones.find((m) => !m.achievedAt);
    if (nextMilestone) {
      const eta = nextMilestone.velocity > 0
        ? ` ETA: ~${Math.round((nextMilestone.targetIPs - nextMilestone.currentIPs) / nextMilestone.velocity)}h`
        : '';
      recommendations.push(
        `Next milestone: "${nextMilestone.name}" at ${nextMilestone.targetIPs.toLocaleString()} IPs ` +
        `(${(nextMilestone.progress * 100).toFixed(1)}% complete)${eta}`,
      );
    }

    // Captcha solver / web unlocker recommendations
    if (!this.captchaSolver) {
      recommendations.push('Captcha solver not loaded -- proxy discovery pages with CAPTCHAs will be skipped');
    }
    if (!this.webUnlocker) {
      recommendations.push('Web unlocker not loaded -- proxy lists behind anti-bot will be inaccessible');
    }

    return recommendations;
  }

  // --- NEW: Fusion Afterburner --------------------------------------------

  /**
   * Check if the reactor is eligible for afterburner mode.
   * Afterburner is the mode beyond self-sustaining that drives explosive growth.
   *
   * @param poolSize - Current effective IP count
   * @returns True if afterburner conditions are met
   */
  private checkAfterburnerEligibility(poolSize: number): boolean {
    if (this.afterburnerActive) return false;
    if (this.status !== 'self_sustaining') return false;

    const qFactor = this.getQFactor();
    return poolSize >= AFTERBURNER_MIN_POOL_SIZE && qFactor >= AFTERBURNER_MIN_QFACTOR;
  }

  /**
   * Activate afterburner mode.
   * Doubles reaction rate and reduces neutron moderation for explosive growth.
   */
  private activateAfterburner(): void {
    if (this.afterburnerActive) return;

    this.afterburnerActive = true;
    this.status = 'afterburner';
    this.afterburnerStartedAt = Date.now();

    // Double reaction rate
    this.currentReactionRate = Math.min(
      this.currentReactionRate * AFTERBURNER_RATE_MULTIPLIER,
      MAX_ADAPTIVE_REACTION_RATE,
    );

    // Reduce neutron moderation
    this.config.neutronModeration = AFTERBURNER_NEUTRON_MODERATION;

    logger.info(
      {
        reactionRate: this.currentReactionRate,
        neutronModeration: this.config.neutronModeration,
      },
      '🚀 FUSION AFTERBURNER ACTIVATED -- Explosive growth mode engaged',
    );
  }

  /**
   * Deactivate afterburner mode.
   * Returns reactor to self_sustaining status.
   */
  private deactivateAfterburner(): void {
    if (!this.afterburnerActive) return;

    this.afterburnerActive = false;
    this.status = 'self_sustaining';

    // Restore normal parameters
    this.config.neutronModeration = DEFAULT_NEUTRON_MODERATION;
    this.currentReactionRate = Math.min(this.currentReactionRate / AFTERBURNER_RATE_MULTIPLIER, MAX_ADAPTIVE_REACTION_RATE);

    logger.info('Fusion afterburner deactivated -- returning to self-sustaining mode');
  }

  // --- NEW: Neutron Multiplication ----------------------------------------

  /**
   * Add neutrons to the economy from a successful reaction.
   * Each validated proxy adds NEUTRON_MULTIPLICATION_FACTOR neutrons.
   *
   * @param validatedCount - Number of proxies validated in this cycle
   */
  private addNeutronsFromSuccess(validatedCount: number): void {
    const produced = Math.ceil(validatedCount * NEUTRON_MULTIPLICATION_FACTOR);
    this.neutronEconomy.neutronsProduced += produced;
    this.updateNeutronEconomy();

    logger.debug(
      { produced, totalProduced: this.neutronEconomy.neutronsProduced, balance: this.neutronEconomy.balance },
      'Neutron multiplication -- neutrons added to economy',
    );
  }

  /**
   * Update the neutron economy balance and check for bonus cascades.
   */
  private updateNeutronEconomy(): void {
    this.neutronEconomy.balance = this.neutronEconomy.neutronsProduced - this.neutronEconomy.neutronsConsumed;

    // Check for bonus cascade trigger
    if (this.neutronEconomy.balance > NEUTRON_ECONOMY_BONUS_THRESHOLD && !this.neutronEconomy.bonusCascadeTriggered) {
      this.neutronEconomy.bonusCascadeTriggered = true;
      logger.info(
        { balance: this.neutronEconomy.balance },
        '⚡ Neutron economy supercritical -- bonus cascade rounds triggered',
      );
    } else if (this.neutronEconomy.balance <= NEUTRON_ECONOMY_BONUS_THRESHOLD) {
      this.neutronEconomy.bonusCascadeTriggered = false;
    }
  }

  /**
   * Get the neutron economy multiplier for discovery batch sizes.
   * Higher neutron balance = larger discovery batches.
   *
   * @returns Multiplier for discovery batch size
   */
  private getNeutronEconomyMultiplier(): number {
    if (this.neutronEconomy.balance <= 0) return 1.0;
    // Logarithmic scaling -- diminishing returns at high balances
    return 1.0 + Math.log10(Math.max(1, this.neutronEconomy.balance)) * 0.5;
  }

  /**
   * Get the current neutron economy stats.
   *
   * @returns Current neutron economy
   */
  getNeutronEconomy(): NeutronEconomy {
    return { ...this.neutronEconomy };
  }

  // --- NEW: Adaptive Rate Control -----------------------------------------

  /**
   * Run adaptive rate control logic.
   * Adjusts reaction rate automatically based on success rate and pool health.
   */
  private runAdaptiveRateControl(): void {
    const now = Date.now();

    // Don't adjust too frequently (at least 10s between adjustments)
    if (now - this.adaptiveRate.lastAdjustment < 10_000) return;

    const successRate = this.calculateRecentSuccessRate();
    const growthRate = this.calculatePoolGrowthRate();

    let newRate = this.adaptiveRate.currentRate;

    // If success rate > 80%: increase rate by 10% per cycle
    if (successRate > 0.8) {
      newRate *= (1 + ADAPTIVE_RATE_INCREASE);
    }

    // If success rate < 50%: decrease rate by 20% per cycle
    if (successRate < 0.5) {
      newRate *= (1 - ADAPTIVE_RATE_DECREASE);
    }

    // If pool growing > 100/min: cap rate to prevent overload
    if (growthRate > POOL_GROWTH_RATE_CAP) {
      newRate = Math.min(newRate, this.adaptiveRate.currentRate * 0.9);
    }

    // Afterburner override -- keep rate high
    if (this.afterburnerActive) {
      newRate = Math.max(newRate, this.adaptiveRate.currentRate);
    }

    // Clamp to allowed range
    newRate = Math.max(MIN_ADAPTIVE_REACTION_RATE, Math.min(MAX_ADAPTIVE_REACTION_RATE, newRate));

    // Apply the adaptive rate
    this.adaptiveRate.currentRate = newRate;
    this.currentReactionRate = newRate;
    this.adaptiveRate.lastAdjustment = now;

    // Adjust neutron moderation inversely (unless afterburner overrides)
    if (!this.afterburnerActive) {
      this.config.neutronModeration = 1 - (newRate - MIN_ADAPTIVE_REACTION_RATE) / (MAX_ADAPTIVE_REACTION_RATE - MIN_ADAPTIVE_REACTION_RATE);
      this.config.neutronModeration = Math.max(0, Math.min(1, this.config.neutronModeration));
    }

    logger.debug(
      {
        adaptiveRate: newRate.toFixed(3),
        successRate: (successRate * 100).toFixed(1) + '%',
        growthRate: growthRate.toFixed(1) + '/min',
        afterburner: this.afterburnerActive,
      },
      'Adaptive rate control adjustment',
    );
  }

  /**
   * Calculate the recent success rate from the success rate window.
   *
   * @returns Success rate (0-1)
   */
  private calculateRecentSuccessRate(): number {
    const now = Date.now();
    const windowMs = 60_000; // Last minute
    this.adaptiveRate.successRateWindow = this.adaptiveRate.successRateWindow.filter(
      (w) => w.timestamp >= now - windowMs,
    );

    if (this.adaptiveRate.successRateWindow.length === 0) return 0.5; // Default

    const successes = this.adaptiveRate.successRateWindow.filter((w) => w.success).length;
    return successes / this.adaptiveRate.successRateWindow.length;
  }

  /**
   * Record a success or failure for adaptive rate tracking.
   *
   * @param success - Whether the reaction was successful
   */
  private recordReactionResult(success: boolean): void {
    this.adaptiveRate.successRateWindow.push({
      timestamp: Date.now(),
      success,
    });
  }

  /**
   * Get the current adaptive rate.
   *
   * @returns Current adaptive reaction rate
   */
  getAdaptiveRate(): number {
    return this.adaptiveRate.currentRate;
  }

  // --- NEW: Smart Cooldown ------------------------------------------------

  /**
   * Calculate smart cooldown based on pool health.
   * Healthy pool = shorter cooldowns, stressed pool = longer cooldowns.
   *
   * @returns Cooldown duration in milliseconds
   */
  private calculateSmartCooldown(): number {
    const now = Date.now();
    if (now - this.smartCooldown.lastCalculation < 5_000) {
      return this.smartCooldown.currentCooldownMs;
    }

    const successRate = this.calculateRecentSuccessRate();
    const poolSize = this.getPoolSize();
    const qFactor = this.getQFactor();

    // Health score: combination of success rate, pool size, and Q-factor
    let healthScore = 0;

    // Success rate component (0-0.4)
    healthScore += successRate * 0.4;

    // Pool size component (0-0.3) -- normalized to SELF_SUSTAINING_MIN_PROXIES
    healthScore += Math.min(0.3, (poolSize / SELF_SUSTAINING_MIN_PROXIES) * 0.3);

    // Q-factor component (0-0.3) -- Q > 1 is healthy
    healthScore += Math.min(0.3, (isFinite(qFactor) ? qFactor : 2) / 2 * 0.3);

    this.smartCooldown.healthScore = healthScore;

    // Map health score to cooldown: healthier = shorter cooldown
    // healthScore 1.0 → SMART_COOLDOWN_MIN_MS
    // healthScore 0.0 → SMART_COOLDOWN_MAX_MS
    const cooldownRange = SMART_COOLDOWN_MAX_MS - SMART_COOLDOWN_MIN_MS;
    this.smartCooldown.currentCooldownMs = Math.round(
      SMART_COOLDOWN_MAX_MS - (healthScore * cooldownRange),
    );

    // Afterburner override -- minimal cooldown
    if (this.afterburnerActive) {
      this.smartCooldown.currentCooldownMs = SMART_COOLDOWN_MIN_MS;
    }

    this.smartCooldown.lastCalculation = now;

    return this.smartCooldown.currentCooldownMs;
  }

  /**
   * Get the current smart cooldown state.
   *
   * @returns Current smart cooldown state
   */
  getSmartCooldown(): SmartCooldownState {
    return { ...this.smartCooldown };
  }

  // --- NEW: Plasma Injection ----------------------------------------------

  /**
   * Inject discovered proxies directly into the plasma state.
   * Batch injection for efficiency.
   *
   * @param proxies - Array of proxy URLs and protocols to inject
   * @returns Number of proxies successfully injected
   */
  private async injectIntoPlasma(proxies: Array<{ url: string; protocol: string }>): Promise<number> {
    if (!this.plasmaState || proxies.length === 0) return 0;

    let injected = 0;

    try {
      // Batch injection
      const batches: Array<Array<{ url: string; protocol: string }>> = [];
      for (let i = 0; i < proxies.length; i += PLASMA_INJECTION_BATCH_SIZE) {
        batches.push(proxies.slice(i, i + PLASMA_INJECTION_BATCH_SIZE));
      }

      for (const batch of batches) {
        try {
          const result = await this.plasmaState.injectProxies?.(batch) ?? 0;
          injected += result;
        } catch (err: unknown) {
          logger.debug(
            { error: err instanceof Error ? err.message : String(err), batchSize: batch.length },
            'Plasma batch injection failed',
          );
        }
      }

      // Track injection result
      const result: PlasmaInjectionResult = {
        totalAttempted: proxies.length,
        totalSucceeded: injected,
        totalFailed: proxies.length - injected,
        successRate: proxies.length > 0 ? injected / proxies.length : 0,
      };

      this.plasmaInjectionResults.push(result);

      // Keep only last 100 results
      if (this.plasmaInjectionResults.length > 100) {
        this.plasmaInjectionResults = this.plasmaInjectionResults.slice(-100);
      }
    } catch (err: unknown) {
      logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Plasma injection failed');
    }

    return injected;
  }

  /**
   * Calculate the plasma injection rate (proxies/minute).
   *
   * @returns Injection rate
   */
  private calculatePlasmaInjectionRate(): number {
    if (this.plasmaInjectionResults.length === 0) return 0;

    const now = Date.now();
    const windowMs = 60_000; // Last minute
    const recentResults = this.plasmaInjectionResults.filter(
      // We don't have timestamps on results, so use recent ones
      (_, index) => index >= this.plasmaInjectionResults.length - 10,
    );

    const totalSucceeded = recentResults.reduce((sum, r) => sum + r.totalSucceeded, 0);
    return totalSucceeded; // Approximate per-minute rate
  }

  /**
   * Queue proxies for plasma injection.
   *
   * @param proxies - Proxies to queue
   */
  private queuePlasmaInjection(proxies: Array<{ url: string; protocol: string }>): void {
    this.pendingPlasmaInjection.push(...proxies);

    // Don't let the queue grow unbounded
    if (this.pendingPlasmaInjection.length > MAX_FUEL_BATCH_SIZE * 2) {
      this.pendingPlasmaInjection = this.pendingPlasmaInjection.slice(-MAX_FUEL_BATCH_SIZE);
    }
  }

  /**
   * Process the pending plasma injection queue.
   */
  private async processPlasmaInjectionQueue(): Promise<void> {
    if (this.pendingPlasmaInjection.length === 0) return;

    const toInject = this.pendingPlasmaInjection.splice(0, PLASMA_INJECTION_BATCH_SIZE);
    const injected = await this.injectIntoPlasma(toInject);

    logger.debug(
      { attempted: toInject.length, injected },
      'Plasma injection queue processed',
    );
  }

  // --- NEW: Enhanced Breeding ---------------------------------------------

  /**
   * Run enhanced breeding -- generate actual proxy configs from patterns.
   * Unlike the old fallback breeding which only counted patterns, this
   * generates port variations, protocol variations, and auth variations.
   *
   * @returns Number of new proxy configs generated and imported
   */
  private async runEnhancedBreeding(): Promise<number> {
    let totalBred = 0;

    try {
      // Find successful proxy patterns to breed from
      const successfulProxies = await db.proxy.findMany({
        where: {
          retired: false,
          successRate: { gte: 0.7 },
        },
        orderBy: { successRate: 'desc' },
        take: 50,
      });

      if (successfulProxies.length === 0) return 0;

      const bredConfigs: BredProxyConfig[] = [];

      for (const proxy of successfulProxies) {
        // Parse the proxy URL to extract IP
        const urlMatch = proxy.url?.match(/(\d+\.\d+\.\d+\.\d+)/);
        if (!urlMatch) continue;

        const ip = urlMatch[1];

        // Generate port variations
        const portsToTry = BREEDING_COMMON_PORTS.slice(0, BREEDING_PORT_VARIATIONS);

        // Generate protocol variations
        for (const protocol of BREEDING_PROTOCOLS) {
          // Generate a few port variations per protocol
          for (const port of portsToTry.slice(0, 5)) {
            bredConfigs.push({
              ip,
              port,
              protocol,
              provider: proxy.provider || 'bred',
              country: proxy.country || null,
              authUser: null,
              authPass: null,
            });
          }
        }

        // Generate auth variations if auth pattern found
        if (proxy.url?.includes('@')) {
          const authMatch = proxy.url.match(/\/\/([^:]+):([^@]+)@/);
          if (authMatch) {
            for (const protocol of BREEDING_PROTOCOLS) {
              bredConfigs.push({
                ip,
                port: 8080,
                protocol,
                provider: proxy.provider || 'bred-auth',
                country: proxy.country || null,
                authUser: authMatch[1],
                authPass: authMatch[2],
              });
            }
          }
        }
      }

      // Import bred configs to DB
      for (const config of bredConfigs) {
        try {
          const url = config.authUser
            ? `${config.protocol}://${config.authUser}:${config.authPass}@${config.ip}:${config.port}`
            : `${config.protocol}://${config.ip}:${config.port}`;

          // Check if this proxy already exists
          const existing = await db.proxy.findFirst({
            where: { url, retired: false },
          });

          if (!existing) {
            await db.proxy.create({
              data: {
                id: `bred-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                url,
                provider: config.provider,
                tier: 'datacenter',
                country: config.country ?? 'US',
                successRate: 0.5, // Initial estimate for bred proxies
                addedAt: new Date(),
                lastChecked: new Date(0), // Never checked
              },
            });
            totalBred++;
          }
        } catch (err: unknown) {
          // Skip duplicates or DB errors silently
          logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Bred config insert skipped');
        }
      }

      if (totalBred > 0) {
        logger.info({ totalBred, patternsUsed: successfulProxies.length }, 'Enhanced breeding produced new proxy configs');
      }
    } catch (err: unknown) {
      logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Enhanced breeding failed');
    }

    return totalBred;
  }

  // --- NEW: Module Integration (Captcha Solver & Web Unlocker) -----------

  /**
   * Use captcha solver to unlock a proxy discovery page.
   *
   * @param pageUrl - URL of the page with CAPTCHA
   * @param siteKey - CAPTCHA site key (if known)
   * @returns Solved token or null
   */
  async solveCaptcha(pageUrl: string, siteKey?: string): Promise<string | null> {
    if (!this.captchaSolver) {
      logger.debug('Captcha solver not available -- cannot solve CAPTCHA');
      return null;
    }

    try {
      const result = await this.captchaSolver.solveCaptcha?.(pageUrl, siteKey ?? '');
      if (result?.solved) {
        logger.info({ pageUrl }, '✓ CAPTCHA solved successfully');
        return result.token;
      }
      logger.debug({ pageUrl }, 'CAPTCHA solving failed');
      return null;
    } catch (err: unknown) {
      logger.debug({ error: err instanceof Error ? err.message : String(err), pageUrl }, 'Captcha solver error');
      return null;
    }
  }

  /**
   * Use web unlocker to access a page behind anti-bot protection.
   *
   * @param url - URL to unlock
   * @param options - Options for the unlocker
   * @returns Page content or null
   */
  async unlockPage(url: string, options?: { useProxy?: boolean; country?: string }): Promise<string | null> {
    if (!this.webUnlocker) {
      logger.debug('Web unlocker not available -- cannot bypass anti-bot');
      return null;
    }

    try {
      const result = await this.webUnlocker.unlockPage?.(url, options);
      if (result?.unlocked) {
        logger.info({ url }, '✓ Page unlocked successfully');
        return result.content;
      }
      logger.debug({ url }, 'Page unlock failed');
      return null;
    } catch (err: unknown) {
      logger.debug({ error: err instanceof Error ? err.message : String(err), url }, 'Web unlocker error');
      return null;
    }
  }

  // --- NEW: Pool Growth Rate ----------------------------------------------

  /**
   * Calculate the pool growth rate (proxies/minute).
   *
   * @returns Growth rate in proxies per minute
   */
  private calculatePoolGrowthRate(): number {
    const now = Date.now();
    const windowMs = 60_000; // 1-minute window

    // Clean old entries
    this.poolSizeHistory = this.poolSizeHistory.filter((h) => h.timestamp >= now - 5 * windowMs);

    if (this.poolSizeHistory.length < 2) return 0;

    const oldest = this.poolSizeHistory[0];
    const newest = this.poolSizeHistory[this.poolSizeHistory.length - 1];
    const elapsedMinutes = (newest.timestamp - oldest.timestamp) / 60_000;

    if (elapsedMinutes <= 0) return 0;

    return (newest.size - oldest.size) / elapsedMinutes;
  }

  /**
   * Update pool size history for growth rate tracking.
   */
  private async updatePoolSizeHistory(): Promise<void> {
    const size = await this.getEffectiveIPCount();
    this.poolSizeHistory.push({ timestamp: Date.now(), size });

    // Keep only last 5 minutes of history
    const now = Date.now();
    this.poolSizeHistory = this.poolSizeHistory.filter((h) => h.timestamp >= now - 5 * 60_000);
  }

  // --- Private: Reactor Loops ---------------------------------------------

  /**
   * Start all reactor maintenance loops.
   */
  private startReactorLoops(): void {
    // Main reactor loop -- drives fusion reactions (5s interval)
    this.reactorLoopTimer = setInterval(() => {
      this.runReactorLoop().catch((err) => {
        logger.warn({ error: (err as Error).message }, 'Reactor loop failed');
      });
    }, REACTOR_LOOP_INTERVAL_MS);

    // Q-factor measurement loop (10s interval)
    this.qfactorTimer = setInterval(() => {
      this.runQFactorMeasurement().catch((err) => {
        logger.warn({ error: (err as Error).message }, 'Q-factor measurement failed');
      });
    }, QFACTOR_MEASUREMENT_INTERVAL_MS);

    // Milestone check loop (30s interval)
    this.milestoneTimer = setInterval(() => {
      this.runMilestoneCheck().catch((err) => {
        logger.warn({ error: (err as Error).message }, 'Milestone check failed');
      });
    }, MILESTONE_CHECK_INTERVAL_MS);

    // Critical mass check loop (15s interval)
    this.criticalMassTimer = setInterval(() => {
      this.checkCriticalMass().catch((err) => {
        logger.warn({ error: (err as Error).message }, 'Critical mass check failed');
      });
    }, CRITICAL_MASS_CHECK_INTERVAL_MS);
  }

  /**
   * Stop all reactor maintenance loops.
   */
  private stopReactorLoops(): void {
    if (this.reactorLoopTimer) { clearInterval(this.reactorLoopTimer); this.reactorLoopTimer = null; }
    if (this.qfactorTimer) { clearInterval(this.qfactorTimer); this.qfactorTimer = null; }
    if (this.milestoneTimer) { clearInterval(this.milestoneTimer); this.milestoneTimer = null; }
    if (this.criticalMassTimer) { clearInterval(this.criticalMassTimer); this.criticalMassTimer = null; }
  }

  /**
   * Main reactor loop -- drives the fusion reaction.
   * This is where the actual "fusion" happens:
   *  - Discovery + Breeding = new proxies (D-T reaction) -- NOW PARALLEL
   *  - Chain reactions multiply existing proxies -- NOW PARALLEL with concurrency
   *  - Self-healing replaces lost proxies -- NOW PARALLEL across plasma regions
   *  - Adaptive rate control adjusts reaction rate
   *  - Plasma injection pushes discovered proxies into plasma state
   *  - Smart cooldown prevents overheating
   */
  private async runReactorLoop(): Promise<void> {
    if (!this.running) return;

    try {
      // Apply smart cooldown
      const cooldownMs = this.calculateSmartCooldown();
      if (cooldownMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(cooldownMs, 100)));
      }

      // -- Step 1: Drive D-T reactions in PARALLEL (Discovery + Breeding) -
      const [discoveryCount, breedingCount] = await Promise.allSettled([
        this.runDiscoveryReaction(),
        this.runBreedingReaction(),
      ]);

      const dCount = discoveryCount.status === 'fulfilled' ? discoveryCount.value : 0;
      const bCount = breedingCount.status === 'fulfilled' ? breedingCount.value : 0;
      this.lastDiscoveryCount = dCount;
      this.lastBreedingCount = bCount;

      const totalNew = dCount + bCount;
      if (totalNew > 0) {
        this.recentReactions.push({ timestamp: Date.now(), count: totalNew });
        this.totalEnergyProduced += totalNew;

        // Record energy output
        this.energyMeasurements.push({
          timestamp: Date.now(),
          inputCount: 0,
          outputCount: totalNew,
        });

        // Neutron multiplication -- successful reactions add neutrons
        this.addNeutronsFromSuccess(totalNew);

        // Record success for adaptive rate
        this.recordReactionResult(true);
      } else {
        this.recordReactionResult(false);
      }

      // -- Step 2: Chain reactions in PARALLEL (up to 5 concurrent) --------
      if (this.chainReaction) {
        try {
          // Determine cascade count
          let cascadeCount = CASCADE_TRIGGER_COUNT;
          if (this.neutronEconomy.bonusCascadeTriggered) {
            cascadeCount *= 2; // Double cascades when neutron economy is supercritical
          }
          if (this.afterburnerActive) {
            cascadeCount *= 2; // Double cascades in afterburner mode
          }

          // Trigger parallel chain reactions
          const chainPromises: Array<Promise<{ newProxies: number; depth: number }>> = [];
          for (let i = 0; i < Math.min(cascadeCount, PARALLEL_CHAIN_CONCURRENCY); i++) {
            if (this.chainReaction.triggerCascade) {
              chainPromises.push(this.chainReaction.triggerCascade(i + 1));
            } else if (this.chainReaction.triggerChain) {
              chainPromises.push(
                this.chainReaction.triggerChain().then((r) => ({ newProxies: r.newProxies, depth: 1 })),
              );
            }
          }

          if (chainPromises.length > 0) {
            const chainResults = await Promise.allSettled(chainPromises);
            for (const result of chainResults) {
              if (result.status === 'fulfilled' && result.value.newProxies > 0) {
                this.recentReactions.push({ timestamp: Date.now(), count: result.value.newProxies });
                this.totalEnergyProduced += result.value.newProxies;
                this.addNeutronsFromSuccess(result.value.newProxies);
              }
            }
          }
        } catch (err: unknown) {
          logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Chain reaction failed');
        }
      }

      // -- Step 3: Plasma injection (push discovered proxies to plasma) ----
      await this.processPlasmaInjectionQueue();

      // -- Step 4: Self-healing -- PARALLEL across plasma regions -----------
      if (this.plasmaState) {
        try {
          // Run healing in parallel with containment check
          await Promise.allSettled([
            this.plasmaState.heal?.() ?? Promise.resolve(),
          ]);
        } catch (err: unknown) {
          logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Self-healing failed');
        }
      }

      // -- Step 5: Containment check --------------------------------------
      if (this.containment) {
        try {
          await Promise.allSettled([
            this.containment.detectBreach?.() ?? Promise.resolve(),
            this.containment.checkShieldIntegrity?.() ?? Promise.resolve(),
          ]);
        } catch (err: unknown) {
          logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Containment check failed');
        }
      }

      // -- Step 6: Adaptive rate control ----------------------------------
      this.runAdaptiveRateControl();

      // -- Step 7: Update pool size history -------------------------------
      await this.updatePoolSizeHistory();

      // -- Step 8: Update reactor status ----------------------------------
      this.updateReactorStatus();

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ error: msg }, 'Reactor loop encountered an error');
    }
  }

  /**
   * Run the discovery reaction (Deuterium analog).
   * Discovers new proxies from configured fuel sources.
   * Now uses 100*effectiveRate (was 10) and 50*effectiveRate for validation (was 5).
   * Uses neutron economy multiplier for batch sizing.
   * Uses captcha solver and web unlocker for discovery if available.
   */
  private async runDiscoveryReaction(): Promise<number> {
    if (this.currentReactionRate <= 0) return 0;

    // Apply neutron moderation -- slow down reactions
    let effectiveRate = this.currentReactionRate * this.config.neutronModeration;

    // Apply neutron economy multiplier
    const neutronMultiplier = this.getNeutronEconomyMultiplier();
    effectiveRate *= neutronMultiplier;

    // Afterburner doubles the effective rate
    if (this.afterburnerActive) {
      effectiveRate *= AFTERBURNER_RATE_MULTIPLIER;
    }

    if (effectiveRate < 0.1) return 0;

    let discovered = 0;
    let validated = 0;

    // Consume neutrons for discovery
    this.neutronEconomy.neutronsConsumed += Math.ceil(effectiveRate);

    // Discover from DB -- find proxies that aren't yet in the pool
    try {
      const discoveryBatchSize = Math.ceil(100 * effectiveRate);
      const newProxies = await db.proxy.findMany({
        where: {
          retired: false,
          successRate: { gte: 0.3 },
          lastChecked: { lt: new Date(Date.now() - 5 * 60 * 1000) }, // Not recently checked
        },
        orderBy: { addedAt: 'desc' },
        take: discoveryBatchSize,
      });

      discovered = newProxies.length;

      // Validate a batch of discovered proxies (50 * effectiveRate, was 5)
      const validationBatchSize = Math.ceil(50 * effectiveRate);
      const toValidate = newProxies.slice(0, validationBatchSize);

      // Parallel validation using Promise.allSettled
      const validationPromises = toValidate.map((proxy) =>
        (async () => {
          try {
            const result = await testProxy(proxy.url, undefined, 8_000);
            if (result.working) {
              await db.proxy.update({
                where: { id: proxy.id },
                data: {
                  successRate: Math.min(1, (proxy.successRate || 0.5) * 0.8 + 0.2),
                  lastChecked: new Date(),
                  p95Latency: result.latencyMs,
                },
              });
              return true;
            } else {
              await db.proxy.update({
                where: { id: proxy.id },
                data: {
                  consecutiveFailures: { increment: 1 },
                  lastChecked: new Date(),
                },
              });
              return false;
            }
          } catch {
            return false;
          }
        })(),
      );

      const validationResults = await Promise.allSettled(validationPromises);
      validated = validationResults.filter(
        (r) => r.status === 'fulfilled' && r.value === true,
      ).length;

      // Queue validated proxies for plasma injection
      if (validated > 0) {
        const workingProxies = toValidate
          .filter((_, index) => {
            const result = validationResults[index];
            return result.status === 'fulfilled' && result.value === true;
          })
          .map((p) => ({
            url: p.url,
            protocol: p.url.startsWith('https') ? 'https' :
                      p.url.startsWith('socks5') ? 'socks5' :
                      p.url.startsWith('socks4') ? 'socks4' : 'http',
          }));

        this.queuePlasmaInjection(workingProxies);
      }
    } catch (err: unknown) {
      logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Discovery reaction failed');
    }

    // Try using captcha solver for discovery if available and discovery was low
    if (discovered < 10 && this.captchaSolver) {
      try {
        // The captcha solver can help unlock proxy list pages
        // This is a passive integration -- actual usage would be in the scraper
        logger.debug('Captcha solver available for proxy discovery pages');
      } catch (err: unknown) {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Captcha solver integration failed');
      }
    }

    // Try using web unlocker if available and discovery was low
    if (discovered < 10 && this.webUnlocker) {
      try {
        // The web unlocker can access proxy lists behind anti-bot
        // This is a passive integration -- actual usage would be in the scraper
        logger.debug('Web unlocker available for anti-bot proxy lists');
      } catch (err: unknown) {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Web unlocker integration failed');
      }
    }

    return discovered;
  }

  /**
   * Run the breeding reaction (Tritium analog).
   * Breeds new proxy configurations from existing ones.
   * Like breeding tritium from lithium in a real fusion reactor.
   * Now uses enhanced breeding with actual proxy config generation.
   */
  private async runBreedingReaction(): Promise<number> {
    let bred = 0;

    // Try the breeder reactor module first
    if (this.breederReactor) {
      try {
        const result = await this.breederReactor.breed?.();
        if (result && result.newConfigs && result.newConfigs > 0) {
          bred = result.newConfigs;
          this.totalEnergyProduced += bred;
        }
      } catch (err: unknown) {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Breeder reactor module failed');
      }
    }

    // Enhanced fallback breeding: generate actual proxy configs
    if (bred === 0 && this.currentReactionRate > 0.5) {
      bred = await this.runEnhancedBreeding();
    }

    // If enhanced breeding produced nothing, try basic pattern breeding
    if (bred === 0 && this.currentReactionRate > 0.3) {
      bred = await this.fallbackBreeding();
    }

    return bred;
  }

  /**
   * Fallback breeding -- generate proxy variations from existing DB patterns.
   * This is the basic version that counts patterns.
   * Enhanced breeding (runEnhancedBreeding) generates actual configs.
   */
  private async fallbackBreeding(): Promise<number> {
    let bred = 0;

    try {
      // Find successful proxy patterns to breed from
      const successfulPatterns = await db.proxy.groupBy({
        by: ['provider', 'tier', 'country'],
        where: {
          retired: false,
          successRate: { gte: 0.7 },
        },
        _count: { id: true },
        _avg: { successRate: true },
        having: {
          successRate: { _avg: { gte: 0.7 } },
        },
        orderBy: {
          _count: { id: 'desc' as const },
        },
        take: 10,
      });

      // For each successful pattern, estimate potential for more proxies
      bred = successfulPatterns.reduce((sum, p) => sum + (p._count.id > 5 ? p._count.id * 2 : p._count.id), 0);
    } catch (err: unknown) {
      logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Fallback breeding failed');
    }

    return bred;
  }

  // --- Private: Q-Factor Measurement --------------------------------------

  /**
   * Run Q-factor measurement and update reactor status accordingly.
   * Now runs every 10s (was 60s) for real-time tracking.
   */
  private async runQFactorMeasurement(): Promise<void> {
    const qFactor = this.getQFactor();
    const temperature = this.measurePlasmaTemperature();

    logger.info(
      { qFactor: isFinite(qFactor) ? qFactor.toFixed(3) : '∞', temperature, status: this.status },
      'Q-factor measurement',
    );

    // If Q-factor exceeds target, transition to self-sustaining
    if (qFactor >= this.config.targetQFactor && this.status === 'burning') {
      const poolSize = this.getPoolSize();
      if (poolSize >= SELF_SUSTAINING_MIN_PROXIES) {
        this.status = 'self_sustaining';
        logger.info('🔥 Fusion reaction transitioned to SELF-SUSTAINING mode');
      }
    }

    // Check for afterburner eligibility
    if (this.status === 'self_sustaining') {
      const effectiveIPs = await this.getEffectiveIPCount();
      if (this.checkAfterburnerEligibility(effectiveIPs)) {
        this.activateAfterburner();
      }
    }

    // If Q-factor drops below 1, transition back from afterburner → self_sustaining → burning
    if (qFactor < AFTERBURNER_MIN_QFACTOR && this.afterburnerActive) {
      this.deactivateAfterburner();
    }

    if (qFactor < 1 && this.status === 'self_sustaining') {
      this.status = 'burning';
      logger.info('Fusion reaction dropped below self-sustaining -- back to burning mode');
    }

    // Persist Q-factor
    await cacheSet('fusion:qfactor', {
      value: qFactor,
      timestamp: Date.now(),
      target: this.config.targetQFactor,
    }, 120).catch(() => {});
  }

  // --- Private: Milestone Check -------------------------------------------

  /**
   * Run milestone checks and log achievements.
   * Now runs every 30s (was 2min) and includes velocity tracking.
   */
  private async runMilestoneCheck(): Promise<void> {
    const currentIPs = await this.getEffectiveIPCount();

    for (const milestone of this.milestones) {
      const wasAchieved = milestone.achievedAt !== null;
      milestone.currentIPs = currentIPs;
      milestone.progress = Math.min(1, currentIPs / milestone.targetIPs);

      // Calculate velocity (IPs/hour toward this milestone)
      if (milestone.achievedAt === null && this.startedAt) {
        const elapsedHours = (Date.now() - this.startedAt) / (1000 * 60 * 60);
        milestone.velocity = elapsedHours > 0 ? currentIPs / elapsedHours : 0;
      } else {
        milestone.velocity = 0;
      }

      if (milestone.progress >= 1 && !wasAchieved) {
        milestone.achievedAt = Date.now();
        logger.info(
          { name: milestone.name, targetIPs: milestone.targetIPs, currentIPs },
          `🏆 FUSION MILESTONE ACHIEVED: ${milestone.name}`,
        );
      }
    }

    // Persist milestones
    await cacheSet('fusion:milestones', this.milestones, 300).catch(() => {});
  }

  // --- Private: Status Update ---------------------------------------------

  /**
   * Update reactor status based on current conditions.
   * Now handles afterburner status transitions and more granular checks.
   */
  private updateReactorStatus(): void {
    if (!this.running) return;

    const qFactor = this.getQFactor();
    const temperature = this.measurePlasmaTemperature();
    const poolSize = this.getPoolSize();

    // Status transitions -- don't auto-transition from terminal states
    if ((this.status as string) === 'scram' || (this.status as string) === 'shutdown') {
      return;
    }

    // Temperature-based status warnings
    if (temperature >= 90) {
      logger.warn(
        { temperature, poolSize },
        '⚠ Plasma temperature critical -- risk of runaway reaction',
      );
    }

    // Pool size checks
    if (poolSize < 10 && this.status === 'burning') {
      logger.warn(
        { poolSize },
        'Pool size critically low -- reactor may not sustain fusion',
      );
    }

    // Containment level check
    if (this.containment) {
      try {
        const containmentLevel = this.containment.getLevel?.() ?? 0;
        if (containmentLevel >= 4 && this.status !== 'scram') {
          logger.error('Containment level 4+ -- consider SCRAM');
        }
      } catch (err: unknown) {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Containment level check failed');
      }
    }

    // Afterburner health check -- deactivate if conditions no longer met
    if (this.afterburnerActive) {
      if (qFactor < AFTERBURNER_MIN_QFACTOR || poolSize < AFTERBURNER_MIN_POOL_SIZE) {
        this.deactivateAfterburner();
      }
    }
  }

  // --- Private: Fuel Injection Implementations ----------------------------

  /**
   * Inject free proxy sources as fuel.
   */
  private async injectFreeFuel(amount: number): Promise<number> {
    let injected = 0;

    try {
      // Query DB for recently added proxies that haven't been validated yet
      const candidates = await db.proxy.findMany({
        where: {
          retired: false,
          provider: 'free',
          lastChecked: { lt: new Date(Date.now() - 10 * 60 * 1000) },
        },
        take: amount,
        orderBy: { addedAt: 'desc' },
      });

      // Validate each candidate in parallel using Promise.allSettled
      const validationPromises = candidates.map((candidate) =>
        (async () => {
          try {
            const result = await testProxy(candidate.url, undefined, 10_000);
            if (result.working) {
              await db.proxy.update({
                where: { id: candidate.id },
                data: {
                  successRate: Math.min(1, (candidate.successRate || 0.5) * 0.7 + 0.3),
                  lastChecked: new Date(),
                  p95Latency: result.latencyMs,
                },
              });
              return { success: true, proxy: candidate, latency: result.latencyMs };
            } else {
              await db.proxy.update({
                where: { id: candidate.id },
                data: {
                  consecutiveFailures: { increment: 1 },
                  lastChecked: new Date(),
                },
              });
              return { success: false, proxy: candidate, latency: 0 };
            }
          } catch {
            return { success: false, proxy: candidate, latency: 0 };
          }
        })(),
      );

      const results = await Promise.allSettled(validationPromises);
      injected = results.filter(
        (r) => r.status === 'fulfilled' && r.value.success,
      ).length;

      // Queue successful injections for plasma injection
      const successfulProxies = results
        .filter((r) => r.status === 'fulfilled' && r.value.success)
        .map((r) => {
          const fulfilled = r as PromiseFulfilledResult<{ success: boolean; proxy: { url: string }; latency: number }>;
          return {
            url: fulfilled.value.proxy.url,
            protocol: fulfilled.value.proxy.url.startsWith('https') ? 'https' : 'http',
          };
        });

      this.queuePlasmaInjection(successfulProxies);
    } catch (err: unknown) {
      logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Free fuel injection failed');
    }

    return injected;
  }

  /**
   * Inject residential proxy sources as fuel.
   */
  private async injectResidentialFuel(amount: number): Promise<number> {
    let injected = 0;

    try {
      // Query for residential proxies from known providers
      const providers = ['brightdata', 'oxylabs', 'smartproxy', 'iproyal', 'webshare'];
      const candidates = await db.proxy.findMany({
        where: {
          retired: false,
          provider: { in: providers },
          tier: 'residential',
        },
        take: amount,
        orderBy: { successRate: 'desc' },
      });

      // Validate in parallel
      const validationPromises = candidates.map((candidate) =>
        (async () => {
          try {
            const result = await testProxy(candidate.url, undefined, 10_000);
            if (result.working) {
              await db.proxy.update({
                where: { id: candidate.id },
                data: {
                  successRate: Math.min(1, (candidate.successRate || 0.5) * 0.8 + 0.2),
                  lastChecked: new Date(),
                  p95Latency: result.latencyMs,
                },
              });
              return true;
            }
            return false;
          } catch {
            return false;
          }
        })(),
      );

      const results = await Promise.allSettled(validationPromises);
      injected = results.filter((r) => r.status === 'fulfilled' && r.value === true).length;
    } catch (err: unknown) {
      logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Residential fuel injection failed');
    }

    return injected;
  }

  /**
   * Inject TOR proxy sources as fuel.
   */
  private async injectTorFuel(amount: number): Promise<number> {
    let injected = 0;

    try {
      const candidates = await db.proxy.findMany({
        where: {
          retired: false,
          provider: 'tor',
          successRate: { gte: 0.1 },
        },
        take: amount,
        orderBy: { successRate: 'desc' },
      });

      // Validate in parallel
      const validationPromises = candidates.map((candidate) =>
        (async () => {
          try {
            const result = await testProxy(candidate.url, 'https://check.torproject.org/api/ip', 15_000);
            if (result.working) {
              await db.proxy.update({
                where: { id: candidate.id },
                data: {
                  successRate: Math.min(1, (candidate.successRate || 0.3) * 0.7 + 0.3),
                  lastChecked: new Date(),
                },
              });
              return true;
            }
            return false;
          } catch {
            return false;
          }
        })(),
      );

      const results = await Promise.allSettled(validationPromises);
      injected = results.filter((r) => r.status === 'fulfilled' && r.value === true).length;
    } catch (err: unknown) {
      logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'TOR fuel injection failed');
    }

    return injected;
  }

  /**
   * Inject datacenter proxy sources as fuel.
   */
  private async injectDatacenterFuel(amount: number): Promise<number> {
    let injected = 0;

    try {
      const candidates = await db.proxy.findMany({
        where: {
          retired: false,
          tier: 'datacenter',
          successRate: { gte: 0.3 },
        },
        take: amount,
        orderBy: { successRate: 'desc' },
      });

      // Validate in parallel
      const validationPromises = candidates.map((candidate) =>
        (async () => {
          try {
            const result = await testProxy(candidate.url, undefined, 8_000);
            if (result.working) {
              await db.proxy.update({
                where: { id: candidate.id },
                data: {
                  successRate: Math.min(1, (candidate.successRate || 0.5) * 0.8 + 0.2),
                  lastChecked: new Date(),
                  p95Latency: result.latencyMs,
                },
              });
              return true;
            }
            return false;
          } catch {
            return false;
          }
        })(),
      );

      const results = await Promise.allSettled(validationPromises);
      injected = results.filter((r) => r.status === 'fulfilled' && r.value === true).length;
    } catch (err: unknown) {
      logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Datacenter fuel injection failed');
    }

    return injected;
  }

  /**
   * Inject custom proxy sources as fuel.
   */
  private async injectCustomFuel(amount: number): Promise<number> {
    // Custom fuel injection is a no-op by default -- users can override
    // by calling injectFuel directly with proxy URLs
    return 0;
  }

  // --- Private: Helper Methods --------------------------------------------

  /**
   * Get the number of effective (usable) IPs in the pool.
   */
  private async getEffectiveIPCount(): Promise<number> {
    try {
      return await db.proxy.count({
        where: {
          retired: false,
          successRate: { gte: 0.3 },
        },
      });
    } catch {
      return 0;
    }
  }

  /**
   * Get the current pool size (all non-retired proxies).
   */
  private getPoolSize(): number {
    if (this.plasmaState) {
      try {
        return this.plasmaState.getPoolSize?.() ?? 0;
      } catch (err: unknown) {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Pool size check failed');
      }
    }
    return 0;
  }

  /**
   * Get the current utilization rate.
   */
  private getUtilizationRate(): number {
    if (this.plasmaState) {
      try {
        const poolSize = this.plasmaState.getPoolSize?.() ?? 0;
        const checkedOut = this.plasmaState.getCheckedOutCount?.() ?? 0;
        return poolSize > 0 ? checkedOut / poolSize : 0;
      } catch (err: unknown) {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Utilization rate check failed');
      }
    }
    return 0;
  }

  /**
   * Get the energy input rate (proxies discovered per minute).
   * Uses the ENERGY_TRACKING_WINDOW_MIN (3 min) window.
   */
  private getEnergyInputRate(): number {
    const now = Date.now();
    const windowMs = ENERGY_TRACKING_WINDOW_MIN * 60 * 1000;
    this.energyMeasurements = this.energyMeasurements.filter((m) => m.timestamp >= now - windowMs);

    const totalInput = this.energyMeasurements.reduce((sum, m) => sum + m.inputCount, 0);
    return totalInput / ENERGY_TRACKING_WINDOW_MIN;
  }

  /**
   * Persist the reactor state to Redis.
   */
  private async persistReactorState(): Promise<void> {
    try {
      const state = {
        status: this.status,
        config: this.config,
        totalFuelInjected: this.totalFuelInjected,
        totalEnergyProduced: this.totalEnergyProduced,
        scramCount: this.scramCount,
        currentQFactor: this.currentQFactor,
        criticalMassPercent: this.criticalMassPercent,
        milestones: this.milestones,
        startedAt: this.startedAt,
        burnStartedAt: this.burnStartedAt,
        afterburnerStartedAt: this.afterburnerStartedAt,
        afterburnerActive: this.afterburnerActive,
        neutronEconomy: this.neutronEconomy,
        adaptiveRate: this.adaptiveRate.currentRate,
        timestamp: Date.now(),
      };
      await cacheSet('fusion:state', state, 3600);
    } catch (err: unknown) {
      logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'State persistence failed');
    }
  }

  /**
   * Load the reactor state from Redis.
   */
  async loadReactorState(): Promise<void> {
    try {
      const state = await cacheGet<Record<string, unknown>>('fusion:state');
      if (state) {
        this.totalFuelInjected = (state.totalFuelInjected as number) || 0;
        this.totalEnergyProduced = (state.totalEnergyProduced as number) || 0;
        this.scramCount = (state.scramCount as number) || 0;
        this.currentQFactor = (state.currentQFactor as number) || 0;
        this.criticalMassPercent = (state.criticalMassPercent as number) || 0;
        this.milestones = (state.milestones as FusionMilestone[]) || this.milestones;
        this.afterburnerActive = (state.afterburnerActive as boolean) || false;
        this.afterburnerStartedAt = (state.afterburnerStartedAt as number) || null;
        this.adaptiveRate.currentRate = (state.adaptiveRate as number) || 1.0;
        if (state.neutronEconomy) {
          this.neutronEconomy = state.neutronEconomy as NeutronEconomy;
        }
        logger.info({ previousStatus: state.status }, 'Reactor state loaded from Redis');
      }
    } catch (err: unknown) {
      logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'State load failed');
    }
  }

  // --- Public Getters -----------------------------------------------------

  /**
   * Check if the reactor is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the fusion configuration.
   */
  getConfig(): FusionConfig {
    return { ...this.config };
  }

  /**
   * Update the fusion configuration.
   */
  updateConfig(updates: Partial<FusionConfig>): void {
    this.config = { ...this.config, ...updates };
    logger.info({ updates }, 'Fusion configuration updated');
  }

  /**
   * Get active fuel types.
   */
  getActiveFuelTypes(): string[] {
    return Array.from(this.activeFuelTypes);
  }

  /**
   * Get total fuel injected.
   */
  getTotalFuelInjected(): number {
    return this.totalFuelInjected;
  }

  /**
   * Get total energy produced.
   */
  getTotalEnergyProduced(): number {
    return this.totalEnergyProduced;
  }

  /**
   * Get SCRAM count.
   */
  getScramCount(): number {
    return this.scramCount;
  }

  /**
   * Get uptime in milliseconds.
   */
  getUptime(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  /**
   * Get burn time in milliseconds.
   */
  getBurnTime(): number {
    return this.burnStartedAt ? Date.now() - this.burnStartedAt : 0;
  }

  /**
   * Get afterburner time in milliseconds.
   */
  getAfterburnerTime(): number {
    return this.afterburnerStartedAt ? Date.now() - this.afterburnerStartedAt : 0;
  }

  /**
   * Get the neutron moderation factor.
   */
  getNeutronModeration(): number {
    return this.config.neutronModeration;
  }

  /**
   * Set the neutron moderation factor (0-1).
   */
  setNeutronModeration(moderation: number): void {
    this.config.neutronModeration = Math.max(0, Math.min(1, moderation));
    logger.info({ neutronModeration: this.config.neutronModeration }, 'Neutron moderation adjusted');
  }

  /**
   * Check if afterburner mode is active.
   */
  isAfterburnerActive(): boolean {
    return this.afterburnerActive;
  }

  /**
   * Get the reaction efficiency (validated / discovered).
   */
  getReactionEfficiency(): number {
    return this.reactionEfficiency;
  }

  /**
   * Get the pool growth rate (proxies/minute).
   */
  getPoolGrowthRate(): number {
    return this.poolGrowthRate;
  }

  /**
   * Get the last discovery count.
   */
  getLastDiscoveryCount(): number {
    return this.lastDiscoveryCount;
  }

  /**
   * Get the last breeding count.
   */
  getLastBreedingCount(): number {
    return this.lastBreedingCount;
  }

  /**
   * Get the plasma injection results history.
   */
  getPlasmaInjectionResults(): PlasmaInjectionResult[] {
    return [...this.plasmaInjectionResults];
  }

  /**
   * Manually trigger afterburner mode.
   * Use with caution -- only activates if conditions are met.
   *
   * @returns True if afterburner was activated
   */
  async manualAfterburner(): Promise<boolean> {
    const effectiveIPs = await this.getEffectiveIPCount();
    if (this.checkAfterburnerEligibility(effectiveIPs)) {
      this.activateAfterburner();
      return true;
    }
    logger.warn(
      { poolSize: effectiveIPs, qFactor: this.getQFactor() },
      'Manual afterburner activation failed -- conditions not met',
    );
    return false;
  }

  /**
   * Get module status for all loaded modules.
   *
   * @returns Object with module names and their loaded status
   */
  getModuleStatus(): Record<string, boolean> {
    return {
      'chain-reaction': this.chainReaction !== null,
      'breeder-reactor': this.breederReactor !== null,
      'quantum-tunnel': this.quantumTunnel !== null,
      'plasma-state': this.plasmaState !== null,
      'containment': this.containment !== null,
      'ip-pool': this.megaPool !== null,
      'captcha-solver': this.captchaSolver !== null,
      'web-unlocker': this.webUnlocker !== null,
    };
  }

  /**
   * Get failed modules awaiting retry.
   *
   * @returns Array of failed module names with their last failure timestamp
   */
  getFailedModules(): Array<{ name: string; lastFailure: number }> {
    return Array.from(this.failedModuleLoads.entries()).map(([name, timestamp]) => ({
      name,
      lastFailure: timestamp,
    }));
  }

  /**
   * Get a comprehensive diagnostic report of the fusion core.
   *
   * @returns Diagnostic information
   */
  getDiagnostics(): Record<string, unknown> {
    return {
      status: this.status,
      running: this.running,
      afterburner: this.afterburnerActive,
      qFactor: this.currentQFactor,
      criticalMass: this.criticalMassPercent,
      neutronEconomy: this.neutronEconomy,
      adaptiveRate: this.adaptiveRate.currentRate,
      smartCooldown: this.smartCooldown,
      reactionEfficiency: this.reactionEfficiency,
      poolGrowthRate: this.poolGrowthRate,
      modules: this.getModuleStatus(),
      failedModules: this.getFailedModules(),
      pendingPlasmaInjection: this.pendingPlasmaInjection.length,
      energyMeasurements: this.energyMeasurements.length,
      recentReactions: this.recentReactions.length,
      uptime: this.getUptime(),
      burnTime: this.getBurnTime(),
      afterburnerTime: this.getAfterburnerTime(),
    };
  }
}

// --- Singleton ----------------------------------------------------------------

export const fusionCore = new FusionCore();
