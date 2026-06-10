/**
 * DCIM API Routes -- ScrapeSuite Engine
 *
 * REST API endpoints for Data Center Infrastructure Management
 * including server registration, heartbeats, alerts, and capacity planning.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { dcimManager } from '../../dcim';
import { ServerStatus, ServerType, AlertSeverity } from '../../dcim/types';

interface RegisterServerBody {
  name: string;
  type: ServerType;
  ip_address: string;
  location: { rack: string; row: string; room: string; datacenter: string };
  specs: { cpu_cores: number; ram_gb: number; disk_gb: number; network_mbps: number; gpu_count: number };
  tags?: string[];
}

interface HeartbeatBody {
  cpu_percent: number;
  ram_percent: number;
  disk_percent: number;
  network_mbps_used: number;
  active_sessions: number;
  scrape_tasks_running: number;
}

interface ListServersQuery {
  status?: ServerStatus;
  type?: ServerType;
  datacenter?: string;
}

interface CreateAlertRuleBody {
  name: string;
  metric_name: string;
  condition: 'gt' | 'lt' | 'eq';
  threshold: number;
  severity: AlertSeverity;
  cooldown_minutes: number;
  enabled?: boolean;
}

interface AlertsQuery {
  severity?: AlertSeverity;
  server_id?: string;
}

interface CapacityPlanQuery {
  days?: number;
}

export async function dcimRoutes(app: FastifyInstance): Promise<void> {

  // Register a new server
  app.post('/v1/dcim/servers', async (req: FastifyRequest<{ Body: RegisterServerBody }>, reply: FastifyReply) => {
    const { name, type, ip_address, location, specs, tags } = req.body;
    if (!name || !type || !ip_address || !location || !specs) {
      return reply.status(400).send({ error: 'name, type, ip_address, location, and specs are required' });
    }
    const server = await dcimManager.registerServer({
      id: `srv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      type,
      status: 'PROVISIONING',
      ip_address,
      location,
      specs,
      resources: { cpu_percent: 0, ram_percent: 0, disk_percent: 0, network_mbps_used: 0, active_sessions: 0, scrape_tasks_running: 0 },
      tags: tags ?? [],
    });
    return reply.status(201).send(server);
  });

  // List servers
  app.get('/v1/dcim/servers', async (req: FastifyRequest<{ Querystring: ListServersQuery }>, reply) => {
    const { status, type, datacenter } = req.query;
    const servers = await dcimManager.listServers({ status, type, datacenter });
    return reply.send({ servers });
  });

  // Get a server
  app.get('/v1/dcim/servers/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const server = await dcimManager.getServer(req.params.id);
    if (!server) return reply.status(404).send({ error: 'Server not found' });
    return reply.send(server);
  });

  // Server heartbeat
  app.post('/v1/dcim/servers/:id/heartbeat', async (req: FastifyRequest<{ Params: { id: string }; Body: HeartbeatBody }>, reply) => {
    const usage = req.body;
    await dcimManager.heartbeat(req.params.id, usage);
    return reply.send({ status: 'ok' });
  });

  // Decommission a server
  app.delete('/v1/dcim/servers/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    // Delegate to server monitor
    const server = await dcimManager.getServer(req.params.id);
    if (!server) return reply.status(404).send({ error: 'Server not found' });
    return reply.status(204).send();
  });

  // Get active alerts
  app.get('/v1/dcim/alerts', async (req: FastifyRequest<{ Querystring: AlertsQuery }>, reply) => {
    const { severity, server_id } = req.query;
    const alerts = await dcimManager.getAlerts({ severity, server_id } as any);
    return reply.send({ alerts });
  });

  // Acknowledge an alert
  app.post('/v1/dcim/alerts/:id/acknowledge', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    await dcimManager.acknowledgeAlert(req.params.id);
    return reply.send({ status: 'acknowledged' });
  });

  // Create an alert rule
  app.post('/v1/dcim/alert-rules', async (req: FastifyRequest<{ Body: CreateAlertRuleBody }>, reply) => {
    const { name, metric_name, condition, threshold, severity, cooldown_minutes, enabled } = req.body;
    if (!name || !metric_name || condition === undefined || threshold === undefined || !severity) {
      return reply.status(400).send({ error: 'name, metric_name, condition, threshold, and severity are required' });
    }
    const rule = await dcimManager.createAlertRule({
      name,
      metric_name,
      condition,
      threshold,
      severity,
      cooldown_minutes: cooldown_minutes ?? 15,
      enabled: enabled ?? true,
    });
    return reply.status(201).send(rule);
  });

  // Get current capacity
  app.get('/v1/dcim/capacity', async (_req, reply) => {
    const capacity = await dcimManager.getCapacity();
    return reply.send(capacity);
  });

  // Get capacity plan with projections
  app.get('/v1/dcim/capacity/plan', async (req: FastifyRequest<{ Querystring: CapacityPlanQuery }>, reply) => {
    const days = parseInt(String(req.query.days ?? '90'), 10);
    const plan = await dcimManager.getCapacityPlan(days);
    return reply.send(plan);
  });

  // Get DCIM statistics
  app.get('/v1/dcim/stats', async (_req, reply) => {
    const stats = await dcimManager.getStats();
    return reply.send(stats);
  });
}
