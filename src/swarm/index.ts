/**
 * Swarm Intelligence Crawler -- ScrapeSuite Engine
 *
 * Main entry point for the swarm intelligence crawling system.
 * Orchestrates colonies across multiple domains and provides
 * a unified API for the rest of the engine.
 *
 * Architecture:
 *  +-------------------------------------------------------------------------+
 *  |                    Swarm Engine (this file)                             |
 *  |                                                                        |
 *  |  +-------------------+  +-------------------+  +------------------+    |
 *  |  | Colony: shop.com  |  | Colony: news.com  |  | Colony: soc.com  |    |
 *  |  | (scouts+workers)  |  | (scouts+workers)  |  | (scouts+workers) |    |
 *  |  +-------------------+  +-------------------+  +------------------+    |
 *  |                                                                        |
 *  |  +-------------------+  +------------------------------------------+   |
 *  |  | Pheromone Store   |  | Cross-Colony Learning                     |   |
 *  |  | (Redis-backed)    |  | (share patterns between domains)          |   |
 *  |  +-------------------+  +------------------------------------------+   |
 *  +-------------------------------------------------------------------------+
 */

import { createChildLogger } from '../utils/logger';
import {
  type SwarmColony,
  type ColonyConfig,
  type ColonyStats,
  type SwarmCrawlResult,
  type SwarmAgent,
  type WaggleDance,
} from './types';
import { createColony, processAgentStep, maintainColony, performWaggleDance, calculateColonyStats, DEFAULT_COLONY_CONFIG } from './colony';

const logger = createChildLogger('swarm-engine');

// ===============================================================================
// SWARM ENGINE
// ===============================================================================

class SwarmEngine {
  private colonies = new Map<string, SwarmColony>(); // domain -> colony
  private maintenanceInterval: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  private globalDances: WaggleDance[] = [];

  /** Initialize the swarm engine. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // Start maintenance loop every 2 minutes
    this.maintenanceInterval = setInterval(() => {
      this.maintainAll();
    }, 120000);

    logger.info('Swarm Engine initialized');
  }

  /** Create a new colony for a domain. */
  createColony(domain: string, seedUrls: string[], config?: Partial<ColonyConfig>): SwarmColony {
    // If colony already exists, return it
    const existing = this.colonies.get(domain);
    if (existing && existing.isActive) return existing;

    const colony = createColony(domain, seedUrls, config);
    this.colonies.set(domain, colony);

    logger.info({ domain, seedUrls: seedUrls.length }, 'Colony created');
    return colony;
  }

  /** Get an existing colony. */
  getColony(domain: string): SwarmColony | undefined {
    return this.colonies.get(domain);
  }

  /** Process a crawl step for a specific colony. */
  processStep(
    domain: string,
    agentId: string,
    pageResult: { success: boolean; data?: Map<string, unknown[]>; links?: string[]; blocked?: boolean } | null,
  ): void {
    const colony = this.colonies.get(domain);
    if (!colony) return;

    const agent = colony.agents.get(agentId);
    if (!agent) return;

    processAgentStep(agent, colony, pageResult);

    // Check if agent found rich data -- trigger waggle dance
    if (pageResult?.success && pageResult.data && pageResult.data.size > 0) {
      const dataRichness = Array.from(pageResult.data.values()).reduce((sum, v) => sum + v.length, 0) / 10;
      if (dataRichness > 0.5 && agent.currentUrl) {
        const dance = performWaggleDance(agent, colony, agent.currentUrl, Math.min(1, dataRichness));
        this.globalDances.push(dance);
      }
    }
  }

  /** Get the next URL to crawl for an agent. */
  getNextUrl(domain: string, agentId: string): string | null {
    const colony = this.colonies.get(domain);
    if (!colony) return null;

    const agent = colony.agents.get(agentId);
    if (!agent) return null;

    if (agent.frontier.length > 0) {
      return agent.frontier.shift() || null;
    }

    if (colony.sharedFrontier.length > 0) {
      return colony.sharedFrontier.shift() || null;
    }

    return null;
  }

  /** Get all idle agents across all colonies. */
  getIdleAgents(domain?: string): SwarmAgent[] {
    const idle: SwarmAgent[] = [];
    const colonies = domain ? [this.colonies.get(domain)].filter(Boolean) : Array.from(this.colonies.values());

    for (const colony of colonies) {
      if (!colony) continue;
      for (const agent of colony.agents.values()) {
        if (agent.state === 'idle') idle.push(agent);
      }
    }

    return idle;
  }

  /** Get colony statistics. */
  getColonyStats(domain: string): ColonyStats | null {
    const colony = this.colonies.get(domain);
    if (!colony) return null;
    return calculateColonyStats(colony);
  }

  /** Get all colony statistics. */
  getAllStats(): Map<string, ColonyStats> {
    const stats = new Map<string, ColonyStats>();
    for (const [domain, colony] of this.colonies) {
      stats.set(domain, calculateColonyStats(colony));
    }
    return stats;
  }

  /** Get global statistics. */
  getGlobalStats(): {
    totalColonies: number;
    activeColonies: number;
    totalAgents: number;
    totalPagesCrawled: number;
    totalDataExtracted: number;
    totalDances: number;
  } {
    let totalAgents = 0;
    let totalPages = 0;
    let totalData = 0;
    let activeColonies = 0;

    for (const colony of this.colonies.values()) {
      if (colony.isActive) activeColonies++;
      totalAgents += colony.agents.size;
      for (const agent of colony.agents.values()) {
        totalPages += agent.pagesScraped;
        for (const values of agent.extractedData.values()) {
          totalData += values.length;
        }
      }
    }

    return {
      totalColonies: this.colonies.size,
      activeColonies,
      totalAgents,
      totalPagesCrawled: totalPages,
      totalDataExtracted: totalData,
      totalDances: this.globalDances.length,
    };
  }

  /** Stop a colony. */
  stopColony(domain: string): void {
    const colony = this.colonies.get(domain);
    if (colony) {
      colony.isActive = false;
      logger.info({ domain }, 'Colony stopped');
    }
  }

  /** Remove a colony. */
  removeColony(domain: string): void {
    this.colonies.delete(domain);
    logger.info({ domain }, 'Colony removed');
  }

  /** Maintain all colonies. */
  private maintainAll(): void {
    for (const [domain, colony] of this.colonies) {
      if (!colony.isActive) continue;
      maintainColony(colony);
      colony.stats = calculateColonyStats(colony);
    }

    // Trim old waggle dances
    const now = Date.now();
    this.globalDances = this.globalDances.filter(d => now - d.performedAt < 3600000);
  }

  /** Shut down the swarm engine. */
  shutdown(): void {
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
      this.maintenanceInterval = null;
    }
    for (const colony of this.colonies.values()) {
      colony.isActive = false;
    }
    logger.info('Swarm Engine shut down');
  }
}

// ===============================================================================
// SINGLETON & EXPORTS
// ===============================================================================

export const swarmEngine = new SwarmEngine();
export default SwarmEngine;

// Re-export types and sub-modules
export type {
  SwarmAgent,
  AgentRole,
  Pheromone,
  PheromoneType,
  PheromoneMatrix,
  SwarmColony,
  ColonyConfig,
  ColonyStats,
  URLSelection,
  URLHeuristic,
  WaggleDance,
  SwarmCrawlResult,
} from './types';

export { createColony, processAgentStep, maintainColony, performWaggleDance, calculateColonyStats, DEFAULT_COLONY_CONFIG } from './colony';
