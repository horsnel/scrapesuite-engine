/**
 * DCIM Integration Types -- ScrapeSuite Engine
 *
 * Type definitions for Data Center Infrastructure Management integration
 * including server monitoring, alerting, and capacity planning.
 */

/** Server deployment type. */
export type ServerType = 'PHYSICAL' | 'VIRTUAL' | 'CONTAINER' | 'EDGE';

/** Server operational status. */
export type ServerStatus = 'ONLINE' | 'OFFLINE' | 'MAINTENANCE' | 'DEGRADED' | 'PROVISIONING';

/** Alert severity level. */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/** Risk level for capacity planning. */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Hardware specifications of a server. */
export interface ServerSpecs {
  cpu_cores: number;
  ram_gb: number;
  disk_gb: number;
  network_mbps: number;
  gpu_count: number;
}

/** Current resource usage metrics. */
export interface ResourceUsage {
  cpu_percent: number;
  ram_percent: number;
  disk_percent: number;
  network_mbps_used: number;
  active_sessions: number;
  scrape_tasks_running: number;
}

/** Physical location of a server. */
export interface ServerLocation {
  rack: string;
  row: string;
  room: string;
  datacenter: string;
}

/** A managed server instance. */
export interface Server {
  id: string;
  name: string;
  type: ServerType;
  status: ServerStatus;
  ip_address: string;
  location: ServerLocation;
  specs: ServerSpecs;
  resources: ResourceUsage;
  tags: string[];
  created_at: number;
  last_heartbeat: number;
}

/** A data center facility. */
export interface Datacenter {
  id: string;
  name: string;
  location: { city: string; country: string };
  provider: string;
  capacity: ServerSpecs;
  usage: ResourceUsage;
  servers: string[];
  network_zones: string[];
}

/** A triggered alert. */
export interface Alert {
  id: string;
  server_id: string;
  severity: AlertSeverity;
  message: string;
  metric_name: string;
  threshold: number;
  current_value: number;
  triggered_at: number;
  acknowledged: boolean;
  resolved_at: number | null;
}

/** An alert rule definition. */
export interface AlertRule {
  id: string;
  name: string;
  metric_name: string;
  condition: 'gt' | 'lt' | 'eq';
  threshold: number;
  severity: AlertSeverity;
  cooldown_minutes: number;
  enabled: boolean;
}

/** Capacity plan with projections. */
export interface CapacityPlan {
  current_usage: ResourceUsage;
  projected_usage_30d: ResourceUsage;
  projected_usage_60d: ResourceUsage;
  projected_usage_90d: ResourceUsage;
  recommendations: string[];
  risk_level: RiskLevel;
  growth_rate_percent_per_month: number;
}

/** Configuration for the DCIM module. */
export interface DCIMConfig {
  heartbeat_interval_ms: number;
  alert_check_interval_ms: number;
  capacity_projection_days: number;
  auto_scale_enabled: boolean;
  min_servers: number;
  max_servers: number;
}

/** A metric data point. */
export interface MetricPoint {
  timestamp: number;
  value: number;
}

/** Impact analysis of a scaling action. */
export interface ScalingImpact {
  action: 'add' | 'remove';
  specs: ServerSpecs;
  projected_cpu_change: number;
  projected_ram_change: number;
  projected_cost_change: number;
}

/** Aggregate DCIM statistics. */
export interface DCIMStats {
  total_servers: number;
  by_status: Record<ServerStatus, number>;
  by_type: Record<ServerType, number>;
  by_datacenter: Record<string, number>;
  active_alerts: number;
  avg_resource_usage: ResourceUsage;
  quantum_ready_servers: number;
}

/** Capacity report. */
export interface CapacityReport {
  total_capacity: ServerSpecs;
  total_usage: ResourceUsage;
  utilization_percent: number;
  servers_by_status: Record<ServerStatus, number>;
}
