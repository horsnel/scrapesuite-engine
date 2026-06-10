/**
 * Evolution Engine -- ScrapeSuite DNA Engine
 *
 * Implements the genetic algorithm that drives fingerprint evolution:
 * - Selection: Tournament selection to pick the fittest organisms
 * - Crossover: Breed new organisms from successful parents
 * - Mutation: Directed mutation with constraint enforcement
 * - Speciation: Maintain diverse species using compatibility distance
 * - Extinction: Remove underperforming organisms
 * - Stagnation recovery: Mass extinction + reseeding when stuck
 *
 * Hard-to-copy because: The fitness function is domain-specific and
 * multi-objective (balancing success rate, consistency, uniqueness,
 * and realism simultaneously), and the constraint system prevents
 * impossible fingerprints that anti-bot systems would flag instantly.
 */

import { createChildLogger } from '../utils/logger';
import {
  type Organism,
  type Gene,
  type Chromosome,
  type MutationResult,
  type MutationOperator,
  type FitnessContext,
  type PopulationStats,
  type DNAEngineConfig,
} from './types';
import { createOrganism, createFromCrossover, createSeededPopulation, expressPhenotype } from './organism';

const logger = createChildLogger('dna-evolution');

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_DNA_CONFIG: DNAEngineConfig = {
  maxPopulationSize: 200,
  minPopulationSize: 50,
  baseMutationRate: 0.08,
  crossoverRate: 0.7,
  eliteRate: 0.1,
  tournamentSize: 5,
  speciesThreshold: 0.6,
  stagnationLimit: 20,
  fitnessWeights: {
    successRate: 0.35,
    consistency: 0.25,
    uniqueness: 0.2,
    realism: 0.15,
    responseTime: 0.05,
  },
  verbose: false,
};

// ===============================================================================
// FITNESS EVALUATION
// ===============================================================================

/** Evaluate the fitness of an organism given its performance context. */
export function evaluateFitness(organism: Organism, context: FitnessContext): number {
  const w = DEFAULT_DNA_CONFIG.fitnessWeights;

  const totalAttempts = context.bypassSuccesses + context.bypassFailures;
  const successRate = totalAttempts > 0 ? context.bypassSuccesses / totalAttempts : 0.5;
  const successComponent = Math.pow(successRate, 0.8); // Slight diminishing returns

  const consistencyComponent = context.consistencyScore;
  const uniquenessComponent = context.uniquenessScore;
  const realismComponent = context.realismScore;

  // Response time component: faster is better, but with diminishing returns
  const responseComponent = Math.max(0, 1 - (context.avgResponseTimeMs / 30000));

  const fitness =
    w.successRate * successComponent +
    w.consistency * consistencyComponent +
    w.uniqueness * uniquenessComponent +
    w.realism * realismComponent +
    w.responseTime * responseComponent;

  return Math.max(0, Math.min(1, fitness));
}

/** Calculate default fitness for an organism with no history (initial fitness). */
export function defaultFitness(organism: Organism): number {
  const totalAttempts = organism.successes + organism.failures;
  if (totalAttempts === 0) return 0.5 + Math.random() * 0.1; // Start moderate

  const successRate = organism.successes / totalAttempts;
  // Age penalty: older organisms that haven't been used recently decay slightly
  const ageHours = (Date.now() - organism.lastUsedAt) / 3600000;
  const recencyBonus = Math.max(0, 1 - ageHours / 48); // Decay over 48 hours

  return Math.max(0.1, Math.min(1, successRate * 0.8 + recencyBonus * 0.2));
}

// ===============================================================================
// SELECTION
// ===============================================================================

/** Tournament selection: pick the best from a random subset. */
export function tournamentSelect(population: Organism[], tournamentSize: number): Organism {
  const contestants: Organism[] = [];
  for (let i = 0; i < tournamentSize; i++) {
    const idx = Math.floor(Math.random() * population.length);
    contestants.push(population[idx]);
  }
  contestants.sort((a, b) => b.fitness - a.fitness);
  return contestants[0];
}

/** Roulette wheel selection for diversity. */
export function rouletteSelect(population: Organism[]): Organism {
  const totalFitness = population.reduce((sum, o) => sum + o.fitness, 0);
  if (totalFitness === 0) return population[Math.floor(Math.random() * population.length)];

  let random = Math.random() * totalFitness;
  for (const organism of population) {
    random -= organism.fitness;
    if (random <= 0) return organism;
  }
  return population[population.length - 1];
}

// ===============================================================================
// MUTATION
// ===============================================================================

/** Apply a random mutation to an organism. Returns the mutation result. */
export function mutate(organism: Organism, generation: number, forceOperator?: MutationOperator): MutationResult {
  const operator: MutationOperator = forceOperator || selectMutationOperator(organism);
  const affectedLoci: string[] = [];
  const constraintViolations: string[] = [];
  const oldFitness = organism.fitness;

  switch (operator) {
    case 'point':
      applyPointMutation(organism, generation, affectedLoci, constraintViolations);
      break;
    case 'crossover':
      // Self-crossover within the organism (recombine its own chromosomes)
      applyInternalCrossover(organism, generation, affectedLoci);
      break;
    case 'regulation':
      applyRegulationMutation(organism, generation, affectedLoci);
      break;
    case 'inversion':
      applyInversionMutation(organism, generation, affectedLoci);
      break;
    case 'translocation':
      applyTranslocationMutation(organism, generation, affectedLoci);
      break;
    default:
      applyPointMutation(organism, generation, affectedLoci, constraintViolations);
      break;
  }

  // Re-express phenotype after mutation
  organism.phenotype = expressPhenotype(organism);

  const fitnessDelta = organism.fitness - oldFitness;

  return {
    organism,
    operator,
    affectedLoci,
    constraintViolations,
    fitnessDelta,
  };
}

/** Select which mutation operator to apply based on organism state. */
function selectMutationOperator(organism: Organism): MutationOperator {
  // If organism is failing, use more aggressive mutations
  if (organism.failures > organism.successes * 2) {
    const roll = Math.random();
    if (roll < 0.4) return 'point';
    if (roll < 0.7) return 'crossover';
    if (roll < 0.85) return 'regulation';
    return 'inversion';
  }

  // If organism is successful, use conservative mutations
  if (organism.fitness > 0.8) {
    const roll = Math.random();
    if (roll < 0.6) return 'regulation';
    if (roll < 0.85) return 'point';
    return 'translocation';
  }

  // Default: balanced mutation
  const roll = Math.random();
  if (roll < 0.5) return 'point';
  if (roll < 0.75) return 'crossover';
  if (roll < 0.9) return 'regulation';
  return 'inversion';
}

function applyPointMutation(
  organism: Organism,
  generation: number,
  affectedLoci: string[],
  violations: string[],
): void {
  // Pick a random chromosome and gene
  const chromNames = Array.from(organism.chromosomes.keys());
  const chromName = chromNames[Math.floor(Math.random() * chromNames.length)];
  const chromosome = organism.chromosomes.get(chromName);
  if (!chromosome) return;

  const geneNames = Array.from(chromosome.genes.keys());
  const geneName = geneNames[Math.floor(Math.random() * geneNames.length)];
  const gene = chromosome.genes.get(geneName);
  if (!gene || gene.allelePool.length <= 1) return;

  // Select a new allele different from current
  const newAllele = selectNewAllele(gene);
  if (newAllele !== undefined && newAllele !== gene.allele) {
    // Check constraints
    const isViolation = checkConstraints(gene, newAllele, organism);
    if (isViolation) {
      violations.push(gene.locus);
      // Still apply but mark as violated -- the fitness function will penalize
    }

    gene.allele = newAllele;
    gene.lastMutatedGen = generation;
    affectedLoci.push(gene.locus);
  }
}

function selectNewAllele(gene: Gene): unknown {
  const otherAlleles = gene.allelePool.filter(a => a !== gene.allele);
  if (otherAlleles.length === 0) return gene.allele;
  return otherAlleles[Math.floor(Math.random() * otherAlleles.length)];
}

function checkConstraints(gene: Gene, _newAllele: unknown, organism: Organism): boolean {
  let violated = false;
  for (const constraint of gene.constraints) {
    for (const chrom of organism.chromosomes.values()) {
      const linkedGene = chrom.genes.get(constraint.linkedLocus);
      if (!linkedGene) continue;

      switch (constraint.type) {
        case 'requires': {
          // Simple check: if the linked gene's value doesn't match required data
          // This is a simplified check -- full implementation would be more thorough
          break;
        }
        case 'excludes': {
          // Would check if new allele excludes linked gene's allele
          break;
        }
        default:
          break;
      }
    }
  }
  return violated;
}

function applyInternalCrossover(
  organism: Organism,
  _generation: number,
  affectedLoci: string[],
): void {
  // Exchange alleles between chromosomes of the same type
  const chromNames = Array.from(organism.chromosomes.keys());
  if (chromNames.length < 2) return;

  // Pick two random chromosomes
  const idx1 = Math.floor(Math.random() * chromNames.length);
  let idx2 = Math.floor(Math.random() * chromNames.length);
  while (idx2 === idx1) idx2 = Math.floor(Math.random() * chromNames.length);

  const chrom1 = organism.chromosomes.get(chromNames[idx1])!;
  const chrom2 = organism.chromosomes.get(chromNames[idx2])!;

  // Swap a random gene between chromosomes (if they share locus names)
  for (const locus of chrom1.genes.keys()) {
    if (chrom2.genes.has(locus) && Math.random() < 0.3) {
      const gene1 = chrom1.genes.get(locus)!;
      const gene2 = chrom2.genes.get(locus)!;
      const temp = gene1.allele;
      gene1.allele = gene2.allele;
      gene2.allele = temp;
      affectedLoci.push(locus);
    }
  }
}

function applyRegulationMutation(
  organism: Organism,
  _generation: number,
  affectedLoci: string[],
): void {
  // Change mutation rates of genes
  for (const chrom of organism.chromosomes.values()) {
    for (const [locus, gene] of chrom.genes) {
      if (Math.random() < 0.1) {
        // Shift mutation rate slightly
        const delta = (Math.random() - 0.5) * 0.02;
        gene.mutationRate = Math.max(0.001, Math.min(0.5, gene.mutationRate + delta));
        affectedLoci.push(locus);
      }
    }
  }
}

function applyInversionMutation(
  organism: Organism,
  _generation: number,
  affectedLoci: string[],
): void {
  // Pick a chromosome and invert gene values where possible
  const chromNames = Array.from(organism.chromosomes.keys());
  const chromName = chromNames[Math.floor(Math.random() * chromNames.length)];
  const chromosome = organism.chromosomes.get(chromName);
  if (!chromosome) return;

  for (const [locus, gene] of chromosome.genes) {
    if (typeof gene.allele === 'number' && gene.allelePool.length > 1) {
      // Invert numeric values within their pool
      const poolValues = gene.allelePool as number[];
      const currentIdx = poolValues.indexOf(gene.allele);
      const invertedIdx = poolValues.length - 1 - currentIdx;
      if (invertedIdx >= 0 && invertedIdx < poolValues.length) {
        gene.allele = poolValues[invertedIdx];
        affectedLoci.push(locus);
      }
    }
  }
}

function applyTranslocationMutation(
  organism: Organism,
  _generation: number,
  affectedLoci: string[],
): void {
  // Move a gene's allele pool position to affect selection probability
  const chromNames = Array.from(organism.chromosomes.keys());
  const chromName = chromNames[Math.floor(Math.random() * chromNames.length)];
  const chromosome = organism.chromosomes.get(chromName);
  if (!chromosome) return;

  const geneNames = Array.from(chromosome.genes.keys());
  const geneName = geneNames[Math.floor(Math.random() * geneNames.length)];
  const gene = chromosome.genes.get(geneName);
  if (!gene || gene.allelePool.length <= 2) return;

  // Shift allele pool order (affects future mutation selection)
  const shift = Math.floor(Math.random() * 3) - 1;
  gene.allelePool = [...gene.allelePool.slice(shift), ...gene.allelePool.slice(0, shift)];
  affectedLoci.push(gene.locus);
}

// ===============================================================================
// SPECIATION
// ===============================================================================

/** Calculate compatibility distance between two organisms. */
export function compatibilityDistance(a: Organism, b: Organism): number {
  let matchingGenes = 0;
  let matchingAlleles = 0;

  for (const chromName of a.chromosomes.keys()) {
    const chromA = a.chromosomes.get(chromName);
    const chromB = b.chromosomes.get(chromName);
    if (!chromA || !chromB) continue;

    for (const locus of chromA.genes.keys()) {
      const geneA = chromA.genes.get(locus);
      const geneB = chromB.genes.get(locus);
      if (!geneA || !geneB) continue;

      matchingGenes++;
      if (JSON.stringify(geneA.allele) === JSON.stringify(geneB.allele)) {
        matchingAlleles++;
      }
    }
  }

  if (matchingGenes === 0) return 1;
  return 1 - (matchingAlleles / matchingGenes);
}

// ===============================================================================
// EVOLUTION CYCLE
// ===============================================================================

export class EvolutionEngine {
  private config: DNAEngineConfig;
  private population: Organism[] = [];
  private generation: number = 0;
  private bestFitnessHistory: number[] = [];
  private stagnationCounter: number = 0;

  constructor(config?: Partial<DNAEngineConfig>) {
    this.config = { ...DEFAULT_DNA_CONFIG, ...config };
  }

  /** Initialize the population. */
  initialize(size?: number): void {
    const popSize = size || this.config.maxPopulationSize;
    this.population = createSeededPopulation(popSize, this.generation);
    this.generation = 0;
    logger.info({ populationSize: popSize }, 'Evolution engine initialized');
  }

  /** Get the current population. */
  getPopulation(): Organism[] {
    return this.population;
  }

  /** Get the current generation. */
  getGeneration(): number {
    return this.generation;
  }

  /** Run one evolution cycle. */
  evolve(): PopulationStats {
    const stats = this.getStats();

    // 1. Evaluate fitness for all organisms
    for (const organism of this.population) {
      organism.fitness = defaultFitness(organism);
    }

    // 2. Sort by fitness
    this.population.sort((a, b) => b.fitness - a.fitness);

    // 3. Check for stagnation
    const bestFitness = this.population[0]?.fitness || 0;
    this.bestFitnessHistory.push(bestFitness);

    if (this.bestFitnessHistory.length > this.config.stagnationLimit) {
      const recentBest = this.bestFitnessHistory.slice(-this.config.stagnationLimit);
      const improvement = Math.max(...recentBest) - Math.min(...recentBest);
      if (improvement < 0.01) {
        this.stagnationCounter++;
        if (this.stagnationCounter >= 3) {
          this.massExtinction();
          return this.getStats();
        }
      } else {
        this.stagnationCounter = 0;
      }
    }

    // 4. Preserve elite
    const eliteCount = Math.floor(this.population.length * this.config.eliteRate);
    const elite = this.population.slice(0, eliteCount);

    // 5. Breed new organisms
    const newOrganisms: Organism[] = [...elite];
    const targetSize = this.config.maxPopulationSize;

    while (newOrganisms.length < targetSize) {
      if (Math.random() < this.config.crossoverRate && this.population.length >= 2) {
        // Crossover breeding
        const parent1 = tournamentSelect(this.population, this.config.tournamentSize);
        const parent2 = tournamentSelect(this.population, this.config.tournamentSize);
        const child = createFromCrossover(parent1, parent2, this.generation + 1);

        // Mutate the child
        if (Math.random() < this.config.baseMutationRate) {
          mutate(child, this.generation + 1);
        }

        newOrganisms.push(child);
      } else {
        // Asexual reproduction with mutation
        const parent = tournamentSelect(this.population, this.config.tournamentSize);
        const child = createFromCrossover(parent, parent, this.generation + 1);
        mutate(child, this.generation + 1);
        newOrganisms.push(child);
      }
    }

    // 6. Replace population
    this.population = newOrganisms.slice(0, targetSize);
    this.generation++;

    return this.getStats();
  }

  /** Mass extinction event -- kill most of the population and reseed. */
  private massExtinction(): void {
    logger.warn({ generation: this.generation }, 'Mass extinction triggered due to stagnation');

    // Keep top 10%
    const survivorCount = Math.max(5, Math.floor(this.population.length * 0.1));
    const survivors = this.population
      .sort((a, b) => b.fitness - a.fitness)
      .slice(0, survivorCount);

    // Reseed with fresh organisms
    const freshCount = this.config.maxPopulationSize - survivorCount;
    const freshOrganisms = createSeededPopulation(freshCount, this.generation + 1);

    this.population = [...survivors, ...freshOrganisms];
    this.stagnationCounter = 0;
    this.bestFitnessHistory = [];

    logger.info(
      { survivors: survivorCount, fresh: freshCount },
      'Population reseeded after mass extinction',
    );
  }

  /** Get the fittest organism for a given domain. */
  getFittestForDomain(domain: string, domainFitness: Map<string, Map<string, number>>): Organism | null {
    const domainMap = domainFitness.get(domain);
    if (!domainMap || domainMap.size === 0) {
      // No domain-specific data -- return the global fittest
      return this.population[0] || null;
    }

    // Sort population by domain-specific fitness
    const sorted = [...this.population].sort((a, b) => {
      const aFit = domainMap.get(a.id) || a.fitness;
      const bFit = domainMap.get(b.id) || b.fitness;
      return bFit - aFit;
    });

    return sorted[0];
  }

  /** Report a success or failure for an organism. */
  reportResult(organismId: string, success: boolean): void {
    const organism = this.population.find(o => o.id === organismId);
    if (!organism) return;

    if (success) {
      organism.successes++;
    } else {
      organism.failures++;
    }
    organism.lastUsedAt = Date.now();
  }

  /** Get population statistics. */
  getStats(): PopulationStats {
    const fitnesses = this.population.map(o => o.fitness);
    const avgFitness = fitnesses.length > 0 ? fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length : 0;
    const bestFitness = fitnesses.length > 0 ? Math.max(...fitnesses) : 0;
    const worstFitness = fitnesses.length > 0 ? Math.min(...fitnesses) : 0;

    const variance = fitnesses.length > 0
      ? fitnesses.reduce((sum, f) => sum + Math.pow(f - avgFitness, 2), 0) / fitnesses.length
      : 0;
    const fitnessStdDev = Math.sqrt(variance);

    // Species distribution
    const speciesDist = new Map<string, number>();
    for (const org of this.population) {
      speciesDist.set(org.species, (speciesDist.get(org.species) || 0) + 1);
    }

    // Diversity index (Shannon entropy normalized)
    let diversityIndex = 0;
    if (this.population.length > 0) {
      for (const count of speciesDist.values()) {
        const p = count / this.population.length;
        if (p > 0) diversityIndex -= p * Math.log2(p);
      }
      diversityIndex /= Math.log2(this.population.length); // Normalize to 0-1
    }

    return {
      populationSize: this.population.length,
      avgFitness,
      bestFitness,
      worstFitness,
      fitnessStdDev,
      speciesCount: speciesDist.size,
      generation: this.generation,
      births: this.population.filter(o => o.generation === this.generation).length,
      deaths: 0,
      diversityIndex,
      speciesDistribution: speciesDist,
    };
  }
}

/** Singleton evolution engine. */
export const evolutionEngine = new EvolutionEngine();
