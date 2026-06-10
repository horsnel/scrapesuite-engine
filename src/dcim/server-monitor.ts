/**
 * Server Monitor -- ScrapeSuite Engine
 *
 * Monitors server health via heartbeats, tracks resource metrics,
 * and detects stale/offline servers.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { Server, ServerStatus, ServerType, ResourceUsage, ServerSpecs, ServerLocation, MetricPoint } from './types';

const logger = createChildLogger('dcim:server-monitor');

const SERVER_PREFIX = 'dcim:server:';
const SERVER_LIST_KEY = 'dcim:servers';
const METRICS_PREFIX = 'dcim:metrics:';
const HEARTBEAT_TIMEOUT_MS = 60000; // 60 seconds

// ---------- Server Monitor class ----------------------------------------------

export class ServerMonitor {

  /** Register a new server. */
  async registerServer(server: Omit<Server, 'created_at' | 'last_heartbeat'>): Promise<Server> {
    const fullServer: Server = {
      ...server,
      created_at: Date.now(),
      last_heartbeat: Date.now(),
      status: server.status ?? 'PROVISIONING',
    };

    await cacheSet(SERVER_PREFIX + fullServer.id, fullServer, 86400 * 7);

    // Add to server list
    const list = await cacheGet<string[]>(SERVER_LIST_KEY) ?? [];
    if (!list.includes(fullServer.id)) {
      list.push(fullServer.id);
      await cacheSet(SERVER_LIST_KEY, list, 86400 * 7);
    }

    logger.info({ id: fullServer.id, name: fullServer.name, type: fullServer.type }, 'Server registered');
    return fullServer;
  }

  /** Update a server's heartbeat with current resource usage. */
  async updateHeartbeat(serverId: string, usage: ResourceUsage): Promise<void> {
    const server = await cacheGet<Server>(SERVER_PREFIX + serverId);
    if (!server) {
      logger.warn({ serverId }, 'Heartbeat from unknown server');
      return;
    }

    server.resources = usage;
    server.last_heartbeat = Date.now();

    // Auto-detect status based on usage
    if (server.status === 'OFFLINE') {
      server.status = 'ONLINE';
    }
    if (usage.cpu_percent > 95 || usage.ram_percent > 95) {
      server.status = 'DEGRADED';
    } else if (server.status === 'DEGRADED' && usage.cpu_percent < 85 && usage.ram_percent < 85) {
      server.status = 'ONLINE';
    }

    await cacheSet(SERVER_PREFIX + serverId, server, 86400 * 7);

    // Store metrics
    await this.recordMetric(serverId, 'cpu_percent', usage.cpu_percent);
    await this.recordMetric(serverId, 'ram_percent', usage.ram_percent);
    await this.recordMetric(serverId, 'disk_percent', usage.disk_percent);
  }

  /** Get a server's current status. */
  async getServerStatus(serverId: string): Promise<Server | null> {
    return await cacheGet<Server>(SERVER_PREFIX + serverId);
  }

  /** List servers with optional filters. */
  async listServers(filter?: { status?: ServerStatus; type?: ServerType; datacenter?: string }): Promise<Server[]> {
    const list = await cacheGet<string[]>(SERVER_LIST_KEY) ?? [];
    const servers: Server[] = [];

    for (const id of list) {
      const server = await cacheGet<Server>(SERVER_PREFIX + id);
      if (server) {
        if (filter?.status && server.status !== filter.status) continue;
        if (filter?.type && server.type !== filter.type) continue;
        if (filter?.datacenter && server.location.datacenter !== filter.datacenter) continue;
        servers.push(server);
      }
    }

    return servers;
  }

  /** Decommission a server. */
  async decommissionServer(serverId: string): Promise<void> {
    const server = await cacheGet<Server>(SERVER_PREFIX + serverId);
    if (server) {
      server.status = 'OFFLINE';
      await cacheSet(SERVER_PREFIX + serverId, server, 86400 * 7);
    }

    const list = await cacheGet<string[]>(SERVER_LIST_KEY) ?? [];
    await cacheSet(SERVER_LIST_KEY, list.filter(id => id !== serverId), 86400 * 7);

    logger.info({ serverId }, 'Server decommissioned');
  }

  /** Get historical metrics for a server. */
  async getServerMetrics(serverId: string, metricName: string, periodMinutes = 60): Promise<MetricPoint[]> {
    const key = `${METRICS_PREFIX}${serverId}:${metricName}`;
    const points = await cacheGet<MetricPoint[]>(key) ?? [];
    const cutoff = Date.now() - periodMinutes * 60 * 1000;
    return points.filter(p => p.timestamp >= cutoff);
  }

  /** Check for stale heartbeats and mark servers as OFFLINE. */
  async checkStaleHeartbeats(): Promise<string[]> {
    const servers = await this.listServers();
    const staleIds: string[] = [];
    const now = Date.now();

    for (const server of servers) {
      if (server.status === 'OFFLINE' || server.status === 'MAINTENANCE') continue;

      const elapsed = now - server.last_heartbeat;
      if (elapsed > HEARTBEAT_TIMEOUT_MS) {
        server.status = 'OFFLINE';
        await cacheSet(SERVER_PREFIX + server.id, server, 86400 * 7);
        staleIds.push(server.id);
        logger.warn({ serverId: server.id, elapsed_ms: elapsed }, 'Server heartbeat stale, marking OFFLINE');
      }
    }

    return staleIds;
  }

  // ---------- Internal helpers ------------------------------------------------

  private async recordMetric(serverId: string, metricName: string, value: number): Promise<void> {
    const key = `${METRICS_PREFIX}${serverId}:${metricName}`;
    const points = await cacheGet<MetricPoint[]>(key) ?? [];
    points.push({ timestamp: Date.now(), value });

    // Keep last 1440 points (24 hours at 1-minute intervals)
    const trimmed = points.slice(-1440);
    await cacheSet(key, trimmed, 86400);
  }
}
