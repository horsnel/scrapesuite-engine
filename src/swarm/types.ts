/**
 * Swarm Intelligence Crawler Types -- ScrapeSuite Engine
 *
 * The Swarm Crawler uses decentralized, nature-inspired algorithms
 * (ant colony optimization + bee foraging) to crawl websites
 * intelligently. Unlike traditional crawlers that follow sitemaps
 * or brute-force links, the Swarm learns optimal paths through
 * pheromone trails left by successful scrapes.
 *
 * Hard-to-copy because: The pheromone matrix is built from millions
 * of real crawl decisions and encodes site-specific navigation
 * knowledge that can't be reverse-engineered.
 */

// ===============================================================================
// SWARM AGENT TYPES
// ===============================================================================

/** Type of swarm agent. */
export type AgentRole = 'scout' | 'worker' | 'soldier' | 'queen';

/** A single swarm agent that crawls pages. */
export interface SwarmAgent {
  /** Unique agent ID. */
  id: string;
  /** Agent role. */
  role: AgentRole;
  /** Current URL being processed. */
  currentUrl: string | null;
  /** URLs discovered but not yet visited. */
  frontier: string[];
  /** URLs successfully scraped. */
  visited: string[];
  /** Pheromone trail -- URLs this agent has visited with strength. */
  pheromoneTrail: Map<string, number>;
  /** Energy level (0-100). Depleted by crawling, restored by successful data extraction. */
  energy: number;
  /** Data extracted by this agent. */
  extractedData: Map<string, unknown[]>;
  /** Number of pages scraped. */
  pagesScraped: number;
  /** Number of errors encountered. */
  errors: number;
  /** Current state. */
  state: 'idle' | 'crawling' | 'extracting' | 'returning' | 'dead';
  /** Birth timestamp. */
  bornAt: number;
  /** Maximum pages this agent should visit. */
  maxPages: number;
  /** Domain this agent is assigned to. */
  domain: string;
}

// ===============================================================================
// PHEROMONE TYPES
// ===============================================================================

/** Pheromone types in the colony. */
export type PheromoneType = 'data' | 'path' | 'warning' | 'block';

/** A pheromone deposit on a URL. */
export interface Pheromone {
  /** URL this pheromone is deposited on. */
  url: string;
  /** Type of pheromone. */
  type: PheromoneType;
  /** Strength (0-1). Decays over time. */
  strength: number;
  /** When this pheromone was deposited. */
  depositedAt: number;
  /** Which agent deposited it. */
  agentId: string;
  /** What data was found (for data pheromones). */
  dataSignature: string;
  /** How many times this URL has been reinforced. */
  reinforcementCount: number;
}

/** The global pheromone matrix -- a map of URL paths to pheromone deposits. */
export interface PheromoneMatrix {
  /** All pheromone deposits, keyed by URL. */
  deposits: Map<string, Pheromone[]>;
  /** Decay rate per hour. */
  decayRate: number;
  /** Evaporation threshold -- pheromones below this are removed. */
  evaporationThreshold: number;
  /** Maximum pheromone strength. */
  maxStrength: number;
  /** Total pheromone deposits. */
  totalDeposits: number;
}

// ===============================================================================
// COLONY TYPES
// ===============================================================================

/** Swarm colony configuration. */
export interface ColonyConfig {
  /** Number of scout agents (discover new URLs). */
  scoutCount: number;
  /** Number of worker agents (extract data). */
  workerCount: number;
  /** Number of soldier agents (handle blocks/captchas). */
  soldierCount: number;
  /** Maximum pages per agent before returning. */
  maxPagesPerAgent: number;
  /** Pheromone importance in URL selection (0-1). */
  pheromoneWeight: number;
  /** Heuristic importance in URL selection (0-1). */
  heuristicWeight: number;
  /** Pheromone decay rate per hour. */
  pheromoneDecayRate: number;
  /** Energy cost per page crawl. */
  crawlEnergyCost: number;
  /** Energy gained per successful extraction. */
  extractionEnergyGain: number;
  /** Maximum colony size. */
  maxColonySize: number;
  /** Whether to auto-spawn new agents. */
  autoSpawn: boolean;
  /** Data extraction patterns to prioritize. */
  targetPatterns: string[];
}

/** The swarm colony -- a collection of agents working together. */
export interface SwarmColony {
  /** Colony ID. */
  id: string;
  /** Target domain. */
  domain: string;
  /** All agents in the colony. */
  agents: Map<string, SwarmAgent>;
  /** The global pheromone matrix. */
  pheromones: PheromoneMatrix;
  /** Shared URL frontier (agents deposit discovered URLs here). */
  sharedFrontier: string[];
  /** URLs that have been fully processed. */
  completedUrls: Set<string>;
  /** Colony statistics. */
  stats: ColonyStats;
  /** Configuration. */
  config: ColonyConfig;
  /** Whether the colony is active. */
  isActive: boolean;
  /** When the colony was created. */
  createdAt: number;
}

/** Colony statistics. */
export interface ColonyStats {
  totalPagesCrawled: number;
  totalPagesExtracted: number;
  totalDataExtracted: number;
  totalErrors: number;
  avgPagesPerMinute: number;
  activeAgents: number;
  pheromoneDensity: number;
  frontierSize: number;
  completionPercentage: number;
  topDataUrls: string[];
  blockedUrls: string[];
}

// ===============================================================================
// URL SELECTION TYPES
// ===============================================================================

/** URL selection result. */
export interface URLSelection {
  /** Selected URL. */
  url: string;
  /** Why this URL was selected. */
  reason: 'pheromone' | 'heuristic' | 'random' | 'queen-directive' | 'shared-frontier';
  /** Pheromone strength at this URL. */
  pheromoneStrength: number;
  /** Heuristic score for this URL. */
  heuristicScore: number;
  /** Combined selection probability. */
  probability: number;
}

/** URL heuristic scoring criteria. */
export interface URLHeuristic {
  /** URL depth from start URL. */
  depth: number;
  /** Whether the URL path matches target patterns. */
  matchesTarget: boolean;
  /** Whether the URL has been visited before. */
  isVisited: boolean;
  /** Link context score (how relevant the linking page's content was). */
  contextScore: number;
  /** URL structure score (pagination, category, product patterns). */
  structureScore: number;
  /** Pheromone strength at this URL. */
  pheromoneStrength: number;
}

// ===============================================================================
// DANCE COMMUNICATION TYPES (Bee-inspired)
// ===============================================================================

/** A waggle dance -- communication about a rich data source. */
export interface WaggleDance {
  /** The URL with rich data. */
  url: string;
  /** Data richness score (0-1). */
  richness: number;
  /** Direction -- relative URL path from colony origin. */
  direction: string;
  /** Distance -- number of hops from origin. */
  distance: number;
  /** Agent that performed the dance. */
  dancerId: string;
  /** Number of agents that followed this dance. */
  followers: number;
  /** When this dance was performed. */
  performedAt: number;
}

// ===============================================================================
// SWARM RESULT TYPES
// ===============================================================================

/** Result from a swarm crawl operation. */
export interface SwarmCrawlResult {
  /** Whether the crawl was successful. */
  success: boolean;
  /** Colony ID. */
  colonyId: string;
  /** Total pages crawled. */
  pagesCrawled: number;
  /** Total data items extracted. */
  dataExtracted: number;
  /** Extracted data organized by type. */
  data: Map<string, unknown[]>;
  /** URLs that were blocked. */
  blockedUrls: string[];
  /** Pheromone trails deposited. */
  pheromoneTrails: number;
  /** Duration in ms. */
  durationMs: number;
  /** Errors encountered. */
  errors: string[];
  /** Colony statistics after the crawl. */
  stats: ColonyStats;
}
