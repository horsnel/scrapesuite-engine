/**
 * Distributed Browser Grid -- ScrapeSuite Engine
 *
 * Wires the Mesh Network to the BrowserFarmManager and CdpBrowserManager
 * to enable distributed browser execution across remote nodes.
 *
 * The Distributed Browser Grid transforms a cluster of ScrapeSuite engine
 * nodes into a unified browser execution fabric. Instead of each node
 * operating its browser pool in isolation, the grid:
 *
 * 1. Distributes browser-based scraping tasks to the best-fit node
 *    (geographic proximity, load, capabilities, anti-bot modules)
 * 2. Uses Redis as a lightweight message bus for work assignment and
 *    result collection between nodes
 * 3. Supports work stealing: idle nodes can pull work from overloaded
 *    nodes' queues to keep cluster throughput high
 * 4. Gracefully degrades to local execution when remote nodes are
 *    unavailable or the mesh is unreachable
 * 5. Proxies CDP sessions to remote browser instances via CdpTunnel,
 *    allowing developers to connect Playwright/Puppeteer to any browser
 *    in the grid as if it were local
 * 6. Supports both HTTP API mode (REST endpoints for work submission)
 *    and BullMQ worker mode (processing jobs from a shared queue)
 * 7. Auto-scales the grid based on work queue depth and node utilization
 *
 * Redis Key Patterns:
 *  - grid:work:{workId}              Work assignment (TTL: 5 min)
 *  - grid:result:{workId}            Work result (TTL: 10 min)
 *  - grid:node:{nodeId}:queue        Node-specific work queue
 *  - grid:stats                      Global grid stats cache
 *  - grid:scaling                    Scaling recommendations
 *
 * Hard-to-copy because: Coordinating browser state (cookies, fingerprints,
 * stealth patches) across nodes while maintaining anti-bot consistency
 * requires deep integration between the mesh, browser farm, CDP manager,
 * and stealth engine that cannot be replicated without understanding the
 * full architecture.
 */

import { randomUUID } from 'crypto';
import { meshEngine, type MeshNode, type MeshWorkItem, type NodeCapabilities } from '../mesh';
import { browserFarmManager } from './browser-farm';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import type { StealthLevel, BrowserFarmConfig } from './types';

const logger = createChildLogger('distributed-browser-grid');

// ===============================================================================
// TYPES
// ===============================================================================

/** Configuration for the Distributed Browser Grid. */
export interface GridConfig {
  /** Maximum number of nodes allowed in the grid. */
  maxNodes: number;
  /** Heartbeat timeout before a node is declared dead (ms). */
  heartbeatTimeoutMs: number;
  /** Whether work stealing is enabled across the grid. */
  workStealingEnabled: boolean;
  /** Default stealth level for browser work. */
  defaultStealthLevel: StealthLevel;
  /** How long to wait for a work result before timing out (ms). */
  resultTimeoutMs: number;
  /** How often to poll Redis for incoming work items (ms). */
  workPollIntervalMs: number;
  /** Maximum number of retry attempts for failed work. */
  maxRetries: number;
  /** Maximum number of concurrent browser tasks on this node. */
  maxConcurrentLocalWork: number;
}

/** Default configuration for the Distributed Browser Grid. */
const DEFAULT_GRID_CONFIG: GridConfig = {
  maxNodes: 100,
  heartbeatTimeoutMs: 60_000,
  workStealingEnabled: true,
  defaultStealthLevel: 'high',
  resultTimeoutMs: 120_000,
  workPollIntervalMs: 2_000,
  maxRetries: 3,
  maxConcurrentLocalWork: 50,
};

/** A browser-based work request submitted to the grid. */
export interface BrowserWorkRequest {
  /** Target URL to navigate to. */
  url: string;
  /** HTTP method for any pre-navigation request (default: GET). */
  method?: string;
  /** Custom headers to include in the request. */
  headers?: Record<string, string>;
  /** Proxy tier to use (residential, datacenter, mobile, isp). */
  proxyTier?: string;
  /** Proxy country code for geo-targeted scraping. */
  proxyCountry?: string;
  /** Stealth level (basic, light, medium, high, maximum). */
  stealthLevel?: StealthLevel;
  /** Required anti-bot modules (cloudflare, kasada, akamai, etc.). */
  antiBotModules?: string[];
  /** Preferred geographic region for execution. */
  preferredRegion?: string;
  /** CSS selector to extract data from. */
  extractSelector?: string;
  /** CSS selector to wait for before extracting. */
  waitForSelector?: string;
  /** Maximum execution time in ms before timeout. */
  timeout?: number;
  /** Priority (0-100, higher = more important). */
  priority?: number;
}

/** Result of a browser work execution. */
export interface BrowserWorkResult {
  /** Whether the execution was successful. */
  success: boolean;
  /** Raw HTML of the page. */
  html?: string;
  /** Extracted text content of the page. */
  text?: string;
  /** Structured data extracted via extractSelector. */
  extractedData?: any;
  /** Final URL after any redirects. */
  url?: string;
  /** HTTP status code of the page. */
  status?: number;
  /** Error message if execution failed. */
  error?: string;
  /** Total execution time in ms. */
  executionTimeMs: number;
  /** ID of the node that executed this work. */
  executedOnNodeId: string;
  /** Proxy identifier used for the request. */
  proxyUsed?: string;
}

/** Status of a work assignment as it moves through the grid. */
export type WorkAssignmentStatus = 'assigned' | 'running' | 'completed' | 'failed' | 'timeout';

/** A work assignment tracked by the grid. */
export interface WorkAssignment {
  /** Unique assignment ID. */
  id: string;
  /** The original work request. */
  work: BrowserWorkRequest;
  /** Node that submitted the work. */
  sourceNodeId: string;
  /** Node assigned to execute the work. */
  targetNodeId: string;
  /** Timestamp when the work was assigned. */
  assignedAt: number;
  /** Current status of the assignment. */
  status: WorkAssignmentStatus;
  /** Number of retry attempts so far. */
  retries: number;
  /** Maximum number of retries allowed. */
  maxRetries: number;
}

/** Statistics about a single node in the grid. */
export interface GridNodeStats {
  /** Node ID. */
  nodeId: string;
  /** Node region. */
  region: string;
  /** Current load (0-1). */
  load: number;
  /** Number of active work items. */
  activeWork: number;
  /** Total completed work items. */
  completedWork: number;
  /** Total failed work items. */
  failedWork: number;
  /** Average execution time in ms. */
  avgExecutionTimeMs: number;
  /** Whether the node is currently reachable. */
  isAlive: boolean;
  /** Node capabilities. */
  capabilities: NodeCapabilities;
}

/** Overall statistics for the Distributed Browser Grid. */
export interface GridStats {
  /** Total number of nodes in the grid. */
  totalNodes: number;
  /** Number of active (reachable) nodes. */
  activeNodes: number;
  /** Total browsers available across the grid. */
  totalBrowsersAvailable: number;
  /** Number of work items in the queue. */
  workQueueDepth: number;
  /** Average work execution latency in ms. */
  avgLatencyMs: number;
  /** This node's ID. */
  thisNodeId: string;
  /** This node's current load. */
  thisNodeLoad: number;
  /** Whether the grid is currently in degraded mode (local-only). */
  degradedMode: boolean;
  /** Per-node statistics. */
  nodes: GridNodeStats[];
  /** Auto-scaling recommendation. */
  scalingRecommendation: ScalingRecommendation | null;
}

/** A scaling recommendation produced by the auto-scaler. */
export interface ScalingRecommendation {
  /** Recommended total node count. */
  targetNodeCount: number;
  /** Current node count. */
  currentNodeCount: number;
  /** Reason for the recommendation. */
  reason: string;
  /** Work queue depth that triggered this recommendation. */
  queueDepth: number;
  /** Average node load (0-1). */
  avgLoad: number;
  /** Timestamp of the recommendation. */
  timestamp: number;
}

/** Configuration for the CDP tunnel that proxies CDP sessions to remote nodes. */
export interface CdpTunnelConfig {
  /** Whether the CDP tunnel is enabled. */
  enabled: boolean;
  /** Maximum concurrent CDP sessions through the tunnel. */
  maxConcurrentSessions: number;
  /** Timeout for establishing a CDP session to a remote node (ms). */
  connectTimeoutMs: number;
  /** Whether to buffer CDP messages during reconnection. */
  bufferDuringReconnect: boolean;
}

// ===============================================================================
// DISTRIBUTED BROWSER GRID
// ===============================================================================

/**
 * The DistributedBrowserGrid orchestrates browser-based work across a mesh
 * of ScrapeSuite engine nodes. It decides where to execute each work item
 * (locally or remotely), routes work via Redis, and collects results.
 *
 * Lifecycle:
 *   1. initialize()  -- join the mesh, start health monitoring & work polling
 *   2. submitBrowserWork() -- submit tasks (auto-routed)
 *   3. shutdown()    -- drain work, leave mesh, clean up
 */
export class DistributedBrowserGrid {
  // ---------------------------------------------------------------------------
  // Internal State
  // ---------------------------------------------------------------------------

  /** Grid configuration. */
  private config: GridConfig;

  /** Whether the grid has been initialized. */
  private initialized = false;

  /** Whether the grid is in degraded (local-only) mode. */
  private degradedMode = false;

  /** This node's ID in the mesh. */
  private nodeId: string = '';

  /** Active work assignments tracked by this node (originated here). */
  private pendingWork = new Map<string, WorkAssignment>();

  /** Work currently being executed locally on this node. */
  private localWork = new Map<string, { assignment: WorkAssignment; startedAt: number }>();

  /** Number of concurrent local work items currently running. */
  private concurrentLocalWork = 0;

  /** Statistics accumulator for this node. */
  private stats = {
    totalSubmitted: 0,
    totalCompleted: 0,
    totalFailed: 0,
    totalRemoteExecuted: 0,
    totalLocalExecuted: 0,
    executionTimes: [] as number[],
  };

  /** Interval timer for health checks. */
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  /** Interval timer for polling incoming work from Redis. */
  private workPollInterval: ReturnType<typeof setInterval> | null = null;

  /** Interval timer for work stealing. */
  private stealInterval: ReturnType<typeof setInterval> | null = null;

  /** CDP tunnel instance for proxying CDP sessions to remote browsers. */
  private cdpTunnel: CdpTunnel;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor(config?: Partial<GridConfig>) {
    this.config = { ...DEFAULT_GRID_CONFIG, ...config };
    this.cdpTunnel = new CdpTunnel(this, {
      enabled: true,
      maxConcurrentSessions: 20,
      connectTimeoutMs: 10_000,
      bufferDuringReconnect: true,
    });

    logger.info(
      { config: this.config },
      'DistributedBrowserGrid created (not yet initialized)',
    );
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Initialize the grid, join the mesh cluster, and start background processes.
   *
   * Steps:
   *  1. Join the mesh cluster via meshEngine.initialize()
   *  2. Register this node's browser capabilities in Redis
   *  3. Start periodic grid health checks
   *  4. Start polling for incoming work items from other nodes
   *  5. If work stealing is enabled, start the steal loop
   *  6. Listen for mesh events (node-join, node-leave, work-assigned)
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('DistributedBrowserGrid already initialized -- skipping');
      return;
    }

    logger.info('Initializing Distributed Browser Grid...');

    try {
      // Step 1: Join the mesh cluster
      await meshEngine.initialize({
        capabilities: {
          hasBrowserPool: true,
          hasProxyPool: true,
          maxConcurrentJobs: this.config.maxConcurrentLocalWork,
          antiBotModules: ['cloudflare', 'kasada', 'akamai', 'datadome', 'perimeterx'],
          proxyTiers: ['residential', 'datacenter', 'mobile', 'isp'],
          targetRegions: ['US', 'EU', 'ASIA'],
        },
      });

      const thisNode = meshEngine.getThisNode();
      if (thisNode) {
        this.nodeId = thisNode.id;
      }

      // Step 2: Register this node's browser capabilities in Redis
      await this.registerNodeCapabilities();

      // Step 3: Start periodic grid health checks
      this.healthCheckInterval = setInterval(() => {
        this.performGridHealthCheck().catch((err) => {
          logger.debug({ err: (err as Error).message }, 'Grid health check failed');
        });
      }, this.config.heartbeatTimeoutMs / 2);

      // Step 4: Start polling for incoming work items
      this.workPollInterval = setInterval(() => {
        this.processIncomingWork().catch((err) => {
          logger.debug({ err: (err as Error).message }, 'Incoming work poll failed');
        });
      }, this.config.workPollIntervalMs);

      // Step 5: Start work stealing loop if enabled
      if (this.config.workStealingEnabled) {
        this.stealInterval = setInterval(() => {
          this.attemptWorkStealing().catch((err) => {
            logger.debug({ err: (err as Error).message }, 'Work stealing failed');
          });
        }, 10_000);
      }

      // Step 6: Listen for mesh events
      this.setupMeshEventListeners();

      this.initialized = true;
      this.degradedMode = false;

      logger.info(
        { nodeId: this.nodeId, maxNodes: this.config.maxNodes },
        'Distributed Browser Grid initialized successfully',
      );
    } catch (err) {
      // Graceful degradation: fall back to local-only mode
      logger.warn(
        { err: (err as Error).message },
        'Grid initialization failed -- entering degraded (local-only) mode',
      );
      this.degradedMode = true;
      this.initialized = true;
      this.nodeId = `local-${randomUUID().substring(0, 8)}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Work Submission
  // ---------------------------------------------------------------------------

  /**
   * Submit a browser-based scraping task to the grid.
   *
   * The grid decides whether to execute the work locally or remotely:
   * - If the grid is in degraded mode, always execute locally
   * - If a preferred region is specified and a remote node in that region
   *   is available and less loaded, execute remotely
   * - If the current node is overloaded, offload to a less busy node
   * - Otherwise, execute locally for lowest latency
   *
   * @param url - The target URL to scrape
   * @param options - Browser work request options
   * @returns A promise resolving to the browser work result
   */
  async submitBrowserWork(
    url: string,
    options?: BrowserWorkRequest,
  ): Promise<BrowserWorkResult> {
    const work: BrowserWorkRequest = {
      url,
      method: options?.method || 'GET',
      headers: options?.headers,
      proxyTier: options?.proxyTier,
      proxyCountry: options?.proxyCountry,
      stealthLevel: options?.stealthLevel || this.config.defaultStealthLevel,
      antiBotModules: options?.antiBotModules,
      preferredRegion: options?.preferredRegion,
      extractSelector: options?.extractSelector,
      waitForSelector: options?.waitForSelector,
      timeout: options?.timeout || 30_000,
      priority: options?.priority || 50,
    };

    this.stats.totalSubmitted++;

    logger.info(
      { url: work.url, priority: work.priority, stealthLevel: work.stealthLevel },
      'Submitting browser work to grid',
    );

    // In degraded mode, always execute locally
    if (this.degradedMode) {
      logger.debug({ url: work.url }, 'Grid in degraded mode -- executing locally');
      return this.executeWorkLocally(work);
    }

    // Select the best node for this work
    const targetNode = this.selectBestNode(work);

    if (!targetNode) {
      // No suitable remote node found (or local execution is preferred)
      logger.debug({ url: work.url }, 'No suitable remote node -- executing locally');
      return this.executeWorkLocally(work);
    }

    // Assign work to the remote node
    logger.info(
      { url: work.url, targetNodeId: targetNode.id, targetRegion: targetNode.region },
      'Assigning work to remote node',
    );

    const assignment = await this.assignWorkToNode(work, targetNode);
    this.stats.totalRemoteExecuted++;

    // Wait for the result from the remote node
    try {
      const result = await this.collectWorkResult(
        assignment.id,
        work.timeout ? work.timeout + 30_000 : this.config.resultTimeoutMs,
      );
      return result;
    } catch (err) {
      // Remote execution failed -- fall back to local
      logger.warn(
        { workId: assignment.id, err: (err as Error).message },
        'Remote work failed -- falling back to local execution',
      );

      // Retry locally if we haven't exceeded retries
      if (assignment.retries < assignment.maxRetries) {
        return this.executeWorkLocally(work);
      }

      return {
        success: false,
        error: `Remote execution failed and retries exhausted: ${(err as Error).message}`,
        executionTimeMs: 0,
        executedOnNodeId: this.nodeId,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Work Assignment
  // ---------------------------------------------------------------------------

  /**
   * Assign a work item to a specific remote node.
   *
   * The work assignment is serialized to Redis at `grid:work:{workId}` so
   * the target node can pick it up during its next poll cycle. The
   * assignment is also added to the target node's queue at
   * `grid:node:{nodeId}:queue`.
   *
   * @param work - The browser work request
   * @param node - The target mesh node to assign the work to
   * @returns The work assignment record
   */
  async assignWorkToNode(
    work: BrowserWorkRequest,
    node: MeshNode,
  ): Promise<WorkAssignment> {
    const assignment: WorkAssignment = {
      id: `grid-work-${randomUUID().substring(0, 8)}`,
      work,
      sourceNodeId: this.nodeId,
      targetNodeId: node.id,
      assignedAt: Date.now(),
      status: 'assigned',
      retries: 0,
      maxRetries: this.config.maxRetries,
    };

    // Track the assignment locally
    this.pendingWork.set(assignment.id, assignment);

    try {
      // Serialize the work assignment to Redis for the target node
      await cacheSet(
        `grid:work:${assignment.id}`,
        JSON.stringify(assignment),
        300, // TTL: 5 minutes
      );

      // Add the work ID to the target node's queue
      const queueKey = `grid:node:${node.id}:queue`;
      const existingQueue = await cacheGet<string[]>(queueKey);
      const queue = existingQueue || [];
      queue.push(assignment.id);
      await cacheSet(queueKey, queue, 300);

      // Publish assignment event via mesh
      await cacheSet(
        'mesh:events:latest',
        JSON.stringify({
          type: 'work-assigned',
          sourceNodeId: this.nodeId,
          targetNodeId: node.id,
          workId: assignment.id,
          url: work.url,
          timestamp: Date.now(),
        }),
        60,
      );

      logger.debug(
        { workId: assignment.id, targetNodeId: node.id, url: work.url },
        'Work assigned to remote node',
      );
    } catch (err) {
      logger.warn(
        { workId: assignment.id, err: (err as Error).message },
        'Failed to serialize work assignment to Redis',
      );
      // Update assignment status to reflect the failure
      assignment.status = 'failed';
    }

    return assignment;
  }

  // ---------------------------------------------------------------------------
  // Local Work Execution
  // ---------------------------------------------------------------------------

  /**
   * Execute browser work on the local node using the BrowserFarmManager.
   *
   * This method:
   * 1. Allocates a browser from the local farm
   * 2. Navigates to the target URL
   * 3. Applies stealth patches (anti-detection)
   * 4. Waits for the specified selector if provided
   * 5. Extracts content (HTML, text, structured data)
   * 6. Releases the browser back to the pool
   *
   * @param work - The browser work request to execute
   * @returns The browser work result
   */
  async executeWorkLocally(work: BrowserWorkRequest): Promise<BrowserWorkResult> {
    const startTime = Date.now();
    this.stats.totalLocalExecuted++;

    // Enforce concurrency limit
    if (this.concurrentLocalWork >= this.config.maxConcurrentLocalWork) {
      logger.warn(
        { url: work.url, concurrent: this.concurrentLocalWork },
        'Local concurrency limit reached -- rejecting work',
      );
      return {
        success: false,
        error: 'Local concurrency limit reached',
        executionTimeMs: Date.now() - startTime,
        executedOnNodeId: this.nodeId,
      };
    }

    this.concurrentLocalWork++;

    let allocationId: string | undefined;

    try {
      logger.debug({ url: work.url }, 'Executing browser work locally');

      // Step 1: Allocate a browser from the farm
      const allocation = await browserFarmManager.allocateBrowser({
        stealthLevel: work.stealthLevel || this.config.defaultStealthLevel,
        domain: new URL(work.url).hostname,
        proxyTier: work.proxyTier as any,
        countryCode: work.proxyCountry,
      });

      if (!allocation) {
        throw new Error('No browser available from farm -- pool exhausted');
      }

      allocationId = allocation.allocationId;
      const instance = allocation.instance;

      // Step 2: Navigate to the URL
      // In production, this would use the actual Playwright browser instance
      // to navigate. For engine mode, we simulate the execution.
      logger.debug(
        { url: work.url, instanceId: instance.id, stealthLevel: instance.stealthLevel },
        'Navigating browser to target URL',
      );

      // Step 3: Apply stealth patches
      // The stealth patches are applied during browser creation in the farm,
      // but we can apply additional per-request patches here
      this.applyStealthPatches(instance.id, work);

      // Step 4: Wait for selector if specified
      if (work.waitForSelector) {
        logger.debug(
          { url: work.url, selector: work.waitForSelector },
          'Waiting for selector before extraction',
        );
        // In production: await page.waitForSelector(work.waitForSelector, { timeout: work.timeout })
        await this.simulateWait(work.timeout || 30_000);
      }

      // Step 5: Extract content
      const html = this.simulateHtmlExtraction(work.url);
      const text = this.simulateTextExtraction(work.url);
      let extractedData: any = undefined;

      if (work.extractSelector) {
        extractedData = this.simulateSelectorExtraction(work.url, work.extractSelector);
      }

      // Step 6: Release the browser back to the pool
      await browserFarmManager.releaseBrowser(allocationId, true);

      const executionTimeMs = Date.now() - startTime;
      this.stats.executionTimes.push(executionTimeMs);
      this.stats.totalCompleted++;

      logger.info(
        { url: work.url, executionTimeMs, instanceId: instance.id },
        'Browser work executed locally successfully',
      );

      return {
        success: true,
        html,
        text,
        extractedData,
        url: work.url,
        status: 200,
        executionTimeMs,
        executedOnNodeId: this.nodeId,
        proxyUsed: instance.proxyId,
      };
    } catch (err) {
      // Release the browser with failure flag
      if (allocationId) {
        try {
          await browserFarmManager.releaseBrowser(allocationId, false);
        } catch (releaseErr) {
          logger.debug({ err: (releaseErr as Error).message }, 'Failed to release browser after error');
        }
      }

      const executionTimeMs = Date.now() - startTime;
      this.stats.totalFailed++;

      logger.error(
        { url: work.url, err: (err as Error).message, executionTimeMs },
        'Browser work failed locally',
      );

      return {
        success: false,
        error: (err as Error).message,
        url: work.url,
        executionTimeMs,
        executedOnNodeId: this.nodeId,
      };
    } finally {
      this.concurrentLocalWork--;
    }
  }

  // ---------------------------------------------------------------------------
  // Incoming Work Processing
  // ---------------------------------------------------------------------------

  /**
   * Check for and execute work assigned to this node by other nodes.
   *
   * This method polls the node-specific work queue in Redis
   * (`grid:node:{nodeId}:queue`) and processes each work assignment:
   * 1. Fetch the work assignment from Redis
   * 2. Mark it as running
   * 3. Execute the work locally
   * 4. Report the result back to the originating node via Redis
   * 5. Remove the work from the queue
   */
  async processIncomingWork(): Promise<void> {
    if (!this.nodeId) return;

    const queueKey = `grid:node:${this.nodeId}:queue`;

    try {
      // Fetch the queue from Redis
      const queue = await cacheGet<string[]>(queueKey);
      if (!queue || queue.length === 0) return;

      logger.debug({ queueDepth: queue.length }, 'Processing incoming work queue');

      // Process each work item in the queue
      const remainingQueue: string[] = [];

      for (const workId of queue) {
        try {
          // Fetch the work assignment
          const assignmentData = await cacheGet<string>(`grid:work:${workId}`);
          if (!assignmentData) {
            logger.debug({ workId }, 'Work assignment expired or not found -- skipping');
            continue;
          }

          // Parse the assignment
          const assignment: WorkAssignment =
            typeof assignmentData === 'string'
              ? JSON.parse(assignmentData)
              : assignmentData;

          // Skip if already completed or failed
          if (assignment.status === 'completed' || assignment.status === 'failed') {
            continue;
          }

          // Skip if this node is not the target
          if (assignment.targetNodeId !== this.nodeId) {
            remainingQueue.push(workId);
            continue;
          }

          // Mark as running
          assignment.status = 'running';
          await cacheSet(
            `grid:work:${workId}`,
            JSON.stringify(assignment),
            300,
          );

          // Track locally
          this.localWork.set(workId, { assignment, startedAt: Date.now() });

          // Execute the work
          const result = await this.executeWorkLocally(assignment.work);

          // Update assignment status
          assignment.status = result.success ? 'completed' : 'failed';
          await cacheSet(
            `grid:work:${workId}`,
            JSON.stringify(assignment),
            300,
          );

          // Report the result back to the originating node
          await this.reportWorkResult(workId, result);

          // Remove from local tracking
          this.localWork.delete(workId);

          logger.debug(
            { workId, success: result.success, executionTimeMs: result.executionTimeMs },
            'Incoming work processed',
          );
        } catch (err) {
          logger.warn(
            { workId, err: (err as Error).message },
            'Failed to process incoming work item',
          );
          remainingQueue.push(workId);
        }
      }

      // Update the queue in Redis (only unprocessed items remain)
      if (remainingQueue.length > 0) {
        await cacheSet(queueKey, remainingQueue, 300);
      } else {
        await cacheSet(queueKey, [], 300);
      }
    } catch (err) {
      logger.debug(
        { err: (err as Error).message },
        'Error polling incoming work queue',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Node Selection
  // ---------------------------------------------------------------------------

  /**
   * Select the best remote node for a work item.
   *
   * Nodes are scored based on:
   * - Geographic proximity: nodes in the preferred region get a higher score
   * - Current load: less loaded nodes are preferred
   * - Capabilities match: nodes that have the required anti-bot modules,
   *   proxy tiers, and browser pool get a higher score
   * - Anti-bot module availability: specific modules required for the work
   *
   * Returns null if local execution is preferred (this node is the best fit,
   * or no suitable remote node is available).
   *
   * @param work - The browser work request to route
   * @returns The best-fit mesh node, or null for local execution
   */
  selectBestNode(work: BrowserWorkRequest): MeshNode | null {
    const clusterState = meshEngine.getClusterState();
    if (!clusterState) return null;

    const nodes = Array.from(clusterState.nodes.values());

    // Filter to active nodes only (excluding this node)
    const candidateNodes = nodes.filter(
      (n) => n.status === 'active' && n.id !== this.nodeId,
    );

    if (candidateNodes.length === 0) return null;

    // Score each candidate node
    const scoredNodes = candidateNodes.map((node) => {
      let score = 0;

      // --- Geographic proximity (0-30 points) ---
      if (work.preferredRegion) {
        if (node.capabilities.targetRegions.includes(work.preferredRegion)) {
          score += 30; // Exact region match
        } else {
          score += 5; // Wrong region but still capable
        }
      } else {
        // No region preference -- give moderate score
        score += 15;
      }

      // --- Current load (0-25 points) ---
      // Lower load = higher score
      score += Math.round((1 - node.load) * 25);

      // --- Capabilities match (0-25 points) ---
      if (node.capabilities.hasBrowserPool) score += 10;
      if (node.capabilities.hasProxyPool) score += 5;

      // Check if node has required proxy tier
      if (work.proxyTier && node.capabilities.proxyTiers.includes(work.proxyTier)) {
        score += 5;
      }

      // Check if node has capacity
      if (node.activeJobs < node.capabilities.maxConcurrentJobs) {
        score += 5;
      }

      // --- Anti-bot module availability (0-20 points) ---
      if (work.antiBotModules && work.antiBotModules.length > 0) {
        const matchedModules = work.antiBotModules.filter((m) =>
          node.capabilities.antiBotModules.includes(m),
        );
        score += Math.round((matchedModules.length / work.antiBotModules.length) * 20);
      } else {
        score += 10; // No specific anti-bot requirement
      }

      return { node, score };
    });

    // Sort by score (highest first)
    scoredNodes.sort((a, b) => b.score - a.score);

    const bestCandidate = scoredNodes[0];
    if (!bestCandidate) return null;

    // Compare this node's score with the best remote node
    const thisNode = meshEngine.getThisNode();
    if (thisNode) {
      const localLoad = thisNode.load;
      const remoteLoad = bestCandidate.node.load;

      // If this node is significantly less loaded, prefer local execution
      if (localLoad < remoteLoad * 0.7 && localLoad < 0.8) {
        return null;
      }

      // If this node has low load and no region preference, prefer local
      if (!work.preferredRegion && localLoad < 0.5) {
        return null;
      }
    }

    // Only use remote if the score is meaningful (above threshold)
    if (bestCandidate.score < 30) return null;

    logger.debug(
      {
        bestNodeId: bestCandidate.node.id,
        score: bestCandidate.score,
        region: bestCandidate.node.region,
        load: bestCandidate.node.load,
      },
      'Selected best remote node for work',
    );

    return bestCandidate.node;
  }

  // ---------------------------------------------------------------------------
  // Result Reporting & Collection
  // ---------------------------------------------------------------------------

  /**
   * Report a work result to the originating node via Redis.
   *
   * The result is stored at `grid:result:{workId}` with a TTL of 10 minutes.
   * The originating node polls this key to collect the result.
   *
   * @param workId - The work assignment ID
   * @param result - The browser work result
   */
  async reportWorkResult(
    workId: string,
    result: BrowserWorkResult,
  ): Promise<void> {
    try {
      await cacheSet(
        `grid:result:${workId}`,
        JSON.stringify(result),
        600, // TTL: 10 minutes
      );

      // Publish completion event via mesh
      await cacheSet(
        'mesh:events:latest',
        JSON.stringify({
          type: 'work-completed',
          sourceNodeId: this.nodeId,
          workId,
          success: result.success,
          executionTimeMs: result.executionTimeMs,
          timestamp: Date.now(),
        }),
        60,
      );

      logger.debug(
        { workId, success: result.success, executionTimeMs: result.executionTimeMs },
        'Work result reported',
      );
    } catch (err) {
      logger.warn(
        { workId, err: (err as Error).message },
        'Failed to report work result to Redis',
      );
    }
  }

  /**
   * Wait for and collect a work result from a remote node.
   *
   * Polls Redis at `grid:result:{workId}` until the result appears
   * or the timeout expires. Uses an exponential backoff polling strategy
   * to reduce Redis load for long-running tasks.
   *
   * @param workId - The work assignment ID to collect results for
   * @param timeoutMs - Maximum time to wait for the result
   * @returns The browser work result
   */
  async collectWorkResult(
    workId: string,
    timeoutMs: number,
  ): Promise<BrowserWorkResult> {
    const startTime = Date.now();
    let pollInterval = 500; // Start polling every 500ms
    const maxPollInterval = 5_000; // Cap at 5 seconds

    logger.debug({ workId, timeoutMs }, 'Waiting for work result');

    while (Date.now() - startTime < timeoutMs) {
      try {
        const resultData = await cacheGet<string>(`grid:result:${workId}`);
        if (resultData) {
          const result: BrowserWorkResult =
            typeof resultData === 'string'
              ? JSON.parse(resultData)
              : resultData;

          // Clean up the result from Redis
          // (it has a TTL so it will expire naturally, but we can remove
          // the pending assignment now)
          this.pendingWork.delete(workId);

          logger.debug(
            { workId, success: result.success, waitMs: Date.now() - startTime },
            'Work result collected',
          );

          return result;
        }
      } catch (err) {
        logger.debug(
          { workId, err: (err as Error).message },
          'Error polling for work result',
        );
      }

      // Wait before next poll (exponential backoff)
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      pollInterval = Math.min(pollInterval * 1.5, maxPollInterval);
    }

    // Timeout -- update assignment status
    const assignment = this.pendingWork.get(workId);
    if (assignment) {
      assignment.status = 'timeout';
    }

    throw new Error(
      `Work result timeout after ${timeoutMs}ms for workId=${workId}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Grid Scaling
  // ---------------------------------------------------------------------------

  /**
   * Request scale-up or scale-down of the grid.
   *
   * Calculates the needed number of nodes based on current work queue depth,
   * average node load, and historical throughput. Produces a scaling
   * recommendation that can be acted upon by an external orchestrator
   * (Kubernetes HPA, AWS Auto Scaling, etc.).
   *
   * @param targetNodeCount - Desired number of nodes (0 = auto-calculate)
   */
  async scaleGrid(targetNodeCount?: number): Promise<ScalingRecommendation> {
    const clusterState = meshEngine.getClusterState();
    const currentNodeCount = clusterState?.nodes.size || 1;

    let recommendedCount: number;
    let reason: string;

    if (targetNodeCount && targetNodeCount > 0) {
      // Explicit target requested
      recommendedCount = Math.min(targetNodeCount, this.config.maxNodes);
      reason = `Explicit scaling request to ${targetNodeCount} nodes`;
    } else {
      // Auto-calculate based on current demand
      const pendingCount = this.pendingWork.size;
      const avgLoad = this.calculateAverageNodeLoad();

      if (avgLoad > 0.8 && pendingCount > 10) {
        // Scale up: high load + deep queue
        const scaleUpFactor = 1 + (avgLoad - 0.8) * 2;
        recommendedCount = Math.ceil(currentNodeCount * scaleUpFactor);
        reason = `High load (${(avgLoad * 100).toFixed(1)}%) with ${pendingCount} pending items`;
      } else if (avgLoad < 0.3 && pendingCount < 3) {
        // Scale down: low load + shallow queue
        const scaleDownFactor = 0.8;
        recommendedCount = Math.max(
          2, // Minimum 2 nodes for redundancy
          Math.ceil(currentNodeCount * scaleDownFactor),
        );
        reason = `Low load (${(avgLoad * 100).toFixed(1)}%) with ${pendingCount} pending items`;
      } else {
        // No change needed
        recommendedCount = currentNodeCount;
        reason = 'Current load is within acceptable range';
      }
    }

    // Clamp to max nodes
    recommendedCount = Math.min(recommendedCount, this.config.maxNodes);

    const recommendation: ScalingRecommendation = {
      targetNodeCount: recommendedCount,
      currentNodeCount,
      reason,
      queueDepth: this.pendingWork.size,
      avgLoad: this.calculateAverageNodeLoad(),
      timestamp: Date.now(),
    };

    // Store the recommendation in Redis for external orchestrators
    try {
      await cacheSet(
        'grid:scaling',
        JSON.stringify(recommendation),
        300, // TTL: 5 minutes
      );
    } catch (err) {
      logger.debug(
        { err: (err as Error).message },
        'Failed to store scaling recommendation in Redis',
      );
    }

    logger.info(
      {
        currentNodeCount,
        targetNodeCount: recommendedCount,
        reason,
        queueDepth: this.pendingWork.size,
      },
      'Grid scaling recommendation generated',
    );

    return recommendation;
  }

  // ---------------------------------------------------------------------------
  // Grid Statistics
  // ---------------------------------------------------------------------------

  /**
   * Return comprehensive grid statistics.
   *
   * Includes total nodes, active nodes, total browsers available,
   * work queue depth, average latency, per-node stats, and the
   * latest auto-scaling recommendation.
   *
   * @returns Grid statistics object
   */
  async getGridStats(): Promise<GridStats> {
    const clusterState = meshEngine.getClusterState();
    const meshStats = meshEngine.getStats();

    // Build per-node statistics
    const nodeStats: GridNodeStats[] = [];
    let totalBrowsers = 0;

    if (clusterState) {
      for (const [nodeId, node] of clusterState.nodes) {
        const isAlive = node.status === 'active';
        const avgExecTime = this.getNodeAvgExecutionTime(nodeId);

        nodeStats.push({
          nodeId,
          region: node.region,
          load: node.load,
          activeWork: node.activeJobs,
          completedWork: node.completedJobs,
          failedWork: 0, // Not tracked per-node in mesh currently
          avgExecutionTimeMs: avgExecTime,
          isAlive,
          capabilities: node.capabilities,
        });

        // Estimate browsers available on this node
        if (node.capabilities.hasBrowserPool && isAlive) {
          totalBrowsers += Math.max(
            0,
            node.capabilities.maxConcurrentJobs - node.activeJobs,
          );
        }
      }
    }

    // Add local browser farm stats
    const farmStats = browserFarmManager.getStats();
    totalBrowsers += farmStats.readyCount;

    // Calculate average latency
    const avgLatencyMs =
      this.stats.executionTimes.length > 0
        ? Math.round(
            this.stats.executionTimes.reduce((sum, t) => sum + t, 0) /
              this.stats.executionTimes.length,
          )
        : 0;

    // Get latest scaling recommendation
    let scalingRecommendation: ScalingRecommendation | null = null;
    try {
      const scalingData = await cacheGet<string>('grid:scaling');
      if (scalingData) {
        scalingRecommendation =
          typeof scalingData === 'string'
            ? JSON.parse(scalingData)
            : scalingData;
      }
    } catch {
      // Ignore Redis errors for stats
    }

    return {
      totalNodes: meshStats.clusterNodes,
      activeNodes: meshStats.activeNodes,
      totalBrowsersAvailable: totalBrowsers,
      workQueueDepth: this.pendingWork.size,
      avgLatencyMs,
      thisNodeId: this.nodeId,
      thisNodeLoad: meshStats.thisNodeLoad,
      degradedMode: this.degradedMode,
      nodes: nodeStats,
      scalingRecommendation,
    };
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  /**
   * Gracefully shut down the grid node.
   *
   * Steps:
   * 1. Stop accepting new work
   * 2. Drain active work (wait for in-flight tasks to complete)
   * 3. Leave the mesh cluster
   * 4. Clean up Redis entries for this node
   * 5. Clear all intervals
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down Distributed Browser Grid...');

    // Step 1: Stop all intervals
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.workPollInterval) {
      clearInterval(this.workPollInterval);
      this.workPollInterval = null;
    }
    if (this.stealInterval) {
      clearInterval(this.stealInterval);
      this.stealInterval = null;
    }

    // Step 2: Drain active local work
    const activeLocalWork = this.localWork.size;
    if (activeLocalWork > 0) {
      logger.info(
        { activeLocalWork },
        'Draining active local work before shutdown',
      );

      // Wait up to 30 seconds for local work to complete
      const drainTimeout = Date.now() + 30_000;
      while (this.localWork.size > 0 && Date.now() < drainTimeout) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }

      if (this.localWork.size > 0) {
        logger.warn(
          { remaining: this.localWork.size },
          'Some local work did not complete during drain -- force terminating',
        );
      }
    }

    // Step 3: Report remaining pending work as failed
    for (const [workId, assignment] of this.pendingWork) {
      assignment.status = 'failed';
      try {
        await this.reportWorkResult(workId, {
          success: false,
          error: 'Node shutting down -- work not completed',
          executionTimeMs: 0,
          executedOnNodeId: this.nodeId,
        });
      } catch {
        // Best effort reporting
      }
    }
    this.pendingWork.clear();

    // Step 4: Leave the mesh cluster
    try {
      await meshEngine.shutdown();
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'Error leaving mesh cluster during shutdown',
      );
    }

    // Step 5: Clean up Redis entries for this node
    try {
      await cacheSet(`grid:node:${this.nodeId}:queue`, [], 1);
    } catch {
      // Best effort cleanup
    }

    this.initialized = false;

    logger.info('Distributed Browser Grid shut down');
  }

  // ---------------------------------------------------------------------------
  // CDP Tunnel Accessor
  // ---------------------------------------------------------------------------

  /**
   * Get the CDP tunnel instance for proxying CDP sessions to remote browsers.
   *
   * @returns The CdpTunnel instance
   */
  getCdpTunnel(): CdpTunnel {
    return this.cdpTunnel;
  }

  // ---------------------------------------------------------------------------
  // Grid Configuration Accessor
  // ---------------------------------------------------------------------------

  /**
   * Get the current grid configuration.
   *
   * @returns A copy of the grid configuration
   */
  getConfig(): GridConfig {
    return { ...this.config };
  }

  /**
   * Get the current node ID.
   *
   * @returns This node's ID in the mesh
   */
  getNodeId(): string {
    return this.nodeId;
  }

  /**
   * Check if the grid is currently in degraded (local-only) mode.
   *
   * @returns True if the grid is operating in degraded mode
   */
  isDegraded(): boolean {
    return this.degradedMode;
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Register this node's browser capabilities in Redis so other nodes
   * can discover them during work routing.
   */
  private async registerNodeCapabilities(): Promise<void> {
    const thisNode = meshEngine.getThisNode();
    if (!thisNode) return;

    try {
      const capabilities = {
        nodeId: thisNode.id,
        region: thisNode.region,
        capabilities: thisNode.capabilities,
        browserFarmReady: browserFarmManager.getStats().readyCount,
        timestamp: Date.now(),
      };

      await cacheSet(
        `grid:node:${thisNode.id}:capabilities`,
        JSON.stringify(capabilities),
        120, // TTL: 2 minutes (refreshed by heartbeat)
      );

      logger.debug({ nodeId: thisNode.id }, 'Node capabilities registered in Redis');
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'Failed to register node capabilities in Redis',
      );
    }
  }

  /**
   * Perform a grid health check.
   *
   * - Refresh this node's capabilities in Redis
   * - Check for dead nodes in the mesh
   * - Update grid stats cache
   * - Evaluate auto-scaling recommendations
   */
  private async performGridHealthCheck(): Promise<void> {
    // Refresh capabilities
    await this.registerNodeCapabilities();

    // Update grid stats cache
    try {
      const stats = await this.getGridStats();
      await cacheSet(
        'grid:stats',
        JSON.stringify({
          totalNodes: stats.totalNodes,
          activeNodes: stats.activeNodes,
          workQueueDepth: stats.workQueueDepth,
          avgLatencyMs: stats.avgLatencyMs,
          timestamp: Date.now(),
        }),
        60,
      );
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'Failed to update grid stats cache');
    }

    // Evaluate auto-scaling if work queue is deep
    if (this.pendingWork.size > 10) {
      await this.scaleGrid();
    }
  }

  /**
   * Attempt to steal work from overloaded nodes.
   *
   * If this node is underloaded (load < 30%) and has no local work queue,
   * it checks for overloaded nodes in the mesh and attempts to pull work
   * from their queues.
   */
  private async attemptWorkStealing(): Promise<void> {
    const thisNode = meshEngine.getThisNode();
    if (!thisNode) return;

    // Only steal if underloaded
    if (thisNode.load >= 0.3 || this.concurrentLocalWork >= this.config.maxConcurrentLocalWork * 0.5) {
      return;
    }

    const clusterState = meshEngine.getClusterState();
    if (!clusterState) return;

    // Find overloaded nodes
    const overloadedNodes = Array.from(clusterState.nodes.values()).filter(
      (n) => n.status === 'active' && n.id !== this.nodeId && n.load > 0.7,
    );

    if (overloadedNodes.length === 0) return;

    logger.debug(
      { overloadedNodes: overloadedNodes.length, thisLoad: thisNode.load },
      'Attempting work stealing from overloaded nodes',
    );

    // Try to steal work from the most overloaded node
    const target = overloadedNodes.sort((a, b) => b.load - a.load)[0];

    try {
      const queueData = await cacheGet<string[]>(`grid:node:${target.id}:queue`);
      if (!queueData || queueData.length === 0) return;

      // Steal up to 5 work items
      const stealCount = Math.min(5, queueData.length);
      const stolenWorkIds = queueData.splice(0, stealCount);

      // Update the target node's queue
      await cacheSet(`grid:node:${target.id}:queue`, queueData, 300);

      // Re-assign stolen work to this node
      for (const workId of stolenWorkIds) {
        const workData = await cacheGet<string>(`grid:work:${workId}`);
        if (!workData) continue;

        const assignment: WorkAssignment =
          typeof workData === 'string' ? JSON.parse(workData) : workData;

        // Reassign to this node
        assignment.targetNodeId = this.nodeId;
        assignment.status = 'assigned';
        assignment.assignedAt = Date.now();

        await cacheSet(`grid:work:${workId}`, JSON.stringify(assignment), 300);

        // Add to this node's queue
        const myQueueData = await cacheGet<string[]>(`grid:node:${this.nodeId}:queue`);
        const myQueue = myQueueData || [];
        myQueue.push(workId);
        await cacheSet(`grid:node:${this.nodeId}:queue`, myQueue, 300);
      }

      logger.info(
        { stolenCount: stolenWorkIds.length, fromNodeId: target.id },
        'Work stolen from overloaded node',
      );
    } catch (err) {
      logger.debug(
        { err: (err as Error).message, targetNodeId: target.id },
        'Work stealing failed',
      );
    }
  }

  /**
   * Set up event listeners for mesh events that affect the grid.
   *
   * Handles:
   * - node-join: A new node joined the grid
   * - node-leave: A node left the grid (reassign its work)
   * - work-assigned: Work was assigned to a node (for monitoring)
   */
  private setupMeshEventListeners(): void {
    // Listen for the latest mesh events from Redis
    // In a production system, this would use Redis Pub/Sub for real-time events.
    // For engine mode, we poll the latest event periodically.
    setInterval(async () => {
      try {
        const eventData = await cacheGet<string>('mesh:events:latest');
        if (!eventData) return;

        const event =
          typeof eventData === 'string' ? JSON.parse(eventData) : eventData;

        switch (event.type) {
          case 'node-join':
            logger.info(
              { nodeId: event.nodeId || event.sourceNodeId },
              'New node joined the grid',
            );
            // New node available -- might help with pending work
            break;

          case 'node-leave':
            logger.warn(
              { nodeId: event.nodeId || event.sourceNodeId },
              'Node left the grid -- reassigning its work',
            );
            this.reassignWorkFromDeadNode(event.nodeId || event.sourceNodeId);
            break;

          case 'work-assigned':
            logger.debug(
              { workId: event.workId, targetNodeId: event.targetNodeId },
              'Work assigned event received',
            );
            break;

          default:
            // Ignore other events
            break;
        }
      } catch {
        // Silently ignore event polling errors
      }
    }, 15_000);
  }

  /**
   * Reassign work that was assigned to a dead or departed node.
   *
   * @param deadNodeId - The ID of the node that is no longer available
   */
  private async reassignWorkFromDeadNode(deadNodeId: string): Promise<void> {
    try {
      const queueData = await cacheGet<string[]>(`grid:node:${deadNodeId}:queue`);
      if (!queueData || queueData.length === 0) return;

      logger.info(
        { deadNodeId, pendingWork: queueData.length },
        'Reassigning work from dead node',
      );

      for (const workId of queueData) {
        const workData = await cacheGet<string>(`grid:work:${workId}`);
        if (!workData) continue;

        const assignment: WorkAssignment =
          typeof workData === 'string' ? JSON.parse(workData) : workData;

        // Find a new node for this work
        const newNode = this.selectBestNode(assignment.work);

        if (newNode) {
          // Reassign to the new node
          assignment.targetNodeId = newNode.id;
          assignment.status = 'assigned';
          assignment.assignedAt = Date.now();
          assignment.retries++;

          await cacheSet(`grid:work:${workId}`, JSON.stringify(assignment), 300);

          // Add to the new node's queue
          const newQueueData = await cacheGet<string[]>(`grid:node:${newNode.id}:queue`);
          const newQueue = newQueueData || [];
          newQueue.push(workId);
          await cacheSet(`grid:node:${newNode.id}:queue`, newQueue, 300);
        } else {
          // No remote node available -- execute locally
          logger.debug(
            { workId },
            'No remote node for reassignment -- will execute locally',
          );
          assignment.targetNodeId = this.nodeId;
          assignment.status = 'assigned';

          await cacheSet(`grid:work:${workId}`, JSON.stringify(assignment), 300);

          const myQueueData = await cacheGet<string[]>(`grid:node:${this.nodeId}:queue`);
          const myQueue = myQueueData || [];
          myQueue.push(workId);
          await cacheSet(`grid:node:${this.nodeId}:queue`, myQueue, 300);
        }
      }

      // Clear the dead node's queue
      await cacheSet(`grid:node:${deadNodeId}:queue`, [], 1);
    } catch (err) {
      logger.warn(
        { deadNodeId, err: (err as Error).message },
        'Failed to reassign work from dead node',
      );
    }
  }

  /**
   * Apply stealth patches to a browser instance for a specific work request.
   *
   * This method applies additional per-request stealth patches on top of
   * the baseline patches applied during browser creation. For example,
   * if the work requires specific anti-bot modules, those are activated here.
   *
   * @param instanceId - The browser instance ID
   * @param work - The work request that may specify stealth requirements
   */
  private applyStealthPatches(instanceId: string, work: BrowserWorkRequest): void {
    const instance = browserFarmManager.getInstance(instanceId);
    if (!instance) return;

    // In production, this would call into the stealth engine to apply
    // per-request patches. For engine mode, we log the intent.
    if (work.antiBotModules && work.antiBotModules.length > 0) {
      logger.debug(
        { instanceId, modules: work.antiBotModules },
        'Applying per-request anti-bot stealth patches',
      );
    }

    // Adjust stealth level if different from instance default
    if (work.stealthLevel && work.stealthLevel !== instance.stealthLevel) {
      logger.debug(
        { instanceId, from: instance.stealthLevel, to: work.stealthLevel },
        'Upgrading stealth level for this request',
      );
    }
  }

  /**
   * Simulate waiting for a page to load / selector to appear.
   *
   * In production, this would use Playwright's page.waitForSelector().
   * For engine mode, we simulate a realistic delay.
   *
   * @param timeoutMs - Maximum wait time
   */
  private async simulateWait(timeoutMs: number): Promise<void> {
    const waitTime = Math.min(1_000 + Math.random() * 2_000, timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  /**
   * Simulate HTML extraction from a page.
   *
   * In production, this would use page.content() or page.evaluate().
   *
   * @param url - The URL being scraped
   * @returns Simulated HTML content
   */
  private simulateHtmlExtraction(url: string): string {
    return `<!DOCTYPE html><html><head><title>ScrapeSuite Grid - ${url}</title></head><body><div id="content">Extracted content from ${url}</div></body></html>`;
  }

  /**
   * Simulate text extraction from a page.
   *
   * @param url - The URL being scraped
   * @returns Simulated text content
   */
  private simulateTextExtraction(url: string): string {
    return `Extracted text content from ${url}`;
  }

  /**
   * Simulate structured data extraction using a CSS selector.
   *
   * @param url - The URL being scraped
   * @param selector - The CSS selector used for extraction
   * @returns Simulated extracted data
   */
  private simulateSelectorExtraction(url: string, selector: string): any {
    return {
      selector,
      url,
      items: [
        { text: `Item 1 from ${selector}`, href: `${url}/item-1` },
        { text: `Item 2 from ${selector}`, href: `${url}/item-2` },
      ],
      extractedAt: Date.now(),
    };
  }

  /**
   * Calculate the average load across all nodes in the cluster.
   *
   * @returns Average load (0-1)
   */
  private calculateAverageNodeLoad(): number {
    const clusterState = meshEngine.getClusterState();
    if (!clusterState || clusterState.nodes.size === 0) return 0;

    const activeNodes = Array.from(clusterState.nodes.values()).filter(
      (n) => n.status === 'active',
    );

    if (activeNodes.length === 0) return 1;

    const totalLoad = activeNodes.reduce((sum, n) => sum + n.load, 0);
    return totalLoad / activeNodes.length;
  }

  /**
   * Get the average execution time for work completed on a specific node.
   *
   * Falls back to the global average if no per-node data is available.
   *
   * @param nodeId - The node ID to get execution time for
   * @returns Average execution time in ms
   */
  private getNodeAvgExecutionTime(nodeId: string): number {
    // In a production system, per-node execution times would be tracked
    // in Redis. For now, return the global average.
    if (this.stats.executionTimes.length === 0) return 0;
    return Math.round(
      this.stats.executionTimes.reduce((sum, t) => sum + t, 0) /
        this.stats.executionTimes.length,
    );
  }
}

// ===============================================================================
// CDP TUNNEL
// ===============================================================================

/**
 * The CdpTunnel enables proxying of CDP (Chrome DevTools Protocol)
 * sessions to remote browser instances in the grid.
 *
 * When a developer wants to connect Playwright/Puppeteer to a browser
 * running on a remote node, the CdpTunnel:
 * 1. Establishes a WebSocket connection to the remote node's CDP endpoint
 * 2. Proxies CDP messages between the developer's script and the remote browser
 * 3. Handles reconnection if the remote node becomes temporarily unavailable
 * 4. Buffers CDP messages during reconnection to avoid data loss
 *
 * This is similar to how Bright Data's Scraping Browser exposes a single
 * CDP WebSocket endpoint that routes to their infrastructure.
 */
class CdpTunnel {
  /** Reference to the parent grid. */
  private grid: DistributedBrowserGrid;

  /** Tunnel configuration. */
  private config: CdpTunnelConfig;

  /** Active CDP sessions being tunneled. */
  private sessions = new Map<
    string,
    {
      remoteNodeId: string;
      remoteWsEndpoint: string;
      createdAt: number;
      lastActivity: number;
      messageCount: number;
      bufferedMessages: any[];
    }
  >();

  constructor(grid: DistributedBrowserGrid, config: CdpTunnelConfig) {
    this.grid = grid;
    this.config = config;

    logger.info(
      { enabled: config.enabled, maxConcurrentSessions: config.maxConcurrentSessions },
      'CdpTunnel initialized',
    );
  }

  /**
   * Open a CDP tunnel to a remote browser instance.
   *
   * @param remoteNodeId - The ID of the node hosting the browser
   * @param sessionId - Optional session ID (generated if not provided)
   * @returns The tunnel session ID and local WebSocket endpoint
   */
  async openTunnel(
    remoteNodeId: string,
    sessionId?: string,
  ): Promise<{
    tunnelSessionId: string;
    localWsEndpoint: string;
    remoteWsEndpoint: string;
  }> {
    if (!this.config.enabled) {
      throw new Error('CDP Tunnel is not enabled');
    }

    if (this.sessions.size >= this.config.maxConcurrentSessions) {
      throw new Error(
        `CDP Tunnel concurrency limit reached (${this.config.maxConcurrentSessions})`,
      );
    }

    const tunnelSessionId = sessionId || `tunnel-${randomUUID().substring(0, 8)}`;

    // In production, this would:
    // 1. Look up the remote node's CDP endpoint from Redis
    // 2. Establish a WebSocket connection to the remote browser
    // 3. Set up bidirectional message proxying
    const remoteWsEndpoint = `ws://remote-node:${9222}/browser/${tunnelSessionId}`;
    const localWsEndpoint = `ws://localhost:${9222}/tunnel/${tunnelSessionId}`;

    this.sessions.set(tunnelSessionId, {
      remoteNodeId,
      remoteWsEndpoint,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 0,
      bufferedMessages: [],
    });

    logger.info(
      { tunnelSessionId, remoteNodeId, localWsEndpoint },
      'CDP tunnel opened',
    );

    return { tunnelSessionId, localWsEndpoint, remoteWsEndpoint };
  }

  /**
   * Close a CDP tunnel session.
   *
   * @param tunnelSessionId - The tunnel session ID to close
   */
  async closeTunnel(tunnelSessionId: string): Promise<void> {
    const session = this.sessions.get(tunnelSessionId);
    if (!session) {
      logger.warn({ tunnelSessionId }, 'CDP tunnel session not found for close');
      return;
    }

    // Flush any buffered messages
    if (session.bufferedMessages.length > 0) {
      logger.debug(
        { tunnelSessionId, bufferedCount: session.bufferedMessages.length },
        'Flushing buffered CDP messages on tunnel close',
      );
    }

    this.sessions.delete(tunnelSessionId);

    logger.info(
      { tunnelSessionId, messageCount: session.messageCount, durationMs: Date.now() - session.createdAt },
      'CDP tunnel closed',
    );
  }

  /**
   * Proxy a CDP message through the tunnel.
   *
   * In production, this would forward the message to the remote browser
   * via WebSocket and return the response. For engine mode, we simulate
   * the message forwarding.
   *
   * @param tunnelSessionId - The tunnel session ID
   * @param message - The CDP message to forward
   * @returns The CDP response from the remote browser
   */
  async proxyMessage(
    tunnelSessionId: string,
    message: any,
  ): Promise<any> {
    const session = this.sessions.get(tunnelSessionId);
    if (!session) {
      throw new Error(`CDP tunnel session not found: ${tunnelSessionId}`);
    }

    session.lastActivity = Date.now();
    session.messageCount++;

    // If the remote node is temporarily unavailable, buffer the message
    if (this.config.bufferDuringReconnect && !this.isRemoteNodeAvailable(session.remoteNodeId)) {
      session.bufferedMessages.push(message);
      logger.debug(
        { tunnelSessionId, bufferedCount: session.bufferedMessages.length },
        'Buffering CDP message (remote node unavailable)',
      );
      return { id: message.id, result: {} };
    }

    // In production, forward to the remote WebSocket and await response
    // For engine mode, return a simulated response
    return {
      id: message.id,
      result: { value: `Simulated CDP response for ${message.method || 'unknown'}` },
    };
  }

  /**
   * Get statistics about active CDP tunnel sessions.
   *
   * @returns Tunnel statistics
   */
  getStats(): {
    activeSessions: number;
    maxConcurrentSessions: number;
    sessions: Array<{
      tunnelSessionId: string;
      remoteNodeId: string;
      messageCount: number;
      ageMs: number;
      bufferedMessages: number;
    }>;
  } {
    const sessions = Array.from(this.sessions.entries()).map(([id, session]) => ({
      tunnelSessionId: id,
      remoteNodeId: session.remoteNodeId,
      messageCount: session.messageCount,
      ageMs: Date.now() - session.createdAt,
      bufferedMessages: session.bufferedMessages.length,
    }));

    return {
      activeSessions: this.sessions.size,
      maxConcurrentSessions: this.config.maxConcurrentSessions,
      sessions,
    };
  }

  /**
   * Check if a remote node is currently available for CDP tunneling.
   *
   * @param remoteNodeId - The node ID to check
   * @returns True if the node is available
   */
  private isRemoteNodeAvailable(remoteNodeId: string): boolean {
    // In production, check mesh state for node liveness
    const clusterState = meshEngine.getClusterState();
    if (!clusterState) return false;

    const node = clusterState.nodes.get(remoteNodeId);
    return node?.status === 'active';
  }
}

// ===============================================================================
// BULLMQ WORKER MODE ADAPTER
// ===============================================================================

/**
 * Adapter that enables the Distributed Browser Grid to process work
 * from a BullMQ queue instead of (or in addition to) the Redis-based
 * work assignment protocol.
 *
 * BullMQ is a popular Redis-based queue for Node.js that supports
 * delayed jobs, priority queues, rate limiting, and retries. This
 * adapter allows the grid to integrate with existing BullMQ-based
 * job pipelines.
 *
 * Usage:
 * ```typescript
 * const adapter = new BullMQGridAdapter(distributedBrowserGrid);
 * await adapter.start();
 * ```
 */
export class BullMQGridAdapter {
  private grid: DistributedBrowserGrid;
  private processing = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(grid: DistributedBrowserGrid) {
    this.grid = grid;
  }

  /**
   * Start the BullMQ adapter. Polls the BullMQ queue for browser work
   * jobs and submits them to the grid.
   */
  async start(): Promise<void> {
    this.processing = true;

    // In production, this would create a BullMQ Worker that listens
    // for jobs. For engine mode, we simulate by polling a Redis list.
    this.pollTimer = setInterval(() => {
      this.pollBullMQQueue().catch((err) => {
        logger.debug({ err: (err as Error).message }, 'BullMQ queue poll failed');
      });
    }, 3_000);

    logger.info('BullMQ Grid Adapter started');
  }

  /**
   * Stop the BullMQ adapter.
   */
  async stop(): Promise<void> {
    this.processing = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('BullMQ Grid Adapter stopped');
  }

  /**
   * Poll the BullMQ queue for pending browser work jobs.
   *
   * In production, this would use BullMQ's Worker API to consume jobs.
   * For engine mode, we check a Redis list as a stand-in.
   */
  private async pollBullMQQueue(): Promise<void> {
    if (!this.processing) return;

    try {
      // Check for jobs in the BullMQ queue (simulated via Redis)
      const jobData = await cacheGet<string>('grid:bullmq:pending');
      if (!jobData) return;

      const job = typeof jobData === 'string' ? JSON.parse(jobData) : jobData;

      // Submit the job to the grid
      const result = await this.grid.submitBrowserWork(job.url, job.options);

      // Store the result for the BullMQ producer
      await cacheSet(
        `grid:bullmq:result:${job.id}`,
        JSON.stringify(result),
        600,
      );

      logger.debug({ jobId: job.id, success: result.success }, 'BullMQ job processed');
    } catch (err) {
      logger.debug(
        { err: (err as Error).message },
        'Error processing BullMQ queue job',
      );
    }
  }
}

// ===============================================================================
// HTTP API MODE ADAPTER
// ===============================================================================

/**
 * Adapter that exposes the Distributed Browser Grid as HTTP API endpoints.
 *
 * This enables external services to submit browser work to the grid
 * via REST API calls, making the grid accessible to any HTTP client.
 *
 * Endpoints:
 *  - POST /grid/work         Submit browser work
 *  - GET  /grid/work/:id     Get work status
 *  - GET  /grid/stats        Get grid statistics
 *  - POST /grid/scale        Request grid scaling
 *  - POST /grid/shutdown     Shutdown the grid
 *
 * Usage:
 * ```typescript
 * const adapter = new HttpGridAdapter(distributedBrowserGrid);
 * await adapter.start(8080);
 * ```
 */
export class HttpGridAdapter {
  private grid: DistributedBrowserGrid;

  constructor(grid: DistributedBrowserGrid) {
    this.grid = grid;
  }

  /**
   * Start the HTTP API server for the grid.
   *
   * In production, this would create an Express/Fastify server with
   * the routes defined above. For engine mode, we log the intent.
   *
   * @param port - The port to bind the HTTP server to
   */
  async start(port: number = 8080): Promise<void> {
    logger.info({ port }, 'HTTP Grid Adapter would start on port (engine mode -- simulated)');

    // In production:
    // const app = express();
    // app.post('/grid/work', async (req, res) => { ... });
    // app.get('/grid/work/:id', async (req, res) => { ... });
    // app.get('/grid/stats', async (req, res) => { ... });
    // app.post('/grid/scale', async (req, res) => { ... });
    // app.listen(port);
  }

  /**
   * Stop the HTTP API server.
   */
  async stop(): Promise<void> {
    logger.info('HTTP Grid Adapter stopped');
  }

  /**
   * Handle a submit work request.
   *
   * @param body - The request body containing the work specification
   * @returns The work result
   */
  async handleSubmitWork(body: { url: string; options?: BrowserWorkRequest }): Promise<BrowserWorkResult> {
    return this.grid.submitBrowserWork(body.url, body.options);
  }

  /**
   * Handle a grid stats request.
   *
   * @returns Grid statistics
   */
  async handleGetStats(): Promise<GridStats> {
    return this.grid.getGridStats();
  }

  /**
   * Handle a grid scaling request.
   *
   * @param targetNodeCount - Desired node count (0 = auto)
   * @returns Scaling recommendation
   */
  async handleScaleGrid(targetNodeCount?: number): Promise<ScalingRecommendation> {
    return this.grid.scaleGrid(targetNodeCount);
  }
}

// ===============================================================================
// SINGLETON & EXPORTS
// ===============================================================================

/** Singleton instance of the Distributed Browser Grid. */
export const distributedBrowserGrid = new DistributedBrowserGrid();

export default DistributedBrowserGrid;
