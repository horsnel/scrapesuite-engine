/**
 * Chain Reaction Discovery Engine -- ENHANCED EDITION
 *
 * Like nuclear fission, each discovered proxy triggers discovery of MORE proxies
 * from adjacent networks. This engine implements the full cascade amplification
 * pipeline: seed → discover → validate → cascade → repeat.
 *
 * +----------------------------------------------------------------------+
 * |                   NUCLEAR FISSION METAPHOR                          |
 * |                                                                      |
 * |  SEED PROXY --- NEUTRON ---> ADJACENT IPs ---> FISSION EVENT       |
 * |       |                              |                               |
 * |       |    +-------- NEUTRON MULTIPLICATION ◄-----+                 |
 * |       |    |  Level 0: 3x  |  Level 1-3: 2x      |                 |
 * |       |    |  Level 4-8: 1.5x  |  Failed: -1     |                 |
 * |       |    +------------------+-------------------+                 |
 * |       ▼                       ▼                                     |
 * |  CASCADE --► VALIDATE --► DEEPER CASCADE --► SELF-SUSTAINING       |
 * |       |                       |                                     |
 * |       ▼                       ▼                                     |
 * |  HOT SUBNET TRACKING    PARALLEL CASCADE EXECUTION                 |
 * |  (>30% rate = HOT)      (up to 10 concurrent cascades)             |
 * |  (<5% rate = COLD)      (semaphore-controlled)                     |
 * |                                                                      |
 * |  AMPLIFICATION BOOST:                                               |
 * |    > 1.0 → 2x adjacent IP ranges                                   |
 * |    > 2.0 → 3x port scanning                                        |
 * |    > 5.0 → add full /16 subnet scanning                             |
 * +----------------------------------------------------------------------+
 *
 * Features:
 * - Neutron multiplication: each successful cascade multiplies next cascade size
 * - Hot subnet tracking: prioritize subnets yielding the most proxies
 * - Parallel cascade execution: up to 10 concurrent cascades
 * - Smart seeding: seed from best proxies first (success rate × recency × diversity)
 * - Cascade amplification boost: self-sustaining mode intensifies scanning
 * - Provider chain expansion: 15+ provider gateway patterns + DNS brute-force
 * - Discovery bloom filter: memory-efficient IP tracking for 10M+ IPs
 * - Cascade metrics dashboard: comprehensive real-time metrics
 * - Adaptive cooldown: 10s base, down to 3s for hot subnets
 * - Neutron seeding: each seed proxy triggers N adjacent discoveries
 * - Cascade amplification: discovery → validation → more discovery
 * - Cross-contamination (beneficial): sources share findings
 * - Subnet fission: split successful subnets for finer granularity
 * - IP adjacency scanning: expanded ranges ±1,2,3,5,10,15,20,30,40,50,60,75,100,150,200,254
 * - Port expansion: 5 ports per adjacent IP (was 2)
 * - Provider chain discovery: use one provider's IPs to find another's endpoints
 * - Cascade depth limiting: max depth = 8 (was 5)
 * - Self-sustaining mode detection: amplification > 1.0
 */

import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';
import { testProxy } from '../utils/proxy-fetch';

const logger = createChildLogger('chain-reaction');

// --- Types --------------------------------------------------------------------

export interface CascadeEvent {
  id: string;
  parentProxyId?: string;
  seedIP: string;
  seedPort: number;
  depth: number;
  discovered: DiscoveredNode[];
  validated: string[];
  amplification: number;
  neutronCount: number;
  subnetTemperature: SubnetTemperature;
  timestamp: number;
  durationMs: number;
}

export interface DiscoveredNode {
  ip: string;
  port: number;
  protocol: string;
  source: 'adjacent_scan' | 'port_expansion' | 'subnet_fission' | 'cross_pollination' | 'provider_chain' | 'bloom_filter_hit' | 'hot_subnet_deep_scan' | 'amplification_boost';
  parentIP: string;
  cascadeDepth: number;
  validated: boolean;
  proxyId?: string;
  subnetKey?: string;
}

export type SubnetTemperature = 'hot' | 'warm' | 'cold' | 'unknown';

export interface ChainReactionStats {
  totalSeeds: number;
  totalCascades: number;
  totalDiscovered: number;
  totalValidated: number;
  totalImported: number;
  amplificationFactor: number;
  isSelfSustaining: boolean;
  activeCascades: number;
  maxDepthReached: number;
  cascadesBySource: Record<string, number>;
  recentCascades: CascadeEvent[];
  criticalMassReached: boolean;
  energyOutput: number;
  // Enhanced stats
  neutronEconomy: NeutronEconomy;
  hotSubnetCount: number;
  coldSubnetCount: number;
  warmSubnetCount: number;
  cascadeDepthDistribution: Record<number, number>;
  discoveredPerMinute: number;
  validatedPerMinute: number;
  validationRate: number;
  bloomFilterSize: number;
  bloomFilterCapacity: number;
  parallelCascadeActive: number;
  smartSeedDiversityScore: number;
  amplificationBoostLevel: AmplificationBoostLevel;
}

export interface NeutronEconomy {
  totalNeutrons: number;
  activeNeutrons: number;
  neutronMultiplier: number;
  neutronDeficit: number;
  multiplicationRate: number;
  neutronsByLevel: Record<number, number>;
  failedCascades: number;
  successfulCascades: number;
}

export type AmplificationBoostLevel = 'none' | 'low' | 'medium' | 'high';

export interface HotSubnetEntry {
  cidr: string;
  discovered: number;
  validated: number;
  validationRate: number;
  temperature: SubnetTemperature;
  lastScanned: number;
  scanCount: number;
  consecutiveColdScans: number;
}

export interface CascadeMetrics {
  discoveredPerMinute: number;
  validatedPerMinute: number;
  validationRate: number;
  hotSubnetCount: number;
  coldSubnetCount: number;
  warmSubnetCount: number;
  neutronEconomy: NeutronEconomy;
  cascadeDepthDistribution: Record<number, number>;
  amplificationFactor: number;
  isSelfSustaining: boolean;
  activeCascades: number;
  parallelCascadeActive: number;
  energyOutput: number;
  bloomFilterSize: number;
  bloomFilterCapacity: number;
  smartSeedDiversityScore: number;
  amplificationBoostLevel: AmplificationBoostLevel;
  timestamp: number;
}

export interface SmartSeedProxy {
  url: string;
  id: string;
  ip: string;
  port: number;
  country: string;
  provider: string;
  successRate: number;
  recencyScore: number;
  diversityScore: number;
  rankScore: number;
}

// --- Constants ----------------------------------------------------------------

const MAX_CASCADE_DEPTH = 8; // was 5
const ADJACENCY_RANGES = [1, 2, 3, 5, 10, 15, 20, 30, 40, 50, 60, 75, 100, 150, 200, 254]; // expanded from [1,2,3,10,20,50,100,254]
const COMMON_PROXY_PORTS = [
  80, 443, 1080, 1081, 22225, 3128, 3129, 8080, 8081, 8118,
  8443, 8888, 9050, 9051, 10000, 12321, 14000, 15000, 29842,
  40000, 50000, 5566, 7000, 7001, 7753, 7777, 8000,
];
const PROTOCOLS = ['http', 'https', 'socks4', 'socks5'] as const;

// Speed: cooldown is now adaptive -- base 10s, hot subnets get 3s
const CASCADE_COOLDOWN_BASE_MS = 10_000; // was 60_000
const CASCADE_COOLDOWN_HOT_MS = 3_000;   // adaptive for hot subnets
const CASCADE_COOLDOWN_COLD_MS = 30_000;  // cold subnets get longer cooldown

const VALIDATION_TIMEOUT_MS = 10_000;
const CRITICAL_MASS_THRESHOLD = 500; // was 50
const BATCH_VALIDATE_SIZE = 25;      // was 5

// Main cascade loop interval -- 5 seconds (was 30)
const CASCADE_LOOP_INTERVAL_MS = 5_000;

// Per-cascade loop: how many proxies to scan
const CASCADE_LOOP_PROXY_COUNT = 15; // was 3

// Ports to try per adjacent IP
const PORTS_PER_ADJACENT_IP = 5; // was 2

// /24 sampling: every 3rd IP (was every 10th)
const SUBNET_24_SAMPLE_INTERVAL = 3;

// /16 sampling: every 3rd /24 (was every 10th)
const SUBNET_16_SAMPLE_INTERVAL = 3;

// Other prefix max samples
const OTHER_PREFIX_MAX_SAMPLES = 500; // was 50

// Deeper cascades from validated proxies
const MAX_DEEPER_CASCADES = 8; // was 3

// Stagger delay between deeper cascades
const DEEPER_CASCADE_STAGGER_MS = 1_000; // was 5_000

// Cross-pollinate nodes
const CROSS_POLLINATE_NODE_COUNT = 10; // was 3

// Subnet patterns cache
const SUBNET_PATTERN_CACHE_SIZE = 50; // was 10

// Discovered IPs bloom filter capacity
const BLOOM_FILTER_CAPACITY = 500_000; // was 100k Set limit
const BLOOM_FILTER_FALSE_POSITIVE_RATE = 0.01; // 1% false positive rate
const BLOOM_FILTER_REBUILD_INTERVAL_MS = 30 * 60 * 1000; // rebuild every 30 min

// Cascade history limit
const CASCADE_HISTORY_LIMIT = 5000; // was 1000
const CASCADE_HISTORY_SLICE = 2500;  // was 500

// Parallel cascade execution
const MAX_PARALLEL_CASCADES = 10;    // up to 10 concurrent cascades
const CASCADE_SEMAPHORE_TIMEOUT_MS = 30_000; // timeout waiting for semaphore

// Neutron multiplication factors per cascade level
const NEUTRON_MULTIPLIER_LEVEL_0 = 3.0;    // level 0: 3x
const NEUTRON_MULTIPLIER_LEVEL_1_3 = 2.0;  // levels 1-3: 2x
const NEUTRON_MULTIPLIER_LEVEL_4_8 = 1.5;  // levels 4-8: 1.5x
const NEUTRON_DECREMENT_ON_FAIL = 1;        // subtract on failed cascade

// Hot subnet thresholds
const HOT_SUBNET_THRESHOLD = 0.30;   // >30% validation rate = hot
const WARM_SUBNET_THRESHOLD = 0.10;  // >10% = warm
const COLD_SUBNET_THRESHOLD = 0.05;  // <5% = cold
const HOT_SUBNET_MIN_SCANS = 3;      // minimum scans before classifying

// Amplification boost thresholds
const AMPLIFICATION_BOOST_LOW = 1.0;   // >1.0: double adjacent ranges
const AMPLIFICATION_BOOST_MEDIUM = 2.0; // >2.0: triple port scanning
const AMPLIFICATION_BOOST_HIGH = 5.0;   // >5.0: add full /16 scanning

// Smart seeding limits
const SMART_SEED_MAX_COUNTRIES = 10;
const SMART_SEED_BATCH_SIZE = 100;

// Provider chain expansion -- 15 provider gateway patterns (was 5)
const PROVIDER_GATEWAY_PATTERNS: Array<{ domain: string; ports: number[]; protocol: string }> = [
  { domain: 'brd.superproxy.io', ports: [22225, 22226], protocol: 'http' },
  { domain: 'pr.oxylabs.io', ports: [7777, 7778], protocol: 'http' },
  { domain: 'gate.smartproxy.com', ports: [7000, 7001], protocol: 'http' },
  { domain: 'geo.iproyal.com', ports: [12321, 12322], protocol: 'http' },
  { domain: 'proxy.webshare.io', ports: [80, 443], protocol: 'http' },
  { domain: 'gate.decodeip.com', ports: [10000, 10001], protocol: 'http' },
  { domain: 'proxy.nodemaven.com', ports: [8080, 8081], protocol: 'http' },
  { domain: 'proxy.ipidea.com', ports: [2333, 2334], protocol: 'http' },
  { domain: 'proxy.pia.com', ports: [1234, 5678], protocol: 'http' },
  { domain: 'api.proxyscrape.com', ports: [80, 443], protocol: 'http' },
  { domain: 'proxy.spider.com', ports: [9000, 9001], protocol: 'http' },
  { domain: 'gate.proxyrack.com', ports: [9000, 9001], protocol: 'http' },
  { domain: 'proxy.soax.com', ports: [9000, 9001], protocol: 'http' },
  { domain: 'proxy.infatica.io', ports: [8080, 8443], protocol: 'http' },
  { domain: 'gateway.brightdata.com', ports: [22225, 22226], protocol: 'http' },
];

// DNS brute-force patterns for proxy domains
const DNS_BRUTE_PATTERNS = [
  'proxy', 'gate', 'gateway', 'api', 'relay', 'tunnel',
  'forward', 'cache', 'cdn', 'node', 'server', 'endpoint',
  'hub', 'router', 'switch', 'loadbalancer', 'lb', 'vip',
];

const DNS_BRUTE_DOMAINS = [
  'proxy.local', 'gate.proxy', 'cdn.proxy', 'relay.proxy',
  'tunnel.proxy', 'forward.proxy', 'cache.proxy', 'node.proxy',
];

// --- Bloom Filter Implementation ---------------------------------------------

/**
 * Simple bloom filter for memory-efficient IP tracking.
 * Supports 10M+ IPs with low false positive rate.
 * Uses double hashing (Kirsch-Mitzenmacker optimization).
 */
class DiscoveryBloomFilter {
  private bitArray: Uint8Array;
  private bitSize: number; // Size of the bit array (not itemCount)
  private numHashes: number;
  private itemCount: number = 0;
  private capacity: number;
  private falsePositiveRate: number;

  constructor(capacity: number, falsePositiveRate: number) {
    this.capacity = capacity;
    this.falsePositiveRate = falsePositiveRate;

    // Calculate optimal bit array size: m = -(n * ln(p)) / (ln(2))^2
    const ln2 = Math.log(2);
    this.bitSize = Math.ceil(
      -(capacity * Math.log(falsePositiveRate)) / (ln2 * ln2),
    );

    // Calculate optimal number of hash functions: k = (m/n) * ln(2)
    this.numHashes = Math.max(1, Math.round((this.bitSize / capacity) * ln2));

    // Allocate bit array (using Uint8Array for byte-level access)
    const byteSize = Math.ceil(this.bitSize / 8);
    this.bitArray = new Uint8Array(byteSize);

    logger.debug(
      {
        capacity,
        falsePositiveRate,
        bitArraySize: this.bitSize,
        numHashes: this.numHashes,
        memoryBytes: byteSize,
      },
      'Bloom filter initialized',
    );
  }

  /**
   * Add an item to the bloom filter.
   */
  add(item: string): void {
    const hashes = this.getDoubleHashes(item);
    for (let i = 0; i < this.numHashes; i++) {
      const hash = (hashes[0] + i * hashes[1]) % this.bitSize;
      const byteIndex = Math.floor(hash / 8);
      const bitOffset = hash % 8;
      this.bitArray[byteIndex] |= (1 << bitOffset);
    }
    this.itemCount++;
  }

  /**
   * Check if an item might be in the bloom filter.
   * Returns true if the item is definitely NOT in the filter.
   * Returns false if the item MIGHT be in the filter (could be false positive).
   */
  mightContain(item: string): boolean {
    const hashes = this.getDoubleHashes(item);
    for (let i = 0; i < this.numHashes; i++) {
      const hash = (hashes[0] + i * hashes[1]) % this.bitSize;
      const byteIndex = Math.floor(hash / 8);
      const bitOffset = hash % 8;
      if ((this.bitArray[byteIndex] & (1 << bitOffset)) === 0) {
        return false; // Definitely not in the filter
      }
    }
    return true; // Might be in the filter
  }

  /**
   * Get the number of items added to the filter.
   */
  get size(): number {
    return this.itemCount;
  }

  /**
   * Get the current estimated false positive rate.
   */
  get currentFalsePositiveRate(): number {
    if (this.itemCount === 0) return 0;
    const k = this.numHashes;
    const m = this.bitSize;
    const n = this.itemCount;
    return Math.pow(1 - Math.exp(-(k * n) / m), k);
  }

  /**
   * Check if the bloom filter is saturated (too many items for accuracy).
   */
  get isSaturated(): boolean {
    return this.itemCount > this.capacity * 1.5;
  }

  /**
   * Clear the bloom filter.
   */
  clear(): void {
    this.bitArray.fill(0);
    this.itemCount = 0;
  }

  /**
   * Rebuild the bloom filter from a set of known IPs.
   * Used for periodic maintenance to maintain accuracy.
   */
  rebuildFrom(ips: string[]): void {
    this.clear();
    for (const ip of ips) {
      this.add(ip);
    }
    logger.debug(
      { itemCount: this.itemCount, falsePositiveRate: this.currentFalsePositiveRate.toFixed(4) },
      'Bloom filter rebuilt',
    );
  }

  /**
   * Double hashing using FNV-1a and a secondary hash.
   * Kirsch-Mitzenmacker optimization: h_i(x) = h1(x) + i * h2(x)
   */
  private getDoubleHashes(item: string): [number, number] {
    let h1 = this.fnv1aHash(item);
    let h2 = this.fnv1aHash(item + '#secondary');

    // Ensure positive values
    h1 = ((h1 % this.bitSize) + this.bitSize) % this.bitSize;
    h2 = ((h2 % this.bitSize) + this.bitSize) % this.bitSize;

    return [h1, h2];
  }

  /**
   * FNV-1a hash -- fast, well-distributed 32-bit hash.
   */
  private fnv1aHash(str: string): number {
    let hash = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193); // FNV prime
    }
    return hash >>> 0; // Ensure unsigned 32-bit
  }
}

// --- Semaphore for Concurrency Control ---------------------------------------

/**
 * Simple semaphore for limiting concurrent cascade executions.
 */
class CascadeSemaphore {
  private current = 0;
  private waitQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(private maxConcurrency: number) {}

  /**
   * Acquire a semaphore slot. Waits if at capacity.
   */
  async acquire(timeoutMs: number = CASCADE_SEMAPHORE_TIMEOUT_MS): Promise<void> {
    if (this.current < this.maxConcurrency) {
      this.current++;
      return;
    }

    // Wait for a slot to open
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.waitQueue.findIndex(w => w.resolve === resolve);
        if (idx !== -1) this.waitQueue.splice(idx, 1);
        reject(new Error('Semaphore acquire timeout'));
      }, timeoutMs);

      const wrappedResolve = () => {
        clearTimeout(timeout);
        this.current++;
        resolve();
      };
      const wrappedReject = (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      };

      this.waitQueue.push({ resolve: wrappedResolve, reject: wrappedReject });
    });
  }

  /**
   * Release a semaphore slot.
   */
  release(): void {
    this.current = Math.max(0, this.current - 1);

    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      next.resolve();
    }
  }

  /**
   * Get current number of active holders.
   */
  get active(): number {
    return this.current;
  }

  /**
   * Get number of waiters.
   */
  get waiting(): number {
    return this.waitQueue.length;
  }
}

// --- IP Utilities -------------------------------------------------------------

/**
 * Convert an IPv4 address to a numeric value for arithmetic.
 */
function ipToNumber(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Convert a numeric value back to an IPv4 address string.
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
 * Check if an IP address is valid (not reserved, multicast, etc.).
 */
function isValidPublicIP(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  if (parts.some(p => isNaN(p) || p < 0 || p > 255)) return false;

  // Reserved ranges
  if (parts[0] === 0) return false;           // 0.x.x.x
  if (parts[0] === 10) return false;           // 10.x.x.x
  if (parts[0] === 127) return false;          // 127.x.x.x loopback
  if (parts[0] === 169 && parts[1] === 254) return false; // link-local
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false; // private
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return false; // IETF
  if (parts[0] === 192 && parts[1] === 168) return false; // private
  if (parts[0] === 198 && parts[1] === 18) return false;  // benchmarking
  if (parts[0] >= 224) return false;           // multicast / reserved

  return true;
}

/**
 * Extract IP and port from a proxy URL.
 */
function parseProxyUrl(proxyUrl: string): { ip: string; port: number; protocol: string; username: string; password: string } | null {
  try {
    const parsed = new URL(proxyUrl);
    return {
      ip: parsed.hostname,
      port: parseInt(parsed.port, 10) || 80,
      protocol: parsed.protocol.replace(':', ''),
      username: parsed.username,
      password: parsed.password,
    };
  } catch {
    return null;
  }
}

/**
 * Build a proxy URL from components.
 */
function buildProxyUrl(protocol: string, ip: string, port: number, username?: string, password?: string): string {
  if (username && password) {
    return `${protocol}://${username}:${password}@${ip}:${port}`;
  }
  return `${protocol}://${ip}:${port}`;
}

// --- Subnet Fission ----------------------------------------------------------

interface SubnetRange {
  cidr: string;
  network: number;
  broadcast: number;
  mask: number;
  prefixLen: number;
}

/**
 * Parse a CIDR notation into a subnet range.
 */
function parseCIDR(cidr: string): SubnetRange | null {
  try {
    const [ipStr, prefixStr] = cidr.split('/');
    const prefixLen = parseInt(prefixStr, 10);
    if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) return null;

    const ip = ipToNumber(ipStr);
    const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
    const network = (ip & mask) >>> 0;
    const broadcast = (network | ~mask) >>> 0;

    return { cidr, network, broadcast, mask, prefixLen };
  } catch {
    return null;
  }
}

/**
 * Get the /24 subnet for an IP address.
 */
function getSubnet24(ip: string): string {
  const parts = ip.split('.');
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

/**
 * Get the /16 subnet for an IP address.
 */
function getSubnet16(ip: string): string {
  const parts = ip.split('.');
  return `${parts[0]}.${parts[1]}.0.0/16`;
}

/**
 * Get the /16 prefix (first two octets) from an IP.
 */
function getSubnet16Prefix(ip: string): string {
  const parts = ip.split('.');
  return `${parts[0]}.${parts[1]}`;
}

// --- Neutron Multiplication Engine --------------------------------------------

/**
 * Tracks neutron economy for the chain reaction.
 * Each successful cascade produces neutrons that multiply future discovery.
 */
class NeutronMultiplicationEngine {
  private totalNeutrons = 0;
  private activeNeutrons = 0;
  private neutronDeficit = 0;
  private failedCascades = 0;
  private successfulCascades = 0;
  private neutronsByLevel: Record<number, number> = {};

  /**
   * Get the neutron multiplier for a given cascade depth.
   * Level 0: 3x, Level 1-3: 2x, Level 4-8: 1.5x
   */
  getMultiplier(depth: number): number {
    if (depth === 0) return NEUTRON_MULTIPLIER_LEVEL_0;
    if (depth >= 1 && depth <= 3) return NEUTRON_MULTIPLIER_LEVEL_1_3;
    return NEUTRON_MULTIPLIER_LEVEL_4_8;
  }

  /**
   * Record a successful cascade -- adds neutrons based on depth and discovery count.
   */
  recordSuccess(depth: number, discoveredCount: number): number {
    const multiplier = this.getMultiplier(depth);
    const neutronsProduced = Math.floor(discoveredCount * multiplier);
    this.totalNeutrons += neutronsProduced;
    this.activeNeutrons += neutronsProduced;
    this.successfulCascades++;

    // Track by level
    this.neutronsByLevel[depth] = (this.neutronsByLevel[depth] || 0) + neutronsProduced;

    return neutronsProduced;
  }

  /**
   * Record a failed cascade -- subtracts neutrons.
   */
  recordFailure(depth: number): void {
    this.activeNeutrons = Math.max(0, this.activeNeutrons - NEUTRON_DECREMENT_ON_FAIL);
    this.neutronDeficit += NEUTRON_DECREMENT_ON_FAIL;
    this.failedCascades++;
  }

  /**
   * Consume neutrons for a new cascade attempt.
   */
  consumeNeutrons(count: number): boolean {
    if (this.activeNeutrons < count) return false;
    this.activeNeutrons -= count;
    return true;
  }

  /**
   * Get the multiplication rate (successful / total).
   */
  get multiplicationRate(): number {
    const total = this.successfulCascades + this.failedCascades;
    return total > 0 ? this.successfulCascades / total : 0;
  }

  /**
   * Get the current neutron economy snapshot.
   */
  getEconomy(): NeutronEconomy {
    return {
      totalNeutrons: this.totalNeutrons,
      activeNeutrons: this.activeNeutrons,
      neutronMultiplier: this.getMultiplier(0),
      neutronDeficit: this.neutronDeficit,
      multiplicationRate: this.multiplicationRate,
      neutronsByLevel: { ...this.neutronsByLevel },
      failedCascades: this.failedCascades,
      successfulCascades: this.successfulCascades,
    };
  }

  /**
   * Reset the neutron economy.
   */
  reset(): void {
    this.totalNeutrons = 0;
    this.activeNeutrons = 0;
    this.neutronDeficit = 0;
    this.failedCascades = 0;
    this.successfulCascades = 0;
    this.neutronsByLevel = {};
  }
}

// --- Hot Subnet Tracker ------------------------------------------------------

/**
 * Tracks subnet temperature (validation rate) to prioritize scanning.
 * Hot subnets (>30%) get deeper scanning, cold subnets (<5%) get skipped.
 */
class HotSubnetTracker {
  private subnetMap = new Map<string, HotSubnetEntry>();

  /**
   * Record a discovery attempt in a subnet.
   */
  recordDiscovery(subnetCidr: string, validated: boolean): void {
    const entry = this.subnetMap.get(subnetCidr) || {
      cidr: subnetCidr,
      discovered: 0,
      validated: 0,
      validationRate: 0,
      temperature: 'unknown' as SubnetTemperature,
      lastScanned: Date.now(),
      scanCount: 0,
      consecutiveColdScans: 0,
    };

    entry.discovered++;
    if (validated) entry.validated++;
    entry.scanCount++;
    entry.lastScanned = Date.now();
    entry.validationRate = entry.discovered > 0 ? entry.validated / entry.discovered : 0;

    // Classify temperature based on minimum scan threshold
    if (entry.scanCount >= HOT_SUBNET_MIN_SCANS) {
      if (entry.validationRate > HOT_SUBNET_THRESHOLD) {
        entry.temperature = 'hot';
        entry.consecutiveColdScans = 0;
      } else if (entry.validationRate > WARM_SUBNET_THRESHOLD) {
        entry.temperature = 'warm';
        entry.consecutiveColdScans = 0;
      } else if (entry.validationRate < COLD_SUBNET_THRESHOLD) {
        entry.temperature = 'cold';
        entry.consecutiveColdScans++;
      } else {
        entry.temperature = 'warm';
        entry.consecutiveColdScans = 0;
      }
    }

    this.subnetMap.set(subnetCidr, entry);
  }

  /**
   * Get the temperature of a subnet.
   */
  getTemperature(subnetCidr: string): SubnetTemperature {
    return this.subnetMap.get(subnetCidr)?.temperature || 'unknown';
  }

  /**
   * Get the entry for a subnet.
   */
  getEntry(subnetCidr: string): HotSubnetEntry | undefined {
    return this.subnetMap.get(subnetCidr);
  }

  /**
   * Check if a subnet should be skipped (cold for too long).
   */
  shouldSkip(subnetCidr: string): boolean {
    const entry = this.subnetMap.get(subnetCidr);
    if (!entry) return false;
    return entry.temperature === 'cold' && entry.consecutiveColdScans >= 3;
  }

  /**
   * Get all hot subnets sorted by validation rate (descending).
   */
  getHotSubnets(): HotSubnetEntry[] {
    return Array.from(this.subnetMap.entries())
      .filter(([, e]) => e.temperature === 'hot')
      .map(([, e]) => e)
      .sort((a, b) => b.validationRate - a.validationRate);
  }

  /**
   * Get all warm subnets.
   */
  getWarmSubnets(): HotSubnetEntry[] {
    return Array.from(this.subnetMap.entries())
      .filter(([, e]) => e.temperature === 'warm')
      .map(([, e]) => e);
  }

  /**
   * Get all cold subnets.
   */
  getColdSubnets(): HotSubnetEntry[] {
    return Array.from(this.subnetMap.entries())
      .filter(([, e]) => e.temperature === 'cold')
      .map(([, e]) => e);
  }

  /**
   * Get adaptive scan intensity for a subnet.
   * Hot subnets get full intensity, cold subnets get minimal.
   */
  getScanIntensity(subnetCidr: string): number {
    const temperature = this.getTemperature(subnetCidr);
    switch (temperature) {
      case 'hot': return 1.0;   // Full intensity
      case 'warm': return 0.6;  // Moderate intensity
      case 'cold': return 0.2;  // Minimal intensity
      default: return 0.5;      // Default: medium intensity
    }
  }

  /**
   * Get counts by temperature.
   */
  getCounts(): { hot: number; warm: number; cold: number; unknown: number } {
    let hot = 0, warm = 0, cold = 0, unknown = 0;
    for (const entry of this.subnetMap.values()) {
      switch (entry.temperature) {
        case 'hot': hot++; break;
        case 'warm': warm++; break;
        case 'cold': cold++; break;
        default: unknown++; break;
      }
    }
    return { hot, warm, cold, unknown };
  }

  /**
   * Prune old subnet entries to keep memory bounded.
   */
  prune(maxAgeMs: number = 3_600_000): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [cidr, entry] of this.subnetMap) {
      if (entry.lastScanned < cutoff && entry.temperature !== 'hot') {
        this.subnetMap.delete(cidr);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Reset the tracker.
   */
  reset(): void {
    this.subnetMap.clear();
  }
}

// --- Smart Seeding Engine -----------------------------------------------------

/**
 * Ranks proxies by success rate × recency × country diversity
 * and seeds from the best proxies first.
 */
class SmartSeedingEngine {
  private recentlySeededIPs = new Map<string, number>(); // ip → last seeded timestamp
  private countryCounts = new Map<string, number>();

  /**
   * Rank proxies by composite score.
   * Score = successRate * recencyScore * diversityScore
   */
  rankProxies(proxies: Array<{ url: string; id: string; country?: string | null; provider?: string | null; successRate?: number | null; lastChecked?: Date | null }>): SmartSeedProxy[] {
    const now = Date.now();
    const ranked: SmartSeedProxy[] = [];

    // Reset country counts for this ranking round
    this.countryCounts.clear();

    for (const proxy of proxies) {
      const parsed = parseProxyUrl(proxy.url);
      if (!parsed) continue;

      // Recency score: exponentially decay, max 1.0
      const lastChecked = proxy.lastChecked ? new Date(proxy.lastChecked).getTime() : 0;
      const ageMs = now - lastChecked;
      const recencyScore = Math.max(0.1, Math.exp(-ageMs / (30 * 60 * 1000))); // 30min half-life

      // Success rate: default to 0.5 if unknown
      const successRate = proxy.successRate ?? 0.5;

      // Country diversity: penalize over-represented countries
      const country = proxy.country || 'XX';
      const currentCount = this.countryCounts.get(country) || 0;
      const diversityScore = 1.0 / (1.0 + currentCount * 0.3);

      // Composite score
      const rankScore = successRate * recencyScore * diversityScore;

      ranked.push({
        url: proxy.url,
        id: proxy.id,
        ip: parsed.ip,
        port: parsed.port,
        country,
        provider: proxy.provider || 'unknown',
        successRate,
        recencyScore,
        diversityScore,
        rankScore,
      });

      // Track country distribution
      this.countryCounts.set(country, currentCount + 1);
    }

    // Sort by rank score descending
    ranked.sort((a, b) => b.rankScore - a.rankScore);

    // Ensure country diversity by interleaving
    return this.ensureDiversity(ranked);
  }

  /**
   * Ensure country diversity by interleaving top proxies from different countries.
   */
  private ensureDiversity(ranked: SmartSeedProxy[]): SmartSeedProxy[] {
    if (ranked.length <= SMART_SEED_MAX_COUNTRIES) return ranked;

    const byCountry = new Map<string, SmartSeedProxy[]>();
    for (const proxy of ranked) {
      const country = proxy.country;
      if (!byCountry.has(country)) byCountry.set(country, []);
      byCountry.get(country)!.push(proxy);
    }

    // Interleave: take top proxy from each country, then second, etc.
    const result: SmartSeedProxy[] = [];
    const countryArrays = Array.from(byCountry.values());
    const maxLen = Math.max(...countryArrays.map(a => a.length));

    for (let i = 0; i < maxLen && result.length < ranked.length; i++) {
      for (const arr of countryArrays) {
        if (i < arr.length) {
          result.push(arr[i]);
        }
      }
    }

    return result;
  }

  /**
   * Filter out recently-seeded IPs efficiently.
   */
  filterRecentlySeeded(proxies: SmartSeedProxy[], cooldownMs: number = CASCADE_COOLDOWN_BASE_MS): SmartSeedProxy[] {
    const now = Date.now();
    return proxies.filter(p => {
      const lastSeeded = this.recentlySeededIPs.get(p.ip);
      if (lastSeeded && now - lastSeeded < cooldownMs) return false;
      return true;
    });
  }

  /**
   * Mark an IP as recently seeded.
   */
  markSeeded(ip: string): void {
    this.recentlySeededIPs.set(ip, Date.now());
  }

  /**
   * Get diversity score (0-1) based on country distribution of seeded IPs.
   */
  get diversityScore(): number {
    if (this.countryCounts.size === 0) return 0;
    const total = Array.from(this.countryCounts.values()).reduce((a, b) => a + b, 0);
    if (total === 0) return 0;

    // Shannon entropy normalized to [0, 1]
    let entropy = 0;
    for (const count of this.countryCounts.values()) {
      const p = count / total;
      if (p > 0) entropy -= p * Math.log2(p);
    }

    const maxEntropy = Math.log2(this.countryCounts.size);
    return maxEntropy > 0 ? entropy / maxEntropy : 0;
  }

  /**
   * Clean up old entries.
   */
  prune(maxAgeMs: number = 3_600_000): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [ip, timestamp] of this.recentlySeededIPs) {
      if (timestamp < cutoff) {
        this.recentlySeededIPs.delete(ip);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Reset the engine.
   */
  reset(): void {
    this.recentlySeededIPs.clear();
    this.countryCounts.clear();
  }
}

// --- Cascade Amplification Boost Engine ---------------------------------------

/**
 * When the chain reaction is self-sustaining (amplification > 1.0),
 * increases scanning intensity to maximize discoveries.
 */
class CascadeAmplificationBoost {
  private currentAmplification = 0;

  /**
   * Update the amplification factor.
   */
  updateAmplification(factor: number): void {
    this.currentAmplification = factor;
  }

  /**
   * Get the current boost level.
   */
  getBoostLevel(): AmplificationBoostLevel {
    if (this.currentAmplification >= AMPLIFICATION_BOOST_HIGH) return 'high';
    if (this.currentAmplification >= AMPLIFICATION_BOOST_MEDIUM) return 'medium';
    if (this.currentAmplification >= AMPLIFICATION_BOOST_LOW) return 'low';
    return 'none';
  }

  /**
   * Get boosted adjacency ranges based on current amplification.
   * If amplification > 1.0: double the ranges (expand search radius).
   */
  getBoostedAdjacencyRanges(): number[] {
    const boostLevel = this.getBoostLevel();

    if (boostLevel === 'none') return ADJACENCY_RANGES;

    // Double the ranges for low boost
    const boostedRanges = [...ADJACENCY_RANGES];
    for (const range of ADJACENCY_RANGES) {
      const doubled = range * 2;
      if (doubled <= 254 && !boostedRanges.includes(doubled)) {
        boostedRanges.push(doubled);
      }
    }

    // For high boost, add even more ranges
    if (boostLevel === 'high') {
      for (const range of ADJACENCY_RANGES) {
        const tripled = range * 3;
        if (tripled <= 254 && !boostedRanges.includes(tripled)) {
          boostedRanges.push(tripled);
        }
      }
    }

    return boostedRanges.sort((a, b) => a - b);
  }

  /**
   * Get boosted port count for adjacent IPs.
   * If amplification > 2.0: triple port scanning.
   */
  getBoostedPortCount(): number {
    const boostLevel = this.getBoostLevel();
    switch (boostLevel) {
      case 'high': return PORTS_PER_ADJACENT_IP * 3;
      case 'medium': return PORTS_PER_ADJACENT_IP * 3;
      case 'low': return PORTS_PER_ADJACENT_IP * 2;
      default: return PORTS_PER_ADJACENT_IP;
    }
  }

  /**
   * Should we do full /16 subnet scanning?
   * If amplification > 5.0: yes.
   */
  shouldScanFull16(): boolean {
    return this.currentAmplification >= AMPLIFICATION_BOOST_HIGH;
  }

  /**
   * Get the current amplification factor.
   */
  get amplification(): number {
    return this.currentAmplification;
  }
}

// --- ChainReaction Engine ----------------------------------------------------

export class ChainReaction {
  private running = false;
  private cascadeHistory: CascadeEvent[] = [];
  private cascadeTimers: ReturnType<typeof setTimeout>[] = [];
  private stats: ChainReactionStats;
  private recentCascadeTimestamps: number[] = [];
  private recentDiscoveryTimestamps: number[] = [];
  private recentValidationTimestamps: number[] = [];
  private activeCascadeIPs = new Set<string>();
  private cascadeCooldowns = new Map<string, number>();

  // Enhanced: Bloom filter replaces Set for memory efficiency
  private discoveredIPs: DiscoveryBloomFilter;
  private discoveredIPsExact = new Set<string>(); // Exact set for recent IPs (supplement bloom filter)
  private bloomFilterLastRebuild = Date.now();
  private mainLoopTimer: ReturnType<typeof setInterval> | null = null;

  // New subsystems
  private neutronEngine: NeutronMultiplicationEngine;
  private hotSubnetTracker: HotSubnetTracker;
  private smartSeeding: SmartSeedingEngine;
  private amplificationBoost: CascadeAmplificationBoost;
  private cascadeSemaphore: CascadeSemaphore;

  // Cascade depth distribution tracking
  private cascadeDepthDistribution: Record<number, number> = {};

  // Provider endpoint change tracking
  private providerEndpointHistory = new Map<string, string[]>(); // domain → last known IPs

  constructor() {
    this.discoveredIPs = new DiscoveryBloomFilter(BLOOM_FILTER_CAPACITY, BLOOM_FILTER_FALSE_POSITIVE_RATE);
    this.neutronEngine = new NeutronMultiplicationEngine();
    this.hotSubnetTracker = new HotSubnetTracker();
    this.smartSeeding = new SmartSeedingEngine();
    this.amplificationBoost = new CascadeAmplificationBoost();
    this.cascadeSemaphore = new CascadeSemaphore(MAX_PARALLEL_CASCADES);

    this.stats = this.createInitialStats();
  }

  /**
   * Create the initial stats object.
   */
  private createInitialStats(): ChainReactionStats {
    return {
      totalSeeds: 0,
      totalCascades: 0,
      totalDiscovered: 0,
      totalValidated: 0,
      totalImported: 0,
      amplificationFactor: 0,
      isSelfSustaining: false,
      activeCascades: 0,
      maxDepthReached: 0,
      cascadesBySource: {},
      recentCascades: [],
      criticalMassReached: false,
      energyOutput: 0,
      neutronEconomy: this.neutronEngine.getEconomy(),
      hotSubnetCount: 0,
      coldSubnetCount: 0,
      warmSubnetCount: 0,
      cascadeDepthDistribution: {},
      discoveredPerMinute: 0,
      validatedPerMinute: 0,
      validationRate: 0,
      bloomFilterSize: 0,
      bloomFilterCapacity: BLOOM_FILTER_CAPACITY,
      parallelCascadeActive: 0,
      smartSeedDiversityScore: 0,
      amplificationBoostLevel: 'none',
    };
  }

  /**
   * Start the chain reaction engine.
   * Begins the periodic cascade loop that sustains discovery.
   * Now runs every 5 seconds (was 30).
   */
  startReaction(): void {
    if (this.running) {
      logger.warn('Chain reaction already running');
      return;
    }

    this.running = true;
    logger.info('Chain reaction engine started -- inserting fuel rods (ENHANCED MODE)');

    // Main cascade loop -- every 5 seconds, try to trigger cascades
    this.mainLoopTimer = setInterval(() => {
      this.runCascadeLoop().catch((err: any) => {
        logger.error({ error: err.message }, 'Cascade loop error');
      });
    }, CASCADE_LOOP_INTERVAL_MS);

    // Periodic bloom filter rebuild
    this.scheduleBloomFilterRebuild();

    // Periodic hot subnet pruning
    this.scheduleSubnetPruning();

    // Run initial cascade from existing proxies
    this.seedFromExistingProxies().catch((err: any) => {
      logger.error({ error: err.message }, 'Initial seeding failed');
    });
  }

  /**
   * Stop the chain reaction engine.
   * Cancels all pending cascades and timers.
   */
  stopReaction(): void {
    this.running = false;

    if (this.mainLoopTimer) {
      clearInterval(this.mainLoopTimer);
      this.mainLoopTimer = null;
    }

    for (const timer of this.cascadeTimers) {
      clearTimeout(timer);
    }
    this.cascadeTimers = [];

    logger.info('Chain reaction engine stopped -- control rods inserted');
  }

  /**
   * Seed the chain reaction with initial proxies (like inserting uranium fuel rods).
   * Each seed proxy acts as a "neutron" that triggers discovery of adjacent proxies.
   * Now with smart seeding: ranks by success rate × recency × diversity.
   */
  async seedReaction(seedProxies: Array<{ url: string; id?: string }>): Promise<void> {
    if (!this.running) {
      logger.warn('Cannot seed -- chain reaction engine not running');
      return;
    }

    logger.info({ seedCount: seedProxies.length }, 'Seeding chain reaction with fuel rods');

    // Parse and rank seeds using smart seeding
    const parsedSeeds = seedProxies
      .map(seed => {
        const parsed = parseProxyUrl(seed.url);
        if (!parsed) return null;
        return { seed, parsed };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    for (const { seed, parsed } of parsedSeeds) {
      try {
        this.stats.totalSeeds++;
        this.addToDiscoveredIPs(parsed.ip);
        this.smartSeeding.markSeeded(parsed.ip);

        // Trigger cascade from this seed
        await this.triggerCascade(
          {
            url: seed.url,
            id: seed.id,
            ip: parsed.ip,
            port: parsed.port,
          },
          0,
        );
      } catch (err: any) {
        logger.warn({ error: err.message, url: seed.url }, 'Failed to seed proxy');
      }
    }

    // Check if critical mass reached
    this.stats.criticalMassReached = this.stats.totalSeeds >= CRITICAL_MASS_THRESHOLD;
    logger.info(
      {
        totalSeeds: this.stats.totalSeeds,
        criticalMass: this.stats.criticalMassReached,
        criticalMassThreshold: CRITICAL_MASS_THRESHOLD,
      },
      'Seeding complete -- critical mass status',
    );
  }

  /**
   * Trigger a cascade from a single proxy.
   * This is the core fission event -- one proxy spawns discoveries.
   * Now with parallel execution, neutron multiplication, and hot subnet awareness.
   */
  async triggerCascade(
    proxy: { url: string; id?: string; ip: string; port: number },
    depth: number,
  ): Promise<CascadeEvent | null> {
    if (depth > MAX_CASCADE_DEPTH) {
      logger.debug({ ip: proxy.ip, depth }, 'Cascade depth limit reached -- chain terminated');
      return null;
    }

    // Adaptive cooldown based on subnet temperature
    const subnetKey = getSubnet24(proxy.ip);
    const subnetTemp = this.hotSubnetTracker.getTemperature(subnetKey);
    const cooldownMs = this.getAdaptiveCooldown(subnetTemp);

    const cooldownExpiry = this.cascadeCooldowns.get(proxy.ip);
    if (cooldownExpiry && Date.now() < cooldownExpiry) {
      logger.debug({ ip: proxy.ip, depth, subnetTemp, cooldownMs }, 'Cascade cooldown active -- skipping');
      return null;
    }

    // Prevent concurrent cascades for the same IP
    if (this.activeCascadeIPs.has(proxy.ip)) {
      return null;
    }

    // Acquire semaphore for parallel cascade control
    try {
      await this.cascadeSemaphore.acquire();
    } catch {
      logger.debug({ ip: proxy.ip, depth }, 'Cascade semaphore timeout -- skipping');
      return null;
    }

    this.activeCascadeIPs.add(proxy.ip);
    this.stats.activeCascades++;
    this.stats.parallelCascadeActive = this.cascadeSemaphore.active;

    const startTime = Date.now();
    const eventId = crypto.randomUUID();
    const event: CascadeEvent = {
      id: eventId,
      parentProxyId: proxy.id,
      seedIP: proxy.ip,
      seedPort: proxy.port,
      depth,
      discovered: [],
      validated: [],
      amplification: 0,
      neutronCount: 0,
      subnetTemperature: subnetTemp,
      timestamp: startTime,
      durationMs: 0,
    };

    try {
      logger.info({ ip: proxy.ip, port: proxy.port, depth, subnetTemp }, 'Cascade triggered -- fission event');

      // Check if subnet should be skipped (too cold)
      if (this.hotSubnetTracker.shouldSkip(subnetKey)) {
        logger.debug({ ip: proxy.ip, subnetKey }, 'Skipping cold subnet');
        this.neutronEngine.recordFailure(depth);
        return null;
      }

      // Get scan intensity for this subnet
      const scanIntensity = this.hotSubnetTracker.getScanIntensity(subnetKey);

      // Phase 1: IP adjacency scan (with amplification boost)
      const adjacentNodes = await this.scanAdjacentIPs(proxy.ip, depth, scanIntensity);
      event.discovered.push(...adjacentNodes);

      // Phase 2: Port expansion (with amplification boost)
      const portNodes = await this.scanAlternativePorts(proxy.ip, proxy.port, scanIntensity);
      event.discovered.push(...portNodes);

      // Phase 3: Subnet fission (expanded depth range: 0-4, was 0-2)
      if (depth <= 4) {
        const subnet = getSubnet24(proxy.ip);
        const subnetNodes = await this.fissionSubnet(subnet, scanIntensity);
        const filteredNodes = subnetNodes
          .filter(n => !this.isInDiscoveredIPs(n.ip))
          .map(n => ({ ...n, cascadeDepth: depth }));
        event.discovered.push(...filteredNodes);
      }

      // Phase 3b: Amplification boost -- full /16 subnet scanning at high amplification
      if (this.amplificationBoost.shouldScanFull16() && depth <= 2) {
        const subnet16 = getSubnet16(proxy.ip);
        const subnet16Nodes = await this.fissionSubnet(subnet16, scanIntensity);
        const filteredNodes16 = subnet16Nodes
          .filter(n => !this.isInDiscoveredIPs(n.ip))
          .map(n => ({
            ...n,
            cascadeDepth: depth,
            source: 'amplification_boost' as const,
          }));
        event.discovered.push(...filteredNodes16);
      }

      // Phase 3c: Hot subnet deep scan
      if (subnetTemp === 'hot' && depth <= 3) {
        const hotNodes = await this.deepScanHotSubnet(subnetKey, proxy.ip, depth);
        event.discovered.push(...hotNodes);
      }

      // Phase 4: Provider chain discovery (expanded with 15 patterns)
      const providerNodes = await this.discoverProviderChain(proxy.ip, proxy.port, depth);
      event.discovered.push(...providerNodes);

      // Phase 4b: DNS brute-force discovery
      if (depth <= 1) {
        const dnsNodes = await this.dnsBruteForceDiscovery(proxy.ip, depth);
        event.discovered.push(...dnsNodes);
      }

      // Phase 5: Validate discovered nodes (25 parallel, was 5)
      const validatedIds = await this.validateDiscoveredNodes(event.discovered);
      event.validated = validatedIds;

      // Phase 6: Neutron multiplication -- record success
      const neutronsProduced = this.neutronEngine.recordSuccess(depth, event.discovered.length);
      event.neutronCount = neutronsProduced;

      // Phase 7: Cross-pollinate with other sources (10 nodes, was 3)
      if (validatedIds.length > 0) {
        await this.crossPollinate(proxy.ip, event.discovered);
      }

      // Phase 8: Record subnet discoveries for hot tracking
      for (const node of event.discovered) {
        const nodeSubnet = getSubnet24(node.ip);
        this.hotSubnetTracker.recordDiscovery(nodeSubnet, node.validated);
      }

      // Update event metrics
      event.amplification = event.discovered.length > 0 ? event.discovered.length / 1 : 0;
      event.durationMs = Date.now() - startTime;

      // Track discovered IPs using bloom filter
      for (const node of event.discovered) {
        this.addToDiscoveredIPs(node.ip);
      }

      // Update stats
      this.stats.totalCascades++;
      this.stats.totalDiscovered += event.discovered.length;
      this.stats.totalValidated += validatedIds.length;
      this.stats.maxDepthReached = Math.max(this.stats.maxDepthReached, depth);

      // Track by source
      for (const node of event.discovered) {
        this.stats.cascadesBySource[node.source] = (this.stats.cascadesBySource[node.source] || 0) + 1;
      }

      // Track depth distribution
      this.cascadeDepthDistribution[depth] = (this.cascadeDepthDistribution[depth] || 0) + 1;

      // Record timestamps for per-minute calculations
      this.recentCascadeTimestamps.push(Date.now());
      for (let i = 0; i < event.discovered.length; i++) {
        this.recentDiscoveryTimestamps.push(Date.now());
      }
      for (let i = 0; i < validatedIds.length; i++) {
        this.recentValidationTimestamps.push(Date.now());
      }

      // Record cascade
      this.cascadeHistory.push(event);

      // Keep only last 5000 cascades in memory (was 1000)
      if (this.cascadeHistory.length > CASCADE_HISTORY_LIMIT) {
        this.cascadeHistory = this.cascadeHistory.slice(-CASCADE_HISTORY_SLICE);
      }

      // Keep only recent timestamps (last 10 minutes)
      const tenMinAgo = Date.now() - 600_000;
      this.recentCascadeTimestamps = this.recentCascadeTimestamps.filter(t => t > tenMinAgo);
      this.recentDiscoveryTimestamps = this.recentDiscoveryTimestamps.filter(t => t > tenMinAgo);
      this.recentValidationTimestamps = this.recentValidationTimestamps.filter(t => t > tenMinAgo);

      // Calculate energy output (cascades per minute)
      this.stats.energyOutput = this.recentCascadeTimestamps.length;

      // Calculate amplification
      this.stats.amplificationFactor = this.stats.totalSeeds > 0
        ? this.stats.totalDiscovered / this.stats.totalSeeds
        : 0;
      this.stats.isSelfSustaining = this.stats.amplificationFactor > 1.0;

      // Update amplification boost
      this.amplificationBoost.updateAmplification(this.stats.amplificationFactor);

      // Set adaptive cooldown
      this.cascadeCooldowns.set(proxy.ip, Date.now() + cooldownMs);

      // Trigger cascades from validated proxies (deeper levels, up to 8, was 3)
      if (validatedIds.length > 0 && depth < MAX_CASCADE_DEPTH) {
        this.scheduleDeeperCascades(validatedIds, depth + 1);
      }

      logger.info(
        {
          ip: proxy.ip,
          depth,
          discovered: event.discovered.length,
          validated: validatedIds.length,
          amplification: event.amplification.toFixed(2),
          neutrons: neutronsProduced,
          subnetTemp,
          durationMs: event.durationMs,
        },
        'Cascade event completed',
      );

      return event;
    } catch (err: any) {
      // Record failure in neutron economy
      this.neutronEngine.recordFailure(depth);
      logger.error({ error: err.message, ip: proxy.ip, depth }, 'Cascade event failed');
      return null;
    } finally {
      this.activeCascadeIPs.delete(proxy.ip);
      this.stats.activeCascades--;
      this.cascadeSemaphore.release();
      this.stats.parallelCascadeActive = this.cascadeSemaphore.active;
    }
  }

  /**
   * Scan IPs adjacent to a working proxy.
   * Now with expanded ranges and amplification boost support.
   * Tests IPs at various offsets: ±1,2,3,5,10,15,20,30,40,50,60,75,100,150,200,254
   * Tries 5 ports per adjacent IP (was 2).
   */
  async scanAdjacentIPs(ip: string, depth: number, scanIntensity: number = 1.0): Promise<DiscoveredNode[]> {
    const nodes: DiscoveredNode[] = [];
    const ipNum = ipToNumber(ip);

    logger.debug({ ip, depth, scanIntensity }, 'Scanning adjacent IPs');

    // Get boosted ranges based on amplification level
    const adjacencyRanges = this.amplificationBoost.getBoostedAdjacencyRanges();
    const portCount = this.amplificationBoost.getBoostedPortCount();

    // Adjust ranges by scan intensity
    const effectiveRanges = adjacencyRanges.filter((_, idx) => {
      // With lower intensity, skip some larger ranges
      if (scanIntensity < 0.5 && idx > adjacencyRanges.length * 0.5) return false;
      if (scanIntensity < 0.3 && idx > adjacencyRanges.length * 0.3) return false;
      return true;
    });

    for (const offset of effectiveRanges) {
      for (const direction of [-1, 1]) {
        const newNum = ipNum + offset * direction;
        const newIp = numberToIp(newNum >>> 0);

        if (!isValidPublicIP(newIp)) continue;
        if (this.isInDiscoveredIPs(newIp)) continue;

        // Check subnet temperature for this new IP
        const newSubnet = getSubnet24(newIp);
        if (this.hotSubnetTracker.shouldSkip(newSubnet)) continue;

        // Try 5 common proxy ports on adjacent IPs (was 2)
        const portsToTry = [8080, 3128, 1080, 8888, 80].slice(0, Math.ceil(portCount * scanIntensity));

        for (const port of portsToTry) {
          nodes.push({
            ip: newIp,
            port,
            protocol: 'http',
            source: 'adjacent_scan',
            parentIP: ip,
            cascadeDepth: depth,
            validated: false,
            subnetKey: newSubnet,
          });
        }
      }
    }

    logger.debug({ ip, adjacentCount: nodes.length }, 'Adjacent IP scan complete');
    return nodes;
  }

  /**
   * Scan alternative ports on a working proxy IP.
   * If a proxy works on one port, it might work on others too.
   * Now with amplification boost: triple port scanning at >2.0 amplification.
   */
  async scanAlternativePorts(ip: string, port: number, scanIntensity: number = 1.0): Promise<DiscoveredNode[]> {
    const nodes: DiscoveredNode[] = [];
    let portsToTry = COMMON_PROXY_PORTS.filter(p => p !== port);

    // Amplification boost: at >2.0 amplification, triple port scanning
    if (this.amplificationBoost.getBoostLevel() !== 'none') {
      // Add more aggressive port combinations
      portsToTry = [...new Set([...portsToTry, ...COMMON_PROXY_PORTS])];
    }

    // Apply scan intensity
    if (scanIntensity < 1.0) {
      portsToTry = portsToTry.filter((_, idx) => idx % Math.ceil(1 / scanIntensity) === 0);
    }

    logger.debug({ ip, knownPort: port, portCount: portsToTry.length }, 'Scanning alternative ports');

    for (const altPort of portsToTry) {
      // Try multiple protocols on each port
      for (const protocol of PROTOCOLS) {
        nodes.push({
          ip,
          port: altPort,
          protocol,
          source: 'port_expansion',
          parentIP: ip,
          cascadeDepth: 0,
          validated: false,
          subnetKey: getSubnet24(ip),
        });
      }
    }

    return nodes;
  }

  /**
   * Deep scan a hot subnet -- scan every IP in the /24.
   * Hot subnets have >30% validation rate and deserve extra attention.
   */
  async deepScanHotSubnet(subnetCidr: string, parentIP: string, depth: number): Promise<DiscoveredNode[]> {
    const subnet = parseCIDR(subnetCidr);
    if (!subnet) return [];

    const nodes: DiscoveredNode[] = [];
    const entry = this.hotSubnetTracker.getEntry(subnetCidr);
    if (!entry || entry.temperature !== 'hot') return [];

    logger.debug({ subnetCidr, validationRate: entry.validationRate.toFixed(2) }, 'Deep scanning hot subnet');

    // Scan every IP in the hot subnet (or every other IP for very large subnets)
    const step = subnet.prefixLen === 24 ? 1 : 2;
    const start = subnet.network + 1;
    const end = subnet.broadcast - 1;

    for (let ipNum = start; ipNum <= end; ipNum += step) {
      const ip = numberToIp(ipNum >>> 0);
      if (!isValidPublicIP(ip)) continue;
      if (this.isInDiscoveredIPs(ip)) continue;

      // Try multiple ports on hot subnet IPs
      const hotPorts = [8080, 3128, 1080, 8888, 80, 443, 8443, 9050];
      for (const port of hotPorts) {
        nodes.push({
          ip,
          port,
          protocol: 'http',
          source: 'hot_subnet_deep_scan',
          parentIP,
          cascadeDepth: depth,
          validated: false,
          subnetKey: subnetCidr,
        });
      }
    }

    logger.debug({ subnetCidr, hotScanNodes: nodes.length }, 'Hot subnet deep scan complete');
    return nodes;
  }

  /**
   * Split a subnet into smaller ranges for finer discovery.
   * Like nuclear fission, splitting the atom into smaller pieces.
   * Enhanced: every 3rd IP in /24 (was every 10th),
   *           every 3rd /24 in /16 (was every 10th),
   *           500 samples for other prefixes (was 50).
   */
  async fissionSubnet(cidr: string, scanIntensity: number = 1.0): Promise<DiscoveredNode[]> {
    const subnet = parseCIDR(cidr);
    if (!subnet) {
      logger.warn({ cidr }, 'Invalid CIDR for subnet fission');
      return [];
    }

    const nodes: DiscoveredNode[] = [];

    // If /24, split into individual IPs (sample every 3rd, was every 10th)
    if (subnet.prefixLen === 24) {
      const start = subnet.network + 1;
      const end = subnet.broadcast - 1;

      // Sample every 3rd IP for efficiency (was every 10th)
      const sampleInterval = Math.max(1, Math.round(SUBNET_24_SAMPLE_INTERVAL / scanIntensity));

      for (let ipNum = start; ipNum <= end; ipNum += sampleInterval) {
        const ip = numberToIp(ipNum >>> 0);
        if (!isValidPublicIP(ip)) continue;
        if (this.isInDiscoveredIPs(ip)) continue;

        // Try a representative port
        nodes.push({
          ip,
          port: 8080,
          protocol: 'http',
          source: 'subnet_fission',
          parentIP: numberToIp(start >>> 0),
          cascadeDepth: 0,
          validated: false,
          subnetKey: cidr,
        });
      }
    } else if (subnet.prefixLen === 16) {
      // If /16, split into /24 subnets (every 3rd, was every 10th)
      const sampleInterval = Math.max(1, Math.round(SUBNET_16_SAMPLE_INTERVAL / scanIntensity));

      for (let thirdOctet = 0; thirdOctet < 256; thirdOctet += sampleInterval) {
        const sub24Cidr = `${cidr.split('.')[0]}.${cidr.split('.')[1]}.${thirdOctet}.0/24`;
        const sub24 = parseCIDR(sub24Cidr);
        if (sub24) {
          // Pick a representative IP from each /24
          const repIp = numberToIp((sub24.network + 1) >>> 0);
          if (isValidPublicIP(repIp) && !this.isInDiscoveredIPs(repIp)) {
            nodes.push({
              ip: repIp,
              port: 8080,
              protocol: 'http',
              source: 'subnet_fission',
              parentIP: cidr.split('/')[0],
              cascadeDepth: 0,
              validated: false,
              subnetKey: sub24Cidr,
            });
          }
        }
      }
    } else {
      // For other prefix lengths, pick representative IPs (500 samples, was 50)
      const start = subnet.network + 1;
      const end = Math.min(subnet.broadcast, subnet.network + OTHER_PREFIX_MAX_SAMPLES);

      for (let ipNum = start; ipNum <= end; ipNum += Math.max(1, Math.round(3 / scanIntensity))) {
        const ip = numberToIp(ipNum >>> 0);
        if (!isValidPublicIP(ip)) continue;
        if (this.isInDiscoveredIPs(ip)) continue;

        nodes.push({
          ip,
          port: 8080,
          protocol: 'http',
          source: 'subnet_fission',
          parentIP: cidr.split('/')[0],
          cascadeDepth: 0,
          validated: false,
        });
      }
    }

    logger.debug({ cidr, fissionNodes: nodes.length }, 'Subnet fission complete');
    return nodes;
  }

  /**
   * Cross-pollinate discovered proxies across different sources.
   * Like beneficial cross-contamination -- one source's findings help another.
   * Now cross-pollinates with 10 nodes (was 3) and stores 50 subnet patterns (was 10).
   */
  async crossPollinate(source: string, discovered: DiscoveredNode[]): Promise<void> {
    if (discovered.length === 0) return;

    try {
      // Group discoveries by subnet /24
      const subnetGroups = new Map<string, DiscoveredNode[]>();
      for (const node of discovered) {
        const subnet = getSubnet24(node.ip);
        if (!subnetGroups.has(subnet)) {
          subnetGroups.set(subnet, []);
        }
        subnetGroups.get(subnet)!.push(node);
      }

      // For each subnet with discoveries, find similar subnets in other providers
      for (const [subnet, nodes] of subnetGroups) {
        const subnetPrefix = getSubnet16Prefix(subnet);

        // Look for other proxies in the same /16 range from different providers
        const relatedProxies = await db.proxy.findMany({
          where: {
            url: { contains: subnetPrefix },
            retired: false,
          },
          select: { id: true, url: true, provider: true, country: true },
          take: 30, // increased from 20
        });

        if (relatedProxies.length > 0) {
          // Create cross-pollination nodes from these providers
          for (const related of relatedProxies) {
            const parsed = parseProxyUrl(related.url);
            if (!parsed) continue;

            // Try the discovered ports on the related proxy's IP (10 nodes, was 3)
            for (const node of nodes.slice(0, CROSS_POLLINATE_NODE_COUNT)) {
              const pollinatedNode: DiscoveredNode = {
                ip: parsed.ip,
                port: node.port,
                protocol: node.protocol,
                source: 'cross_pollination',
                parentIP: source,
                cascadeDepth: node.cascadeDepth,
                validated: false,
                subnetKey: getSubnet24(parsed.ip),
              };

              // Cache this cross-pollinated node for later validation
              await cacheSet(
                `cross_pollinated:${parsed.ip}:${node.port}`,
                pollinatedNode,
                3600,
              );
            }
          }
        }

        // Also check Redis for known proxy patterns from other sources
        const cachedPatterns = await cacheGet<DiscoveredNode[]>(
          `chain:patterns:${subnetPrefix}`,
        );

        if (cachedPatterns && cachedPatterns.length > 0) {
          for (const pattern of cachedPatterns.slice(0, CROSS_POLLINATE_NODE_COUNT)) {
            if (!this.isInDiscoveredIPs(pattern.ip)) {
              await cacheSet(
                `cross_pollinated:${pattern.ip}:${pattern.port}`,
                { ...pattern, source: 'cross_pollination', parentIP: source },
                3600,
              );
            }
          }
        }
      }

      // Store the current subnet patterns for future cross-pollination (50 patterns, was 10)
      for (const [subnet, nodes] of subnetGroups) {
        const subnetPrefix = getSubnet16Prefix(subnet);
        await cacheSet(
          `chain:patterns:${subnetPrefix}`,
          nodes.slice(0, SUBNET_PATTERN_CACHE_SIZE),
          86400, // 24 hours
        );
      }

      logger.debug(
        { source, subnetGroups: subnetGroups.size, totalNodes: discovered.length },
        'Cross-pollination complete',
      );
    } catch (err: any) {
      logger.warn({ error: err.message, source }, 'Cross-pollination failed');
    }
  }

  /**
   * Measure the current amplification factor.
   * Returns the ratio of total discovered to total seeded.
   */
  measureAmplification(): number {
    if (this.stats.totalSeeds === 0) return 0;
    return this.stats.totalDiscovered / this.stats.totalSeeds;
  }

  /**
   * Check if the chain reaction is self-sustaining.
   * A self-sustaining chain produces more discoveries than seeds consumed.
   */
  isSelfSustaining(): boolean {
    return this.measureAmplification() > 1.0;
  }

  /**
   * Get the cascade history (recent cascade events).
   */
  getCascadeHistory(): CascadeEvent[] {
    return [...this.cascadeHistory];
  }

  /**
   * Get chain reaction statistics (enhanced with all new metrics).
   */
  getStats(): ChainReactionStats {
    // Update computed fields
    this.stats.amplificationFactor = this.measureAmplification();
    this.stats.isSelfSustaining = this.isSelfSustaining();
    this.stats.recentCascades = this.cascadeHistory.slice(-10);
    this.stats.criticalMassReached = this.stats.totalSeeds >= CRITICAL_MASS_THRESHOLD;

    // Calculate energy output (cascades per minute)
    const tenMinAgo = Date.now() - 600_000;
    const recentCount = this.recentCascadeTimestamps.filter(t => t > tenMinAgo).length;
    this.stats.energyOutput = recentCount;

    // Enhanced stats
    this.stats.neutronEconomy = this.neutronEngine.getEconomy();

    const subnetCounts = this.hotSubnetTracker.getCounts();
    this.stats.hotSubnetCount = subnetCounts.hot;
    this.stats.warmSubnetCount = subnetCounts.warm;
    this.stats.coldSubnetCount = subnetCounts.cold;

    this.stats.cascadeDepthDistribution = { ...this.cascadeDepthDistribution };

    // Per-minute metrics
    this.stats.discoveredPerMinute = this.recentDiscoveryTimestamps.filter(t => t > tenMinAgo).length;
    this.stats.validatedPerMinute = this.recentValidationTimestamps.filter(t => t > tenMinAgo).length;
    this.stats.validationRate = this.stats.totalDiscovered > 0
      ? this.stats.totalValidated / this.stats.totalDiscovered
      : 0;

    // Bloom filter stats
    this.stats.bloomFilterSize = this.discoveredIPs.size;
    this.stats.bloomFilterCapacity = BLOOM_FILTER_CAPACITY;

    // Parallel cascade stats
    this.stats.parallelCascadeActive = this.cascadeSemaphore.active;

    // Smart seeding diversity
    this.stats.smartSeedDiversityScore = this.smartSeeding.diversityScore;

    // Amplification boost level
    this.stats.amplificationBoostLevel = this.amplificationBoost.getBoostLevel();

    return { ...this.stats };
  }

  /**
   * Get comprehensive cascade metrics for the dashboard.
   */
  getMetrics(): CascadeMetrics {
    const stats = this.getStats();
    const tenMinAgo = Date.now() - 600_000;
    const subnetCounts = this.hotSubnetTracker.getCounts();

    return {
      discoveredPerMinute: this.recentDiscoveryTimestamps.filter(t => t > tenMinAgo).length,
      validatedPerMinute: this.recentValidationTimestamps.filter(t => t > tenMinAgo).length,
      validationRate: stats.validationRate,
      hotSubnetCount: subnetCounts.hot,
      coldSubnetCount: subnetCounts.cold,
      warmSubnetCount: subnetCounts.warm,
      neutronEconomy: this.neutronEngine.getEconomy(),
      cascadeDepthDistribution: { ...this.cascadeDepthDistribution },
      amplificationFactor: stats.amplificationFactor,
      isSelfSustaining: stats.isSelfSustaining,
      activeCascades: stats.activeCascades,
      parallelCascadeActive: this.cascadeSemaphore.active,
      energyOutput: stats.energyOutput,
      bloomFilterSize: this.discoveredIPs.size,
      bloomFilterCapacity: BLOOM_FILTER_CAPACITY,
      smartSeedDiversityScore: this.smartSeeding.diversityScore,
      amplificationBoostLevel: this.amplificationBoost.getBoostLevel(),
      timestamp: Date.now(),
    };
  }

  /**
   * Get the neutron economy snapshot.
   */
  getNeutronEconomy(): NeutronEconomy {
    return this.neutronEngine.getEconomy();
  }

  /**
   * Get the hot subnet tracker entries.
   */
  getHotSubnets(): HotSubnetEntry[] {
    return this.hotSubnetTracker.getHotSubnets();
  }

  /**
   * Get the smart seed diversity score.
   */
  getSmartSeedDiversityScore(): number {
    return this.smartSeeding.diversityScore;
  }

  /**
   * Get the current amplification boost level.
   */
  getAmplificationBoostLevel(): AmplificationBoostLevel {
    return this.amplificationBoost.getBoostLevel();
  }

  // --- Private Methods --------------------------------------------------------

  /**
   * Seed from existing proxies in the database using smart seeding.
   * Ranks proxies by success rate × recency × country diversity.
   */
  private async seedFromExistingProxies(): Promise<void> {
    try {
      const existingProxies = await db.proxy.findMany({
        where: {
          retired: false,
          successRate: { gte: 0.5 },
        },
        select: { id: true, url: true, country: true, provider: true, successRate: true, lastChecked: true },
        take: SMART_SEED_BATCH_SIZE,
      });

      if (existingProxies.length > 0) {
        // Smart seed: rank and filter
        const rankedProxies = this.smartSeeding.rankProxies(existingProxies);
        const freshProxies = this.smartSeeding.filterRecentlySeeded(rankedProxies);

        logger.info(
          { total: existingProxies.length, ranked: rankedProxies.length, fresh: freshProxies.length },
          'Smart seeding from existing proxies',
        );

        await this.seedReaction(freshProxies.map(p => ({ url: p.url, id: p.id })));
      }
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to seed from existing proxies');
    }
  }

  /**
   * Main cascade loop -- periodically trigger cascades from the best proxies.
   * Now runs every 5 seconds and scans 15 proxies (was 3).
   * Uses smart seeding to prioritize the best proxies.
   */
  private async runCascadeLoop(): Promise<void> {
    if (!this.running) return;

    try {
      // Find proxies that haven't been cascaded recently
      const cooldownThreshold = Date.now() - CASCADE_COOLDOWN_COLD_MS;
      const recentIPs = new Set(
        this.cascadeHistory
          .filter(e => e.timestamp > cooldownThreshold)
          .map(e => e.seedIP),
      );

      // Get working proxies to cascade from
      const candidateProxies = await db.proxy.findMany({
        where: {
          retired: false,
          successRate: { gte: 0.6 },
          consecutiveFailures: { lte: 2 },
        },
        select: { id: true, url: true, country: true, provider: true, successRate: true, lastChecked: true },
        take: 100, // Fetch more candidates for smart ranking
      });

      // Smart seed: rank and filter candidates
      const rankedProxies = this.smartSeeding.rankProxies(candidateProxies);

      // Filter out recently cascaded IPs
      const freshProxies = rankedProxies.filter(p => !recentIPs.has(p.ip));

      // Also filter out recently seeded by smart seeding engine
      const eligibleProxies = this.smartSeeding.filterRecentlySeeded(freshProxies);

      if (eligibleProxies.length === 0) {
        logger.debug('No fresh proxies for cascade loop');
        return;
      }

      // Trigger cascades from up to 15 fresh proxies (was 3)
      const toCascade = eligibleProxies.slice(0, CASCADE_LOOP_PROXY_COUNT);

      // Launch cascades in parallel (up to MAX_PARALLEL_CASCADES)
      const cascadePromises = toCascade.map(proxy =>
        this.triggerCascade(
          { url: proxy.url, id: proxy.id, ip: proxy.ip, port: proxy.port },
          0,
        ).catch((err: any) => {
          logger.debug({ error: err.message, ip: proxy.ip }, 'Background cascade failed');
        }),
      );

      // Don't await -- let them run in the background for true parallelism
      await Promise.allSettled(cascadePromises);
    } catch (err: any) {
      logger.error({ error: err.message }, 'Cascade loop error');
    }
  }

  /**
   * Validate discovered nodes by testing proxy connectivity.
   * Now validates 25 in parallel (was 5).
   */
  private async validateDiscoveredNodes(nodes: DiscoveredNode[]): Promise<string[]> {
    const validatedIds: string[] = [];

    // Deduplicate by ip:port
    const uniqueNodes = new Map<string, DiscoveredNode>();
    for (const node of nodes) {
      const key = `${node.ip}:${node.port}`;
      if (!uniqueNodes.has(key) && !this.isInDiscoveredIPs(node.ip)) {
        uniqueNodes.set(key, node);
      }
    }

    const nodeArray = Array.from(uniqueNodes.values());
    logger.debug({ total: nodeArray.length }, 'Validating discovered nodes');

    // Validate in batches of 25 (was 5)
    for (let i = 0; i < nodeArray.length; i += BATCH_VALIDATE_SIZE) {
      const batch = nodeArray.slice(i, i + BATCH_VALIDATE_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (node) => {
          const proxyUrl = buildProxyUrl(node.protocol, node.ip, node.port);

          try {
            const result = await testProxy(proxyUrl, 'https://httpbin.org/ip', VALIDATION_TIMEOUT_MS);

            if (result.working) {
              node.validated = true;

              // Import to database
              const proxyId = crypto.randomUUID();
              try {
                await db.proxy.upsert({
                  where: { id: proxyId },
                  update: {
                    url: proxyUrl,
                    retired: false,
                    lastChecked: new Date(),
                    p95Latency: result.latencyMs,
                  },
                  create: {
                    id: proxyId,
                    url: proxyUrl,
                    tier: 'datacenter',
                    country: 'XX',
                    provider: `chain-reaction-${node.source}`,
                    successRate: 0.5,
                    p95Latency: result.latencyMs,
                    failures: 0,
                    consecutiveFailures: 0,
                    retired: false,
                    sticky: false,
                    lastUsed: new Date(),
                    lastChecked: new Date(),
                    addedAt: new Date(),
                  },
                });

                node.proxyId = proxyId;
                this.stats.totalImported++;
                validatedIds.push(proxyId);

                logger.debug(
                  { ip: node.ip, port: node.port, protocol: node.protocol, source: node.source, latencyMs: result.latencyMs },
                  'Validated and imported discovered proxy',
                );
              } catch (dbErr: any) {
                logger.debug({ error: dbErr.message, ip: node.ip }, 'Failed to import validated proxy');
              }
            }
          } catch {
            // Validation failed -- not a working proxy
          }

          return node;
        }),
      );

      // Update validated status
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.validated) {
          // Already handled above
        }
      }
    }

    logger.info({ validated: validatedIds.length, total: nodeArray.length }, 'Validation batch complete');
    return validatedIds;
  }

  /**
   * Discover proxies via provider chain -- use one provider's infrastructure
   * to discover another provider's endpoints.
   * Now with 15 provider gateway patterns (was 5) and endpoint change tracking.
   */
  private async discoverProviderChain(ip: string, port: number, depth: number): Promise<DiscoveredNode[]> {
    const nodes: DiscoveredNode[] = [];

    for (const pattern of PROVIDER_GATEWAY_PATTERNS) {
      try {
        // Try to resolve the domain to see if we can discover IPs
        const dnsResult = await this.resolveDNS(pattern.domain);
        if (dnsResult && dnsResult.length > 0) {
          // Track provider endpoint changes over time
          const previousIPs = this.providerEndpointHistory.get(pattern.domain);
          if (previousIPs) {
            // Check for new IPs (endpoint changes)
            const newIPs = dnsResult.filter(rIP => !previousIPs.includes(rIP));
            if (newIPs.length > 0) {
              logger.debug(
                { domain: pattern.domain, newIPs: newIPs.length },
                'Provider endpoint change detected',
              );
            }
          }
          this.providerEndpointHistory.set(pattern.domain, dnsResult);

          for (const resolvedIp of dnsResult.slice(0, 3)) { // up to 3 IPs per provider (was 2)
            if (resolvedIp === ip || this.isInDiscoveredIPs(resolvedIp)) continue;
            if (!isValidPublicIP(resolvedIp)) continue;

            for (const p of pattern.ports) {
              nodes.push({
                ip: resolvedIp,
                port: p,
                protocol: pattern.protocol,
                source: 'provider_chain',
                parentIP: ip,
                cascadeDepth: depth,
                validated: false,
                subnetKey: getSubnet24(resolvedIp),
              });
            }
          }
        }
      } catch {
        // DNS resolution failed -- skip
      }
    }

    return nodes;
  }

  /**
   * DNS brute-force discovery -- resolve common proxy domain patterns
   * to discover additional provider endpoints.
   */
  private async dnsBruteForceDiscovery(ip: string, depth: number): Promise<DiscoveredNode[]> {
    const nodes: DiscoveredNode[] = [];

    // Try resolving DNS brute-force patterns
    for (const pattern of DNS_BRUTE_PATTERNS) {
      for (const domain of DNS_BRUTE_DOMAINS) {
        try {
          const fqdn = `${pattern}.${domain}`;
          const dnsResult = await this.resolveDNS(fqdn);

          if (dnsResult && dnsResult.length > 0) {
            for (const resolvedIp of dnsResult.slice(0, 2)) {
              if (resolvedIp === ip || this.isInDiscoveredIPs(resolvedIp)) continue;
              if (!isValidPublicIP(resolvedIp)) continue;

              nodes.push({
                ip: resolvedIp,
                port: 8080,
                protocol: 'http',
                source: 'provider_chain',
                parentIP: ip,
                cascadeDepth: depth,
                validated: false,
                subnetKey: getSubnet24(resolvedIp),
              });
            }
          }
        } catch {
          // DNS resolution failed -- skip
        }
      }
    }

    logger.debug({ ip, bruteForceNodes: nodes.length }, 'DNS brute-force discovery complete');
    return nodes;
  }

  /**
   * Simple DNS resolution helper using Node.js dns module.
   */
  private async resolveDNS(hostname: string): Promise<string[]> {
    return new Promise((resolve) => {
      import('dns').then((dns) => {
        dns.default.resolve4(hostname, (err: any, addresses: string[]) => {
          if (err) {
            resolve([]);
          } else {
            resolve(addresses || []);
          }
        });
      }).catch(() => resolve([]));
    });
  }

  /**
   * Schedule deeper cascade levels from validated proxies.
   * Now triggers up to 8 deeper cascades (was 3) with 1s stagger (was 5s).
   */
  private scheduleDeeperCascades(proxyIds: string[], depth: number): void {
    // Only cascade from a subset to prevent exponential explosion
    const maxCascades = Math.min(proxyIds.length, MAX_DEEPER_CASCADES); // 8, was 3

    for (let i = 0; i < maxCascades; i++) {
      const proxyId = proxyIds[i];
      if (!proxyId) continue;

      const timer = setTimeout(async () => {
        if (!this.running) return;

        try {
          const proxy = await db.proxy.findUnique({
            where: { id: proxyId },
            select: { id: true, url: true },
          });

          if (!proxy) return;

          const parsed = parseProxyUrl(proxy.url);
          if (!parsed) return;

          await this.triggerCascade(
            { url: proxy.url, id: proxy.id, ip: parsed.ip, port: parsed.port },
            depth,
          );
        } catch (err: any) {
          logger.debug({ error: err.message, proxyId, depth }, 'Scheduled cascade failed');
        }
      }, (i + 1) * DEEPER_CASCADE_STAGGER_MS); // 1s stagger (was 5s)

      this.cascadeTimers.push(timer);
    }
  }

  /**
   * Get adaptive cooldown based on subnet temperature.
   * Hot subnets: 3s, Unknown: 10s, Cold subnets: 30s
   */
  private getAdaptiveCooldown(temperature: SubnetTemperature): number {
    switch (temperature) {
      case 'hot': return CASCADE_COOLDOWN_HOT_MS;      // 3s
      case 'warm': return CASCADE_COOLDOWN_BASE_MS;     // 10s
      case 'cold': return CASCADE_COOLDOWN_COLD_MS;     // 30s
      default: return CASCADE_COOLDOWN_BASE_MS;          // 10s (unknown)
    }
  }

  /**
   * Add an IP to the discovery bloom filter and exact set.
   * Uses dual tracking: bloom filter for efficiency, exact set for recent IPs.
   */
  private addToDiscoveredIPs(ip: string): void {
    this.discoveredIPs.add(ip);
    this.discoveredIPsExact.add(ip);

    // Keep the exact set bounded (keep last 100k)
    if (this.discoveredIPsExact.size > 100_000) {
      // Evict oldest entries (Set maintains insertion order)
      const iterator = this.discoveredIPsExact.values();
      const toEvict = this.discoveredIPsExact.size - 80_000; // Remove down to 80k
      for (let i = 0; i < toEvict; i++) {
        const entry = iterator.next();
        if (!entry.done) {
          this.discoveredIPsExact.delete(entry.value);
        }
      }
    }
  }

  /**
   * Check if an IP has been discovered using bloom filter + exact set.
   * Bloom filter provides fast negative lookups; exact set confirms positives.
   */
  private isInDiscoveredIPs(ip: string): boolean {
    // Fast exact check first
    if (this.discoveredIPsExact.has(ip)) return true;

    // Bloom filter check -- may have false positives but never false negatives
    if (this.discoveredIPs.mightContain(ip)) {
      // Could be a false positive -- check exact set
      // Since exact set may have evicted it, we assume it was discovered
      // (conservative approach: skip potentially already-discovered IPs)
      return true;
    }

    return false;
  }

  /**
   * Clean up old cooldown entries.
   */
  private cleanupCooldowns(): void {
    const now = Date.now();
    for (const [ip, expiry] of this.cascadeCooldowns) {
      if (now > expiry) {
        this.cascadeCooldowns.delete(ip);
      }
    }
  }

  /**
   * Schedule periodic bloom filter rebuild to maintain accuracy.
   */
  private scheduleBloomFilterRebuild(): void {
    const rebuildTimer = setInterval(() => {
      if (!this.running) return;

      try {
        // Rebuild bloom filter from exact set
        const exactIPs = Array.from(this.discoveredIPsExact);
        this.discoveredIPs.rebuildFrom(exactIPs);
        this.bloomFilterLastRebuild = Date.now();

        // Check if bloom filter is saturated and needs expansion
        if (this.discoveredIPs.isSaturated) {
          logger.warn(
            { bloomFilterSize: this.discoveredIPs.size, capacity: BLOOM_FILTER_CAPACITY },
            'Bloom filter saturated -- consider increasing capacity',
          );
        }

        logger.debug(
          {
            bloomFilterSize: this.discoveredIPs.size,
            exactSetSize: this.discoveredIPsExact.size,
            falsePositiveRate: this.discoveredIPs.currentFalsePositiveRate.toFixed(4),
          },
          'Bloom filter rebuilt',
        );
      } catch (err: any) {
        logger.warn({ error: err.message }, 'Bloom filter rebuild failed');
      }
    }, BLOOM_FILTER_REBUILD_INTERVAL_MS);

    this.cascadeTimers.push(rebuildTimer as any);
  }

  /**
   * Schedule periodic hot subnet pruning.
   */
  private scheduleSubnetPruning(): void {
    const pruneTimer = setInterval(() => {
      if (!this.running) return;

      const pruned = this.hotSubnetTracker.prune();
      if (pruned > 0) {
        logger.debug({ pruned }, 'Pruned hot subnet tracker entries');
      }
    }, 30 * 60 * 1000); // Every 30 minutes

    this.cascadeTimers.push(pruneTimer as any);
  }

  /**
   * Get the subnet graph -- which subnets have produced the most validated proxies.
   * Useful for identifying "hot" subnets for deeper exploration.
   */
  async getSubnetGraph(): Promise<Map<string, { discovered: number; validated: number; hitRate: number }>> {
    const subnetMap = new Map<string, { discovered: number; validated: number; hitRate: number }>();

    for (const event of this.cascadeHistory) {
      for (const node of event.discovered) {
        const subnet = getSubnet24(node.ip);
        const entry = subnetMap.get(subnet) || { discovered: 0, validated: 0, hitRate: 0 };
        entry.discovered++;
        if (node.validated) entry.validated++;
        entry.hitRate = entry.discovered > 0 ? entry.validated / entry.discovered : 0;
        subnetMap.set(subnet, entry);
      }
    }

    return subnetMap;
  }

  /**
   * Get the parent-child cascade tree -- which proxies led to which discoveries.
   * Returns a map of parent IP → child cascade events.
   */
  getCascadeTree(): Map<string, CascadeEvent[]> {
    const tree = new Map<string, CascadeEvent[]>();

    for (const event of this.cascadeHistory) {
      const parentKey = event.parentProxyId || event.seedIP;
      const children = tree.get(parentKey) || [];
      children.push(event);
      tree.set(parentKey, children);
    }

    return tree;
  }

  /**
   * Prune cascade history to free memory.
   * Removes cascade events older than the specified age.
   * Now clears bloom filter at 500k (was 100k).
   */
  pruneHistory(maxAgeMs: number = 3_600_000): number {
    const cutoff = Date.now() - maxAgeMs;
    const originalLength = this.cascadeHistory.length;

    this.cascadeHistory = this.cascadeHistory.filter(e => e.timestamp > cutoff);

    // Clean up discovered IPs bloom filter if it grows too large (500k, was 100k)
    if (this.discoveredIPs.size > 500_000) {
      this.discoveredIPs.clear();
      this.discoveredIPsExact.clear();
      logger.info('Cleared discovered IPs cache (exceeded 500k entries -- bloom filter reset)');
    }

    // Clean up cooldowns
    this.cleanupCooldowns();

    // Clean up smart seeding history
    const seededPruned = this.smartSeeding.prune(maxAgeMs);

    const pruned = originalLength - this.cascadeHistory.length;
    if (pruned > 0 || seededPruned > 0) {
      logger.debug(
        { historyPruned: pruned, seededPruned, remaining: this.cascadeHistory.length },
        'Pruned cascade history and seeding data',
      );
    }

    return pruned;
  }

  /**
   * Reset all chain reaction state.
   * Stops the engine and clears all internal state.
   */
  reset(): void {
    this.stopReaction();
    this.cascadeHistory = [];
    this.cascadeCooldowns.clear();
    this.activeCascadeIPs.clear();
    this.discoveredIPs.clear();
    this.discoveredIPsExact.clear();
    this.recentCascadeTimestamps = [];
    this.recentDiscoveryTimestamps = [];
    this.recentValidationTimestamps = [];
    this.cascadeDepthDistribution = {};
    this.providerEndpointHistory.clear();

    // Reset subsystems
    this.neutronEngine.reset();
    this.hotSubnetTracker.reset();
    this.smartSeeding.reset();

    this.stats = this.createInitialStats();
    logger.info('Chain reaction engine reset -- all state cleared');
  }

  /**
   * Get the cascade semaphore status for monitoring.
   */
  getSemaphoreStatus(): { active: number; waiting: number; maxConcurrency: number } {
    return {
      active: this.cascadeSemaphore.active,
      waiting: this.cascadeSemaphore.waiting,
      maxConcurrency: MAX_PARALLEL_CASCADES,
    };
  }

  /**
   * Get provider endpoint history -- tracks changes over time.
   */
  getProviderEndpointHistory(): Map<string, string[]> {
    return new Map(this.providerEndpointHistory);
  }

  /**
   * Get the bloom filter stats.
   */
  getBloomFilterStats(): { size: number; capacity: number; falsePositiveRate: number; isSaturated: boolean; lastRebuild: number } {
    return {
      size: this.discoveredIPs.size,
      capacity: BLOOM_FILTER_CAPACITY,
      falsePositiveRate: this.discoveredIPs.currentFalsePositiveRate,
      isSaturated: this.discoveredIPs.isSaturated,
      lastRebuild: this.bloomFilterLastRebuild,
    };
  }

  /**
   * Force a bloom filter rebuild (useful for maintenance).
   */
  forceBloomFilterRebuild(): void {
    const exactIPs = Array.from(this.discoveredIPsExact);
    this.discoveredIPs.rebuildFrom(exactIPs);
    this.bloomFilterLastRebuild = Date.now();
    logger.info({ size: this.discoveredIPs.size }, 'Forced bloom filter rebuild');
  }
}

// --- Singleton ----------------------------------------------------------------

export const chainReaction = new ChainReaction();
