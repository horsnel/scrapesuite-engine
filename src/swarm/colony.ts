/**
 * Swarm Colony Implementation -- ScrapeSuite Engine
 *
 * Implements the ant colony + bee foraging hybrid algorithm for
 * intelligent web crawling. Agents communicate through pheromone
 * trails and waggle dances to optimize data extraction paths.
 *
 * Key innovations over traditional crawlers:
 * 1. Pheromone-guided navigation (not just link following)
 * 2. Role-based agents (scouts discover, workers extract, soldiers handle blocks)
 * 3. Waggle dance communication (rich data sources attract more agents)
 * 4. Energy-based lifecycle (agents die and spawn based on performance)
 * 5. Shared frontier with priority inheritance
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '../utils/logger';
import {
  type SwarmAgent,
  type AgentRole,
  type Pheromone,
  type PheromoneType,
  type PheromoneMatrix,
  type SwarmColony,
  type ColonyConfig,
  type ColonyStats,
  type URLSelection,
  type URLHeuristic,
  type WaggleDance,
  type SwarmCrawlResult,
} from './types';

const logger = createChildLogger('swarm-colony');

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_COLONY_CONFIG: ColonyConfig = {
  scoutCount: 5,
  workerCount: 10,
  soldierCount: 3,
  maxPagesPerAgent: 100,
  pheromoneWeight: 0.6,
  heuristicWeight: 0.4,
  pheromoneDecayRate: 0.1,
  crawlEnergyCost: 5,
  extractionEnergyGain: 20,
  maxColonySize: 50,
  autoSpawn: true,
  targetPatterns: [],
};

// ===============================================================================
// AGENT FACTORY
// ===============================================================================

function createAgent(role: AgentRole, domain: string, maxPages: number): SwarmAgent {
  return {
    id: randomUUID(),
    role,
    currentUrl: null,
    frontier: [],
    visited: [],
    pheromoneTrail: new Map(),
    energy: 100,
    extractedData: new Map(),
    pagesScraped: 0,
    errors: 0,
    state: 'idle',
    bornAt: Date.now(),
    maxPages,
    domain,
  };
}

// ===============================================================================
// PHEROMONE MATRIX OPERATIONS
// ===============================================================================

function createPheromoneMatrix(): PheromoneMatrix {
  return {
    deposits: new Map(),
    decayRate: DEFAULT_COLONY_CONFIG.pheromoneDecayRate,
    evaporationThreshold: 0.01,
    maxStrength: 1.0,
    totalDeposits: 0,
  };
}

/** Deposit a pheromone on a URL. */
function depositPheromone(
  matrix: PheromoneMatrix,
  url: string,
  type: PheromoneType,
  agentId: string,
  dataSignature: string = '',
  strength: number = 0.5,
): void {
  const existing = matrix.deposits.get(url) || [];

  // Check if same type already exists from same agent -- reinforce instead
  const match = existing.find(p => p.type === type && p.agentId === agentId);
  if (match) {
    match.strength = Math.min(matrix.maxStrength, match.strength + strength * 0.3);
    match.reinforcementCount++;
    match.depositedAt = Date.now();
  } else {
    existing.push({
      url,
      type,
      strength,
      depositedAt: Date.now(),
      agentId,
      dataSignature,
      reinforcementCount: 1,
    });
  }

  matrix.deposits.set(url, existing);
  matrix.totalDeposits++;
}

/** Get pheromone strength for a URL. */
function getPheromoneStrength(matrix: PheromoneMatrix, url: string, type?: PheromoneType): number {
  const deposits = matrix.deposits.get(url);
  if (!deposits || deposits.length === 0) return 0;

  const filtered = type ? deposits.filter(p => p.type === type) : deposits;
  if (filtered.length === 0) return 0;

  return filtered.reduce((sum, p) => sum + p.strength, 0) / filtered.length;
}

/** Evaporate pheromones (decay over time). */
function evaporatePheromones(matrix: PheromoneMatrix): void {
  const now = Date.now();
  const hourMs = 3600000;

  for (const [url, deposits] of matrix.deposits) {
    const updated = deposits
      .map(p => {
        const ageHours = (now - p.depositedAt) / hourMs;
        const decayedStrength = p.strength * Math.exp(-matrix.decayRate * ageHours);
        return { ...p, strength: decayedStrength };
      })
      .filter(p => p.strength >= matrix.evaporationThreshold);

    if (updated.length === 0) {
      matrix.deposits.delete(url);
    } else {
      matrix.deposits.set(url, updated);
    }
  }
}

// ===============================================================================
// URL SELECTION (ACO-inspired)
// ===============================================================================

/** Select the next URL to visit using ant colony optimization. */
function selectNextURL(
  agent: SwarmAgent,
  colony: SwarmColony,
): URLSelection {
  const candidates = [...agent.frontier, ...colony.sharedFrontier]
    .filter(url => !colony.completedUrls.has(url) && !agent.visited.includes(url))
    .filter((url, idx, arr) => arr.indexOf(url) === idx); // Deduplicate

  if (candidates.length === 0) {
    // No URLs available -- return a random one as fallback
    return {
      url: '',
      reason: 'random',
      pheromoneStrength: 0,
      heuristicScore: 0,
      probability: 0,
    };
  }

  // Calculate selection probabilities using ACO formula:
  // P(url) = (tau^alpha * eta^beta) / sum(tau^alpha * eta^beta)
  // where tau = pheromone strength, eta = heuristic value
  const alpha = colony.config.pheromoneWeight;
  const beta = colony.config.heuristicWeight;

  const scores = candidates.map(url => {
    const tau = getPheromoneStrength(colony.pheromones, url, 'data') + 0.1; // Small base pheromone
    const eta = calculateHeuristicScore(url, agent, colony);
    const score = Math.pow(tau, alpha) * Math.pow(eta, beta);
    return { url, tau, eta, score };
  });

  const totalScore = scores.reduce((sum, s) => sum + s.score, 0);
  if (totalScore === 0) {
    const randomUrl = candidates[Math.floor(Math.random() * candidates.length)];
    return { url: randomUrl, reason: 'random', pheromoneStrength: 0, heuristicScore: 0, probability: 1 / candidates.length };
  }

  // Roulette wheel selection
  let random = Math.random() * totalScore;
  for (const s of scores) {
    random -= s.score;
    if (random <= 0) {
      const reason: URLSelection['reason'] = s.tau > s.eta ? 'pheromone' : 'heuristic';
      return {
        url: s.url,
        reason,
        pheromoneStrength: s.tau,
        heuristicScore: s.eta,
        probability: s.score / totalScore,
      };
    }
  }

  const last = scores[scores.length - 1];
  return { url: last.url, reason: 'heuristic', pheromoneStrength: last.tau, heuristicScore: last.eta, probability: last.score / totalScore };
}

/** Calculate heuristic score for a URL. */
function calculateHeuristicScore(url: string, agent: SwarmAgent, colony: SwarmColony): number {
  let score = 0.5; // Base score

  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(Boolean);

    // Depth scoring (prefer moderate depth -- too shallow = navigation, too deep = pagination)
    const depth = pathParts.length;
    if (depth >= 2 && depth <= 5) score += 0.2;
    else if (depth > 5) score -= 0.1;

    // Pattern matching (product pages, article pages, etc.)
    const targetPatterns = colony.config.targetPatterns;
    if (targetPatterns.length > 0) {
      for (const pattern of targetPatterns) {
        if (parsed.pathname.includes(pattern)) {
          score += 0.3;
          break;
        }
      }
    }

    // Warning pheromones reduce score
    const warningStrength = getPheromoneStrength(colony.pheromones, url, 'warning');
    score -= warningStrength * 0.5;

    // Block pheromones strongly reduce score
    const blockStrength = getPheromoneStrength(colony.pheromones, url, 'block');
    score -= blockStrength * 0.8;

    // Data pheromones boost score
    const dataStrength = getPheromoneStrength(colony.pheromones, url, 'data');
    score += dataStrength * 0.3;

    // Path pheromones slightly boost (good intermediate pages)
    const pathStrength = getPheromoneStrength(colony.pheromones, url, 'path');
    score += pathStrength * 0.1;

  } catch {
    score = 0.1; // Invalid URLs get low score
  }

  return Math.max(0.01, Math.min(1, score));
}

// ===============================================================================
// COLONY OPERATIONS
// ===============================================================================

/** Create a new swarm colony for a domain. */
export function createColony(domain: string, seedUrls: string[], config?: Partial<ColonyConfig>): SwarmColony {
  const colonyConfig = { ...DEFAULT_COLONY_CONFIG, ...config };

  const agents = new Map<string, SwarmAgent>();

  // Spawn initial agents
  for (let i = 0; i < colonyConfig.scoutCount; i++) {
    const agent = createAgent('scout', domain, colonyConfig.maxPagesPerAgent);
    agents.set(agent.id, agent);
  }
  for (let i = 0; i < colonyConfig.workerCount; i++) {
    const agent = createAgent('worker', domain, colonyConfig.maxPagesPerAgent);
    agents.set(agent.id, agent);
  }
  for (let i = 0; i < colonyConfig.soldierCount; i++) {
    const agent = createAgent('soldier', domain, colonyConfig.maxPagesPerAgent);
    agents.set(agent.id, agent);
  }
  // Queen agent for coordination
  const queen = createAgent('queen', domain, colonyConfig.maxPagesPerAgent);
  agents.set(queen.id, queen);

  const colony: SwarmColony = {
    id: randomUUID(),
    domain,
    agents,
    pheromones: createPheromoneMatrix(),
    sharedFrontier: [...seedUrls],
    completedUrls: new Set(),
    stats: createEmptyStats(),
    config: colonyConfig,
    isActive: true,
    createdAt: Date.now(),
  };

  // Assign seed URLs to scouts
  for (const agent of agents.values()) {
    if (agent.role === 'scout' && colony.sharedFrontier.length > 0) {
      agent.frontier.push(colony.sharedFrontier.shift()!);
      agent.state = 'crawling';
    }
  }

  logger.info(
    { domain, agentCount: agents.size, seedUrls: seedUrls.length },
    'Swarm colony created',
  );

  return colony;
}

/** Process a crawl step for an agent. */
export function processAgentStep(
  agent: SwarmAgent,
  colony: SwarmColony,
  pageResult: { success: boolean; data?: Map<string, unknown[]>; links?: string[]; blocked?: boolean } | null,
): void {
  if (agent.state === 'dead') return;

  // Handle previous result
  if (pageResult) {
    if (pageResult.blocked) {
      // Deposit block pheromone
      depositPheromone(colony.pheromones, agent.currentUrl!, 'block', agent.id, '', 0.8);
      agent.errors++;

      // Soldiers handle blocks
      if (agent.role === 'soldier') {
        // Soldiers persist longer with blocks
        agent.energy -= colony.config.crawlEnergyCost * 0.5;
      } else {
        agent.energy -= colony.config.crawlEnergyCost * 2;
      }
    } else if (pageResult.success) {
      // Deposit data pheromone
      const dataSignature = pageResult.data
        ? Array.from(pageResult.data.keys()).sort().join(',')
        : '';
      depositPheromone(colony.pheromones, agent.currentUrl!, 'data', agent.id, dataSignature, 0.7);
      colony.completedUrls.add(agent.currentUrl!);
      agent.pagesScraped++;
      agent.energy += colony.config.extractionEnergyGain;

      // Merge extracted data
      if (pageResult.data) {
        for (const [key, values] of pageResult.data) {
          const existing = agent.extractedData.get(key) || [];
          agent.extractedData.set(key, [...existing, ...values]);
        }
      }
    } else {
      // Failed but not blocked -- deposit warning
      depositPheromone(colony.pheromones, agent.currentUrl!, 'warning', agent.id, '', 0.3);
      agent.errors++;
      agent.energy -= colony.config.crawlEnergyCost;
    }

    // Add discovered links to frontier
    if (pageResult.links && pageResult.links.length > 0) {
      const domainLinks = pageResult.links.filter(link => {
        try {
          return new URL(link).hostname.includes(colony.domain);
        } catch { return false; }
      });

      if (agent.role === 'scout') {
        // Scouts share their discoveries
        for (const link of domainLinks) {
          if (!colony.completedUrls.has(link)) {
            colony.sharedFrontier.push(link);
            depositPheromone(colony.pheromones, link, 'path', agent.id, '', 0.2);
          }
        }
      } else {
        // Workers keep discoveries locally
        for (const link of domainLinks) {
          if (!colony.completedUrls.has(link) && !agent.visited.includes(link)) {
            agent.frontier.push(link);
          }
        }
      }
    }
  }

  // Check agent health
  if (agent.energy <= 0 || agent.pagesScraped >= agent.maxPages || agent.errors > 10) {
    agent.state = 'dead';
    logger.debug(
      { agentId: agent.id, role: agent.role, pagesScraped: agent.pagesScraped, energy: agent.energy, errors: agent.errors },
      'Agent died',
    );
    return;
  }

  // Select next URL
  const selection = selectNextURL(agent, colony);
  if (!selection.url) {
    agent.state = 'idle';
    return;
  }

  agent.currentUrl = selection.url;
  agent.frontier = agent.frontier.filter(u => u !== selection.url);
  agent.visited.push(selection.url);
  agent.state = 'crawling';

  // Deposit trail pheromone
  depositPheromone(colony.pheromones, selection.url, 'path', agent.id, '', 0.1);
}

/** Perform waggle dance -- recruit other agents to a rich data source. */
export function performWaggleDance(
  agent: SwarmAgent,
  colony: SwarmColony,
  richUrl: string,
  richness: number,
): WaggleDance {
  const dance: WaggleDance = {
    url: richUrl,
    richness,
    direction: extractDirection(richUrl, colony.domain),
    distance: extractDistance(richUrl),
    dancerId: agent.id,
    followers: 0,
    performedAt: Date.now(),
  };

  // Recruit idle workers to this URL
  for (const other of colony.agents.values()) {
    if (other.id === agent.id) continue;
    if (other.state === 'idle' && other.role === 'worker') {
      other.frontier.push(richUrl);
      dance.followers++;
      if (dance.followers >= 3) break; // Limit recruitment
    }
  }

  logger.debug(
    { dancerId: agent.id, richUrl, richness: richness.toFixed(2), followers: dance.followers },
    'Waggle dance performed',
  );

  return dance;
}

/** Evaporate pheromones and clean up dead agents. */
export function maintainColony(colony: SwarmColony): void {
  // Evaporate pheromones
  evaporatePheromones(colony.pheromones);

  // Remove dead agents and spawn replacements
  let deadCount = 0;
  for (const [id, agent] of colony.agents) {
    if (agent.state === 'dead') {
      deadCount++;
      colony.agents.delete(id);
    }
  }

  // Auto-spawn replacements
  if (colony.config.autoSpawn && deadCount > 0 && colony.agents.size < colony.config.maxColonySize) {
    for (let i = 0; i < Math.min(deadCount, 5); i++) {
      const role: AgentRole = Math.random() < 0.7 ? 'worker' : 'scout';
      const newAgent = createAgent(role, colony.domain, colony.config.maxPagesPerAgent);
      // Inherit frontier from shared pool
      if (colony.sharedFrontier.length > 0) {
        newAgent.frontier.push(colony.sharedFrontier.shift()!);
        newAgent.state = 'crawling';
      }
      colony.agents.set(newAgent.id, newAgent);
    }
  }

  // Trim shared frontier if too large
  if (colony.sharedFrontier.length > 10000) {
    colony.sharedFrontier = colony.sharedFrontier.slice(-5000);
  }
}

/** Calculate colony statistics. */
export function calculateColonyStats(colony: SwarmColony): ColonyStats {
  let totalPages = 0;
  let totalExtracted = 0;
  let totalDataItems = 0;
  let totalErrors = 0;
  let activeAgents = 0;
  const dataUrls: { url: string; strength: number }[] = [];
  const blockedUrls: string[] = [];

  for (const agent of colony.agents.values()) {
    totalPages += agent.pagesScraped;
    totalErrors += agent.errors;
    if (agent.state !== 'dead') activeAgents++;
    for (const [key, values] of agent.extractedData) {
      totalDataItems += values.length;
      totalExtracted++;
    }
  }

  for (const [url, deposits] of colony.pheromones.deposits) {
    for (const d of deposits) {
      if (d.type === 'data') dataUrls.push({ url, strength: d.strength });
      if (d.type === 'block' && d.strength > 0.5) blockedUrls.push(url);
    }
  }

  dataUrls.sort((a, b) => b.strength - a.strength);
  const topDataUrls = dataUrls.slice(0, 20).map(d => d.url);

  const elapsedHours = (Date.now() - colony.createdAt) / 3600000;
  const avgPagesPerMinute = elapsedHours > 0 ? totalPages / (elapsedHours * 60) : 0;

  const totalPheromoneStrength = Array.from(colony.pheromones.deposits.values())
    .flat()
    .reduce((sum, p) => sum + p.strength, 0);
  const pheromoneDensity = colony.pheromones.deposits.size > 0
    ? totalPheromoneStrength / colony.pheromones.deposits.size
    : 0;

  return {
    totalPagesCrawled: totalPages,
    totalPagesExtracted: totalExtracted,
    totalDataExtracted: totalDataItems,
    totalErrors,
    avgPagesPerMinute: Math.round(avgPagesPerMinute * 100) / 100,
    activeAgents,
    pheromoneDensity: Math.round(pheromoneDensity * 1000) / 1000,
    frontierSize: colony.sharedFrontier.length,
    completionPercentage: 0, // Unknown without knowing total pages
    topDataUrls,
    blockedUrls,
  };
}

// ===============================================================================
// HELPERS
// ===============================================================================

function createEmptyStats(): ColonyStats {
  return {
    totalPagesCrawled: 0,
    totalPagesExtracted: 0,
    totalDataExtracted: 0,
    totalErrors: 0,
    avgPagesPerMinute: 0,
    activeAgents: 0,
    pheromoneDensity: 0,
    frontierSize: 0,
    completionPercentage: 0,
    topDataUrls: [],
    blockedUrls: [],
  };
}

function extractDirection(url: string, _domain: string): string {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).slice(0, 2).join('/');
  } catch {
    return '/';
  }
}

function extractDistance(url: string): number {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).length;
  } catch {
    return 0;
  }
}
