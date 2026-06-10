/**
 * Akamai Updater API Routes — ScrapeSuite Engine
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { akamaiUpdaterManager } from '../../akamai-updater/manager';
import { formatMonitor } from '../../akamai-updater/format-monitor';
import { autoPatcher } from '../../akamai-updater/auto-patcher';
import type { SensorFormat } from '../../akamai-updater/types';

interface FormatBody {
  id: string;
  version: string;
  scriptHash: string;
  pixelUrl: string;
  [key: string]: any;
}

interface EndpointBody {
  url: string;
  domain: string;
  checkInterval?: number;
}

export async function akamaiUpdaterRoutes(app: FastifyInstance): Promise<void> {

  // Initialize the updater
  app.post('/v1/akamai-updater/initialize', async (_req, reply) => {
    await akamaiUpdaterManager.initialize();
    return reply.send({ success: true, status: akamaiUpdaterManager.getStatus() });
  });

  // Shutdown the updater
  app.post('/v1/akamai-updater/shutdown', async (_req, reply) => {
    await akamaiUpdaterManager.shutdown();
    return reply.send({ success: true });
  });

  // Get updater status
  app.get('/v1/akamai-updater/status', async (_req, reply) => {
    return reply.send(akamaiUpdaterManager.getStatus());
  });

  // Get updater statistics
  app.get('/v1/akamai-updater/stats', async (_req, reply) => {
    return reply.send(akamaiUpdaterManager.getStats());
  });

  // Manually trigger a check
  app.post('/v1/akamai-updater/check', async (_req, reply) => {
    const changes = await akamaiUpdaterManager.checkNow();
    return reply.send({ changesDetected: changes.length, changes });
  });

  // Register a known format
  app.post('/v1/akamai-updater/formats', async (req: FastifyRequest<{ Body: FormatBody }>, reply) => {
    const body = req.body;
    if (!body || !body.id) return reply.status(400).send({ error: 'Format id is required' });
    await akamaiUpdaterManager.registerFormat(body as SensorFormat);
    return reply.send({ success: true });
  });

  // Get known formats
  app.get('/v1/akamai-updater/formats', async (_req, reply) => {
    return reply.send(formatMonitor.getKnownFormats());
  });

  // Get recent changes
  app.get('/v1/akamai-updater/changes', async (req: FastifyRequest<{ Querystring: { limit?: string } }>, reply) => {
    const limit = parseInt(req.query.limit || '20', 10);
    return reply.send(formatMonitor.getRecentChanges(limit));
  });

  // Get patches
  app.get('/v1/akamai-updater/patches', async (req: FastifyRequest<{ Querystring: { status?: string } }>, reply) => {
    const patches = autoPatcher.getPatches(req.query.status as any);
    return reply.send(patches);
  });

  // Get a specific patch
  app.get('/v1/akamai-updater/patches/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const patch = autoPatcher.getPatch(req.params.id);
    if (!patch) return reply.status(404).send({ error: 'Patch not found' });
    return reply.send(patch);
  });

  // Approve a patch for deployment
  app.post('/v1/akamai-updater/patches/:id/approve', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const success = await autoPatcher.approvePatch(req.params.id);
    if (!success) return reply.status(400).send({ error: 'Cannot approve patch' });
    return reply.send({ success: true });
  });

  // Rollback a patch
  app.post('/v1/akamai-updater/patches/:id/rollback', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const success = await autoPatcher.rollbackPatch(req.params.id);
    if (!success) return reply.status(400).send({ error: 'Cannot rollback patch' });
    return reply.send({ success: true });
  });

  // Add a monitoring endpoint
  app.post('/v1/akamai-updater/endpoints', async (req: FastifyRequest<{ Body: EndpointBody }>, reply) => {
    const body = req.body;
    if (!body || !body.url || !body.domain) {
      return reply.status(400).send({ error: 'url and domain are required' });
    }
    formatMonitor.addEndpoint({
      url: body.url,
      domain: body.domain,
      checkInterval: body.checkInterval || 300000,
      lastChecked: 0,
      lastKnownHash: '',
      stableCheckCount: 0,
      active: true,
    });
    return reply.send({ success: true });
  });

  // Get monitor stats
  app.get('/v1/akamai-updater/monitor/stats', async (_req, reply) => {
    return reply.send(formatMonitor.getStats());
  });
}
