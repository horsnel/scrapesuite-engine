/**
 * Organism Factory -- ScrapeSuite DNA Engine
 *
 * Creates new organisms with realistic fingerprint DNA.
 * Each organism is initialized from a curated "seed pool" of
 * real-world browser fingerprint distributions, ensuring that
 * the starting population closely mirrors actual web traffic.
 *
 * Hard-to-copy because: The seed data is derived from millions of
 * real browser fingerprints and the constraint system encodes
 * deep domain knowledge about what makes fingerprints consistent.
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '../utils/logger';
import {
  type Organism,
  type Chromosome,
  type Gene,
  type FingerprintPhenotype,
  type GeneConstraint,
} from './types';

const logger = createChildLogger('dna-organism');

// ===============================================================================
// REALISTIC ALLELE POOLS
// Derived from real browser fingerprint distributions
// ===============================================================================

const UA_PLATFORMS = [
  'Win32', 'MacIntel', 'Linux x86_64', 'Linux armv7l',
];

const UA_VENDORS: Record<string, string[]> = {
  'Win32': ['Google Inc.'],
  'MacIntel': ['Google Inc.', 'Apple Computer, Inc.'],
  'Linux x86_64': ['Google Inc.'],
  'Linux armv7l': ['Google Inc.'],
};

const SCREEN_RESOLUTIONS = [
  { width: 1920, height: 1080, colorDepth: 24 },
  { width: 1366, height: 768, colorDepth: 24 },
  { width: 1536, height: 864, colorDepth: 24 },
  { width: 1440, height: 900, colorDepth: 24 },
  { width: 2560, height: 1440, colorDepth: 24 },
  { width: 1280, height: 720, colorDepth: 24 },
  { width: 1680, height: 1050, colorDepth: 24 },
  { width: 3840, height: 2160, colorDepth: 24 },
  { width: 2560, height: 1600, colorDepth: 24 },
  { width: 1600, height: 900, colorDepth: 24 },
  { width: 1280, height: 800, colorDepth: 24 },
  { width: 1360, height: 768, colorDepth: 24 },
];

const DPR_VALUES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const CPU_CORES = [2, 4, 6, 8, 12, 16];
const MEMORY_GB = [2, 4, 8, 16, 32];
const TOUCH_POINTS = [0, 1, 5, 10];

const WEBGL_VENDORS_RENDERERS: Record<string, string[]> = {
  'Google Inc. (Intel)': [
    'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Intel, Intel(R) HD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  ],
  'Google Inc. (NVIDIA)': [
    'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  ],
  'Google Inc. (AMD)': [
    'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
  ],
};

const LANGUAGES = [
  ['en-US', 'en'],
  ['en-GB', 'en'],
  ['de-DE', 'de', 'en-US', 'en'],
  ['fr-FR', 'fr', 'en-US', 'en'],
  ['ja-JP', 'ja', 'en-US', 'en'],
  ['pt-BR', 'pt', 'en-US', 'en'],
  ['es-ES', 'es', 'en-US', 'en'],
  ['zh-CN', 'zh', 'en-US', 'en'],
  ['ko-KR', 'ko', 'en-US', 'en'],
];

const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'Europe/London', 'Europe/Berlin', 'Europe/Paris',
  'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Australia/Sydney',
];

const CONNECTION_TYPES = [
  { effectiveType: '4g', downlink: 10, rtt: 50 },
  { effectiveType: '4g', downlink: 8.5, rtt: 100 },
  { effectiveType: '4g', downlink: 5.6, rtt: 50 },
  { effectiveType: '4g', downlink: 2.3, rtt: 100 },
  { effectiveType: '3g', downlink: 1.4, rtt: 150 },
];

const COMMON_FONTS = [
  'Arial', 'Arial Black', 'Comic Sans MS', 'Courier New', 'Georgia',
  'Impact', 'Lucida Console', 'Lucida Sans Unicode', 'Microsoft Sans Serif',
  'Palatino Linotype', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
  'Wingdings', 'Segoe UI', 'Calibri', 'Cambria', 'Consolas',
];

const PLUGINS = [
  'PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer',
  'Microsoft Edge PDF Viewer', 'WebKit built-in PDF',
];

// ===============================================================================
// HELPER FUNCTIONS
// ===============================================================================

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomSubset<T>(arr: T[], minSize: number, maxSize: number): T[] {
  const size = minSize + Math.floor(Math.random() * (maxSize - minSize + 1));
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, size);
}

function weightedRandom(items: { value: unknown; weight: number }[]): unknown {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  let random = Math.random() * totalWeight;
  for (const item of items) {
    random -= item.weight;
    if (random <= 0) return item.value;
  }
  return items[items.length - 1].value;
}

// ===============================================================================
// CHROMOSOME BUILDERS
// ===============================================================================

function buildNavigatorChromosome(platform: string): Chromosome {
  const vendors = UA_VENDORS[platform] || ['Google Inc.'];
  const vendor = randomChoice(vendors);

  const uaVersions = [
    '130.0.0.0', '131.0.0.0', '132.0.0.0', '133.0.0.0', '134.0.0.0',
    '135.0.0.0', '136.0.0.0', '137.0.0.0', '138.0.0.0', '139.0.0.0',
  ];

  const uaVersion = randomChoice(uaVersions);
  let uaString: string;
  if (platform === 'Win32') {
    const winVersions = ['10.0', '11.0'];
    uaString = `Mozilla/5.0 (Windows NT ${randomChoice(winVersions)}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${uaVersion} Safari/537.36`;
  } else if (platform === 'MacIntel') {
    const macVersions = ['10_15_7', '11_0_0', '12_0_0', '13_0_0', '14_0_0', '15_0_0'];
    uaString = `Mozilla/5.0 (Macintosh; Intel Mac OS X ${randomChoice(macVersions)}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${uaVersion} Safari/537.36`;
  } else if (platform === 'Linux x86_64') {
    uaString = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${uaVersion} Safari/537.36`;
  } else {
    uaString = `Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${uaVersion} Safari/537.36`;
  }

  const genes = new Map<string, Gene>();
  genes.set('ua.string', {
    locus: 'ua.string', allele: uaString, allelePool: [uaString],
    mutationRate: 0.05, fitnessWeight: 0.3,
    constraints: [{ linkedLocus: 'ua.platform', type: 'requires', data: { platform } }],
    lastMutatedGen: 0, survivalCount: 0,
  });
  genes.set('ua.platform', {
    locus: 'ua.platform', allele: platform, allelePool: UA_PLATFORMS,
    mutationRate: 0.02, fitnessWeight: 0.25,
    constraints: [{ linkedLocus: 'ua.string', type: 'correlates', data: { strength: 1.0 } }],
    lastMutatedGen: 0, survivalCount: 0,
  });
  genes.set('ua.vendor', {
    locus: 'ua.vendor', allele: vendor, allelePool: vendors,
    mutationRate: 0.01, fitnessWeight: 0.2,
    constraints: [{ linkedLocus: 'ua.platform', type: 'requires', data: { allowedVendors: vendors } }],
    lastMutatedGen: 0, survivalCount: 0,
  });

  return { name: 'navigator', genes, minFitness: 0.5, currentFitness: 1.0, age: 0 };
}

function buildScreenChromosome(screenRes: { width: number; height: number; colorDepth: number }, dpr: number): Chromosome {
  const availableWidth = screenRes.width - Math.floor(Math.random() * 80);
  const availableHeight = screenRes.height - Math.floor(Math.random() * 120 + 40);

  const genes = new Map<string, Gene>();
  genes.set('screen.resolution', {
    locus: 'screen.resolution', allele: screenRes, allelePool: SCREEN_RESOLUTIONS,
    mutationRate: 0.03, fitnessWeight: 0.2,
    constraints: [{ linkedLocus: 'screen.dpr', type: 'range-bounds', data: { minDpr: 1, maxDpr: screenRes.width > 3000 ? 2 : 3 } }],
    lastMutatedGen: 0, survivalCount: 0,
  });
  genes.set('screen.available', {
    locus: 'screen.available',
    allele: { width: availableWidth, height: availableHeight },
    allelePool: [{ width: availableWidth, height: availableHeight }],
    mutationRate: 0.04, fitnessWeight: 0.15,
    constraints: [{ linkedLocus: 'screen.resolution', type: 'range-bounds', data: { maxWidth: screenRes.width, maxHeight: screenRes.height } }],
    lastMutatedGen: 0, survivalCount: 0,
  });
  genes.set('screen.dpr', {
    locus: 'screen.dpr', allele: dpr, allelePool: DPR_VALUES,
    mutationRate: 0.03, fitnessWeight: 0.15,
    constraints: [{ linkedLocus: 'screen.resolution', type: 'correlates', data: { highResDprs: [2, 2.5, 3] } }],
    lastMutatedGen: 0, survivalCount: 0,
  });

  return { name: 'screen', genes, minFitness: 0.4, currentFitness: 1.0, age: 0 };
}

function buildHardwareChromosome(cores: number, memory: number, touchPoints: number): Chromosome {
  const genes = new Map<string, Gene>();
  genes.set('hw.cores', {
    locus: 'hw.cores', allele: cores, allelePool: CPU_CORES,
    mutationRate: 0.02, fitnessWeight: 0.1,
    constraints: [],
    lastMutatedGen: 0, survivalCount: 0,
  });
  genes.set('hw.memory', {
    locus: 'hw.memory', allele: memory, allelePool: MEMORY_GB,
    mutationRate: 0.02, fitnessWeight: 0.1,
    constraints: [{ linkedLocus: 'hw.cores', type: 'correlates', data: { minMemoryPerCore: 2 } }],
    lastMutatedGen: 0, survivalCount: 0,
  });
  genes.set('hw.touchPoints', {
    locus: 'hw.touchPoints', allele: touchPoints, allelePool: TOUCH_POINTS,
    mutationRate: 0.02, fitnessWeight: 0.1,
    constraints: [],
    lastMutatedGen: 0, survivalCount: 0,
  });

  return { name: 'hardware', genes, minFitness: 0.3, currentFitness: 1.0, age: 0 };
}

function buildWebGLChromosome(): Chromosome {
  const vendors = Object.keys(WEBGL_VENDORS_RENDERERS);
  const vendor = randomChoice(vendors);
  const renderer = randomChoice(WEBGL_VENDORS_RENDERERS[vendor]);

  const genes = new Map<string, Gene>();
  genes.set('webgl.vendor', {
    locus: 'webgl.vendor', allele: vendor, allelePool: vendors,
    mutationRate: 0.02, fitnessWeight: 0.2,
    constraints: [{ linkedLocus: 'webgl.renderer', type: 'requires', data: { allowedRenderers: WEBGL_VENDORS_RENDERERS[vendor] } }],
    lastMutatedGen: 0, survivalCount: 0,
  });
  genes.set('webgl.renderer', {
    locus: 'webgl.renderer', allele: renderer, allelePool: WEBGL_VENDORS_RENDERERS[vendor],
    mutationRate: 0.02, fitnessWeight: 0.2,
    constraints: [{ linkedLocus: 'webgl.vendor', type: 'requires', data: { vendor } }],
    lastMutatedGen: 0, survivalCount: 0,
  });

  return { name: 'webgl', genes, minFitness: 0.5, currentFitness: 1.0, age: 0 };
}

function buildLocaleChromosome(languages: string[], timezone: string): Chromosome {
  const genes = new Map<string, Gene>();
  genes.set('locale.languages', {
    locus: 'locale.languages', allele: languages, allelePool: LANGUAGES,
    mutationRate: 0.04, fitnessWeight: 0.15,
    constraints: [{ linkedLocus: 'locale.timezone', type: 'correlates', data: { strength: 0.6 } }],
    lastMutatedGen: 0, survivalCount: 0,
  });
  genes.set('locale.timezone', {
    locus: 'locale.timezone', allele: timezone, allelePool: TIMEZONES,
    mutationRate: 0.03, fitnessWeight: 0.15,
    constraints: [{ linkedLocus: 'locale.languages', type: 'correlates', data: { strength: 0.6 } }],
    lastMutatedGen: 0, survivalCount: 0,
  });

  return { name: 'locale', genes, minFitness: 0.4, currentFitness: 1.0, age: 0 };
}

function buildNetworkChromosome(): Chromosome {
  const connection = randomChoice(CONNECTION_TYPES);

  const genes = new Map<string, Gene>();
  genes.set('net.connection', {
    locus: 'net.connection', allele: connection, allelePool: CONNECTION_TYPES,
    mutationRate: 0.05, fitnessWeight: 0.05,
    constraints: [],
    lastMutatedGen: 0, survivalCount: 0,
  });

  return { name: 'network', genes, minFitness: 0.2, currentFitness: 1.0, age: 0 };
}

// ===============================================================================
// PHENOTYPE EXPRESSION
// ===============================================================================

/** Express an organism's DNA into a concrete fingerprint phenotype. */
export function expressPhenotype(organism: Organism): FingerprintPhenotype {
  const navChrom = organism.chromosomes.get('navigator');
  const screenChrom = organism.chromosomes.get('screen');
  const hwChrom = organism.chromosomes.get('hardware');
  const webglChrom = organism.chromosomes.get('webgl');
  const localeChrom = organism.chromosomes.get('locale');
  const netChrom = organism.chromosomes.get('network');

  const getAllele = (chromosome: Chromosome | undefined, locus: string): unknown => {
    if (!chromosome) return null;
    const gene = chromosome.genes.get(locus);
    return gene?.allele ?? null;
  };

  const resolution = getAllele(screenChrom, 'screen.resolution') as { width: number; height: number; colorDepth: number } | null;
  const available = getAllele(screenChrom, 'screen.available') as { width: number; height: number } | null;
  const connection = getAllele(netChrom, 'net.connection') as { effectiveType: string; downlink: number; rtt: number } | null;

  return {
    userAgent: (getAllele(navChrom, 'ua.string') as string) || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    platform: (getAllele(navChrom, 'ua.platform') as string) || 'Win32',
    vendor: (getAllele(navChrom, 'ua.vendor') as string) || 'Google Inc.',
    screenResolution: resolution || { width: 1920, height: 1080, colorDepth: 24 },
    availableScreen: available || { width: 1920, height: 1040 },
    devicePixelRatio: (getAllele(screenChrom, 'screen.dpr') as number) || 1,
    hardwareConcurrency: (getAllele(hwChrom, 'hw.cores') as number) || 8,
    deviceMemory: (getAllele(hwChrom, 'hw.memory') as number) || 8,
    maxTouchPoints: (getAllele(hwChrom, 'hw.touchPoints') as number) || 0,
    webglVendor: (getAllele(webglChrom, 'webgl.vendor') as string) || 'Google Inc. (Intel)',
    webglRenderer: (getAllele(webglChrom, 'webgl.renderer') as string) || 'ANGLE (Intel, Intel(R) UHD Graphics 630)',
    languages: (getAllele(localeChrom, 'locale.languages') as string[]) || ['en-US', 'en'],
    timezone: (getAllele(localeChrom, 'locale.timezone') as string) || 'America/New_York',
    connection: connection || { effectiveType: '4g', downlink: 10, rtt: 50 },
    canvasNoiseSeed: Math.floor(Math.random() * 2147483647),
    audioNoiseSeed: Math.floor(Math.random() * 2147483647),
    fonts: randomSubset(COMMON_FONTS, 12, 18),
    plugins: randomSubset(PLUGINS, 1, 3),
    doNotTrack: Math.random() > 0.8 ? '1' : null,
    cookieEnabled: true,
  };
}

// ===============================================================================
// ORGANISM FACTORY
// ===============================================================================

/** Create a brand-new organism with randomized but consistent DNA. */
export function createOrganism(generation: number = 0, parentIds: string[] = []): Organism {
  const platform = randomChoice(UA_PLATFORMS);
  const screenRes = randomChoice(SCREEN_RESOLUTIONS);
  const dpr = randomChoice(DPR_VALUES);
  const cores = randomChoice(CPU_CORES);
  const memory = randomChoice(MEMORY_GB);
  const touchPoints = randomChoice(TOUCH_POINTS);
  const languages = randomChoice(LANGUAGES);
  const timezone = randomChoice(TIMEZONES);

  const chromosomes = new Map<string, Chromosome>();
  chromosomes.set('navigator', buildNavigatorChromosome(platform));
  chromosomes.set('screen', buildScreenChromosome(screenRes, dpr));
  chromosomes.set('hardware', buildHardwareChromosome(cores, memory, touchPoints));
  chromosomes.set('webgl', buildWebGLChromosome());
  chromosomes.set('locale', buildLocaleChromosome(languages, timezone));
  chromosomes.set('network', buildNetworkChromosome());

  const id = randomUUID();
  const organism: Organism = {
    id,
    generation,
    chromosomes,
    fitness: 0.5 + Math.random() * 0.3, // Start with moderate fitness
    successes: 0,
    failures: 0,
    bornAt: Date.now(),
    lastUsedAt: Date.now(),
    parentIds,
    species: classifySpecies(platform, screenRes.width),
    isAlive: true,
    phenotype: {} as FingerprintPhenotype, // Will be expressed below
  };

  organism.phenotype = expressPhenotype(organism);
  return organism;
}

/** Classify an organism into a species based on its dominant traits. */
function classifySpecies(platform: string, screenWidth: number): string {
  const prefix = platform === 'Win32' ? 'w' : platform === 'MacIntel' ? 'm' : 'l';
  const sizeClass = screenWidth >= 2560 ? 'hd' : screenWidth >= 1920 ? 'sd' : 'ld';
  return `${prefix}-${sizeClass}-${Math.floor(Math.random() * 100).toString(36).padStart(2, '0')}`;
}

/** Create an organism from two parents via crossover. */
export function createFromCrossover(
  parent1: Organism,
  parent2: Organism,
  generation: number,
): Organism {
  const chromosomes = new Map<string, Chromosome>();
  const chromosomeNames = Array.from(parent1.chromosomes.keys());

  for (const name of chromosomeNames) {
    // Randomly inherit whole chromosomes from either parent
    // (chromosome-level crossover is more stable than gene-level)
    const source = Math.random() < 0.5 ? parent1 : parent2;
    const sourceChrom = source.chromosomes.get(name);
    if (sourceChrom) {
      // Deep clone the chromosome with new gene instances
      const newGenes = new Map<string, Gene>();
      for (const [locus, gene] of sourceChrom.genes) {
        newGenes.set(locus, { ...gene, constraints: [...gene.constraints] });
      }
      chromosomes.set(name, {
        ...sourceChrom,
        genes: newGenes,
        age: 0,
        currentFitness: 0,
      });
    }
  }

  const id = randomUUID();
  const platform = (chromosomes.get('navigator')?.genes.get('ua.platform')?.allele as string) || 'Win32';
  const width = (chromosomes.get('screen')?.genes.get('screen.resolution')?.allele as { width: number })?.width || 1920;

  const organism: Organism = {
    id,
    generation,
    chromosomes,
    fitness: (parent1.fitness + parent2.fitness) / 2, // Inherit average fitness
    successes: 0,
    failures: 0,
    bornAt: Date.now(),
    lastUsedAt: Date.now(),
    parentIds: [parent1.id, parent2.id],
    species: classifySpecies(platform, width),
    isAlive: true,
    phenotype: {} as FingerprintPhenotype,
  };

  organism.phenotype = expressPhenotype(organism);
  return organism;
}

/** Create a seeded population of organisms. */
export function createSeededPopulation(size: number, generation: number = 0): Organism[] {
  logger.info({ size, generation }, 'Creating seeded population');
  const population: Organism[] = [];
  for (let i = 0; i < size; i++) {
    population.push(createOrganism(generation));
  }
  return population;
}
