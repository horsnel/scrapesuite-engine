/**
 * Breeder Reactor Engine -- Enhanced Mk.II
 *
 * Like a nuclear breeder reactor that produces more fuel than it consumes,
 * this engine breeds NEW proxy configurations from existing ones. It takes
 * working proxy configs and mutates, cross-breeds, and evolves them to
 * create new variants that cover more geographic regions, subnets, and
 * provider configurations.
 *
 * =======================================================================
 *  REACTOR SPECIFICATIONS -- Mk.II OVERDRIVE
 * =======================================================================
 *
 *  Breeding Cycle:         5s (was 60s) -- 12x faster cycle time
 *  Parallel Breeding:      Promise.allSettled on ALL patterns simultaneously
 *  Batch Import:           500+ bred configs imported per batch
 *  Port Variations:        50+ per successful IP (was 4)
 *  Protocol Coverage:      http, https, socks4, socks5 -- ALL variants
 *  Auth Variations:        Generated from known auth pattern database
 *  Subnet Breeding:        Full /24 range scan from successful IPs
 *  Cross-Provider:         Combine provider A's IP with provider B's port
 *  Geo-Variants:           Country-specific variants using geo-IP patterns
 *  Per-Cycle Output:       1000+ new configs per breeding cycle
 *
 * =======================================================================
 *  BREEDING MODES
 * =======================================================================
 *
 *  1. Exponential Breeding -- each successful breed triggers breeding from
 *     the newly bred configs, creating a chain reaction of config generation
 *
 *  2. Fission Breeding -- split successful subnets into smaller ranges
 *     for finer discovery (e.g., /24 → /25 → /26 → /27 → /28)
 *
 *  3. Fusion Breeding -- combine two successful proxy patterns to create
 *     hybrid configs that inherit the best traits of both parents
 *
 *  4. Breeding Pipeline -- multi-stage pipeline:
 *     GENERATE → VALIDATE → SCORE → IMPORT
 *     Each stage runs concurrently for maximum throughput
 *
 *  5. Breeding Intelligence -- learn which breeding strategies produce
 *     the most working proxies and prioritize those strategies
 *
 *  6. Auto-Breeding -- automatically breed when pool drops below
 *     target threshold, ensuring the reactor never goes critical
 *
 *  7. Breeding Priority -- prioritize breeding from highest-success-rate
 *     patterns first, maximizing yield per cycle
 *
 *  8. Bred Config Caching -- cache bred configs in Redis for fast
 *     retrieval and cross-session persistence
 *
 *  9. Breeding Metrics -- track breeding efficiency, yield rate,
 *     time-to-validate, and other key performance indicators
 *
 *  10. Smart Port Discovery -- learn which ports are most likely to
 *      have proxies by scanning patterns and historical data
 *
 * =======================================================================
 *  NUCLEAR METAPHOR GLOSSARY
 * =======================================================================
 *
 *  Control Rods    → Breeding priority throttles
 *  Fuel Rods       → Source proxy configs (the breeding material)
 *  Moderator       → Breeding intelligence (slows/speeds reactions)
 *  Criticality     → Optimal breeding rate (producing net fuel)
 *  SCRAM           → Emergency stop (kill all breeding)
 *  Containment     → Max active config cap (prevent runaway)
 *  Enrichment      → Fitness score improvement through selection
 *  Half-Life       → Time before an unvalidated config decays
 *  Chain Reaction  → Exponential breeding from successful configs
 *  Fission         → Splitting subnets into finer ranges
 *  Fusion          → Combining two patterns into a hybrid
 *  Neutron Flux    → Breeding rate (configs/second)
 *  Plutonium       → High-fitness, battle-tested configs
 *  Depleted Uranium→ Low-fitness configs awaiting selection
 *  Breeder Blanket → The reservoir of un-bred patterns
 */

import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';
import { testProxy } from '../utils/proxy-fetch';

const logger = createChildLogger('breeder-reactor');

// --- Types --------------------------------------------------------------------

export interface BredConfig {
  id: string;
  parentIds: string[];
  generation: number;
  proxyUrl: string;
  provider: string;
  country: string;
  tier: string;
  mutations: string[];
  fitnessScore: number;
  successRate: number;
  requestCount: number;
  createdAt: number;
  isActive: boolean;
  lineage: string[];
  /** Breeding strategy that produced this config */
  breedingStrategy: BreedingStrategy;
  /** Pipeline stage this config is currently in */
  pipelineStage: PipelineStage;
  /** Number of times this config has been validated */
  validationAttempts: number;
  /** Last validation timestamp */
  lastValidatedAt: number | null;
  /** Time-to-validate in ms (from creation to first successful validation) */
  timeToValidate: number | null;
  /** Exponential breeding depth (how many chain-reaction levels deep) */
  exponentialDepth: number;
  /** Fission generation (how many times the subnet was split) */
  fissionGeneration: number;
  /** Fusion parent signatures (hash of combined parent traits) */
  fusionSignature: string | null;
}

export interface BreederStats {
  totalBred: number;
  totalActive: number;
  totalSelected: number;
  totalKilled: number;
  currentGeneration: number;
  avgFitnessScore: number;
  bestFitnessScore: number;
  breedingRate: number;
  isProducingNetFuel: boolean;
  byGeneration: Record<number, { count: number; avgFitness: number }>;
  byMutation: Record<string, { count: number; successRate: number }>;
  /** New Mk.II stats */
  byStrategy: Record<string, { count: number; successRate: number; avgTimeToValidate: number }>;
  pipelineStats: {
    generated: number;
    validated: number;
    scored: number;
    imported: number;
    rejected: number;
  };
  exponentialBreeding: {
    totalChainReactions: number;
    maxDepth: number;
    avgYieldPerDepth: number;
  };
  fissionBreeding: {
    totalFissions: number;
    maxFissionGeneration: number;
    avgYieldPerFission: number;
  };
  fusionBreeding: {
    totalFusions: number;
    avgHybridFitness: number;
    bestHybridFitness: number;
  };
  smartPortDiscovery: {
    totalPortsScanned: number;
    discoveredPorts: number[];
    topPorts: { port: number; hitRate: number }[];
  };
  breedingEfficiency: number;
  yieldRate: number;
  avgTimeToValidate: number;
  autoBreedingTriggers: number;
  currentNeutronFlux: number;
}

export type BreedingStrategy =
  | 'session_mutation'
  | 'country_mutation'
  | 'port_variation'
  | 'protocol_variation'
  | 'auth_variation'
  | 'subnet_breed'
  | 'subnet_fission'
  | 'cross_provider'
  | 'geo_breed'
  | 'header_mutation'
  | 'exponential_breed'
  | 'fission_breed'
  | 'fusion_breed'
  | 'smart_port'
  | 'country_specific';

export type PipelineStage =
  | 'generated'
  | 'validating'
  | 'validated'
  | 'scoring'
  | 'scored'
  | 'importing'
  | 'imported'
  | 'rejected';

export interface BreedingIntelligenceEntry {
  strategy: BreedingStrategy;
  attempts: number;
  successes: number;
  avgFitness: number;
  avgTimeToValidate: number;
  lastUsed: number;
  /** Weight for priority calculation (higher = more likely to be used) */
  priorityWeight: number;
}

export interface SmartPortEntry {
  port: number;
  hits: number;
  misses: number;
  hitRate: number;
  lastSeen: number;
  provider: string;
  protocol: string;
}

export interface AutoBreedingConfig {
  /** Minimum pool size before auto-breeding triggers */
  targetPoolSize: number;
  /** Minimum success rate of pool before auto-breeding triggers */
  targetSuccessRate: number;
  /** Maximum breeding burst size when auto-breeding triggers */
  maxBurstSize: number;
  /** Whether auto-breeding is enabled */
  enabled: boolean;
}

export interface BreedingPipelineResult {
  generated: number;
  validated: number;
  scored: number;
  imported: number;
  rejected: number;
  duration: number;
}

export interface FissionResult {
  parentCidr: string;
  childCidrs: string[];
  bredConfigs: BredConfig[];
  fissionGeneration: number;
}

export interface FusionResult {
  parentA: BredConfig;
  parentB: BredConfig;
  children: BredConfig[];
  fusionSignature: string;
}

// --- Constants -- Mk.II Overdrive ----------------------------------------------

const BREEDING_INTERVAL_MS = 5_000;              // 5 seconds -- 12x faster
const NATURAL_SELECTION_INTERVAL_MS = 60_000;     // 1 minute between selection rounds
const MAX_GENERATION = 20;                        // Doubled from 10
const FITNESS_THRESHOLD = 25;                     // Lowered from 30 for more survivors
const MAX_ACTIVE_CONFIGS = 5_000;                 // 10x capacity from 500
const BATCH_IMPORT_SIZE = 500;                     // Import 500+ configs at once
const PARALLEL_BREED_LIMIT = 50;                   // Max concurrent breed operations
const PORT_VARIATIONS_PER_IP = 50;                 // 50+ port variations per IP
const TARGET_CONFIGS_PER_CYCLE = 1_000;            // Minimum configs per breeding cycle
const EXPONENTIAL_MAX_DEPTH = 4;                   // Max chain-reaction depth
const FISSION_MAX_GENERATION = 5;                  // Max subnet split depth
const FISSION_MIN_PREFIX = 28;                     // Smallest subnet we'll fission to
const CONFIG_HALF_LIFE_MS = 86_400_000;            // 24 hours -- unvalidated configs decay
const CACHE_TTL_SECONDS = 86_400;                  // 24 hours cache TTL
const INTELLIGENCE_CACHE_KEY = 'breeder:intelligence';
const SMART_PORT_CACHE_KEY = 'breeder:smart_ports';
const PIPELINE_CONCURRENCY = 20;                   // Max concurrent pipeline operations

const SESSION_ID_CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const ALL_PROTOCOLS: string[] = ['http', 'https', 'socks4', 'socks5'];

const PROXY_PORTS_FULL: number[] = [
  // Well-known proxy ports
  80, 443, 1080, 1081, 1082, 1083, 1084, 1085,
  3128, 3129, 3130, 3131, 3132,
  8080, 8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089, 8090,
  8118, 8123, 8181, 8182, 8183,
  8888, 8889, 8890, 8891,
  9050, 9051, 9052, 9053,  // Tor defaults
  // Common datacenter ports
  10000, 10001, 10002, 10003, 10004, 10005,
  10800, 10801, 10802, 10803,
  12345, 12346, 12347,
  15000, 15001,
  20000, 20001, 20002,
  31280, 31281,
  40000, 40001, 44444,
  50000, 50001, 50002, 50003,
  60000, 60001, 60002, 60088,
  61000, 61001,
  // Provider-specific ports
  22225, 22226, 22227,  // Bright Data
  23128, 23129,         // Oxylabs
  27000, 27001,         // SmartProxy
  12321, 12322,         // IPRoyal
  28128, 28129,         // Webshare
];

const GEO_SIMILARITY_MAP: Record<string, string[]> = {
  US: ['CA', 'MX', 'PR', 'GU', 'AS'],
  CA: ['US', 'MX', 'PR'],
  GB: ['IE', 'DE', 'FR', 'NL', 'BE'],
  DE: ['AT', 'CH', 'NL', 'FR', 'GB', 'PL'],
  FR: ['BE', 'CH', 'DE', 'ES', 'IT', 'LU'],
  AU: ['NZ', 'SG', 'JP', 'MY', 'ID'],
  JP: ['KR', 'SG', 'AU', 'HK', 'TW'],
  BR: ['AR', 'CL', 'CO', 'MX', 'PE'],
  IN: ['SG', 'AE', 'AU', 'MY', 'LK'],
  SG: ['MY', 'TH', 'IN', 'AU', 'JP', 'ID', 'PH'],
  NL: ['DE', 'BE', 'GB', 'FR', 'LU'],
  SE: ['NO', 'DK', 'FI', 'DE', 'NL'],
  KR: ['JP', 'SG', 'AU', 'HK', 'TW'],
  ZA: ['NG', 'KE', 'EG', 'MA', 'GH'],
  AE: ['SA', 'QA', 'IN', 'SG', 'KW', 'BH'],
  IT: ['ES', 'FR', 'DE', 'GR', 'PT'],
  ES: ['PT', 'FR', 'IT', 'BR', 'AR'],
  PL: ['DE', 'CZ', 'UA', 'RO', 'SK'],
  RU: ['UA', 'BY', 'KZ', 'UZ', 'GE'],
  CN: ['JP', 'KR', 'SG', 'HK', 'TW'],
  HK: ['CN', 'JP', 'SG', 'TW', 'MY'],
  TW: ['CN', 'JP', 'HK', 'SG', 'KR'],
  IL: ['TR', 'AE', 'GB', 'DE'],
  TR: ['IL', 'AE', 'DE', 'NL'],
  NG: ['ZA', 'KE', 'GH', 'EG'],
  MX: ['US', 'CA', 'BR', 'AR', 'CO'],
  TH: ['SG', 'MY', 'VN', 'ID', 'PH'],
  ID: ['SG', 'MY', 'TH', 'AU', 'PH'],
  PH: ['SG', 'MY', 'TH', 'ID', 'JP'],
  VN: ['TH', 'SG', 'MY', 'ID', 'CN'],
};

const COUNTRY_SPECIFIC_PORT_MAP: Record<string, number[]> = {
  US: [8080, 3128, 80, 443, 1080, 8888, 9050],
  DE: [8080, 3128, 80, 8118, 1080, 3130],
  FR: [8080, 3128, 80, 8081, 1080, 8181],
  GB: [8080, 3128, 80, 8080, 1080, 8888],
  JP: [8080, 3128, 80, 1080, 8081, 9050],
  BR: [8080, 3128, 80, 1080, 3129, 8081],
  IN: [8080, 3128, 80, 1080, 8080, 8888],
  RU: [8080, 3128, 80, 1080, 9050, 3129],
  CN: [8080, 1080, 80, 3128, 8888, 9050],
  KR: [8080, 3128, 80, 1080, 8081, 8888],
};

const COUNTRY_TIER_MAP: Record<string, string[]> = {
  US: ['residential', 'datacenter', 'mobile'],
  GB: ['residential', 'datacenter', 'mobile'],
  DE: ['residential', 'datacenter', 'mobile'],
  FR: ['residential', 'datacenter'],
  JP: ['residential', 'datacenter', 'mobile'],
  BR: ['residential', 'datacenter'],
  IN: ['residential', 'datacenter', 'mobile'],
  AU: ['residential', 'datacenter'],
  CA: ['residential', 'datacenter', 'mobile'],
  SG: ['residential', 'datacenter'],
};

const COMMON_SUBNET_OFFSETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 40, 50, 75, 100, 125, 150, 200];

const AUTH_PATTERN_VARIATIONS = [
  '',               // No auth
  'user:pass',      // Basic auth pattern
  'proxy:proxy',    // Common default
  'admin:admin',    // Another common default
  'root:root',      // Root default
  'test:test',      // Test default
];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

const ACCEPT_LANGUAGES = [
  'en-US,en;q=0.9',
  'en-GB,en;q=0.9,en-US;q=0.8',
  'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
  'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
  'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
  'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'ar-SA,ar;q=0.9,en-US;q=0.8,en;q=0.7',
];

const TLS_CIPHER_SUITES = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
  'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
  'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
  'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256',
];

// --- Utility Functions --------------------------------------------------------

/**
 * Parse a proxy URL into its components.
 */
function parseProxyUrl(proxyUrl: string): {
  protocol: string;
  username: string;
  password: string;
  hostname: string;
  port: number;
} | null {
  try {
    const parsed = new URL(proxyUrl);
    return {
      protocol: parsed.protocol.replace(':', ''),
      username: parsed.username,
      password: parsed.password,
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10) || 80,
    };
  } catch {
    return null;
  }
}

/**
 * Build a proxy URL from components.
 */
function buildProxyUrl(
  protocol: string,
  username: string,
  password: string,
  hostname: string,
  port: number,
): string {
  if (username && password) {
    return `${protocol}://${username}:${password}@${hostname}:${port}`;
  }
  return `${protocol}://${hostname}:${port}`;
}

/**
 * Generate a random session ID for proxy rotation.
 */
function generateSessionId(prefix: string = 'sess'): string {
  let result = prefix + '_';
  for (let i = 0; i < 8; i++) {
    result += SESSION_ID_CHARSET.charAt(Math.floor(Math.random() * SESSION_ID_CHARSET.length));
  }
  return result;
}

/**
 * Convert an IPv4 address to a numeric value.
 */
function ipToNumber(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Convert a numeric value to an IPv4 address string.
 */
function numberToIp(num: number): string {
  return [
    (num >>> 24) & 0xff,
    (num >>> 16) & 0xff,
    (num >>> 8) & 0xff,
    num & 0xff,
  ].join('.');
}

/**
 * Check if an IP is a valid public IP.
 */
function isValidPublicIP(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  if (parts.some(p => isNaN(p) || p < 0 || p > 255)) return false;
  if (parts[0] === 0) return false;
  if (parts[0] === 10) return false;
  if (parts[0] === 127) return false;
  if (parts[0] === 169 && parts[1] === 254) return false;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
  if (parts[0] === 192 && parts[1] === 168) return false;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return false;
  if (parts[0] >= 224) return false;
  return true;
}

/**
 * Get the /24 subnet prefix for an IP.
 */
function getSubnetPrefix(ip: string): string {
  const parts = ip.split('.');
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

/**
 * Get the CIDR prefix length from a netmask.
 */
function cidrToMask(prefix: number): number {
  return Math.pow(2, 32 - prefix) - 1;
}

/**
 * Calculate the number of hosts in a CIDR range.
 */
function cidrHostCount(prefix: number): number {
  return Math.pow(2, 32 - prefix) - 2;
}

/**
 * Generate a fusion signature from two parent configs.
 * Used to identify unique fusion combinations.
 */
function generateFusionSignature(configA: BredConfig, configB: BredConfig): string {
  const sorted = [configA.id, configB.id].sort();
  const traits = [
    configA.provider, configB.provider,
    configA.country, configB.country,
    configA.tier, configB.tier,
  ].join('|');
  let hash = 0;
  const str = sorted.join(':') + '::' + traits;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `fusion_${Math.abs(hash).toString(36)}`;
}

/**
 * Chunk an array into batches of the specified size.
 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Deduplicate an array by a key function.
 */
function deduplicateBy<T, K>(arr: T[], keyFn: (item: T) => K): T[] {
  const seen = new Set<K>();
  return arr.filter(item => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- Provider-Specific Mutation Helpers ---------------------------------------

/**
 * Mutate a Bright Data username to change session, country, or city.
 */
function mutateBrightDataUsername(
  username: string,
  mutations: Record<string, string>,
): string {
  let result = username;

  // Remove existing session
  result = result.replace(/-session-[a-zA-Z0-9_]+/, '');

  // Remove existing country if we're changing it
  if (mutations.country) {
    result = result.replace(/-country-[a-z]+/, `-country-${mutations.country.toLowerCase()}`);
  }

  // Remove existing city if we're changing it
  if (mutations.city) {
    result = result.replace(/-city-[a-zA-Z0-9_]+/, `-city-${mutations.city.toLowerCase().replace(/\s+/g, '_')}`);
  }

  // Add new session
  if (mutations.session) {
    result += `-session-${mutations.session}`;
  }

  // Add ASN if specified
  if (mutations.asn) {
    result = result.replace(/-asn-\d+/, '');
    result += `-asn-${mutations.asn}`;
  }

  // Add state if specified (US-specific)
  if (mutations.state) {
    result = result.replace(/-state-[a-z_]+/, '');
    result += `-state-${mutations.state.toLowerCase().replace(/\s+/g, '_')}`;
  }

  return result;
}

/**
 * Mutate an Oxylabs username for geo-targeting changes.
 */
function mutateOxylabsUsername(
  username: string,
  mutations: Record<string, string>,
): string {
  let result = username;

  if (mutations.country) {
    result = result.replace(/-country-[a-z]+/, `-country-${mutations.country.toLowerCase()}`);
  }

  if (mutations.session) {
    result = result.replace(/-sessid-[a-zA-Z0-9_]+/, `-sessid-${mutations.session}`);
  }

  // Oxylabs city targeting
  if (mutations.city) {
    result = result.replace(/-city_[a-zA-Z0-9_]+/, `-city_${mutations.city.toLowerCase().replace(/\s+/g, '_')}`);
  }

  return result;
}

/**
 * Mutate a SmartProxy username for geo-targeting changes.
 */
function mutateSmartProxyUsername(
  username: string,
  mutations: Record<string, string>,
): string {
  let result = username;

  if (mutations.country) {
    result = result.replace(/-cc-[a-z]+/, `-cc-${mutations.country.toLowerCase()}`);
  }

  if (mutations.session) {
    result = result.replace(/-session-[a-zA-Z0-9_]+/, `-session-${mutations.session}`);
  }

  // SmartProxy city targeting
  if (mutations.city) {
    result = result.replace(/-city-[a-zA-Z0-9_]+/, `-city-${mutations.city.toLowerCase().replace(/\s+/g, '_')}`);
  }

  return result;
}

/**
 * Mutate an IPRoyal username for geo-targeting changes.
 */
function mutateIproyalUsername(
  username: string,
  mutations: Record<string, string>,
): string {
  let result = username;

  if (mutations.country) {
    result = result.replace(/_country-[a-z]+/, `_country-${mutations.country.toLowerCase()}`);
  }

  if (mutations.session) {
    result = result.replace(/_session-[a-zA-Z0-9_]+/, `_session-${mutations.session}`);
  }

  // IPRoyal city targeting
  if (mutations.city) {
    result = result.replace(/_city-[a-zA-Z0-9_]+/, `_city-${mutations.city.toLowerCase().replace(/\s+/g, '_')}`);
  }

  return result;
}

/**
 * Mutate a Webshare username for session changes.
 */
function mutateWebshareUsername(
  username: string,
  mutations: Record<string, string>,
): string {
  let result = username;

  if (mutations.session) {
    result = result.replace(/-session-[a-zA-Z0-9_]+/, `-session-${mutations.session}`);
  }

  if (mutations.country) {
    result = result.replace(/-country-[a-z]+/, `-country-${mutations.country.toLowerCase()}`);
  }

  return result;
}

/**
 * Detect the provider from a proxy URL or hostname.
 */
function detectProvider(proxyUrl: string): string {
  const lower = proxyUrl.toLowerCase();

  if (lower.includes('brd.superproxy') || lower.includes('brightdata')) return 'brightdata';
  if (lower.includes('oxylabs') || lower.includes('pr.oxylabs')) return 'oxylabs';
  if (lower.includes('smartproxy') || lower.includes('gate.smartproxy')) return 'smartproxy';
  if (lower.includes('iproyal') || lower.includes('geo.iproyal')) return 'iproyal';
  if (lower.includes('webshare') || lower.includes('proxy.webshare')) return 'webshare';
  if (lower.includes('packetstream') || lower.includes('proxyscrape')) return 'packetstream';
  if (lower.includes('luminati')) return 'brightdata';  // Luminati → Bright Data

  return 'generic';
}

/**
 * Apply provider-specific username mutations.
 */
function applyProviderMutation(
  provider: string,
  username: string,
  mutations: Record<string, string>,
): string {
  switch (provider) {
    case 'brightdata':
      return mutateBrightDataUsername(username, mutations);
    case 'oxylabs':
      return mutateOxylabsUsername(username, mutations);
    case 'smartproxy':
      return mutateSmartProxyUsername(username, mutations);
    case 'iproyal':
      return mutateIproyalUsername(username, mutations);
    case 'webshare':
      return mutateWebshareUsername(username, mutations);
    default:
      // For generic proxies, just add session to username
      if (mutations.session) {
        return `${username}_${mutations.session}`;
      }
      return username;
  }
}

// --- BreederReactor Engine -- Mk.II Overdrive ---------------------------------

export class BreederReactor {
  private running = false;
  private bredConfigs = new Map<string, BredConfig>();
  private breedingTimer: ReturnType<typeof setInterval> | null = null;
  private selectionTimer: ReturnType<typeof setInterval> | null = null;
  private autoBreedTimer: ReturnType<typeof setInterval> | null = null;
  private intelligenceTimer: ReturnType<typeof setInterval> | null = null;
  private portDiscoveryTimer: ReturnType<typeof setInterval> | null = null;

  private stats: BreederStats = {
    totalBred: 0,
    totalActive: 0,
    totalSelected: 0,
    totalKilled: 0,
    currentGeneration: 0,
    avgFitnessScore: 0,
    bestFitnessScore: 0,
    breedingRate: 0,
    isProducingNetFuel: false,
    byGeneration: {},
    byMutation: {},
    byStrategy: {},
    pipelineStats: {
      generated: 0,
      validated: 0,
      scored: 0,
      imported: 0,
      rejected: 0,
    },
    exponentialBreeding: {
      totalChainReactions: 0,
      maxDepth: 0,
      avgYieldPerDepth: 0,
    },
    fissionBreeding: {
      totalFissions: 0,
      maxFissionGeneration: 0,
      avgYieldPerFission: 0,
    },
    fusionBreeding: {
      totalFusions: 0,
      avgHybridFitness: 0,
      bestHybridFitness: 0,
    },
    smartPortDiscovery: {
      totalPortsScanned: 0,
      discoveredPorts: [],
      topPorts: [],
    },
    breedingEfficiency: 0,
    yieldRate: 0,
    avgTimeToValidate: 0,
    autoBreedingTriggers: 0,
    currentNeutronFlux: 0,
  };

  private recentBreedingTimestamps: number[] = [];

  /** Breeding intelligence -- learns which strategies work best */
  private breedingIntelligence = new Map<string, BreedingIntelligenceEntry>();

  /** Smart port discovery -- learns which ports have proxies */
  private smartPorts = new Map<number, SmartPortEntry>();

  /** Auto-breeding configuration */
  private autoBreedConfig: AutoBreedingConfig = {
    targetPoolSize: 1000,
    targetSuccessRate: 0.5,
    maxBurstSize: 2000,
    enabled: true,
  };

  /** Pipeline queue for multi-stage processing */
  private pipelineQueue: BredConfig[] = [];

  /** Track exponential breeding chain reactions */
  private exponentialChainCount = 0;

  /** Track fission operations */
  private fissionCount = 0;

  /** Track fusion operations */
  private fusionCount = 0;

  /** Cache of imported proxy URLs to prevent duplicates */
  private importedUrlCache = new Set<string>();

  // --- Reactor Control ------------------------------------------------------

  /**
   * Start the breeding cycle -- ignite the reactor.
   * Begins periodic breeding, natural selection, auto-breeding,
   * intelligence learning, and port discovery loops.
   */
  startBreeding(): void {
    if (this.running) {
      logger.warn('Breeder reactor already running -- ignoring ignition signal');
      return;
    }

    this.running = true;
    logger.info('🔥 Breeder reactor Mk.II ignited -- initiating OVERDRIVE breeding cycle');

    // Periodic breeding -- produce new configs from existing ones (5s cycle)
    this.breedingTimer = setInterval(() => {
      this.runBreedingCycle().catch((err: any) => {
        logger.error({ error: err.message }, 'Breeding cycle error -- reactor instability detected');
      });
    }, BREEDING_INTERVAL_MS);

    // Periodic natural selection -- kill underperformers (60s cycle)
    this.selectionTimer = setInterval(() => {
      this.naturalSelection().catch((err: any) => {
        logger.error({ error: err.message }, 'Natural selection error -- containment breach');
      });
    }, NATURAL_SELECTION_INTERVAL_MS);

    // Auto-breeding check -- ensure pool never goes critical (10s cycle)
    this.autoBreedTimer = setInterval(() => {
      this.checkAutoBreeding().catch((err: any) => {
        logger.error({ error: err.message }, 'Auto-breeding check error');
      });
    }, 10_000);

    // Intelligence learning -- update strategy weights (30s cycle)
    this.intelligenceTimer = setInterval(() => {
      this.updateBreedingIntelligence().catch((err: any) => {
        logger.error({ error: err.message }, 'Intelligence update error');
      });
    }, 30_000);

    // Smart port discovery -- scan for new proxy ports (60s cycle)
    this.portDiscoveryTimer = setInterval(() => {
      this.runSmartPortDiscovery().catch((err: any) => {
        logger.error({ error: err.message }, 'Port discovery error');
      });
    }, 60_000);

    // Load state from Redis cache
    this.loadBredConfigs().catch((err: any) => {
      logger.warn({ error: err.message }, 'Failed to load bred configs from cache');
    });
    this.loadBreedingIntelligence().catch((err: any) => {
      logger.warn({ error: err.message }, 'Failed to load breeding intelligence');
    });
    this.loadSmartPorts().catch((err: any) => {
      logger.warn({ error: err.message }, 'Failed to load smart ports');
    });
  }

  /**
   * Stop breeding -- SCRAM the reactor.
   * Cancels all breeding, selection, auto-breeding, intelligence,
   * and port discovery timers. Persists state to Redis.
   */
  stopBreeding(): void {
    this.running = false;

    if (this.breedingTimer) {
      clearInterval(this.breedingTimer);
      this.breedingTimer = null;
    }

    if (this.selectionTimer) {
      clearInterval(this.selectionTimer);
      this.selectionTimer = null;
    }

    if (this.autoBreedTimer) {
      clearInterval(this.autoBreedTimer);
      this.autoBreedTimer = null;
    }

    if (this.intelligenceTimer) {
      clearInterval(this.intelligenceTimer);
      this.intelligenceTimer = null;
    }

    if (this.portDiscoveryTimer) {
      clearInterval(this.portDiscoveryTimer);
      this.portDiscoveryTimer = null;
    }

    // Persist all state to Redis
    Promise.all([
      this.persistBredConfigs(),
      this.persistBreedingIntelligence(),
      this.persistSmartPorts(),
    ]).catch((err: any) => {
      logger.warn({ error: err.message }, 'Failed to persist reactor state during SCRAM');
    });

    logger.info('☢️ Breeder reactor SCRAM -- all breeding cycles halted');
  }

  /**
   * Emergency SCRAM -- immediately kill all breeding and clear state.
   * Use only in emergency situations.
   */
  emergencyScram(): void {
    this.stopBreeding();
    this.bredConfigs.clear();
    this.pipelineQueue = [];
    this.importedUrlCache.clear();
    logger.warn('🚨 EMERGENCY SCRAM -- all bred configs purged, reactor cold');
  }

  // --- Core Breeding Methods ------------------------------------------------

  /**
   * Breed new configs from a working proxy.
   * This is the primary breeding method -- takes a known-good proxy
   * and generates massive variant configs using ALL strategies in parallel.
   */
  async breedFromProxy(proxyId: string): Promise<BredConfig[]> {
    try {
      const proxy = await db.proxy.findUnique({
        where: { id: proxyId },
      });

      if (!proxy) {
        logger.warn({ proxyId }, 'Cannot breed from proxy -- not found in fuel rods');
        return [];
      }

      if (proxy.retired || proxy.successRate < 0.3) {
        logger.debug({ proxyId, successRate: proxy.successRate }, 'Skipping breed from depleted fuel rod');
        return [];
      }

      const parsed = parseProxyUrl(proxy.url);
      if (!parsed) return [];

      const provider = detectProvider(proxy.url);

      // --- PARALLEL BREEDING: All strategies simultaneously ---
      const breedResults = await Promise.allSettled([
        // Strategy 1: Session mutations -- massive rotation
        Promise.resolve(this.generateSessionMutations(provider, parsed, proxy)),

        // Strategy 2: Port variations -- 50+ ports per IP
        this.generatePortVariations(parsed, proxy, provider),

        // Strategy 3: Protocol variations -- ALL protocols
        Promise.resolve(this.generateProtocolVariations(parsed, proxy, provider)),

        // Strategy 4: Auth pattern variations
        Promise.resolve(this.generateAuthVariations(parsed, proxy, provider)),

        // Strategy 5: Geo-breeding -- expand to similar countries
        proxy.country ? this.geoBreed(proxy.country, proxy.tier) : Promise.resolve([]),

        // Strategy 6: Header/TLS mutations
        this.mutateHeaders(proxy.url),

        // Strategy 7: Country-specific variants
        proxy.country ? this.generateCountrySpecificVariants(parsed, proxy, provider) : Promise.resolve([]),

        // Strategy 8: Subnet breeding from this IP
        this.breedSubnetFromIP(parsed.hostname, proxy),

        // Strategy 9: Cross-provider breeding
        this.crossProviderBreed(parsed, proxy, provider),
      ]);

      // Collect all successful results
      const allBredConfigs: BredConfig[] = [];
      for (const result of breedResults) {
        if (result.status === 'fulfilled' && result.value) {
          allBredConfigs.push(...result.value);
        }
      }

      // Deduplicate by proxy URL
      const deduped = deduplicateBy(allBredConfigs, c => c.proxyUrl);

      // Register all bred configs
      for (const config of deduped) {
        if (!config.parentIds.includes(proxyId)) {
          config.parentIds.push(proxyId);
        }
        this.bredConfigs.set(config.id, config);
        this.stats.totalBred++;
        this.trackStrategyResult(config.breedingStrategy, 0, config.fitnessScore);
      }

      this.recentBreedingTimestamps.push(Date.now());

      // --- EXPONENTIAL BREEDING: Breed from successful new configs ---
      if (deduped.length > 0) {
        this.exponentialBreed(deduped).catch((err: any) => {
          logger.debug({ error: err.message }, 'Exponential breeding chain error');
        });
      }

      logger.info(
        {
          proxyId,
          provider,
          country: proxy.country,
          bredCount: deduped.length,
          strategies: breedResults.length,
        },
        'Parallel breeding from proxy complete -- fuel rod enriched',
      );

      return deduped;
    } catch (err: any) {
      logger.error({ error: err.message, proxyId }, 'Failed to breed from proxy -- fuel rod failure');
      return [];
    }
  }

  /**
   * Mutate a proxy config to create variants.
   * Applies various mutations: session, country, city, ASN, protocol.
   * Now generates ALL protocol variants.
   */
  mutateConfig(config: {
    proxyUrl: string;
    provider?: string;
    country?: string;
    tier?: string;
  }): BredConfig[] {
    const parsed = parseProxyUrl(config.proxyUrl);
    if (!parsed) return [];

    const provider = config.provider || detectProvider(config.proxyUrl);
    const variants: BredConfig[] = [];

    // Mutation 1: New session ID for EACH protocol
    for (const protocol of ALL_PROTOCOLS) {
      const sessionMut = applyProviderMutation(provider, parsed.username, {
        session: generateSessionId('mut'),
      });
      variants.push({
        id: crypto.randomUUID(),
        parentIds: [],
        generation: 1,
        proxyUrl: buildProxyUrl(protocol, sessionMut, parsed.password, parsed.hostname, parsed.port),
        provider,
        country: config.country || 'XX',
        tier: config.tier || 'datacenter',
        mutations: ['session_rotation', 'protocol_variation'],
        fitnessScore: 50,
        successRate: 0,
        requestCount: 0,
        createdAt: Date.now(),
        isActive: true,
        lineage: [],
        breedingStrategy: 'session_mutation',
        pipelineStage: 'generated',
        validationAttempts: 0,
        lastValidatedAt: null,
        timeToValidate: null,
        exponentialDepth: 0,
        fissionGeneration: 0,
        fusionSignature: null,
      });
    }

    // Mutation 2: Different country for each similar country
    if (config.country) {
      const similarCountries = GEO_SIMILARITY_MAP[config.country] || [];
      for (const country of similarCountries) {
        for (const protocol of ALL_PROTOCOLS) {
          const countryMut = applyProviderMutation(provider, parsed.username, {
            country,
            session: generateSessionId('geo'),
          });
          variants.push({
            id: crypto.randomUUID(),
            parentIds: [],
            generation: 1,
            proxyUrl: buildProxyUrl(protocol, countryMut, parsed.password, parsed.hostname, parsed.port),
            provider,
            country,
            tier: config.tier || 'datacenter',
            mutations: ['country_mutation', 'session_rotation', 'protocol_variation'],
            fitnessScore: 40,
            successRate: 0,
            requestCount: 0,
            createdAt: Date.now(),
            isActive: true,
            lineage: [],
            breedingStrategy: 'country_mutation',
            pipelineStage: 'generated',
            validationAttempts: 0,
            lastValidatedAt: null,
            timeToValidate: null,
            exponentialDepth: 0,
            fissionGeneration: 0,
            fusionSignature: null,
          });
        }
      }
    }

    return variants;
  }

  /**
   * Cross-breed two proxy configs.
   * Takes features from both parents to create hybrid children.
   * Enhanced to generate more fusion variants.
   */
  crossBreed(configA: BredConfig, configB: BredConfig): BredConfig[] {
    const parsedA = parseProxyUrl(configA.proxyUrl);
    const parsedB = parseProxyUrl(configB.proxyUrl);
    if (!parsedA || !parsedB) return [];

    const children: BredConfig[] = [];
    const nextGen = Math.max(configA.generation, configB.generation) + 1;

    if (nextGen > MAX_GENERATION) {
      logger.debug({ gen: nextGen }, 'Max generation reached -- cross-breeding stopped');
      return [];
    }

    const fusionSig = generateFusionSignature(configA, configB);

    // Fusion 1: A's geo-targeting + B's provider infrastructure (all protocols)
    for (const protocol of ALL_PROTOCOLS) {
      const crossUsername = applyProviderMutation(configB.provider, parsedB.username, {
        country: configA.country,
        session: generateSessionId('xbreed'),
      });
      children.push({
        id: crypto.randomUUID(),
        parentIds: [configA.id, configB.id],
        generation: nextGen,
        proxyUrl: buildProxyUrl(protocol, crossUsername, parsedB.password, parsedB.hostname, parsedB.port),
        provider: configB.provider,
        country: configA.country,
        tier: configA.tier,
        mutations: ['cross_breed_geo_infra', 'protocol_variation'],
        fitnessScore: 45,
        successRate: 0,
        requestCount: 0,
        createdAt: Date.now(),
        isActive: true,
        lineage: [...configA.lineage, ...configB.lineage, configA.id, configB.id].filter((v, i, a) => a.indexOf(v) === i),
        breedingStrategy: 'fusion_breed',
        pipelineStage: 'generated',
        validationAttempts: 0,
        lastValidatedAt: null,
        timeToValidate: null,
        exponentialDepth: 0,
        fissionGeneration: 0,
        fusionSignature: fusionSig,
      });
    }

    // Fusion 2: B's geo-targeting + A's provider infrastructure (all protocols)
    for (const protocol of ALL_PROTOCOLS) {
      const crossUsername = applyProviderMutation(configA.provider, parsedA.username, {
        country: configB.country,
        session: generateSessionId('xbreed'),
      });
      children.push({
        id: crypto.randomUUID(),
        parentIds: [configA.id, configB.id],
        generation: nextGen,
        proxyUrl: buildProxyUrl(protocol, crossUsername, parsedA.password, parsedA.hostname, parsedA.port),
        provider: configA.provider,
        country: configB.country,
        tier: configB.tier,
        mutations: ['cross_breed_infra_geo', 'protocol_variation'],
        fitnessScore: 45,
        successRate: 0,
        requestCount: 0,
        createdAt: Date.now(),
        isActive: true,
        lineage: [...configA.lineage, ...configB.lineage, configA.id, configB.id].filter((v, i, a) => a.indexOf(v) === i),
        breedingStrategy: 'fusion_breed',
        pipelineStage: 'generated',
        validationAttempts: 0,
        lastValidatedAt: null,
        timeToValidate: null,
        exponentialDepth: 0,
        fissionGeneration: 0,
        fusionSignature: fusionSig,
      });
    }

    // Fusion 3: A's session strategy + B's country + A's port
    const cross3Username = applyProviderMutation(configA.provider, parsedA.username, {
      country: configB.country,
      session: generateSessionId('hybrid'),
    });
    children.push({
      id: crypto.randomUUID(),
      parentIds: [configA.id, configB.id],
      generation: nextGen,
      proxyUrl: buildProxyUrl(parsedA.protocol, cross3Username, parsedA.password, parsedA.hostname, parsedA.port),
      provider: configA.provider,
      country: configB.country,
      tier: configA.tier,
      mutations: ['cross_breed_session_geo'],
      fitnessScore: 42,
      successRate: 0,
      requestCount: 0,
      createdAt: Date.now(),
      isActive: true,
      lineage: [...configA.lineage, ...configB.lineage, configA.id, configB.id].filter((v, i, a) => a.indexOf(v) === i),
      breedingStrategy: 'fusion_breed',
      pipelineStage: 'generated',
      validationAttempts: 0,
      lastValidatedAt: null,
      timeToValidate: null,
      exponentialDepth: 0,
      fissionGeneration: 0,
      fusionSignature: fusionSig,
    });

    // Fusion 4: B's hostname + A's auth + B's port (cross-provider fusion)
    if (configA.provider !== configB.provider) {
      const cross4Url = buildProxyUrl(parsedB.protocol, parsedA.username, parsedA.password, parsedB.hostname, parsedB.port);
      children.push({
        id: crypto.randomUUID(),
        parentIds: [configA.id, configB.id],
        generation: nextGen,
        proxyUrl: cross4Url,
        provider: configB.provider,
        country: configA.country,
        tier: configB.tier,
        mutations: ['cross_provider_fusion'],
        fitnessScore: 38,
        successRate: 0,
        requestCount: 0,
        createdAt: Date.now(),
        isActive: true,
        lineage: [...configA.lineage, ...configB.lineage, configA.id, configB.id].filter((v, i, a) => a.indexOf(v) === i),
        breedingStrategy: 'fusion_breed',
        pipelineStage: 'generated',
        validationAttempts: 0,
        lastValidatedAt: null,
        timeToValidate: null,
        exponentialDepth: 0,
        fissionGeneration: 0,
        fusionSignature: fusionSig,
      });
    }

    // Update fusion stats
    this.fusionCount++;
    this.stats.fusionBreeding.totalFusions = this.fusionCount;

    return children;
  }

  // --- Exponential Breeding -------------------------------------------------

  /**
   * Exponential Breeding -- each successful breed triggers breeding from
   * the newly bred configs, creating a chain reaction of config generation.
   *
   * Like a nuclear chain reaction, each fission event releases neutrons
   * that can trigger further fission events, creating exponential growth.
   */
  async exponentialBreed(seedConfigs: BredConfig[], depth: number = 0): Promise<BredConfig[]> {
    if (depth >= EXPONENTIAL_MAX_DEPTH) {
      logger.debug({ depth }, 'Exponential breeding max depth reached -- chain reaction contained');
      return [];
    }

    if (seedConfigs.length === 0) return [];

    // Only breed from high-fitness configs (the "critical mass")
    const criticalConfigs = seedConfigs.filter(c => c.fitnessScore >= 60);
    if (criticalConfigs.length === 0) return [];

    this.exponentialChainCount++;
    this.stats.exponentialBreeding.totalChainReactions = this.exponentialChainCount;
    this.stats.exponentialBreeding.maxDepth = Math.max(this.stats.exponentialBreeding.maxDepth, depth + 1);

    const childConfigs: BredConfig[] = [];

    // Breed from each critical config in parallel
    const breedPromises = criticalConfigs.map(async (config) => {
      const parsed = parseProxyUrl(config.proxyUrl);
      if (!parsed) return [];

      const localChildren: BredConfig[] = [];

      // Generate session mutations from this bred config
      for (let i = 0; i < 5; i++) {
        const session = generateSessionId(`exp${depth}`);
        const mutatedUsername = applyProviderMutation(config.provider, parsed.username, { session });
        const proxyUrl = buildProxyUrl(parsed.protocol, mutatedUsername, parsed.password, parsed.hostname, parsed.port);

        localChildren.push({
          id: crypto.randomUUID(),
          parentIds: [config.id],
          generation: config.generation + 1,
          proxyUrl,
          provider: config.provider,
          country: config.country,
          tier: config.tier,
          mutations: ['exponential_breed', 'session_rotation'],
          fitnessScore: Math.max(20, config.fitnessScore - (depth + 1) * 5),
          successRate: 0,
          requestCount: 0,
          createdAt: Date.now(),
          isActive: true,
          lineage: [...config.lineage, config.id],
          breedingStrategy: 'exponential_breed',
          pipelineStage: 'generated',
          validationAttempts: 0,
          lastValidatedAt: null,
          timeToValidate: null,
          exponentialDepth: depth + 1,
          fissionGeneration: config.fissionGeneration,
          fusionSignature: null,
        });
      }

      // Generate protocol variants for exponential configs
      for (const protocol of ALL_PROTOCOLS) {
        if (protocol === parsed.protocol) continue;
        const session = generateSessionId(`expproto`);
        const mutatedUsername = applyProviderMutation(config.provider, parsed.username, { session });
        const proxyUrl = buildProxyUrl(protocol, mutatedUsername, parsed.password, parsed.hostname, parsed.port);

        localChildren.push({
          id: crypto.randomUUID(),
          parentIds: [config.id],
          generation: config.generation + 1,
          proxyUrl,
          provider: config.provider,
          country: config.country,
          tier: config.tier,
          mutations: ['exponential_breed', 'protocol_variation'],
          fitnessScore: Math.max(15, config.fitnessScore - (depth + 1) * 8),
          successRate: 0,
          requestCount: 0,
          createdAt: Date.now(),
          isActive: true,
          lineage: [...config.lineage, config.id],
          breedingStrategy: 'exponential_breed',
          pipelineStage: 'generated',
          validationAttempts: 0,
          lastValidatedAt: null,
          timeToValidate: null,
          exponentialDepth: depth + 1,
          fissionGeneration: config.fissionGeneration,
          fusionSignature: null,
        });
      }

      return localChildren;
    });

    const results = await Promise.allSettled(breedPromises);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        childConfigs.push(...result.value);
      }
    }

    // Register exponential children
    for (const config of childConfigs) {
      this.bredConfigs.set(config.id, config);
      this.stats.totalBred++;
      this.trackStrategyResult('exponential_breed', 0, config.fitnessScore);
    }

    // Calculate yield per depth
    const totalYieldAtDepth = childConfigs.length;
    this.stats.exponentialBreeding.avgYieldPerDepth =
      (this.stats.exponentialBreeding.avgYieldPerDepth * depth + totalYieldAtDepth) / (depth + 1);

    logger.info(
      { depth, seedCount: criticalConfigs.length, childCount: childConfigs.length },
      'Exponential breeding chain reaction -- neutron flux increasing',
    );

    // Recursively breed from the children (chain reaction!)
    if (childConfigs.length > 0) {
      const grandChildren = await this.exponentialBreed(childConfigs, depth + 1);
      childConfigs.push(...grandChildren);
    }

    return childConfigs;
  }

  // --- Fission Breeding -----------------------------------------------------

  /**
   * Fission Breeding -- split successful subnets into smaller ranges
   * for finer discovery. Like nuclear fission, we split the atom
   * (subnet) into smaller pieces to release more energy (configs).
   *
   * /24 → /25 → /26 → /27 → /28
   * Each split generates configs for every IP in the new smaller ranges.
   */
  async fissionBreed(cidr: string, successRate: number, fissionGen: number = 0): Promise<FissionResult> {
    if (successRate < 0.3) {
      logger.debug({ cidr, successRate }, 'Fission breed skipped -- insufficient critical mass');
      return { parentCidr: cidr, childCidrs: [], bredConfigs: [], fissionGeneration: fissionGen };
    }

    if (fissionGen >= FISSION_MAX_GENERATION) {
      logger.debug({ cidr, fissionGen }, 'Max fission generation reached -- fission contained');
      return { parentCidr: cidr, childCidrs: [], bredConfigs: [], fissionGeneration: fissionGen };
    }

    const parts = cidr.split('/');
    const prefixLen = parseInt(parts[1], 10);
    const baseIp = parts[0];

    if (prefixLen >= FISSION_MIN_PREFIX) {
      logger.debug({ cidr, prefixLen }, 'Minimum fission prefix reached');
      return { parentCidr: cidr, childCidrs: [], bredConfigs: [], fissionGeneration: fissionGen };
    }

    const newPrefix = prefixLen + 1;
    const ipNum = ipToNumber(baseIp);
    const halfSize = Math.pow(2, 32 - newPrefix);

    // Split into two child subnets
    const childCidrs = [
      `${numberToIp(ipNum)}/${newPrefix}`,
      `${numberToIp(ipNum + halfSize)}/${newPrefix}`,
    ];

    const bredConfigs: BredConfig[] = [];
    this.fissionCount++;
    this.stats.fissionBreeding.totalFissions = this.fissionCount;
    this.stats.fissionBreeding.maxFissionGeneration = Math.max(
      this.stats.fissionBreeding.maxFissionGeneration, fissionGen + 1,
    );

    for (const childCidr of childCidrs) {
      const childParts = childCidr.split('/');
      const childPrefix = parseInt(childParts[1], 10);
      const childBase = childParts[0];

      // Generate sample IPs across the child subnet
      const hostsInSubnet = Math.min(cidrHostCount(childPrefix), 20); // Cap at 20 sample IPs
      const step = Math.max(1, Math.floor(cidrHostCount(childPrefix) / hostsInSubnet));

      const childIpNum = ipToNumber(childBase);
      for (let i = 1; i <= hostsInSubnet; i++) {
        const hostIp = numberToIp(childIpNum + i * step);
        if (!isValidPublicIP(hostIp)) continue;

        // Use smart port discovery if available, otherwise use full port list
        const ports = this.getSmartPortsForIP(hostIp);

        for (const port of ports) {
          for (const protocol of ALL_PROTOCOLS) {
            const configId = crypto.randomUUID();
            const proxyUrl = `${protocol}://${hostIp}:${port}`;

            bredConfigs.push({
              id: configId,
              parentIds: [],
              generation: 1,
              proxyUrl,
              provider: 'fission-bred',
              country: 'XX',
              tier: 'datacenter',
              mutations: ['fission_breed', 'subnet_breed', 'protocol_variation'],
              fitnessScore: Math.round(successRate * 40),
              successRate: 0,
              requestCount: 0,
              createdAt: Date.now(),
              isActive: true,
              lineage: [cidr, childCidr],
              breedingStrategy: 'fission_breed',
              pipelineStage: 'generated',
              validationAttempts: 0,
              lastValidatedAt: null,
              timeToValidate: null,
              exponentialDepth: 0,
              fissionGeneration: fissionGen + 1,
              fusionSignature: null,
            });
          }
        }
      }
    }

    // Register fission configs
    for (const config of bredConfigs) {
      this.bredConfigs.set(config.id, config);
      this.stats.totalBred++;
      this.trackStrategyResult('fission_breed', 0, config.fitnessScore);
    }

    this.stats.fissionBreeding.avgYieldPerFission =
      (this.stats.fissionBreeding.avgYieldPerFission * (this.fissionCount - 1) + bredConfigs.length) / this.fissionCount;

    logger.info(
      { cidr, newPrefix, childCidrs, fissionGen, bredCount: bredConfigs.length },
      'Fission breeding complete -- subnet atom split',
    );

    return {
      parentCidr: cidr,
      childCidrs,
      bredConfigs,
      fissionGeneration: fissionGen + 1,
    };
  }

  // --- Fusion Breeding ------------------------------------------------------

  /**
   * Fusion Breeding -- combine two successful proxy patterns to create
   * hybrid configs that inherit the best traits of both parents.
   *
   * Like nuclear fusion, we combine two lighter elements into a
   * heavier one, releasing enormous energy in the process.
   */
  async fusionBreed(configA: BredConfig, configB: BredConfig): Promise<FusionResult> {
    const parsedA = parseProxyUrl(configA.proxyUrl);
    const parsedB = parseProxyUrl(configB.proxyUrl);

    if (!parsedA || !parsedB) {
      return {
        parentA: configA,
        parentB: configB,
        children: [],
        fusionSignature: '',
      };
    }

    const fusionSig = generateFusionSignature(configA, configB);
    const children: BredConfig[] = [];
    const nextGen = Math.max(configA.generation, configB.generation) + 1;

    if (nextGen > MAX_GENERATION) {
      return { parentA: configA, parentB: configB, children: [], fusionSignature: fusionSig };
    }

    // Fusion Type 1: A's auth + B's endpoint (all protocols)
    for (const protocol of ALL_PROTOCOLS) {
      const fusionUrl = buildProxyUrl(protocol, parsedA.username, parsedA.password, parsedB.hostname, parsedB.port);
      children.push({
        id: crypto.randomUUID(),
        parentIds: [configA.id, configB.id],
        generation: nextGen,
        proxyUrl: fusionUrl,
        provider: configB.provider,
        country: configB.country,
        tier: configA.tier === configB.tier ? configA.tier : 'datacenter',
        mutations: ['fusion_breed', 'auth_cross', 'protocol_variation'],
        fitnessScore: Math.round((configA.fitnessScore + configB.fitnessScore) / 2),
        successRate: 0,
        requestCount: 0,
        createdAt: Date.now(),
        isActive: true,
        lineage: [...configA.lineage, ...configB.lineage, configA.id, configB.id].filter((v, i, a) => a.indexOf(v) === i),
        breedingStrategy: 'fusion_breed',
        pipelineStage: 'generated',
        validationAttempts: 0,
        lastValidatedAt: null,
        timeToValidate: null,
        exponentialDepth: 0,
        fissionGeneration: 0,
        fusionSignature: fusionSig,
      });
    }

    // Fusion Type 2: B's auth + A's endpoint (all protocols)
    for (const protocol of ALL_PROTOCOLS) {
      const fusionUrl = buildProxyUrl(protocol, parsedB.username, parsedB.password, parsedA.hostname, parsedA.port);
      children.push({
        id: crypto.randomUUID(),
        parentIds: [configA.id, configB.id],
        generation: nextGen,
        proxyUrl: fusionUrl,
        provider: configA.provider,
        country: configA.country,
        tier: configA.tier === configB.tier ? configB.tier : 'datacenter',
        mutations: ['fusion_breed', 'auth_cross_reverse', 'protocol_variation'],
        fitnessScore: Math.round((configA.fitnessScore + configB.fitnessScore) / 2) - 5,
        successRate: 0,
        requestCount: 0,
        createdAt: Date.now(),
        isActive: true,
        lineage: [...configA.lineage, ...configB.lineage, configA.id, configB.id].filter((v, i, a) => a.indexOf(v) === i),
        breedingStrategy: 'fusion_breed',
        pipelineStage: 'generated',
        validationAttempts: 0,
        lastValidatedAt: null,
        timeToValidate: null,
        exponentialDepth: 0,
        fissionGeneration: 0,
        fusionSignature: fusionSig,
      });
    }

    // Fusion Type 3: A's auth + B's hostname + A's port (port-keeping fusion)
    const portKeepUrl = buildProxyUrl(parsedA.protocol, parsedA.username, parsedA.password, parsedB.hostname, parsedA.port);
    children.push({
      id: crypto.randomUUID(),
      parentIds: [configA.id, configB.id],
      generation: nextGen,
      proxyUrl: portKeepUrl,
      provider: configB.provider,
      country: configB.country,
      tier: configA.tier,
      mutations: ['fusion_breed', 'port_keep_fusion'],
      fitnessScore: Math.round((configA.fitnessScore + configB.fitnessScore) / 2) - 3,
      successRate: 0,
      requestCount: 0,
      createdAt: Date.now(),
      isActive: true,
      lineage: [...configA.lineage, ...configB.lineage, configA.id, configB.id].filter((v, i, a) => a.indexOf(v) === i),
      breedingStrategy: 'fusion_breed',
      pipelineStage: 'generated',
      validationAttempts: 0,
      lastValidatedAt: null,
      timeToValidate: null,
      exponentialDepth: 0,
      fissionGeneration: 0,
      fusionSignature: fusionSig,
    });

    // Register fusion children
    for (const child of children) {
      this.bredConfigs.set(child.id, child);
      this.stats.totalBred++;
      this.trackStrategyResult('fusion_breed', 0, child.fitnessScore);
    }

    this.fusionCount++;
    this.stats.fusionBreeding.totalFusions = this.fusionCount;
    if (children.length > 0) {
      const avgFitness = children.reduce((s, c) => s + c.fitnessScore, 0) / children.length;
      this.stats.fusionBreeding.avgHybridFitness = Math.round(avgFitness);
      this.stats.fusionBreeding.bestHybridFitness = Math.max(
        this.stats.fusionBreeding.bestHybridFitness,
        ...children.map(c => c.fitnessScore),
      );
    }

    logger.info(
      { parentA: configA.id, parentB: configB.id, childCount: children.length, fusionSig },
      'Fusion breeding complete -- nuclei merged',
    );

    return {
      parentA: configA,
      parentB: configB,
      children,
      fusionSignature: fusionSig,
    };
  }

  // --- Subnet Breeding ------------------------------------------------------

  /**
   * Breed from a successful subnet -- discover adjacent subnets.
   * If 10.0.1.0/24 works well, try 10.0.2.0/24, 10.0.3.0/24, etc.
   * Enhanced: generates ALL protocol variants and 50+ port variations.
   */
  async breedSubnet(cidr: string, successRate: number): Promise<BredConfig[]> {
    if (successRate < 0.3) {
      logger.debug({ cidr, successRate }, 'Skipping subnet breed -- low critical mass');
      return [];
    }

    const parts = cidr.split('/');
    const prefixLen = parseInt(parts[1], 10);
    const ipParts = parts[0].split('.');

    if (ipParts.length !== 4) return [];

    const bredConfigs: BredConfig[] = [];

    if (prefixLen === 24) {
      const thirdOctet = parseInt(ipParts[2], 10);

      for (const offset of COMMON_SUBNET_OFFSETS) {
        for (const direction of [-1, 1]) {
          const newThird = thirdOctet + offset * direction;
          if (newThird < 0 || newThird > 255) continue;

          const sampleIp = `${ipParts[0]}.${ipParts[1]}.${newThird}.1`;

          if (!isValidPublicIP(sampleIp)) continue;

          // Use the full port list for maximum variation
          const ports = this.getSmartPortsForIP(sampleIp);

          for (const port of ports) {
            for (const protocol of ALL_PROTOCOLS) {
              const configId = crypto.randomUUID();
              const proxyUrl = `${protocol}://${sampleIp}:${port}`;

              bredConfigs.push({
                id: configId,
                parentIds: [],
                generation: 1,
                proxyUrl,
                provider: 'subnet-bred',
                country: 'XX',
                tier: 'datacenter',
                mutations: ['subnet_breed', 'protocol_variation', 'port_variation'],
                fitnessScore: Math.round(successRate * 50),
                successRate: 0,
                requestCount: 0,
                createdAt: Date.now(),
                isActive: true,
                lineage: [cidr],
                breedingStrategy: 'subnet_breed',
                pipelineStage: 'generated',
                validationAttempts: 0,
                lastValidatedAt: null,
                timeToValidate: null,
                exponentialDepth: 0,
                fissionGeneration: 0,
                fusionSignature: null,
              });
            }
          }
        }
      }

      // Also try fission on this /24
      const fissionResult = await this.fissionBreed(cidr, successRate);
      bredConfigs.push(...fissionResult.bredConfigs);

    } else if (prefixLen === 16) {
      const secondOctet = parseInt(ipParts[1], 10);

      for (const offset of [1, 2, 3, 5, 10, 20, 50]) {
        for (const direction of [-1, 1]) {
          const newSecond = secondOctet + offset * direction;
          if (newSecond < 0 || newSecond > 255) continue;

          const sampleIp = `${ipParts[0]}.${newSecond}.1.1`;
          if (!isValidPublicIP(sampleIp)) continue;

          const ports = this.getSmartPortsForIP(sampleIp);
          for (const port of ports) {
            for (const protocol of ALL_PROTOCOLS) {
              const configId = crypto.randomUUID();
              const proxyUrl = `${protocol}://${sampleIp}:${port}`;

              bredConfigs.push({
                id: configId,
                parentIds: [],
                generation: 1,
                proxyUrl,
                provider: 'subnet-bred',
                country: 'XX',
                tier: 'datacenter',
                mutations: ['subnet_breed_16', 'protocol_variation', 'port_variation'],
                fitnessScore: Math.round(successRate * 40),
                successRate: 0,
                requestCount: 0,
                createdAt: Date.now(),
                isActive: true,
                lineage: [cidr],
                breedingStrategy: 'subnet_breed',
                pipelineStage: 'generated',
                validationAttempts: 0,
                lastValidatedAt: null,
                timeToValidate: null,
                exponentialDepth: 0,
                fissionGeneration: 0,
                fusionSignature: null,
              });
            }
          }
        }
      }
    }

    // Register bred configs
    for (const config of bredConfigs) {
      this.bredConfigs.set(config.id, config);
      this.stats.totalBred++;
    }

    logger.info({ cidr, successRate, bredCount: bredConfigs.length }, 'Subnet breeding complete -- fuel enriched');
    return bredConfigs;
  }

  /**
   * Breed from an individual IP's subnet -- convenience method.
   */
  private async breedSubnetFromIP(
    hostname: string,
    proxy: any,
  ): Promise<BredConfig[]> {
    if (!isValidPublicIP(hostname)) return [];

    const subnet = getSubnetPrefix(hostname);
    return this.breedSubnet(`${subnet}.0/24`, proxy.successRate || 0.5);
  }

  // --- Geo-Breeding ---------------------------------------------------------

  /**
   * Breed configs for similar countries (geo-breeding).
   * Enhanced to use all similar countries and all protocols.
   */
  async geoBreed(country: string, tier: string): Promise<BredConfig[]> {
    const similarCountries = GEO_SIMILARITY_MAP[country.toUpperCase()] || [];
    if (similarCountries.length === 0) {
      logger.debug({ country }, 'No similar countries found for geo-breeding');
      return [];
    }

    const bredConfigs: BredConfig[] = [];

    // Get working providers for this country (increased from 10 to 50)
    const workingProxies = await db.proxy.findMany({
      where: {
        country: country.toUpperCase(),
        retired: false,
        successRate: { gte: 0.5 },
        tier: tier as any,
      },
      select: { id: true, url: true, provider: true },
      take: 50,
    });

    for (const proxy of workingProxies) {
      const parsed = parseProxyUrl(proxy.url);
      if (!parsed) continue;

      const provider = detectProvider(proxy.url);

      for (const targetCountry of similarCountries) {
        // Generate for all protocols
        for (const protocol of ALL_PROTOCOLS) {
          const mutatedUsername = applyProviderMutation(provider, parsed.username, {
            country: targetCountry,
            session: generateSessionId('geobreed'),
          });

          const configId = crypto.randomUUID();
          const proxyUrl = buildProxyUrl(
            protocol,
            mutatedUsername,
            parsed.password,
            parsed.hostname,
            parsed.port,
          );

          bredConfigs.push({
            id: configId,
            parentIds: [proxy.id],
            generation: 1,
            proxyUrl,
            provider,
            country: targetCountry,
            tier,
            mutations: ['geo_breed', 'protocol_variation'],
            fitnessScore: 40,
            successRate: 0,
            requestCount: 0,
            createdAt: Date.now(),
            isActive: true,
            lineage: [proxy.id],
            breedingStrategy: 'geo_breed',
            pipelineStage: 'generated',
            validationAttempts: 0,
            lastValidatedAt: null,
            timeToValidate: null,
            exponentialDepth: 0,
            fissionGeneration: 0,
            fusionSignature: null,
          });
        }
      }
    }

    // Register bred configs
    for (const config of bredConfigs) {
      this.bredConfigs.set(config.id, config);
      this.stats.totalBred++;
    }

    logger.info(
      { country, tier, similarCountries, bredCount: bredConfigs.length },
      'Geo-breeding complete -- geographic coverage expanded',
    );

    return bredConfigs;
  }

  // --- Variation Generators -------------------------------------------------

  /**
   * Generate 50+ port variations for a successful IP.
   * Uses the comprehensive PROXY_PORTS_FULL list plus smart port discovery.
   */
  private generatePortVariations(
    parsed: { protocol: string; username: string; password: string; hostname: string; port: number },
    proxy: any,
    provider: string,
  ): BredConfig[] {
    const variants: BredConfig[] = [];
    const ports = this.getSmartPortsForIP(parsed.hostname);

    // Use the top 50 ports (or all if fewer than 50)
    const topPorts = ports.slice(0, PORT_VARIATIONS_PER_IP);

    for (const port of topPorts) {
      if (port === parsed.port) continue; // Skip the original port

      for (const protocol of ALL_PROTOCOLS) {
        const session = generateSessionId('port');
        const mutatedUsername = applyProviderMutation(provider, parsed.username, { session });
        const proxyUrl = buildProxyUrl(protocol, mutatedUsername, parsed.password, parsed.hostname, port);

        variants.push({
          id: crypto.randomUUID(),
          parentIds: [proxy.id],
          generation: 1,
          proxyUrl,
          provider,
          country: proxy.country || 'XX',
          tier: proxy.tier || 'datacenter',
          mutations: ['port_variation', 'protocol_variation', 'session_rotation'],
          fitnessScore: 35,
          successRate: 0,
          requestCount: 0,
          createdAt: Date.now(),
          isActive: true,
          lineage: [proxy.id],
          breedingStrategy: 'port_variation',
          pipelineStage: 'generated',
          validationAttempts: 0,
          lastValidatedAt: null,
          timeToValidate: null,
          exponentialDepth: 0,
          fissionGeneration: 0,
          fusionSignature: null,
        });
      }
    }

    return variants;
  }

  /**
   * Generate ALL protocol variations for a proxy.
   */
  private generateProtocolVariations(
    parsed: { protocol: string; username: string; password: string; hostname: string; port: number },
    proxy: any,
    provider: string,
  ): BredConfig[] {
    const variants: BredConfig[] = [];

    for (const protocol of ALL_PROTOCOLS) {
      if (protocol === parsed.protocol) continue;

      const session = generateSessionId('proto');
      const mutatedUsername = applyProviderMutation(provider, parsed.username, { session });
      const proxyUrl = buildProxyUrl(protocol, mutatedUsername, parsed.password, parsed.hostname, parsed.port);

      variants.push({
        id: crypto.randomUUID(),
        parentIds: [proxy.id],
        generation: 1,
        proxyUrl,
        provider,
        country: proxy.country || 'XX',
        tier: proxy.tier || 'datacenter',
        mutations: ['protocol_variation', 'session_rotation'],
        fitnessScore: 45,
        successRate: 0,
        requestCount: 0,
        createdAt: Date.now(),
        isActive: true,
        lineage: [proxy.id],
        breedingStrategy: 'protocol_variation',
        pipelineStage: 'generated',
        validationAttempts: 0,
        lastValidatedAt: null,
        timeToValidate: null,
        exponentialDepth: 0,
        fissionGeneration: 0,
        fusionSignature: null,
      });
    }

    return variants;
  }

  /**
   * Generate auth pattern variations from known auth patterns.
   * Tries common username:password combinations.
   */
  private generateAuthVariations(
    parsed: { protocol: string; username: string; password: string; hostname: string; port: number },
    proxy: any,
    provider: string,
  ): BredConfig[] {
    const variants: BredConfig[] = [];

    // Generate variations with modified auth patterns
    const authVariations = [
      // Original auth with different sessions
      { username: parsed.username, password: parsed.password, label: 'original_auth' },
      // Try without auth (public proxy)
      { username: '', password: '', label: 'no_auth' },
      // Try with common auth patterns
      { username: 'proxy', password: 'proxy', label: 'default_proxy' },
      { username: 'admin', password: 'admin', label: 'default_admin' },
    ];

    for (const auth of authVariations) {
      const session = generateSessionId('auth');
      const mutatedUsername = auth.username
        ? applyProviderMutation(provider, auth.username, { session })
        : '';

      for (const protocol of ALL_PROTOCOLS) {
        const proxyUrl = buildProxyUrl(protocol, mutatedUsername, auth.password, parsed.hostname, parsed.port);

        variants.push({
          id: crypto.randomUUID(),
          parentIds: [proxy.id],
          generation: 1,
          proxyUrl,
          provider,
          country: proxy.country || 'XX',
          tier: proxy.tier || 'datacenter',
          mutations: ['auth_variation', 'protocol_variation', auth.label],
          fitnessScore: auth.username === parsed.username ? 45 : 20,
          successRate: 0,
          requestCount: 0,
          createdAt: Date.now(),
          isActive: true,
          lineage: [proxy.id],
          breedingStrategy: 'auth_variation',
          pipelineStage: 'generated',
          validationAttempts: 0,
          lastValidatedAt: null,
          timeToValidate: null,
          exponentialDepth: 0,
          fissionGeneration: 0,
          fusionSignature: null,
        });
      }
    }

    return variants;
  }

  /**
   * Generate country-specific variants using geo-IP patterns.
   * Uses the country-specific port map and tier map.
   */
  private async generateCountrySpecificVariants(
    parsed: { protocol: string; username: string; password: string; hostname: string; port: number },
    proxy: any,
    provider: string,
  ): Promise<BredConfig[]> {
    const variants: BredConfig[] = [];
    const country = proxy.country?.toUpperCase();

    if (!country) return [];

    // Get country-specific ports
    const countryPorts = COUNTRY_SPECIFIC_PORT_MAP[country] || [];
    const countryTiers = COUNTRY_TIER_MAP[country] || ['datacenter'];

    // Get similar countries
    const similarCountries = GEO_SIMILARITY_MAP[country] || [];

    for (const targetCountry of [country, ...similarCountries]) {
      // Use country-specific ports
      const ports = targetCountry === country && countryPorts.length > 0
        ? countryPorts
        : this.getSmartPortsForIP(parsed.hostname);

      for (const port of ports.slice(0, 10)) {
        for (const protocol of ALL_PROTOCOLS) {
          for (const tier of countryTiers) {
            const session = generateSessionId('cntry');
            const mutatedUsername = applyProviderMutation(provider, parsed.username, {
              country: targetCountry,
              session,
            });

            const proxyUrl = buildProxyUrl(protocol, mutatedUsername, parsed.password, parsed.hostname, port);

            variants.push({
              id: crypto.randomUUID(),
              parentIds: [proxy.id],
              generation: 1,
              proxyUrl,
              provider,
              country: targetCountry,
              tier,
              mutations: ['country_specific', 'port_variation', 'protocol_variation', 'session_rotation'],
              fitnessScore: targetCountry === country ? 45 : 35,
              successRate: 0,
              requestCount: 0,
              createdAt: Date.now(),
              isActive: true,
              lineage: [proxy.id],
              breedingStrategy: 'country_specific',
              pipelineStage: 'generated',
              validationAttempts: 0,
              lastValidatedAt: null,
              timeToValidate: null,
              exponentialDepth: 0,
              fissionGeneration: 0,
              fusionSignature: null,
            });
          }
        }
      }
    }

    return variants;
  }

  /**
   * Cross-provider breeding -- combine provider A's IP with provider B's port.
   * Discovers working endpoints from one provider and applies them to another.
   */
  private async crossProviderBreed(
    parsed: { protocol: string; username: string; password: string; hostname: string; port: number },
    proxy: any,
    provider: string,
  ): Promise<BredConfig[]> {
    const variants: BredConfig[] = [];

    // Get proxies from OTHER providers
    const otherProviderProxies = await db.proxy.findMany({
      where: {
        retired: false,
        successRate: { gte: 0.5 },
        provider: { not: provider },
      },
      select: { id: true, url: true, provider: true, country: true, tier: true },
      take: 20,
    });

    for (const otherProxy of otherProviderProxies) {
      const otherParsed = parseProxyUrl(otherProxy.url);
      if (!otherParsed) continue;

      // Cross: A's auth + B's endpoint
      for (const protocol of ALL_PROTOCOLS) {
        const session = generateSessionId('xprov');
        const mutatedUsername = applyProviderMutation(provider, parsed.username, {
          country: otherProxy.country || '',
          session,
        });

        const proxyUrl = buildProxyUrl(protocol, mutatedUsername, parsed.password, otherParsed.hostname, otherParsed.port);

        variants.push({
          id: crypto.randomUUID(),
          parentIds: [proxy.id, otherProxy.id],
          generation: 1,
          proxyUrl,
          provider,
          country: otherProxy.country || 'XX',
          tier: otherProxy.tier || 'datacenter',
          mutations: ['cross_provider', 'protocol_variation', 'session_rotation'],
          fitnessScore: 35,
          successRate: 0,
          requestCount: 0,
          createdAt: Date.now(),
          isActive: true,
          lineage: [proxy.id, otherProxy.id],
          breedingStrategy: 'cross_provider',
          pipelineStage: 'generated',
          validationAttempts: 0,
          lastValidatedAt: null,
          timeToValidate: null,
          exponentialDepth: 0,
          fissionGeneration: 0,
          fusionSignature: null,
        });
      }
    }

    return variants;
  }

  /**
   * Create header variants for a proxy.
   * Generates unique User-Agent + Accept-Language combinations.
   * Enhanced to produce more variants.
   */
  async mutateHeaders(proxyUrl: string): Promise<BredConfig[]> {
    const parsed = parseProxyUrl(proxyUrl);
    if (!parsed) return [];

    const provider = detectProvider(proxyUrl);
    const variants: BredConfig[] = [];

    // Generate more header mutation variants (10 instead of 3)
    for (let i = 0; i < 10; i++) {
      const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      const lang = ACCEPT_LANGUAGES[Math.floor(Math.random() * ACCEPT_LANGUAGES.length)];
      const cipher = TLS_CIPHER_SUITES[Math.floor(Math.random() * TLS_CIPHER_SUITES.length)];

      const sessionMut = applyProviderMutation(provider, parsed.username, {
        session: generateSessionId('hdr'),
      });

      for (const protocol of ALL_PROTOCOLS) {
        const configId = crypto.randomUUID();
        const variantUrl = buildProxyUrl(
          protocol,
          sessionMut,
          parsed.password,
          parsed.hostname,
          parsed.port,
        );

        const config: BredConfig = {
          id: configId,
          parentIds: [],
          generation: 1,
          proxyUrl: variantUrl,
          provider,
          country: 'XX',
          tier: 'datacenter',
          mutations: ['header_mutation', 'tls_mutation', 'protocol_variation'],
          fitnessScore: 35,
          successRate: 0,
          requestCount: 0,
          createdAt: Date.now(),
          isActive: true,
          lineage: [],
          breedingStrategy: 'header_mutation',
          pipelineStage: 'generated',
          validationAttempts: 0,
          lastValidatedAt: null,
          timeToValidate: null,
          exponentialDepth: 0,
          fissionGeneration: 0,
          fusionSignature: null,
        };

        variants.push(config);

        // Store the header/TLS metadata in Redis
        await cacheSet(
          `bred:headers:${configId}`,
          {
            userAgent: ua,
            acceptLanguage: lang,
            cipherSuite: cipher,
            proxyUrl: variantUrl,
          },
          CACHE_TTL_SECONDS,
        );
      }
    }

    return variants;
  }

  // --- Breeding Pipeline ----------------------------------------------------

  /**
   * Breeding Pipeline -- multi-stage pipeline: GENERATE → VALIDATE → SCORE → IMPORT
   *
   * Like a nuclear fuel processing pipeline:
   * 1. GENERATE  -- Raw uranium is mined (create candidate configs)
   * 2. VALIDATE  -- Enrichment process (test connectivity)
   * 3. SCORE     -- Quality grading (calculate fitness)
   * 4. IMPORT    -- Load into reactor (add to active pool)
   */
  async runBreedingPipeline(configs: BredConfig[]): Promise<BreedingPipelineResult> {
    const startTime = Date.now();
    const result: BreedingPipelineResult = {
      generated: configs.length,
      validated: 0,
      scored: 0,
      imported: 0,
      rejected: 0,
      duration: 0,
    };

    if (configs.length === 0) return result;

    // --- Stage 1: GENERATE (already done -- configs are passed in) ---
    this.stats.pipelineStats.generated += configs.length;

    // --- Stage 2: VALIDATE -- test connectivity in parallel batches ---
    const validatedConfigs: BredConfig[] = [];
    const batches = chunkArray(configs, PIPELINE_CONCURRENCY);

    for (const batch of batches) {
      const validationResults = await Promise.allSettled(
        batch.map(async (config) => {
          config.pipelineStage = 'validating';
          try {
            const testResult = await testProxy(config.proxyUrl, 'https://httpbin.org/ip', 10_000);
            config.pipelineStage = testResult.working ? 'validated' : 'rejected';
            config.validationAttempts++;
            config.lastValidatedAt = Date.now();
            if (testResult.working) {
              config.timeToValidate = Date.now() - config.createdAt;
            }
            return { config, working: testResult.working, latency: testResult.latencyMs };
          } catch {
            config.pipelineStage = 'rejected';
            config.validationAttempts++;
            return { config, working: false, latency: Infinity };
          }
        }),
      );

      for (const res of validationResults) {
        if (res.status === 'fulfilled') {
          if (res.value.working) {
            validatedConfigs.push(res.value.config);
            result.validated++;
            this.trackStrategyResult(res.value.config.breedingStrategy, 1, res.value.config.fitnessScore);
          } else {
            result.rejected++;
          }
        } else {
          result.rejected++;
        }
      }
    }

    this.stats.pipelineStats.validated += result.validated;

    // --- Stage 3: SCORE -- calculate fitness scores ---
    const scoredConfigs: BredConfig[] = [];
    for (const config of validatedConfigs) {
      config.pipelineStage = 'scoring';
      const fitness = await this.evaluateFitness(config.id);
      config.fitnessScore = fitness;
      config.pipelineStage = 'scored';
      result.scored++;

      // Only keep configs above threshold
      if (fitness >= FITNESS_THRESHOLD) {
        scoredConfigs.push(config);
      } else {
        config.pipelineStage = 'rejected';
        result.rejected++;
      }
    }

    this.stats.pipelineStats.scored += result.scored;

    // --- Stage 4: IMPORT -- batch import into the active pool ---
    const importedConfigs = scoredConfigs.slice(0, BATCH_IMPORT_SIZE);
    const importBatches = chunkArray(importedConfigs, 50);

    for (const batch of importBatches) {
      await Promise.allSettled(
        batch.map(async (config) => {
          config.pipelineStage = 'importing';
          try {
            // Import to database
            await db.proxy.upsert({
              where: { id: config.id },
              update: {
                url: config.proxyUrl,
                provider: config.provider,
                country: config.country,
                tier: config.tier as any,
                retired: false,
              },
              create: {
                id: config.id,
                url: config.proxyUrl,
                provider: config.provider,
                country: config.country,
                tier: config.tier as any,
                successRate: 0,
                consecutiveFailures: 0,
                p95Latency: 0,
                retired: false,
              },
            });

            config.pipelineStage = 'imported';
            config.isActive = true;
            this.bredConfigs.set(config.id, config);
            this.importedUrlCache.add(config.proxyUrl);
            result.imported++;
          } catch (err: any) {
            config.pipelineStage = 'rejected';
            result.rejected++;
          }
        }),
      );
    }

    this.stats.pipelineStats.imported += result.imported;
    this.stats.pipelineStats.rejected += result.rejected;

    result.duration = Date.now() - startTime;

    // Update breeding efficiency metrics
    if (result.generated > 0) {
      this.stats.breedingEfficiency = Math.round((result.imported / result.generated) * 100);
      this.stats.yieldRate = Math.round((result.validated / result.generated) * 100);
    }

    // Update average time-to-validate
    const ttvs = importedConfigs
      .filter(c => c.timeToValidate !== null)
      .map(c => c.timeToValidate!);
    if (ttvs.length > 0) {
      const avgTtv = ttvs.reduce((a, b) => a + b, 0) / ttvs.length;
      this.stats.avgTimeToValidate = Math.round(
        (this.stats.avgTimeToValidate * 0.8) + (avgTtv * 0.2),
      );
    }

    logger.info(
      {
        generated: result.generated,
        validated: result.validated,
        scored: result.scored,
        imported: result.imported,
        rejected: result.rejected,
        duration: result.duration,
        efficiency: this.stats.breedingEfficiency,
      },
      'Breeding pipeline complete -- fuel processed and loaded',
    );

    return result;
  }

  // --- Fitness Evaluation ---------------------------------------------------

  /**
   * Evaluate a bred config's fitness score.
   * Tests the proxy and calculates a fitness score based on
   * connectivity, latency, and historical success rate.
   * Enhanced with breeding strategy bonus and generation penalty.
   */
  async evaluateFitness(proxyId: string): Promise<number> {
    const config = this.bredConfigs.get(proxyId);

    // Also check database for the proxy
    let proxy: any = null;
    try {
      proxy = await db.proxy.findUnique({ where: { id: proxyId } });
    } catch {
      // Ignore DB errors
    }

    if (config) {
      // Test the bred config
      try {
        const result = await testProxy(config.proxyUrl, 'https://httpbin.org/ip', 15_000);

        let score = 0;

        if (result.working) {
          // Base score for connectivity
          score += 40;

          // Latency bonus (lower = better)
          if (result.latencyMs < 300) score += 25;
          else if (result.latencyMs < 500) score += 20;
          else if (result.latencyMs < 1000) score += 15;
          else if (result.latencyMs < 2000) score += 10;
          else if (result.latencyMs < 5000) score += 5;

          // Success rate bonus from history
          if (proxy && proxy.successRate > 0.8) score += 25;
          else if (proxy && proxy.successRate > 0.5) score += 15;
          else if (proxy && proxy.successRate > 0.3) score += 5;

          // Generation penalty (later generations are less certain)
          score -= config.generation * 2;

          // Exponential depth penalty (deeper chain reactions are less reliable)
          score -= config.exponentialDepth * 3;

          // Strategy bonus -- certain strategies get a bonus
          if (config.breedingStrategy === 'session_mutation') score += 5;
          if (config.breedingStrategy === 'geo_breed') score += 3;
          if (config.breedingStrategy === 'port_variation') score += 2;

          // Time-to-validate bonus (faster validation = higher quality)
          if (config.timeToValidate && config.timeToValidate < 2000) score += 5;

        } else {
          score = 5; // Minimal score for non-working
        }

        config.fitnessScore = Math.max(0, Math.min(100, score));
        config.requestCount++;

        if (result.working) {
          config.successRate = (config.successRate * config.requestCount + 1) / (config.requestCount + 1);
        } else {
          config.successRate = (config.successRate * config.requestCount) / (config.requestCount + 1);
        }

        return config.fitnessScore;
      } catch {
        config.fitnessScore = 0;
        return 0;
      }
    }

    if (proxy) {
      // Evaluate from DB proxy data
      let score = 0;

      score += proxy.successRate * 60;

      if (proxy.p95Latency < 500) score += 20;
      else if (proxy.p95Latency < 1500) score += 10;

      if (!proxy.retired) score += 10;

      if (proxy.consecutiveFailures === 0) score += 10;
      else if (proxy.consecutiveFailures <= 2) score += 5;

      return Math.min(100, Math.max(0, score));
    }

    return 0;
  }

  // --- Natural Selection ----------------------------------------------------

  /**
   * Natural selection -- kill underperforming bred configs.
   * This is the evolutionary pressure that ensures only fit configs survive.
   * Enhanced with config half-life decay and parallel evaluation.
   */
  async naturalSelection(): Promise<number> {
    let killed = 0;
    const toEvaluate: string[] = [];

    for (const [id, config] of this.bredConfigs) {
      // Check config half-life -- decay unvalidated configs
      const age = Date.now() - config.createdAt;
      if (age > CONFIG_HALF_LIFE_MS && config.validationAttempts === 0) {
        config.isActive = false;
        this.bredConfigs.delete(id);
        this.stats.totalKilled++;
        killed++;
        continue;
      }

      toEvaluate.push(id);
    }

    // Evaluate fitness in parallel batches
    const batches = chunkArray(toEvaluate, PIPELINE_CONCURRENCY);
    for (const batch of batches) {
      const results = await Promise.allSettled(
        batch.map(id => this.evaluateFitness(id)),
      );

      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        const id = batch[i];

        if (res.status === 'fulfilled' && res.value < FITNESS_THRESHOLD) {
          const config = this.bredConfigs.get(id);
          if (config) {
            config.isActive = false;
            this.bredConfigs.delete(id);
            this.stats.totalKilled++;
            killed++;

            // Also retire in DB if it was imported
            try {
              await db.proxy.update({
                where: { id },
                data: { retired: true },
              }).catch(() => {});
            } catch {
              // Ignore -- may not exist in DB
            }
          }
        } else if (res.status === 'fulfilled') {
          this.stats.totalSelected++;
        }
      }
    }

    // Cap active configs -- keep the fittest (survival of the fittest)
    const activeConfigs = Array.from(this.bredConfigs.values())
      .filter(c => c.isActive)
      .sort((a, b) => b.fitnessScore - a.fitnessScore);

    if (activeConfigs.length > MAX_ACTIVE_CONFIGS) {
      const toKill = activeConfigs.slice(MAX_ACTIVE_CONFIGS);
      for (const config of toKill) {
        config.isActive = false;
        this.bredConfigs.delete(config.id);
        this.stats.totalKilled++;
        killed++;
      }
    }

    logger.info({ killed, surviving: this.bredConfigs.size }, 'Natural selection round complete -- weak configs eliminated');
    return killed;
  }

  // --- Auto-Breeding -------------------------------------------------------

  /**
   * Check if auto-breeding should be triggered.
   * Automatically breed when pool drops below target threshold.
   */
  private async checkAutoBreeding(): Promise<void> {
    if (!this.autoBreedConfig.enabled || !this.running) return;

    const activeCount = Array.from(this.bredConfigs.values()).filter(c => c.isActive).length;

    if (activeCount < this.autoBreedConfig.targetPoolSize) {
      this.stats.autoBreedingTriggers++;
      const deficit = this.autoBreedConfig.targetPoolSize - activeCount;
      const burstSize = Math.min(deficit * 2, this.autoBreedConfig.maxBurstSize);

      logger.info(
        { activeCount, targetSize: this.autoBreedConfig.targetPoolSize, burstSize },
        'Auto-breeding triggered -- pool below critical mass',
      );

      // Get top proxies for emergency breeding
      const topProxies = await db.proxy.findMany({
        where: {
          retired: false,
          successRate: { gte: 0.4 },
        },
        orderBy: { successRate: 'desc' },
        select: { id: true, url: true, country: true, tier: true, provider: true, successRate: true },
        take: 20,
      });

      // Breed from top proxies in parallel to fill the gap
      const breedPromises = topProxies.map(proxy =>
        this.breedFromProxy(proxy.id).catch(() => []),
      );

      const results = await Promise.allSettled(breedPromises);
      let totalBred = 0;
      for (const res of results) {
        if (res.status === 'fulfilled') {
          totalBred += res.value.length;
        }
      }

      logger.info(
        { totalBred, activeCount: this.bredConfigs.size },
        'Auto-breeding burst complete -- reactor recharged',
      );
    }
  }

  /**
   * Update auto-breeding configuration.
   */
  setAutoBreedConfig(config: Partial<AutoBreedingConfig>): void {
    this.autoBreedConfig = { ...this.autoBreedConfig, ...config };
    logger.info({ config: this.autoBreedConfig }, 'Auto-breeding configuration updated');
  }

  // --- Breeding Intelligence ------------------------------------------------

  /**
   * Track the result of a breeding strategy.
   * This feeds into the intelligence system for learning.
   */
  private trackStrategyResult(strategy: BreedingStrategy, success: number, fitness: number): void {
    const key = strategy;
    const entry = this.breedingIntelligence.get(key) || {
      strategy,
      attempts: 0,
      successes: 0,
      avgFitness: 0,
      avgTimeToValidate: 0,
      lastUsed: Date.now(),
      priorityWeight: 50,
    };

    entry.attempts++;
    entry.successes += success;
    entry.avgFitness = (entry.avgFitness * (entry.attempts - 1) + fitness) / entry.attempts;
    entry.lastUsed = Date.now();

    // Update priority weight based on success rate
    const successRate = entry.successes / entry.attempts;
    entry.priorityWeight = Math.round(
      (successRate * 40) + (entry.avgFitness / 100 * 30) + (30), // Base weight of 30
    );

    this.breedingIntelligence.set(key, entry);
  }

  /**
   * Update breeding intelligence -- recalculate strategy weights.
   * This is the "moderator" that adjusts the reaction rate.
   */
  private async updateBreedingIntelligence(): Promise<void> {
    let totalAttempts = 0;
    let totalSuccesses = 0;

    for (const [key, entry] of this.breedingIntelligence) {
      totalAttempts += entry.attempts;
      totalSuccesses += entry.successes;

      // Decay old strategies (reduce weight for strategies not used recently)
      const age = Date.now() - entry.lastUsed;
      if (age > 300_000) { // 5 minutes
        entry.priorityWeight = Math.max(10, entry.priorityWeight - 5);
      }
    }

    // Update overall stats
    if (totalAttempts > 0) {
      this.stats.yieldRate = Math.round((totalSuccesses / totalAttempts) * 100);
    }

    // Persist intelligence to Redis
    await this.persistBreedingIntelligence();
  }

  /**
   * Get the priority-ordered list of breeding strategies.
   * Strategies with higher weights are prioritized.
   */
  getBreedingPriorities(): BreedingIntelligenceEntry[] {
    return Array.from(this.breedingIntelligence.values())
      .sort((a, b) => b.priorityWeight - a.priorityWeight);
  }

  // --- Smart Port Discovery -------------------------------------------------

  /**
   * Get smart ports for a given IP address.
   * Returns ports ranked by likelihood of having a proxy,
   * based on historical data and known patterns.
   */
  private getSmartPortsForIP(ip: string): number[] {
    // Start with known high-probability ports from smart discovery
    const smartPorts = Array.from(this.smartPorts.values())
      .sort((a, b) => b.hitRate - a.hitRate)
      .slice(0, 20)
      .map(e => e.port);

    // Add the full port list as fallback
    const allPorts = [...new Set([...smartPorts, ...PROXY_PORTS_FULL])];

    return allPorts.slice(0, PORT_VARIATIONS_PER_IP);
  }

  /**
   * Run smart port discovery -- learn which ports are most likely
   * to have proxies by analyzing historical data.
   */
  private async runSmartPortDiscovery(): Promise<void> {
    try {
      // Analyze working proxies to learn port distributions
      const workingProxies = await db.proxy.findMany({
        where: {
          retired: false,
          successRate: { gte: 0.5 },
        },
        select: { url: true, provider: true, successRate: true },
        take: 500,
      });

      const portStats = new Map<number, { hits: number; misses: number; provider: string; protocol: string }>();

      for (const proxy of workingProxies) {
        const parsed = parseProxyUrl(proxy.url);
        if (!parsed) continue;

        const key = parsed.port;
        const entry = portStats.get(key) || { hits: 0, misses: 0, provider: proxy.provider, protocol: parsed.protocol };
        entry.hits++;
        portStats.set(key, entry);
      }

      // Update smart port entries
      for (const [port, data] of portStats) {
        const existing = this.smartPorts.get(port) || {
          port,
          hits: 0,
          misses: 0,
          hitRate: 0,
          lastSeen: Date.now(),
          provider: data.provider,
          protocol: data.protocol,
        };

        existing.hits += data.hits;
        existing.hitRate = existing.hits / (existing.hits + existing.misses);
        existing.lastSeen = Date.now();
        existing.provider = data.provider;
        existing.protocol = data.protocol;

        this.smartPorts.set(port, existing);
      }

      // Update stats
      this.stats.smartPortDiscovery.totalPortsScanned = this.smartPorts.size;
      this.stats.smartPortDiscovery.discoveredPorts = Array.from(this.smartPorts.keys());
      this.stats.smartPortDiscovery.topPorts = Array.from(this.smartPorts.values())
        .sort((a, b) => b.hitRate - a.hitRate)
        .slice(0, 20)
        .map(e => ({ port: e.port, hitRate: Math.round(e.hitRate * 100) / 100 }));

      // Persist to Redis
      await this.persistSmartPorts();
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Smart port discovery error');
    }
  }

  // --- Lineage & Stats ------------------------------------------------------

  /**
   * Get the full breeding lineage for a proxy.
   * Returns the ancestry chain from oldest to newest.
   */
  getLineage(proxyId: string): string[] {
    const config = this.bredConfigs.get(proxyId);
    if (!config) return [];

    return config.lineage;
  }

  /**
   * Get breeder statistics.
   * Enhanced with all Mk.II metrics.
   */
  getStats(): BreederStats {
    const activeConfigs = Array.from(this.bredConfigs.values()).filter(c => c.isActive);

    this.stats.totalActive = activeConfigs.length;
    this.stats.avgFitnessScore = activeConfigs.length > 0
      ? Math.round(activeConfigs.reduce((sum, c) => sum + c.fitnessScore, 0) / activeConfigs.length)
      : 0;
    this.stats.bestFitnessScore = activeConfigs.length > 0
      ? Math.max(...activeConfigs.map(c => c.fitnessScore))
      : 0;

    // Calculate breeding rate (configs per minute)
    const oneMinAgo = Date.now() - 60_000;
    const recentBreeds = this.recentBreedingTimestamps.filter(t => t > oneMinAgo).length;
    this.stats.breedingRate = recentBreeds;

    // Neutron flux -- configs per second
    const fiveSecAgo = Date.now() - 5_000;
    const recentBreeds5s = this.recentBreedingTimestamps.filter(t => t > fiveSecAgo).length;
    this.stats.currentNeutronFlux = recentBreeds5s / 5;

    // Check if producing net fuel (more active configs than killed)
    this.stats.isProducingNetFuel = this.stats.totalBred > this.stats.totalKilled;

    // Calculate generation stats
    this.stats.currentGeneration = activeConfigs.length > 0
      ? Math.max(...activeConfigs.map(c => c.generation))
      : 0;

    // By generation breakdown
    const genMap = new Map<number, { count: number; totalFitness: number }>();
    for (const config of activeConfigs) {
      const entry = genMap.get(config.generation) || { count: 0, totalFitness: 0 };
      entry.count++;
      entry.totalFitness += config.fitnessScore;
      genMap.set(config.generation, entry);
    }

    this.stats.byGeneration = {};
    for (const [gen, data] of genMap) {
      this.stats.byGeneration[gen] = {
        count: data.count,
        avgFitness: Math.round(data.totalFitness / data.count),
      };
    }

    // By mutation breakdown
    const mutMap = new Map<string, { count: number; totalSuccess: number }>();
    for (const config of activeConfigs) {
      for (const mutation of config.mutations) {
        const entry = mutMap.get(mutation) || { count: 0, totalSuccess: 0 };
        entry.count++;
        entry.totalSuccess += config.successRate;
        mutMap.set(mutation, entry);
      }
    }

    this.stats.byMutation = {};
    for (const [mut, data] of mutMap) {
      this.stats.byMutation[mut] = {
        count: data.count,
        successRate: data.count > 0 ? Math.round((data.totalSuccess / data.count) * 100) / 100 : 0,
      };
    }

    // By strategy breakdown
    const stratMap = new Map<string, { count: number; totalSuccess: number; totalTtv: number }>();
    for (const config of activeConfigs) {
      const entry = stratMap.get(config.breedingStrategy) || { count: 0, totalSuccess: 0, totalTtv: 0 };
      entry.count++;
      entry.totalSuccess += config.successRate;
      if (config.timeToValidate) entry.totalTtv += config.timeToValidate;
      stratMap.set(config.breedingStrategy, entry);
    }

    this.stats.byStrategy = {};
    for (const [strat, data] of stratMap) {
      this.stats.byStrategy[strat] = {
        count: data.count,
        successRate: data.count > 0 ? Math.round((data.totalSuccess / data.count) * 100) / 100 : 0,
        avgTimeToValidate: data.count > 0 ? Math.round(data.totalTtv / data.count) : 0,
      };
    }

    return { ...this.stats };
  }

  /**
   * Get statistics for a specific generation.
   */
  getGenerationStats(generation: number): {
    count: number;
    avgFitness: number;
    bestFitness: number;
    worstFitness: number;
    avgSuccessRate: number;
    topMutations: string[];
    configs: BredConfig[];
  } {
    const genConfigs = Array.from(this.bredConfigs.values())
      .filter(c => c.generation === generation && c.isActive);

    if (genConfigs.length === 0) {
      return {
        count: 0,
        avgFitness: 0,
        bestFitness: 0,
        worstFitness: 0,
        avgSuccessRate: 0,
        topMutations: [],
        configs: [],
      };
    }

    const fitnessScores = genConfigs.map(c => c.fitnessScore);
    const mutationCounts = new Map<string, number>();

    for (const config of genConfigs) {
      for (const mutation of config.mutations) {
        mutationCounts.set(mutation, (mutationCounts.get(mutation) || 0) + 1);
      }
    }

    const topMutations = Array.from(mutationCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([m]) => m);

    return {
      count: genConfigs.length,
      avgFitness: Math.round(fitnessScores.reduce((a, b) => a + b, 0) / fitnessScores.length),
      bestFitness: Math.max(...fitnessScores),
      worstFitness: Math.min(...fitnessScores),
      avgSuccessRate: Math.round(genConfigs.reduce((s, c) => s + c.successRate, 0) / genConfigs.length * 100) / 100,
      topMutations,
      configs: genConfigs.sort((a, b) => b.fitnessScore - a.fitnessScore),
    };
  }

  /**
   * Get all active bred configs.
   */
  getActiveConfigs(): BredConfig[] {
    return Array.from(this.bredConfigs.values()).filter(c => c.isActive);
  }

  /**
   * Get configs by breeding strategy.
   */
  getConfigsByStrategy(strategy: BreedingStrategy): BredConfig[] {
    return Array.from(this.bredConfigs.values())
      .filter(c => c.breedingStrategy === strategy && c.isActive);
  }

  /**
   * Get pipeline statistics.
   */
  getPipelineStats(): BreederStats['pipelineStats'] {
    return { ...this.stats.pipelineStats };
  }

  /**
   * Get smart port discovery stats.
   */
  getSmartPortStats(): BreederStats['smartPortDiscovery'] {
    return { ...this.stats.smartPortDiscovery };
  }

  /**
   * Get auto-breeding config.
   */
  getAutoBreedConfig(): AutoBreedingConfig {
    return { ...this.autoBreedConfig };
  }

  // --- Private Methods ------------------------------------------------------

  /**
   * Run a breeding cycle -- pick the best proxies and breed from them.
   * Enhanced: breeds from ALL patterns simultaneously with Promise.allSettled,
   * targets 1000+ configs per cycle, and prioritizes high-success patterns.
   */
  private async runBreedingCycle(): Promise<void> {
    if (!this.running) return;

    try {
      const cycleStart = Date.now();

      // Get top-performing proxies from DB (increased from 10 to 50)
      const topProxies = await db.proxy.findMany({
        where: {
          retired: false,
          successRate: { gte: 0.4 },  // Lowered threshold for more fuel rods
          consecutiveFailures: { lte: 3 },
        },
        orderBy: { successRate: 'desc' },
        select: { id: true, url: true, country: true, tier: true, provider: true, successRate: true },
        take: 50,  // Breed from top 50 (was 3)
      });

      if (topProxies.length === 0) {
        logger.debug('No top proxies available for breeding -- reactor starved');
        return;
      }

      // --- BREEDING PRIORITY: Sort by success rate (highest first) ---
      const prioritizedProxies = topProxies.sort((a, b) => b.successRate - a.successRate);

      // --- PARALLEL BREEDING: Breed from ALL patterns simultaneously ---
      const breedPromises = prioritizedProxies
        .slice(0, PARALLEL_BREED_LIMIT)
        .map(proxy => this.breedFromProxy(proxy.id));

      const breedResults = await Promise.allSettled(breedPromises);

      let totalBred = 0;
      for (const res of breedResults) {
        if (res.status === 'fulfilled') {
          totalBred += res.value.length;
        }
      }

      // --- CROSS-BREEDING: Multiple fusion pairs ---
      const activeConfigs = Array.from(this.bredConfigs.values())
        .filter(c => c.isActive && c.fitnessScore >= 50);

      if (activeConfigs.length >= 4) {
        // Create multiple fusion pairs (up to 10)
        const fusionPairs: [BredConfig, BredConfig][] = [];
        const shuffled = [...activeConfigs].sort(() => Math.random() - 0.5);

        for (let i = 0; i < Math.min(10, Math.floor(shuffled.length / 2)); i++) {
          const a = shuffled[i * 2];
          const b = shuffled[i * 2 + 1];
          if (a && b) {
            fusionPairs.push([a, b]);
          }
        }

        // Fuse all pairs in parallel
        const fusionResults = await Promise.allSettled(
          fusionPairs.map(([a, b]) => this.fusionBreed(a, b)),
        );

        for (const res of fusionResults) {
          if (res.status === 'fulfilled') {
            totalBred += res.value.children.length;
          }
        }
      }

      // --- SUBNET BREEDING from successful subnets ---
      const subnetGroups = new Map<string, { count: number; totalSuccess: number }>();
      for (const proxy of topProxies) {
        const parsed = parseProxyUrl(proxy.url);
        if (!parsed) continue;

        const subnet = getSubnetPrefix(parsed.hostname);
        const entry = subnetGroups.get(subnet) || { count: 0, totalSuccess: 0 };
        entry.count++;
        entry.totalSuccess += proxy.successRate;
        subnetGroups.set(subnet, entry);
      }

      // Breed from top subnets in parallel
      const topSubnets = Array.from(subnetGroups.entries())
        .filter(([, data]) => data.count >= 1 && data.totalSuccess / data.count > 0.4)
        .sort((a, b) => (b[1].totalSuccess / b[1].count) - (a[1].totalSuccess / a[1].count))
        .slice(0, 10);  // Top 10 subnets (was 3)

      const subnetResults = await Promise.allSettled(
        topSubnets.map(([subnet, data]) =>
          this.breedSubnet(`${subnet}.0/24`, data.totalSuccess / data.count),
        ),
      );

      for (const res of subnetResults) {
        if (res.status === 'fulfilled') {
          totalBred += res.value.length;
        }
      }

      // --- FISSION BREEDING from highly successful subnets ---
      const highlySuccessfulSubnets = topSubnets
        .filter(([, data]) => data.totalSuccess / data.count > 0.7);

      const fissionResults = await Promise.allSettled(
        highlySuccessfulSubnets.map(([subnet, data]) =>
          this.fissionBreed(`${subnet}.0/24`, data.totalSuccess / data.count),
        ),
      );

      for (const res of fissionResults) {
        if (res.status === 'fulfilled') {
          totalBred += res.value.bredConfigs.length;
        }
      }

      this.recentBreedingTimestamps.push(Date.now());

      // Clean up timestamps older than 1 minute
      const oneMinAgo = Date.now() - 60_000;
      this.recentBreedingTimestamps = this.recentBreedingTimestamps.filter(t => t > oneMinAgo);

      const cycleDuration = Date.now() - cycleStart;

      logger.info(
        {
          bredFromProxies: prioritizedProxies.length,
          activeConfigs: this.bredConfigs.size,
          totalBredThisCycle: totalBred,
          cycleDuration,
          neutronFlux: totalBred / (cycleDuration / 1000),
        },
        'Breeding cycle complete -- reactor output measured',
      );

      // --- BREEDING PIPELINE: Run pipeline on excess configs if needed ---
      const unprocessedConfigs = Array.from(this.bredConfigs.values())
        .filter(c => c.pipelineStage === 'generated')
        .slice(0, BATCH_IMPORT_SIZE);

      if (unprocessedConfigs.length >= 100) {
        this.runBreedingPipeline(unprocessedConfigs).catch((err: any) => {
          logger.debug({ error: err.message }, 'Pipeline processing error');
        });
      }
    } catch (err: any) {
      logger.error({ error: err.message }, 'Breeding cycle failed -- reactor malfunction');
    }
  }

  /**
   * Generate session mutation variants for a proxy.
   * Enhanced to produce more variants with all protocols.
   */
  private generateSessionMutations(
    provider: string,
    parsed: { protocol: string; username: string; password: string; hostname: string; port: number },
    proxy: any,
  ): BredConfig[] {
    const variants: BredConfig[] = [];

    // Generate 10 session variants (was 3)
    for (let i = 0; i < 10; i++) {
      const session = generateSessionId(`breed${i}`);
      const mutatedUsername = applyProviderMutation(provider, parsed.username, { session });

      for (const protocol of ALL_PROTOCOLS) {
        const proxyUrl = buildProxyUrl(
          protocol,
          mutatedUsername,
          parsed.password,
          parsed.hostname,
          parsed.port,
        );

        variants.push({
          id: crypto.randomUUID(),
          parentIds: [proxy.id],
          generation: 1,
          proxyUrl,
          provider,
          country: proxy.country || 'XX',
          tier: proxy.tier || 'datacenter',
          mutations: ['session_rotation', 'protocol_variation'],
          fitnessScore: 50,
          successRate: 0,
          requestCount: 0,
          createdAt: Date.now(),
          isActive: true,
          lineage: [proxy.id],
          breedingStrategy: 'session_mutation',
          pipelineStage: 'generated',
          validationAttempts: 0,
          lastValidatedAt: null,
          timeToValidate: null,
          exponentialDepth: 0,
          fissionGeneration: 0,
          fusionSignature: null,
        });
      }
    }

    return variants;
  }

  // --- Persistence ----------------------------------------------------------

  /**
   * Load bred configs from Redis cache.
   */
  private async loadBredConfigs(): Promise<void> {
    try {
      const cached = await cacheGet<BredConfig[]>('breeder:configs');
      if (cached && Array.isArray(cached)) {
        for (const config of cached) {
          if (config.isActive) {
            // Ensure Mk.II fields have defaults for backward compatibility
            const fullConfig: BredConfig = {
              ...config,
              breedingStrategy: config.breedingStrategy || 'session_mutation',
              pipelineStage: config.pipelineStage || 'generated',
              validationAttempts: config.validationAttempts || 0,
              lastValidatedAt: config.lastValidatedAt || null,
              timeToValidate: config.timeToValidate || null,
              exponentialDepth: config.exponentialDepth || 0,
              fissionGeneration: config.fissionGeneration || 0,
              fusionSignature: config.fusionSignature || null,
            };
            this.bredConfigs.set(config.id, fullConfig);
            this.importedUrlCache.add(config.proxyUrl);
          }
        }
        logger.info({ loaded: cached.length }, 'Loaded bred configs from cache -- reactor fuel rods installed');
      }
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to load bred configs');
    }
  }

  /**
   * Persist bred configs to Redis cache.
   */
  private async persistBredConfigs(): Promise<void> {
    try {
      const configs = Array.from(this.bredConfigs.values())
        .filter(c => c.isActive)
        .slice(0, MAX_ACTIVE_CONFIGS);

      await cacheSet('breeder:configs', configs, CACHE_TTL_SECONDS);

      logger.debug({ persisted: configs.length }, 'Persisted bred configs to cache');
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to persist bred configs');
    }
  }

  /**
   * Load breeding intelligence from Redis cache.
   */
  private async loadBreedingIntelligence(): Promise<void> {
    try {
      const cached = await cacheGet<BreedingIntelligenceEntry[]>(INTELLIGENCE_CACHE_KEY);
      if (cached && Array.isArray(cached)) {
        for (const entry of cached) {
          this.breedingIntelligence.set(entry.strategy, entry);
        }
        logger.info({ loaded: cached.length }, 'Loaded breeding intelligence from cache');
      }
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to load breeding intelligence');
    }
  }

  /**
   * Persist breeding intelligence to Redis cache.
   */
  private async persistBreedingIntelligence(): Promise<void> {
    try {
      const entries = Array.from(this.breedingIntelligence.values());
      await cacheSet(INTELLIGENCE_CACHE_KEY, entries, CACHE_TTL_SECONDS);

      logger.debug({ persisted: entries.length }, 'Persisted breeding intelligence to cache');
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to persist breeding intelligence');
    }
  }

  /**
   * Load smart ports from Redis cache.
   */
  private async loadSmartPorts(): Promise<void> {
    try {
      const cached = await cacheGet<SmartPortEntry[]>(SMART_PORT_CACHE_KEY);
      if (cached && Array.isArray(cached)) {
        for (const entry of cached) {
          this.smartPorts.set(entry.port, entry);
        }
        logger.info({ loaded: cached.length }, 'Loaded smart ports from cache');
      }
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to load smart ports');
    }
  }

  /**
   * Persist smart ports to Redis cache.
   */
  private async persistSmartPorts(): Promise<void> {
    try {
      const entries = Array.from(this.smartPorts.values());
      await cacheSet(SMART_PORT_CACHE_KEY, entries, CACHE_TTL_SECONDS);

      logger.debug({ persisted: entries.length }, 'Persisted smart ports to cache');
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to persist smart ports');
    }
  }
}

// --- Singleton ----------------------------------------------------------------

export const breederReactor = new BreederReactor();
