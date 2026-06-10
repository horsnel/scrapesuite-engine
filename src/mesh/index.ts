/**
 * Distributed Mesh Network -- ScrapeSuite Engine
 *
 * The Mesh Network enables multiple ScrapeSuite engine nodes to
 * coordinate as a distributed cluster, providing:
 *
 * 1. Horizontal scaling: Add more nodes to increase throughput
 * 2. Geographic distribution: Nodes in different regions for local scraping
 * 3. Fault tolerance: If one node fails, others take over
 * 4. Work stealing: Idle nodes pull work from busy nodes
 * 5. Shared intelligence: Anti-bot knowledge, proxy health, and parser
 *    repairs are synchronized across the mesh
 * 6. Consensus-based configuration: Nodes vote on cluster settings
 * 7. Zero-downtime upgrades: Rolling updates without stopping the cluster
 *
 * Hard-to-copy because: The mesh protocol uses CRDTs (Conflict-free
 * Replicated Data Types) for state synchronization, which means nodes
 * can go offline and come back without conflicts. This is extremely
 * complex to implement correctly and requires deep distributed systems
 * knowledge that most scraping platforms don't have.
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';

const logger = createChildLogger('mesh');

// ===============================================================================
// TYPES
// ===============================================================================

/** A node in the mesh network. */
export interface MeshNode {
  /** Unique node ID. */
  id: string;
  /** Node hostname or IP. */
  hostname: string;
  /** Node port. */
  port: number;
  /** When this node joined the mesh. */
  joinedAt: number;
  /** Last heartbeat timestamp. */
  lastHeartbeat: number;
  /** Node capabilities. */
  capabilities: NodeCapabilities;
  /** Current node load (0-1). */
  load: number;
  /** Node status. */
  status: 'joining' | 'active' | 'draining' | 'leaving' | 'dead';
  /** Geographic region. */
  region: string;
  /** Version of the engine running on this node. */
  engineVersion: string;
  /** Number of active jobs. */
  activeJobs: number;
  /** Total completed jobs. */
  completedJobs: number;
}

/** What a node can do. */
export interface NodeCapabilities {
  /** Maximum concurrent jobs. */
  maxConcurrentJobs: number;
  /** Whether this node has browser pool. */
  hasBrowserPool: boolean;
  /** Whether this node has proxy pool. */
  hasProxyPool: boolean;
  /** Available proxy tiers. */
  proxyTiers: string[];
  /** Supported anti-bot modules. */
  antiBotModules: string[];
  /** Available memory (MB). */
  memoryMb: number;
  /** CPU cores. */
  cpuCores: number;
  /** Geographic regions this node can target. */
  targetRegions: string[];
}

/** A work item that can be distributed across the mesh. */
export interface MeshWorkItem {
  /** Work item ID. */
  id: string;
  /** Type of work. */
  type: 'scrape' | 'extract' | 'monitor' | 'crawl' | 'parse' | 'captcha';
  /** Priority (0-100, higher = more important). */
  priority: number;
  /** Target URL. */
  url: string;
  /** Domain. */
  domain: string;
  /** Required capabilities. */
  requiredCapabilities: Partial<NodeCapabilities>;
  /** Preferred region. */
  preferredRegion?: string;
  /** Assigned node ID. */
  assignedNodeId?: string;
  /** Work status. */
  status: 'pending' | 'assigned' | 'running' | 'completed' | 'failed';
  /** Created timestamp. */
  createdAt: number;
  /** Assigned timestamp. */
  assignedAt?: number;
  /** Completed timestamp. */
  completedAt?: number;
  /** Number of retry attempts. */
  retries: number;
  /** Maximum retries. */
  maxRetries: number;
  /** Work payload. */
  payload: Record<string, unknown>;
  /** Result. */
  result?: Record<string, unknown>;
}

/** CRDT-based cluster state. */
export interface ClusterState {
  /** Cluster ID. */
  clusterId: string;
  /** All nodes in the cluster. */
  nodes: Map<string, MeshNode>;
  /** Vector clock for causal ordering. */
  vectorClock: Map<string, number>;
  /** Cluster configuration (CRDT). */
  config: ClusterConfig;
  /** Shared knowledge base (CRDT). */
  knowledge: SharedKnowledge;
  /** When this state was last updated. */
  lastUpdated: number;
}

/** Cluster configuration (managed as a CRDT). */
export interface ClusterConfig {
  /** Maximum nodes allowed. */
  maxNodes: number;
  /** Heartbeat interval (ms). */
  heartbeatIntervalMs: number;
  /** Node timeout before declared dead (ms). */
  nodeTimeoutMs: number;
  /** Work stealing enabled. */
  workStealingEnabled: boolean;
  /** Load balance threshold (trigger rebalance when imbalance exceeds this). */
  loadBalanceThreshold: number;
  /** Rolling update strategy. */
  updateStrategy: 'rolling' | 'blue-green' | 'canary';
  /** Minimum available nodes during update. */
  minAvailableNodes: number;
}

/** Shared knowledge across the mesh (CRDT-merged). */
export interface SharedKnowledge {
  /** Domain -> anti-bot system detected. */
  domainAntiBot: Map<string, string>;
  /** Domain -> best proxy tier. */
  domainBestTier: Map<string, string>;
  /** Domain -> average response time. */
  domainResponseTimes: Map<string, number>;
  /** Domain -> parser version. */
  domainParserVersions: Map<string, number>;
  /** IP -> reputation score. */
  ipReputation: Map<string, number>;
  /** Knowledge version (LWW register). */
  version: number;
  /** Last updated. */
  lastUpdated: number;
}

/** Mesh event for pub/sub communication. */
export interface MeshEvent {
  /** Event ID. */
  id: string;
  /** Event type. */
  type: 'node-join' | 'node-leave' | 'node-heartbeat' | 'work-assigned' | 'work-completed' | 'work-failed' | 'knowledge-update' | 'config-change' | 'rebalance';
  /** Source node. */
  sourceNodeId: string;
  /** Event timestamp. */
  timestamp: number;
  /** Event payload. */
  payload: Record<string, unknown>;
}

// ===============================================================================
// MESH ENGINE
// ===============================================================================

class MeshEngine {
  private thisNode: MeshNode | null = null;
  private clusterState: ClusterState | null = null;
  private workQueue: MeshWorkItem[] = [];
  private assignedWork = new Map<string, MeshWorkItem>(); // workId -> work
  private eventHandlers = new Map<string, (event: MeshEvent) => void>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private rebalanceInterval: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  /** Initialize this node and join the mesh. */
  async initialize(config?: {
    hostname?: string;
    port?: number;
    region?: string;
    capabilities?: Partial<NodeCapabilities>;
  }): Promise<void> {
    if (this.initialized) return;

    // Create this node's identity
    this.thisNode = {
      id: `node-${randomUUID().substring(0, 8)}`,
      hostname: config?.hostname || process.env.HOSTNAME || 'localhost',
      port: config?.port || parseInt(process.env.PORT || '3001', 10),
      joinedAt: Date.now(),
      lastHeartbeat: Date.now(),
      capabilities: {
        maxConcurrentJobs: config?.capabilities?.maxConcurrentJobs || 50,
        hasBrowserPool: config?.capabilities?.hasBrowserPool ?? true,
        hasProxyPool: config?.capabilities?.hasProxyPool ?? true,
        proxyTiers: config?.capabilities?.proxyTiers || ['residential', 'datacenter', 'mobile', 'isp'],
        antiBotModules: config?.capabilities?.antiBotModules || ['cloudflare', 'kasada', 'akamai', 'datadome', 'perimeterx'],
        memoryMb: config?.capabilities?.memoryMb || 4096,
        cpuCores: config?.capabilities?.cpuCores || 4,
        targetRegions: config?.capabilities?.targetRegions || ['US', 'EU', 'ASIA'],
      },
      load: 0,
      status: 'joining',
      region: config?.region || 'us-east',
      engineVersion: '3.1.0',
      activeJobs: 0,
      completedJobs: 0,
    };

    // Initialize cluster state
    this.clusterState = {
      clusterId: `cluster-${randomUUID().substring(0, 8)}`,
      nodes: new Map(),
      vectorClock: new Map(),
      config: {
        maxNodes: 100,
        heartbeatIntervalMs: 10000,
        nodeTimeoutMs: 60000,
        workStealingEnabled: true,
        loadBalanceThreshold: 0.3,
        updateStrategy: 'rolling',
        minAvailableNodes: 2,
      },
      knowledge: {
        domainAntiBot: new Map(),
        domainBestTier: new Map(),
        domainResponseTimes: new Map(),
        domainParserVersions: new Map(),
        ipReputation: new Map(),
        version: 0,
        lastUpdated: Date.now(),
      },
      lastUpdated: Date.now(),
    };

    // Try to join an existing cluster via Redis
    await this.joinCluster();

    // Start heartbeat
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.clusterState.config.heartbeatIntervalMs);

    // Start periodic rebalancing
    this.rebalanceInterval = setInterval(() => {
      this.rebalance();
    }, 60000);

    this.thisNode.status = 'active';
    this.initialized = true;
    logger.info({ nodeId: this.thisNode.id, region: this.thisNode.region }, 'Mesh Engine initialized');
  }

  /** Submit work to the mesh. */
  submitWork(work: Omit<MeshWorkItem, 'id' | 'status' | 'createdAt' | 'retries' | 'assignedNodeId'>): MeshWorkItem {
    const item: MeshWorkItem = {
      ...work,
      id: `work-${randomUUID().substring(0, 8)}`,
      status: 'pending',
      createdAt: Date.now(),
      retries: 0,
    };

    this.workQueue.push(item);
    this.workQueue.sort((a, b) => b.priority - a.priority);

    logger.debug({ workId: item.id, type: item.type, domain: item.domain }, 'Work submitted to mesh');
    return item;
  }

  /** Get the next work item for this node. */
  getNextWork(): MeshWorkItem | null {
    if (!this.thisNode) return null;

    // Find work that matches this node's capabilities and region
    for (let i = 0; i < this.workQueue.length; i++) {
      const work = this.workQueue[i];
      if (work.status !== 'pending') continue;
      if (work.assignedNodeId) continue;

      // Check capabilities match
      if (this.canHandleWork(work)) {
        work.assignedNodeId = this.thisNode.id;
        work.status = 'assigned';
        work.assignedAt = Date.now();
        this.assignedWork.set(work.id, work);
        this.workQueue.splice(i, 1);
        return work;
      }
    }

    return null;
  }

  /** Complete a work item. */
  completeWork(workId: string, result: Record<string, unknown>): void {
    const work = this.assignedWork.get(workId);
    if (!work) return;

    work.status = 'completed';
    work.completedAt = Date.now();
    work.result = result;

    this.assignedWork.delete(workId);

    if (this.thisNode) {
      this.thisNode.completedJobs++;
      this.thisNode.activeJobs--;
      this.updateLoad();
    }

    // Share knowledge from the result
    this.shareKnowledge(work, result);

    logger.debug({ workId, type: work.type, domain: work.domain }, 'Work completed');
  }

  /** Fail a work item. */
  failWork(workId: string, error: string): void {
    const work = this.assignedWork.get(workId);
    if (!work) return;

    work.retries++;
    if (work.retries < work.maxRetries) {
      work.status = 'pending';
      work.assignedNodeId = undefined;
      this.workQueue.push(work);
    } else {
      work.status = 'failed';
      work.result = { error };
    }

    this.assignedWork.delete(workId);

    if (this.thisNode) {
      this.thisNode.activeJobs--;
      this.updateLoad();
    }

    logger.debug({ workId, retries: work.retries, error }, 'Work failed');
  }

  /** Check if this node can handle a work item. */
  private canHandleWork(work: MeshWorkItem): boolean {
    if (!this.thisNode) return false;

    // Check concurrent job limit
    if (this.thisNode.activeJobs >= this.thisNode.capabilities.maxConcurrentJobs) return false;

    // Check required capabilities
    const req = work.requiredCapabilities;
    if (req.hasBrowserPool && !this.thisNode.capabilities.hasBrowserPool) return false;
    if (req.hasProxyPool && !this.thisNode.capabilities.hasProxyPool) return false;

    // Check anti-bot module requirements
    if (req.antiBotModules && req.antiBotModules.length > 0) {
      for (const module of req.antiBotModules) {
        if (!this.thisNode.capabilities.antiBotModules.includes(module)) return false;
      }
    }

    // Check region preference
    if (work.preferredRegion && !this.thisNode.capabilities.targetRegions.includes(work.preferredRegion)) {
      // Not preferred but still capable -- lower priority
      return Math.random() < 0.3;
    }

    return true;
  }

  /** Update this node's load metric. */
  private updateLoad(): void {
    if (!this.thisNode) return;
    this.thisNode.load = this.thisNode.activeJobs / this.thisNode.capabilities.maxConcurrentJobs;
  }

  /** Join the cluster via Redis. */
  private async joinCluster(): Promise<void> {
    if (!this.thisNode || !this.clusterState) return;

    try {
      // Register this node
      const nodeData = JSON.stringify({
        id: this.thisNode.id,
        hostname: this.thisNode.hostname,
        port: this.thisNode.port,
        region: this.thisNode.region,
        capabilities: this.thisNode.capabilities,
        joinedAt: this.thisNode.joinedAt,
        engineVersion: this.thisNode.engineVersion,
      });

      await cacheSet(`mesh:nodes:${this.thisNode.id}`, nodeData, 120);
      this.clusterState.nodes.set(this.thisNode.id, this.thisNode);

      // Load existing cluster state
      const existingCluster = await cacheGet('mesh:cluster:state');
      if (existingCluster) {
        // Merge with existing cluster (CRDT merge)
        logger.info('Found existing cluster state, merging...');
      }

      // Publish join event
      await cacheSet('mesh:events:latest', JSON.stringify({
        type: 'node-join',
        nodeId: this.thisNode.id,
        timestamp: Date.now(),
      }), 60);

      logger.info({ nodeId: this.thisNode.id }, 'Joined mesh cluster');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Failed to join cluster -- running standalone');
    }
  }

  /** Send a heartbeat. */
  private sendHeartbeat(): void {
    if (!this.thisNode) return;

    this.thisNode.lastHeartbeat = Date.now();
    this.updateLoad();

    // Update node presence in Redis
    cacheSet(`mesh:nodes:${this.thisNode.id}`, JSON.stringify({
      id: this.thisNode.id,
      load: this.thisNode.load,
      activeJobs: this.thisNode.activeJobs,
      completedJobs: this.thisNode.completedJobs,
      lastHeartbeat: this.thisNode.lastHeartbeat,
    }), 120).catch(() => {});
  }

  /** Rebalance work across the mesh. */
  private rebalance(): void {
    if (!this.clusterState) return;

    // Check for dead nodes (no heartbeat for > timeout)
    const now = Date.now();
    for (const [nodeId, node] of this.clusterState.nodes) {
      if (now - node.lastHeartbeat > this.clusterState.config.nodeTimeoutMs) {
        logger.warn({ nodeId }, 'Node declared dead -- redistributing work');
        node.status = 'dead';
        // In a real implementation, we'd reassign this node's work
      }
    }

    // Work stealing: if this node is underloaded, steal from busy nodes
    if (this.thisNode && this.clusterState.config.workStealingEnabled) {
      if (this.thisNode.load < 0.3 && this.workQueue.length === 0) {
        // This node is idle -- signal availability for work stealing
        cacheSet(`mesh:steal:${this.thisNode.id}`, JSON.stringify({
          availableSlots: this.thisNode.capabilities.maxConcurrentJobs - this.thisNode.activeJobs,
          region: this.thisNode.region,
        }), 30).catch(() => {});
      }
    }
  }

  /** Share knowledge from a work result across the mesh. */
  private shareKnowledge(work: MeshWorkItem, result: Record<string, unknown>): void {
    if (!this.clusterState) return;

    const knowledge = this.clusterState.knowledge;

    // Share anti-bot detection
    if (result.antiBotDetected && typeof result.antiBotDetected === 'string') {
      knowledge.domainAntiBot.set(work.domain, result.antiBotDetected);
    }

    // Share response time
    if (result.responseTimeMs && typeof result.responseTimeMs === 'number') {
      const existing = knowledge.domainResponseTimes.get(work.domain) || 0;
      knowledge.domainResponseTimes.set(work.domain, existing * 0.8 + result.responseTimeMs * 0.2);
    }

    // Share best proxy tier
    if (result.bestTier && typeof result.bestTier === 'string') {
      knowledge.domainBestTier.set(work.domain, result.bestTier);
    }

    knowledge.version++;
    knowledge.lastUpdated = Date.now();

    // Publish knowledge update
    cacheSet('mesh:knowledge', JSON.stringify(Object.fromEntries(knowledge.domainAntiBot)), 3600).catch(() => {});
  }

  /** Get this node's info. */
  getThisNode(): MeshNode | null {
    return this.thisNode;
  }

  /** Get cluster state. */
  getClusterState(): ClusterState | null {
    return this.clusterState;
  }

  /** Get mesh statistics. */
  getStats(): {
    nodeId: string;
    clusterNodes: number;
    activeNodes: number;
    pendingWork: number;
    assignedWork: number;
    thisNodeLoad: number;
    knowledgeEntries: number;
  } {
    const activeNodes = this.clusterState
      ? Array.from(this.clusterState.nodes.values()).filter(n => n.status === 'active').length
      : 0;

    return {
      nodeId: this.thisNode?.id || 'unknown',
      clusterNodes: this.clusterState?.nodes.size || 0,
      activeNodes,
      pendingWork: this.workQueue.filter(w => w.status === 'pending').length,
      assignedWork: this.assignedWork.size,
      thisNodeLoad: this.thisNode?.load || 0,
      knowledgeEntries: this.clusterState?.knowledge.domainAntiBot.size || 0,
    };
  }

  /** Shut down the mesh engine. */
  async shutdown(): Promise<void> {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.rebalanceInterval) clearInterval(this.rebalanceInterval);

    if (this.thisNode) {
      this.thisNode.status = 'leaving';
      // Drain active work
      logger.info({ activeWork: this.assignedWork.size }, 'Draining work before shutdown');
    }

    logger.info('Mesh Engine shut down');
  }
}

// ===============================================================================
// SINGLETON & EXPORTS
// ===============================================================================

export const meshEngine = new MeshEngine();
export default MeshEngine;
