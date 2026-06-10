/**
 * DCIM Manager -- ScrapeSuite Engine
 *
 * Main orchestrator for Data Center Infrastructure Management.
 * Wires together server monitoring, alerting, and capacity planning.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { v4 as uuid } from 'uuid';
import { ServerMonitor } from './server-monitor';
import { AlertManager } from './alerting';
import { CapacityPlanner } from './capacity';
import {
  Alert,
  AlertRule,
  CapacityPlan,
  CapacityReport,
  DCIMConfig,
  DCIMStats,
  ResourceUsage,
  Server,
  ServerSpecs,
  ServerStatus,
  ServerType,
} from './types';

const logger = createChildLogger('dcim:manager');

const DEFAULT_CONFIG: DCIMConfig = {
  heartbeat_interval_ms: 10000,
  alert_check_interval_ms: 30000,
  capacity_projection_days: 90,
  auto_scale_enabled: false,
  min_servers: 2,
  max_servers: 50,
};

// ---------- DCIM Manager class ------------------------------------------------

export class DCIMManager {
  private config: DCIMConfig;
  private monitor: ServerMonitor;
  private alertManager: AlertManager;
  private capacityPlanner: CapacityPlanner;
  private alertCheckInterval?: ReturnType<typeof setInterval>;
  private heartbeatCheckInterval?: ReturnType<typeof setInterval>;

  constructor(config?: Partial<DCIMConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.monitor = new ServerMonitor();
    this.alertManager = new AlertManager();
    this.capacityPlanner = new CapacityPlanner();
  }

  /** Initialize the DCIM manager and start background checks. */
  async initialize(): Promise<void> {
    await this.alertManager.initialize();
    this.startBackgroundChecks();
    logger.info({ config: this.config }, 'DCIM Manager initialized');
  }

  /** Register a new server. */
  async registerServer(server: Omit<Server, 'created_at' | 'last_heartbeat'>): Promise<Server> {
    return this.monitor.registerServer(server);
  }

  /** Record a heartbeat from a server. */
  async heartbeat(serverId: string, usage: ResourceUsage): Promise<void> {
    await this.monitor.updateHeartbeat(serverId, usage);
  }

  /** Get a server by ID. */
  async getServer(id: string): Promise<Server | null> {
    return this.monitor.getServerStatus(id);
  }

  /** List servers with optional filters. */
  async listServers(filter?: { status?: ServerStatus; type?: ServerType; datacenter?: string }): Promise<Server[]> {
    return this.monitor.listServers(filter);
  }

  /** Get active alerts. */
  async getAlerts(filter?: { severity?: string; server_id?: string }): Promise<Alert[]> {
    return this.alertManager.getActiveAlerts(filter as any);
  }

  /** Acknowledge an alert. */
  async acknowledgeAlert(id: string): Promise<void> {
    await this.alertManager.acknowledgeAlert(id);
  }

  /** Get the current capacity report. */
  async getCapacity(): Promise<CapacityReport> {
    const servers = await this.monitor.listServers();
    return this.capacityPlanner.getCurrentCapacity(servers);
  }

  /** Get a capacity projection. */
  async getCapacityPlan(days?: number): Promise<CapacityPlan> {
    const servers = await this.monitor.listServers();
    return this.capacityPlanner.projectCapacity(servers, days);
  }

  /** Create an alert rule. */
  async createAlertRule(rule: Omit<AlertRule, 'id'>): Promise<AlertRule> {
    return this.alertManager.createAlertRule(rule);
  }

  /** Get aggregate DCIM statistics. */
  async getStats(): Promise<DCIMStats> {
    const servers = await this.monitor.listServers();
    const alerts = await this.alertManager.getActiveAlerts();

    const byStatus: Record<ServerStatus, number> = { ONLINE: 0, OFFLINE: 0, MAINTENANCE: 0, DEGRADED: 0, PROVISIONING: 0 };
    const byType: Record<ServerType, number> = { PHYSICAL: 0, VIRTUAL: 0, CONTAINER: 0, EDGE: 0 };
    const byDatacenter: Record<string, number> = {};
    const avgUsage: ResourceUsage = { cpu_percent: 0, ram_percent: 0, disk_percent: 0, network_mbps_used: 0, active_sessions: 0, scrape_tasks_running: 0 };

    for (const server of servers) {
      byStatus[server.status] = (byStatus[server.status] ?? 0) + 1;
      byType[server.type] = (byType[server.type] ?? 0) + 1;
      byDatacenter[server.location.datacenter] = (byDatacenter[server.location.datacenter] ?? 0) + 1;

      avgUsage.cpu_percent += server.resources.cpu_percent;
      avgUsage.ram_percent += server.resources.ram_percent;
      avgUsage.disk_percent += server.resources.disk_percent;
      avgUsage.network_mbps_used += server.resources.network_mbps_used;
      avgUsage.active_sessions += server.resources.active_sessions;
      avgUsage.scrape_tasks_running += server.resources.scrape_tasks_running;
    }

    const count = servers.length || 1;
    avgUsage.cpu_percent = Math.round(avgUsage.cpu_percent / count * 100) / 100;
    avgUsage.ram_percent = Math.round(avgUsage.ram_percent / count * 100) / 100;
    avgUsage.disk_percent = Math.round(avgUsage.disk_percent / count * 100) / 100;
    avgUsage.network_mbps_used = Math.round(avgUsage.network_mbps_used / count * 100) / 100;
    avgUsage.active_sessions = Math.round(avgUsage.active_sessions / count);
    avgUsage.scrape_tasks_running = Math.round(avgUsage.scrape_tasks_running / count);

    return {
      total_servers: servers.length,
      by_status: byStatus,
      by_type: byType,
      by_datacenter: byDatacenter,
      active_alerts: alerts.length,
      avg_resource_usage: avgUsage,
      quantum_ready_servers: 0, // Placeholder
    };
  }

  /** Stop background checks. */
  shutdown(): void {
    if (this.alertCheckInterval) clearInterval(this.alertCheckInterval);
    if (this.heartbeatCheckInterval) clearInterval(this.heartbeatCheckInterval);
    logger.info('DCIM Manager shutdown');
  }

  // ---------- Background checks -----------------------------------------------

  private startBackgroundChecks(): void {
    // Periodic stale heartbeat check
    this.heartbeatCheckInterval = setInterval(async () => {
      try {
        await this.monitor.checkStaleHeartbeats();
      } catch (err: any) {
        logger.error({ err: err.message }, 'Heartbeat check failed');
      }
    }, this.config.heartbeat_interval_ms);

    // Periodic alert evaluation
    this.alertCheckInterval = setInterval(async () => {
      try {
        const servers = await this.monitor.listServers();
        await this.alertManager.evaluateRules(servers);
      } catch (err: any) {
        logger.error({ err: err.message }, 'Alert evaluation failed');
      }
    }, this.config.alert_check_interval_ms);

    logger.info('Background checks started');
  }
}

// ---------- Singleton export --------------------------------------------------

export const dcimManager = new DCIMManager();
