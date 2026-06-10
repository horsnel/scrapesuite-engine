/**
 * Alert Manager -- ScrapeSuite Engine
 *
 * Manages alert rules, evaluates them against current server metrics,
 * triggers alerts, and enforces cooldown/deduplication.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { v4 as uuid } from 'uuid';
import { Alert, AlertRule, AlertSeverity, Server } from './types';

const logger = createChildLogger('dcim:alerting');

const ALERT_RULE_PREFIX = 'dcim:alert_rule:';
const ALERT_RULE_LIST_KEY = 'dcim:alert_rules';
const ACTIVE_ALERTS_KEY = 'dcim:alerts:active';
const ALERT_HISTORY_KEY = 'dcim:alerts:history';

// ---------- Default alert rules -----------------------------------------------

const DEFAULT_RULES: Omit<AlertRule, 'id'>[] = [
  { name: 'High CPU', metric_name: 'cpu_percent', condition: 'gt', threshold: 90, severity: 'critical', cooldown_minutes: 15, enabled: true },
  { name: 'High RAM', metric_name: 'ram_percent', condition: 'gt', threshold: 85, severity: 'warning', cooldown_minutes: 15, enabled: true },
  { name: 'Disk Full', metric_name: 'disk_percent', condition: 'gt', threshold: 95, severity: 'critical', cooldown_minutes: 30, enabled: true },
  { name: 'Missed Heartbeats', metric_name: 'missed_heartbeats', condition: 'gt', threshold: 3, severity: 'critical', cooldown_minutes: 30, enabled: true },
  { name: 'Scrape Queue Backlog', metric_name: 'scrape_tasks_running', condition: 'gt', threshold: 1000, severity: 'warning', cooldown_minutes: 10, enabled: true },
  { name: 'Elevated CPU', metric_name: 'cpu_percent', condition: 'gt', threshold: 75, severity: 'info', cooldown_minutes: 30, enabled: true },
];

// ---------- Alert Manager class -----------------------------------------------

export class AlertManager {
  private initialized = false;

  /** Initialize default alert rules. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    const existing = await cacheGet<string[]>(ALERT_RULE_LIST_KEY);
    if (!existing?.length) {
      for (const rule of DEFAULT_RULES) {
        await this.createAlertRule(rule);
      }
    }
    this.initialized = true;
  }

  /** Create a new alert rule. */
  async createAlertRule(rule: Omit<AlertRule, 'id'>): Promise<AlertRule> {
    const fullRule: AlertRule = { ...rule, id: uuid() };
    await cacheSet(ALERT_RULE_PREFIX + fullRule.id, fullRule, 86400 * 30);

    const list = await cacheGet<string[]>(ALERT_RULE_LIST_KEY) ?? [];
    list.push(fullRule.id);
    await cacheSet(ALERT_RULE_LIST_KEY, list, 86400 * 30);

    logger.info({ id: fullRule.id, name: fullRule.name }, 'Alert rule created');
    return fullRule;
  }

  /** Evaluate all rules against current server metrics. */
  async evaluateRules(servers: Server[]): Promise<Alert[]> {
    await this.initialize();
    const ruleIds = await cacheGet<string[]>(ALERT_RULE_LIST_KEY) ?? [];
    const newAlerts: Alert[] = [];

    for (const ruleId of ruleIds) {
      const rule = await cacheGet<AlertRule>(ALERT_RULE_PREFIX + ruleId);
      if (!rule || !rule.enabled) continue;

      for (const server of servers) {
        const currentValue = this.getMetricValue(server, rule.metric_name);
        const triggered = this.evaluateCondition(currentValue, rule.condition, rule.threshold);

        if (triggered) {
          // Check cooldown
          const cooldownKey = `dcim:alert_cooldown:${rule.id}:${server.id}`;
          const inCooldown = await cacheGet<boolean>(cooldownKey);
          if (inCooldown) continue;

          const alert: Alert = {
            id: uuid(),
            server_id: server.id,
            severity: rule.severity,
            message: `${rule.name}: ${rule.metric_name} is ${currentValue} (threshold: ${rule.condition} ${rule.threshold}) on server ${server.name}`,
            metric_name: rule.metric_name,
            threshold: rule.threshold,
            current_value: currentValue,
            triggered_at: Date.now(),
            acknowledged: false,
            resolved_at: null,
          };

          await this.triggerAlert(alert);

          // Set cooldown
          await cacheSet(cooldownKey, true, rule.cooldown_minutes * 60);
          newAlerts.push(alert);
        }
      }
    }

    return newAlerts;
  }

  /** Trigger (store) an alert. */
  async triggerAlert(alert: Alert): Promise<void> {
    // Add to active alerts
    const active = await cacheGet<Alert[]>(ACTIVE_ALERTS_KEY) ?? [];
    // Dedup: check if same server+metric already has an active unresolved alert
    const existing = active.find(a => a.server_id === alert.server_id && a.metric_name === alert.metric_name && !a.resolved_at);
    if (existing) {
      logger.debug({ serverId: alert.server_id, metric: alert.metric_name }, 'Duplicate alert suppressed');
      return;
    }

    active.push(alert);
    await cacheSet(ACTIVE_ALERTS_KEY, active, 86400);

    // Add to history
    const history = await cacheGet<Alert[]>(ALERT_HISTORY_KEY) ?? [];
    history.push(alert);
    await cacheSet(ALERT_HISTORY_KEY, history.slice(-1000), 86400 * 30);

    logger.warn({ alertId: alert.id, severity: alert.severity, serverId: alert.server_id, message: alert.message }, 'Alert triggered');
  }

  /** Acknowledge an alert. */
  async acknowledgeAlert(alertId: string): Promise<void> {
    const active = await cacheGet<Alert[]>(ACTIVE_ALERTS_KEY) ?? [];
    const alert = active.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      await cacheSet(ACTIVE_ALERTS_KEY, active, 86400);
      logger.info({ alertId }, 'Alert acknowledged');
    }
  }

  /** Resolve an alert. */
  async resolveAlert(alertId: string): Promise<void> {
    const active = await cacheGet<Alert[]>(ACTIVE_ALERTS_KEY) ?? [];
    const alert = active.find(a => a.id === alertId);
    if (alert) {
      alert.resolved_at = Date.now();
      // Move to history and remove from active
      const remaining = active.filter(a => a.id !== alertId);
      await cacheSet(ACTIVE_ALERTS_KEY, remaining, 86400);

      const history = await cacheGet<Alert[]>(ALERT_HISTORY_KEY) ?? [];
      history.push(alert);
      await cacheSet(ALERT_HISTORY_KEY, history.slice(-1000), 86400 * 30);

      logger.info({ alertId }, 'Alert resolved');
    }
  }

  /** Get currently active alerts. */
  async getActiveAlerts(filter?: { severity?: AlertSeverity; server_id?: string }): Promise<Alert[]> {
    const active = await cacheGet<Alert[]>(ACTIVE_ALERTS_KEY) ?? [];
    return active.filter(a => {
      if (filter?.severity && a.severity !== filter.severity) return false;
      if (filter?.server_id && a.server_id !== filter.server_id) return false;
      return true;
    });
  }

  /** Get alert history for a time period. */
  async getAlertHistory(periodMinutes = 1440): Promise<Alert[]> {
    const history = await cacheGet<Alert[]>(ALERT_HISTORY_KEY) ?? [];
    const cutoff = Date.now() - periodMinutes * 60 * 1000;
    return history.filter(a => a.triggered_at >= cutoff);
  }

  // ---------- Internal helpers ------------------------------------------------

  private getMetricValue(server: Server, metricName: string): number {
    switch (metricName) {
      case 'cpu_percent': return server.resources.cpu_percent;
      case 'ram_percent': return server.resources.ram_percent;
      case 'disk_percent': return server.resources.disk_percent;
      case 'network_mbps_used': return server.resources.network_mbps_used;
      case 'active_sessions': return server.resources.active_sessions;
      case 'scrape_tasks_running': return server.resources.scrape_tasks_running;
      case 'missed_heartbeats': {
        const elapsed = Date.now() - server.last_heartbeat;
        return Math.floor(elapsed / 10000); // Approximate missed beats
      }
      default: return 0;
    }
  }

  private evaluateCondition(value: number, condition: string, threshold: number): boolean {
    switch (condition) {
      case 'gt': return value > threshold;
      case 'lt': return value < threshold;
      case 'eq': return value === threshold;
      default: return false;
    }
  }
}
