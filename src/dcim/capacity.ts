/**
 * Capacity Planner -- ScrapeSuite Engine
 *
 * Plans capacity by analyzing historical resource usage trends,
 * projecting future needs, and generating scaling recommendations.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { Server, ResourceUsage, ServerSpecs, CapacityPlan, CapacityReport, RiskLevel, ScalingImpact, MetricPoint } from './types';

const logger = createChildLogger('dcim:capacity');

const CAPACITY_HISTORY_KEY = 'dcim:capacity:history';
const METRICS_PREFIX = 'dcim:metrics:';

// ---------- Capacity Planner class --------------------------------------------

export class CapacityPlanner {

  /** Get the current aggregate capacity report. */
  async getCurrentCapacity(servers: Server[]): Promise<CapacityReport> {
    const totalCapacity: ServerSpecs = { cpu_cores: 0, ram_gb: 0, disk_gb: 0, network_mbps: 0, gpu_count: 0 };
    const totalUsage: ResourceUsage = { cpu_percent: 0, ram_percent: 0, disk_percent: 0, network_mbps_used: 0, active_sessions: 0, scrape_tasks_running: 0 };
    const byStatus: Record<string, number> = { ONLINE: 0, OFFLINE: 0, MAINTENANCE: 0, DEGRADED: 0, PROVISIONING: 0 };

    for (const server of servers) {
      totalCapacity.cpu_cores += server.specs.cpu_cores;
      totalCapacity.ram_gb += server.specs.ram_gb;
      totalCapacity.disk_gb += server.specs.disk_gb;
      totalCapacity.network_mbps += server.specs.network_mbps;
      totalCapacity.gpu_count += server.specs.gpu_count;

      totalUsage.cpu_percent += server.resources.cpu_percent;
      totalUsage.ram_percent += server.resources.ram_percent;
      totalUsage.disk_percent += server.resources.disk_percent;
      totalUsage.network_mbps_used += server.resources.network_mbps_used;
      totalUsage.active_sessions += server.resources.active_sessions;
      totalUsage.scrape_tasks_running += server.resources.scrape_tasks_running;

      byStatus[server.status] = (byStatus[server.status] ?? 0) + 1;
    }

    // Average the percentages
    const count = servers.length || 1;
    totalUsage.cpu_percent = Math.round(totalUsage.cpu_percent / count * 100) / 100;
    totalUsage.ram_percent = Math.round(totalUsage.ram_percent / count * 100) / 100;
    totalUsage.disk_percent = Math.round(totalUsage.disk_percent / count * 100) / 100;

    const utilization = (totalUsage.cpu_percent + totalUsage.ram_percent) / 2;

    // Store snapshot for historical analysis
    await this.recordSnapshot(utilization, servers.length);

    return {
      total_capacity: totalCapacity,
      total_usage: totalUsage,
      utilization_percent: Math.round(utilization * 100) / 100,
      servers_by_status: byStatus as CapacityReport['servers_by_status'],
    };
  }

  /** Project capacity needs based on historical growth. */
  async projectCapacity(servers: Server[], days: number = 90): Promise<CapacityPlan> {
    const current = await this.getCurrentCapacity(servers);
    const growthRate = await this.estimateGrowthRate();

    // Simple linear projection
    const monthlyFactor = 1 + growthRate / 100;
    const dailyFactor = Math.pow(monthlyFactor, 1 / 30);

    const project = (current: number, daysAhead: number): number => {
      return Math.round(current * Math.pow(dailyFactor, daysAhead) * 100) / 100;
    };

    const projected30: ResourceUsage = {
      cpu_percent: project(current.total_usage.cpu_percent, 30),
      ram_percent: project(current.total_usage.ram_percent, 30),
      disk_percent: project(current.total_usage.disk_percent, 30),
      network_mbps_used: project(current.total_usage.network_mbps_used, 30),
      active_sessions: Math.round(project(current.total_usage.active_sessions, 30)),
      scrape_tasks_running: Math.round(project(current.total_usage.scrape_tasks_running, 30)),
    };

    const projected60: ResourceUsage = {
      cpu_percent: project(current.total_usage.cpu_percent, 60),
      ram_percent: project(current.total_usage.ram_percent, 60),
      disk_percent: project(current.total_usage.disk_percent, 60),
      network_mbps_used: project(current.total_usage.network_mbps_used, 60),
      active_sessions: Math.round(project(current.total_usage.active_sessions, 60)),
      scrape_tasks_running: Math.round(project(current.total_usage.scrape_tasks_running, 60)),
    };

    const projected90: ResourceUsage = {
      cpu_percent: project(current.total_usage.cpu_percent, 90),
      ram_percent: project(current.total_usage.ram_percent, 90),
      disk_percent: project(current.total_usage.disk_percent, 90),
      network_mbps_used: project(current.total_usage.network_mbps_used, 90),
      active_sessions: Math.round(project(current.total_usage.active_sessions, 90)),
      scrape_tasks_running: Math.round(project(current.total_usage.scrape_tasks_running, 90)),
    };

    // Determine risk level
    const riskLevel = this.assessRisk(projected90);

    // Generate recommendations
    const recommendations = this.generateRecommendations(current.total_usage, projected90, growthRate, servers.length);

    return {
      current_usage: current.total_usage,
      projected_usage_30d: projected30,
      projected_usage_60d: projected60,
      projected_usage_90d: projected90,
      recommendations,
      risk_level: riskLevel,
      growth_rate_percent_per_month: growthRate,
    };
  }

  /** Calculate the impact of adding or removing a server. */
  calculateScaling(action: 'add' | 'remove', specs: ServerSpecs, currentServers: Server[]): ScalingImpact {
    const currentCpuTotal = currentServers.reduce((sum, s) => sum + s.specs.cpu_cores, 0);
    const currentRamTotal = currentServers.reduce((sum, s) => sum + s.specs.ram_gb, 0);

    const newCpuTotal = action === 'add' ? currentCpuTotal + specs.cpu_cores : currentCpuTotal - specs.cpu_cores;
    const newRamTotal = action === 'add' ? currentRamTotal + specs.ram_gb : currentRamTotal - specs.ram_gb;

    const cpuChange = currentCpuTotal > 0 ? ((newCpuTotal - currentCpuTotal) / currentCpuTotal) * 100 : 0;
    const ramChange = currentRamTotal > 0 ? ((newRamTotal - currentRamTotal) / currentRamTotal) * 100 : 0;

    const estimatedCostPerServer = 200; // USD/month estimate
    const costChange = action === 'add' ? estimatedCostPerServer : -estimatedCostPerServer;

    return {
      action,
      specs,
      projected_cpu_change: Math.round(cpuChange * 100) / 100,
      projected_ram_change: Math.round(ramChange * 100) / 100,
      projected_cost_change: costChange,
    };
  }

  /** Check if auto-scaling is needed. */
  async isAutoScaleNeeded(servers: Server[]): Promise<{
    scale_up: boolean;
    scale_down: boolean;
    recommended_count: number;
  }> {
    const current = await this.getCurrentCapacity(servers);

    const scaleUp = current.total_usage.cpu_percent > 80 || current.total_usage.ram_percent > 80;
    const scaleDown = current.total_usage.cpu_percent < 30 && current.total_usage.ram_percent < 30;

    let recommendedCount = servers.length;
    if (scaleUp) {
      // Estimate how many more servers needed
      const overloadedPercent = Math.max(current.total_usage.cpu_percent, current.total_usage.ram_percent);
      const targetUtil = 60;
      recommendedCount = Math.ceil(servers.length * (overloadedPercent / targetUtil));
    } else if (scaleDown) {
      const underloadedPercent = Math.min(current.total_usage.cpu_percent, current.total_usage.ram_percent);
      recommendedCount = Math.max(2, Math.ceil(servers.length * (underloadedPercent / 50)));
    }

    return { scale_up: scaleUp, scale_down: scaleDown, recommended_count: recommendedCount };
  }

  /** Get per-server resource efficiency scores. */
  async getResourceEfficiency(servers: Server[]): Promise<Record<string, number>> {
    const efficiency: Record<string, number> = {};

    for (const server of servers) {
      if (server.status !== 'ONLINE') {
        efficiency[server.id] = 0;
        continue;
      }
      // Efficiency = sessions per CPU core (higher = more efficient use)
      const sessionsPerCore = server.specs.cpu_cores > 0
        ? server.resources.active_sessions / server.specs.cpu_cores
        : 0;
      const utilizationScore = (server.resources.cpu_percent + server.resources.ram_percent) / 200;
      // Balanced: good utilization without being overloaded
      const balancePenalty = server.resources.cpu_percent > 90 ? 0.5 : 1;
      efficiency[server.id] = Math.round(sessionsPerCore * utilizationScore * balancePenalty * 100) / 100;
    }

    return efficiency;
  }

  // ---------- Internal helpers ------------------------------------------------

  private async estimateGrowthRate(): Promise<number> {
    const history = await cacheGet<{ timestamp: number; utilization: number; server_count: number }[]>(CAPACITY_HISTORY_KEY) ?? [];
    if (history.length < 2) return 5; // Default 5% monthly growth

    // Simple linear regression on utilization
    const n = history.length;
    const xMean = history.reduce((s, h) => s + h.timestamp, 0) / n;
    const yMean = history.reduce((s, h) => s + h.utilization, 0) / n;

    let num = 0;
    let den = 0;
    for (const h of history) {
      num += (h.timestamp - xMean) * (h.utilization - yMean);
      den += (h.timestamp - xMean) ** 2;
    }

    if (den === 0) return 5;

    const slope = num / den; // utilization change per millisecond
    const msPerMonth = 30 * 24 * 3600 * 1000;
    const monthlyChange = slope * msPerMonth;

    // Convert to percentage growth
    return yMean > 0 ? Math.round(Math.abs(monthlyChange / yMean * 100) * 100) / 100 : 5;
  }

  private async recordSnapshot(utilization: number, serverCount: number): Promise<void> {
    const history = await cacheGet<{ timestamp: number; utilization: number; server_count: number }[]>(CAPACITY_HISTORY_KEY) ?? [];
    history.push({ timestamp: Date.now(), utilization, server_count: serverCount });

    // Keep last 30 days of snapshots (assuming ~1 per minute)
    const trimmed = history.slice(-43200);
    await cacheSet(CAPACITY_HISTORY_KEY, trimmed, 86400 * 30);
  }

  private assessRisk(projected90: ResourceUsage): RiskLevel {
    const maxUtil = Math.max(projected90.cpu_percent, projected90.ram_percent);
    if (maxUtil > 95) return 'critical';
    if (maxUtil > 80) return 'high';
    if (maxUtil > 60) return 'medium';
    return 'low';
  }

  private generateRecommendations(current: ResourceUsage, projected: ResourceUsage, growthRate: number, serverCount: number): string[] {
    const recommendations: string[] = [];

    if (projected.cpu_percent > 80) {
      const needed = Math.ceil(serverCount * projected.cpu_percent / 60) - serverCount;
      recommendations.push(`Add ${needed} servers within 90 days to handle projected CPU load of ${projected.cpu_percent}%`);
    }

    if (projected.ram_percent > 80) {
      recommendations.push(`Plan for RAM expansion — projected usage at ${projected.ram_percent}% in 90 days`);
    }

    if (projected.disk_percent > 70) {
      recommendations.push(`Disk usage growing — projected at ${projected.disk_percent}% in 90 days. Consider adding storage.`);
    }

    if (current.cpu_percent < 30 && current.ram_percent < 30) {
      recommendations.push('Current utilization is low — consider scaling down to reduce costs');
    }

    if (growthRate > 20) {
      recommendations.push(`High growth rate detected (${growthRate}%/month) — plan capacity early`);
    }

    if (recommendations.length === 0) {
      recommendations.push('Capacity is well-provisioned for projected demand');
    }

    return recommendations;
  }
}
