/**
 * Fingerprint DNA Engine -- ScrapeSuite Engine
 *
 * The DNA Engine is a biologically-inspired fingerprint management system
 * that creates, evolves, and maintains a living population of browser
 * fingerprint profiles. Unlike competitors who use static profiles or
 * simple rotation, ScrapeSuite's fingerprints EVOLVE based on real-world
 * feedback, making them impossible to pattern-detect.
 *
 * Architecture:
 *  +-------------------------------------------------------------------------+
 *  |                        DNA Engine (this file)                          |
 *  |                                                                        |
 *  |  +------------------+  +-----------------+  +---------------------+   |
 *  |  | Organism Factory |  | Evolution Engine|  | Fitness Evaluator   |   |
 *  |  | (create/express) |  | (select/breed)  |  | (success/realism)   |   |
 *  |  +------------------+  +-----------------+  +---------------------+   |
 *  |                                                                        |
 *  |  +------------------+  +------------------------------------------+    |
 *  |  | Population Pool  |  | Domain-Specific Fitness Records           |    |
 *  |  | (active profiles)|  | (per-domain organism performance tracking)|    |
 *  |  +------------------+  +------------------------------------------+    |
 *  +-------------------------------------------------------------------------+
 *
 * Usage:
 *   import { dnaEngine } from './dna';
 *   const profile = await dnaEngine.getProfile('target-site.com');
 *   // profile contains a living fingerprint phenotype ready to use
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import {
  type Organism,
  type FingerprintPhenotype,
  type PopulationStats,
  type DomainFitnessRecord,
  type FitnessContext,
  type DNAEngineConfig,
} from './types';
import { createOrganism, createSeededPopulation, expressPhenotype } from './organism';
import { EvolutionEngine, evaluateFitness, compatibilityDistance, DEFAULT_DNA_CONFIG } from './evolution';

const logger = createChildLogger('dna-engine');

// ===============================================================================
// DNA ENGINE
// ===============================================================================

class DNAEngine {
  private evolution: EvolutionEngine;
  private domainFitness = new Map<string, Map<string, number>>(); // domain -> organismId -> fitness
  private domainRecords = new Map<string, DomainFitnessRecord[]>(); // domain -> records
  private initialized = false;
  private evolutionInterval: ReturnType<typeof setInterval> | null = null;
  private config: DNAEngineConfig;

  constructor(config?: Partial<DNAEngineConfig>) {
    this.config = { ...DEFAULT_DNA_CONFIG, ...config };
    this.evolution = new EvolutionEngine(this.config);
  }

  /** Initialize the DNA engine. */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing Fingerprint DNA Engine...');

    // Try to restore population from Redis cache
    const cached = await this.loadFromCache();
    if (cached) {
      logger.info({ populationSize: cached.length }, 'Restored population from cache');
    } else {
      this.evolution.initialize(this.config.maxPopulationSize);
      logger.info({ populationSize: this.config.maxPopulationSize }, 'Created new seeded population');
    }

    // Start periodic evolution
    this.startEvolution();

    this.initialized = true;
    logger.info('Fingerprint DNA Engine initialized');
  }

  /** Get the best fingerprint profile for a given domain. */
  async getProfile(domain: string): Promise<FingerprintPhenotype> {
    if (!this.initialized) await this.initialize();

    const organism = this.evolution.getFittestForDomain(domain, this.domainFitness);
    if (!organism) {
      // Emergency: create a fresh organism
      const fresh = createOrganism(this.evolution.getGeneration());
      return fresh.phenotype;
    }

    logger.debug(
      { domain, organismId: organism.id, fitness: organism.fitness.toFixed(3), species: organism.species },
      'Selected organism for domain',
    );

    return organism.phenotype;
  }

  /** Get a random but viable profile (for diversity in concurrent requests). */
  async getRandomProfile(domain: string): Promise<FingerprintPhenotype> {
    if (!this.initialized) await this.initialize();

    const population = this.evolution.getPopulation();
    if (population.length === 0) {
      return createOrganism().phenotype;
    }

    // Weighted random selection favoring fitter organisms but allowing diversity
    const domainMap = this.domainFitness.get(domain);
    const candidates = population.filter(o => o.isAlive && o.fitness > 0.3);

    if (candidates.length === 0) {
      return population[Math.floor(Math.random() * population.length)].phenotype;
    }

    // Tournament with small size for more randomness
    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    return selected.phenotype;
  }

  /** Report a result (success/failure) for an organism on a domain. */
  reportResult(domain: string, phenotype: FingerprintPhenotype, success: boolean, responseTimeMs?: number): void {
    // Find the organism that matches this phenotype
    const population = this.evolution.getPopulation();
    const organism = population.find(o => o.phenotype.userAgent === phenotype.userAgent);

    if (organism) {
      this.evolution.reportResult(organism.id, success);
    }

    // Update domain-specific fitness
    if (!this.domainFitness.has(domain)) {
      this.domainFitness.set(domain, new Map());
    }
    const domainMap = this.domainFitness.get(domain)!;

    if (organism) {
      const currentFit = domainMap.get(organism.id) || 0.5;
      const delta = success ? 0.05 : -0.1;
      domainMap.set(organism.id, Math.max(0, Math.min(1, currentFit + delta)));
    }

    // Update domain records
    if (!this.domainRecords.has(domain)) {
      this.domainRecords.set(domain, []);
    }
    const records = this.domainRecords.get(domain)!;
    if (organism) {
      records.push({
        domain,
        organismId: organism.id,
        fitness: domainMap.get(organism.id) || 0.5,
        successes: success ? 1 : 0,
        failures: success ? 0 : 1,
        lastUsedAt: Date.now(),
        preferredSpecies: organism.species,
      });

      // Keep only last 100 records per domain
      if (records.length > 100) {
        this.domainRecords.set(domain, records.slice(-100));
      }
    }
  }

  /** Get population statistics. */
  getStats(): PopulationStats & { domainCount: number; totalProfilesServed: number } {
    const popStats = this.evolution.getStats();
    return {
      ...popStats,
      domainCount: this.domainFitness.size,
      totalProfilesServed: Array.from(this.domainRecords.values())
        .reduce((sum, records) => sum + records.length, 0),
    };
  }

  /** Get domain-specific fitness data. */
  getDomainFitness(domain: string): DomainFitnessRecord[] {
    return this.domainRecords.get(domain) || [];
  }

  /** Get the compatibility distance between two phenotypes. */
  comparePhenotypes(a: FingerprintPhenotype, b: FingerprintPhenotype): number {
    const orgA = createOrganism();
    const orgB = createOrganism();
    orgA.phenotype = a;
    orgB.phenotype = b;
    return compatibilityDistance(orgA, orgB);
  }

  /** Start periodic evolution cycles. */
  private startEvolution(): void {
    // Evolve every 5 minutes
    this.evolutionInterval = setInterval(() => {
      try {
        const stats = this.evolution.evolve();
        logger.info(
          {
            generation: stats.generation,
            populationSize: stats.populationSize,
            avgFitness: stats.avgFitness.toFixed(3),
            bestFitness: stats.bestFitness.toFixed(3),
            diversity: stats.diversityIndex.toFixed(3),
            speciesCount: stats.speciesCount,
          },
          'Evolution cycle completed',
        );

        // Cache the population periodically
        this.saveToCache().catch(err => {
          logger.debug({ err: (err as Error).message }, 'Failed to cache population');
        });
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'Evolution cycle failed');
      }
    }, 300000); // 5 minutes
  }

  /** Stop the engine. */
  async shutdown(): Promise<void> {
    if (this.evolutionInterval) {
      clearInterval(this.evolutionInterval);
      this.evolutionInterval = null;
    }
    await this.saveToCache();
    logger.info('DNA Engine shut down');
  }

  /** Save population to Redis cache. */
  private async saveToCache(): Promise<void> {
    try {
      const population = this.evolution.getPopulation();
      const serializable = population.map(o => ({
        id: o.id,
        generation: o.generation,
        fitness: o.fitness,
        successes: o.successes,
        failures: o.failures,
        bornAt: o.bornAt,
        lastUsedAt: o.lastUsedAt,
        parentIds: o.parentIds,
        species: o.species,
        isAlive: o.isAlive,
        phenotype: o.phenotype,
      }));
      await cacheSet('dna:population', serializable, 3600);
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'Failed to save population to cache');
    }
  }

  /** Load population from Redis cache. */
  private async loadFromCache(): Promise<Organism[] | null> {
    try {
      const cached = await cacheGet<Array<Partial<Organism>>>('dna:population');
      if (!cached) return null;

      const data = cached;
      if (!Array.isArray(data) || data.length === 0) return null;

      // Reconstruct organisms (simplified -- missing chromosomes will be rebuilt)
      const organisms: Organism[] = data.map(item => {
        const org = createOrganism(item.generation || 0, item.parentIds || []);
        org.id = item.id || org.id;
        org.fitness = item.fitness || org.fitness;
        org.successes = item.successes || 0;
        org.failures = item.failures || 0;
        org.species = item.species || org.species;
        if (item.phenotype) {
          org.phenotype = item.phenotype as FingerprintPhenotype;
        }
        return org;
      });

      // Inject into evolution engine
      this.evolution.initialize(0); // Start with empty
      for (const org of organisms) {
        this.evolution.getPopulation().push(org);
      }

      return organisms;
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'Failed to load population from cache');
      return null;
    }
  }
}

// ===============================================================================
// SINGLETON & EXPORTS
// ===============================================================================

export const dnaEngine = new DNAEngine();
export default DNAEngine;

// Re-export types and sub-modules
export type {
  Gene,
  Chromosome,
  Organism,
  FingerprintPhenotype,
  MutationResult,
  MutationOperator,
  FitnessContext,
  PopulationStats,
  DomainFitnessRecord,
  DNAEngineConfig,
  GeneConstraint,
  CrossoverResult,
} from './types';

export { createOrganism, createSeededPopulation, expressPhenotype } from './organism';
export { EvolutionEngine, evaluateFitness, compatibilityDistance, DEFAULT_DNA_CONFIG } from './evolution';
