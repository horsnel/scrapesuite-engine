/**
 * Fingerprint DNA Types -- ScrapeSuite Engine
 *
 * The DNA Engine creates biologically-inspired fingerprint profiles
 * that evolve, mutate, and cross-breed -- making each scraping
 * session genetically unique and impossible to fingerprint-pattern-detect.
 *
 * Key innovation: Instead of static fingerprint profiles (which competitors use
 * and anti-bot systems learn to detect), DNA profiles are LIVING organisms that:
 * - Mutate naturally over time (like biological drift)
 * - Cross-breed successful traits from high-survival profiles
 * - Self-select through a fitness function based on bypass success
 * - Maintain phenotype consistency (fingerprint traits that belong together)
 *
 * This makes it computationally infeasible for anti-bot systems to build
 * detection models against ScrapeSuite because the fingerprint space
 * is constantly evolving in a directed, non-random way.
 */

// ===============================================================================
// CORE DNA TYPES
// ===============================================================================

/** A single gene in the fingerprint DNA. Each gene controls one fingerprint trait. */
export interface Gene<T = unknown> {
  /** Unique gene identifier (e.g., 'ua.platform', 'webgl.vendor'). */
  locus: string;
  /** The current value (allele) of this gene. */
  allele: T;
  /** Possible values this gene can take (the allele pool). */
  allelePool: T[];
  /** How likely this gene is to mutate (0-1). Higher = more volatile. */
  mutationRate: number;
  /** How important this gene is for fitness (0-1). Higher = more selection pressure. */
  fitnessWeight: number;
  /** Constraints on what values are valid together with other genes. */
  constraints: GeneConstraint[];
  /** Generation when this allele was last changed. */
  lastMutatedGen: number;
  /** How many times this allele has survived selection. */
  survivalCount: number;
}

/** Constraint that links two genes together -- if one changes, the other must be compatible. */
export interface GeneConstraint {
  /** The other gene locus this constraint applies to. */
  linkedLocus: string;
  /** Constraint type. */
  type: 'requires' | 'excludes' | 'correlates' | 'range-bounds';
  /** Constraint-specific data (e.g., allowed values, correlation strength). */
  data: Record<string, unknown>;
}

/** A chromosome is a collection of genes that represent a coherent fingerprint subsystem. */
export interface Chromosome {
  /** Chromosome name (e.g., 'navigator', 'webgl', 'screen', 'network'). */
  name: string;
  /** Genes in this chromosome. */
  genes: Map<string, Gene>;
  /** Minimum viable fitness for this chromosome. */
  minFitness: number;
  /** Current calculated fitness of this chromosome. */
  currentFitness: number;
  /** How many generations this chromosome has survived. */
  age: number;
}

/** A complete organism -- a full fingerprint DNA profile. */
export interface Organism {
  /** Unique organism ID. */
  id: string;
  /** Generation number. */
  generation: number;
  /** All chromosomes that make up this organism. */
  chromosomes: Map<string, Chromosome>;
  /** Overall fitness score (0-1). */
  fitness: number;
  /** Number of successful scrapes this organism has achieved. */
  successes: number;
  /** Number of times this organism was detected/blocked. */
  failures: number;
  /** Timestamp when this organism was born. */
  bornAt: number;
  /** Timestamp of last use. */
  lastUsedAt: number;
  /** Parent organism IDs (for lineage tracking). */
  parentIds: string[];
  /** Species classification (group of similar organisms). */
  species: string;
  /** Whether this organism is currently alive (in the active pool). */
  isAlive: boolean;
  /** Phenotype -- the expressed fingerprint (computed from DNA). */
  phenotype: FingerprintPhenotype;
}

/** The expressed fingerprint -- what the browser actually looks like. */
export interface FingerprintPhenotype {
  /** User-Agent string. */
  userAgent: string;
  /** Platform string. */
  platform: string;
  /** Vendor string. */
  vendor: string;
  /** Screen resolution. */
  screenResolution: { width: number; height: number; colorDepth: number };
  /** Available screen dimensions. */
  availableScreen: { width: number; height: number };
  /** Device pixel ratio. */
  devicePixelRatio: number;
  /** Hardware concurrency (CPU cores). */
  hardwareConcurrency: number;
  /** Device memory (GB). */
  deviceMemory: number;
  /** Max touch points. */
  maxTouchPoints: number;
  /** WebGL vendor. */
  webglVendor: string;
  /** WebGL renderer. */
  webglRenderer: string;
  /** Language preferences. */
  languages: string[];
  /** Timezone. */
  timezone: string;
  /** Connection info. */
  connection: { effectiveType: string; downlink: number; rtt: number };
  /** Canvas fingerprint noise seed. */
  canvasNoiseSeed: number;
  /** Audio fingerprint noise seed. */
  audioNoiseSeed: number;
  /** Font list (subset of common fonts). */
  fonts: string[];
  /** Plugins list. */
  plugins: string[];
  /** Do Not Track setting. */
  doNotTrack: string | null;
  /** Cookie enabled. */
  cookieEnabled: boolean;
}

// ===============================================================================
// EVOLUTION TYPES
// ===============================================================================

/** Mutation operator types. */
export type MutationOperator =
  | 'point'         // Single gene allele change
  | 'crossover'     // Exchange alleles between two organisms
  | 'inversion'     // Reverse a sequence of genes
  | 'translocation'  // Move a gene sequence to another position
  | 'duplication'   // Duplicate a gene's allele
  | 'deletion'      // Remove a gene from the pool
  | 'regulation';   // Change a gene's mutation rate

/** Result of a mutation operation. */
export interface MutationResult {
  /** The organism after mutation. */
  organism: Organism;
  /** Which mutation operator was applied. */
  operator: MutationOperator;
  /** Which loci were affected. */
  affectedLoci: string[];
  /** Whether the mutation violated any constraints. */
  constraintViolations: string[];
  /** Fitness change (delta). Positive = improvement. */
  fitnessDelta: number;
}

/** Crossover result from breeding two organisms. */
export interface CrossoverResult {
  /** Child organism. */
  child: Organism;
  /** Parent 1. */
  parent1: Organism;
  /** Parent 2. */
  parent2: Organism;
  /** Crossover points (locus names where genetic material was exchanged). */
  crossoverPoints: string[];
  /** Which parent contributed each chromosome. */
  chromosomeOrigin: Map<string, 'parent1' | 'parent2' | 'recombined'>;
}

/** Fitness evaluation context. */
export interface FitnessContext {
  /** Number of successful bypasses using this organism's phenotype. */
  bypassSuccesses: number;
  /** Number of blocks/detections. */
  bypassFailures: number;
  /** Average response time when using this phenotype. */
  avgResponseTimeMs: number;
  /** Whether the phenotype passed consistency checks. */
  consistencyScore: number;
  /** How unique this phenotype is compared to the population. */
  uniquenessScore: number;
  /** How well the phenotype matches real-world browser distributions. */
  realismScore: number;
  /** Domain-specific success rate. */
  domainSuccessRates: Map<string, number>;
}

// ===============================================================================
// POPULATION TYPES
// ===============================================================================

/** Population statistics. */
export interface PopulationStats {
  /** Total organisms in the population. */
  populationSize: number;
  /** Average fitness across the population. */
  avgFitness: number;
  /** Best fitness in the population. */
  bestFitness: number;
  /** Worst fitness in the population. */
  worstFitness: number;
  /** Fitness standard deviation. */
  fitnessStdDev: number;
  /** Number of species in the population. */
  speciesCount: number;
  /** Current generation number. */
  generation: number;
  /** Total births this generation. */
  births: number;
  /** Total deaths this generation. */
  deaths: number;
  /** Population diversity index (0-1). Higher = more diverse. */
  diversityIndex: number;
  /** Species distribution. */
  speciesDistribution: Map<string, number>;
}

/** Configuration for the DNA engine. */
export interface DNAEngineConfig {
  /** Maximum population size. */
  maxPopulationSize: number;
  /** Minimum population size (before emergency breeding). */
  minPopulationSize: number;
  /** Base mutation rate (overridden per-gene). */
  baseMutationRate: number;
  /** Crossover rate for breeding. */
  crossoverRate: number;
  /** Elite preservation rate (top % kept unchanged). */
  eliteRate: number;
  /** Tournament selection size. */
  tournamentSize: number;
  /** Species compatibility threshold. */
  speciesThreshold: number;
  /** Stagnation limit (generations without improvement before mass extinction). */
  stagnationLimit: number;
  /** Fitness function weights. */
  fitnessWeights: {
    successRate: number;
    consistency: number;
    uniqueness: number;
    realism: number;
    responseTime: number;
  };
  /** Enable verbose logging. */
  verbose: boolean;
}

/** Domain-specific fitness record. */
export interface DomainFitnessRecord {
  domain: string;
  organismId: string;
  fitness: number;
  successes: number;
  failures: number;
  lastUsedAt: number;
  preferredSpecies: string;
}
