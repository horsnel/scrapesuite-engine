/**
 * Infrastructure API Routes — ScrapeSuite Engine
 *
 * REST API endpoints for the infrastructure layer including
 * proxy farm management, IP reputation, browser farm, session farm,
 * and mobile emulation.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { infrastructureManager, proxyFarmManager, ipReputationManager, browserFarmManager, sessionFarmManager, mobileEmulationManager } from '../../infrastructure';
import type { ProxyTier, ProxyProvider } from '../../infrastructure/types';

interface AllocateProxyBody {
  domain?: string;
  tier?: ProxyTier;
  country_code?: string;
  city?: string;
  sticky_session?: boolean;
  min_reputation?: number;
  max_response_ms?: number;
  max_cost_per_gb?: number;
}

interface ReleaseProxyBody {
  allocation_id: string;
  success: boolean;
  response_ms?: number;
}

interface FlagProxyBody {
  proxy_id: string;
  domain: string;
  reason: string;
}

interface CreateSessionBody {
  domain: string;
  type?: 'anonymous' | 'authenticated' | 'premium';
  proxy_id?: string;
  browser_instance_id?: string;
  fingerprint_id?: string;
}

interface AllocateBrowserBody {
  browser_type?: 'chromium' | 'firefox' | 'webkit';
  stealth_level?: 'basic' | 'light' | 'medium' | 'high' | 'maximum';
  domain?: string;
  country_code?: string;
}

interface PrepareNetflixBody {
  country_code?: string;
}

interface PrepareGoogleBody {
  country_code?: string;
}

export async function infrastructureRoutes(app: FastifyInstance): Promise<void> {

  // --- Infrastructure Overview ---
  app.get('/v1/infrastructure/stats', async (_req, reply) => {
    const stats = await infrastructureManager.getStats();
    return reply.send(stats);
  });

  app.post('/v1/infrastructure/initialize', async (_req, reply) => {
    await infrastructureManager.initialize();
    return reply.send({ status: 'initialized' });
  });

  // --- Proxy Farm ---
  app.get('/v1/infrastructure/proxy/stats', async (_req, reply) => {
    return reply.send(proxyFarmManager.getStats());
  });

  app.post('/v1/infrastructure/proxy/allocate', async (req: FastifyRequest<{ Body: AllocateProxyBody }>, reply) => {
    const { domain, tier, country_code, city, sticky_session, min_reputation, max_response_ms, max_cost_per_gb } = req.body;
    const result = await proxyFarmManager.allocateProxy({
      domain,
      tier,
      countryCode: country_code,
      city,
      stickySession: sticky_session,
      minReputation: min_reputation,
      maxResponseMs: max_response_ms,
      maxCostPerGb: max_cost_per_gb,
    });
    if (!result) return reply.status(503).send({ error: 'No suitable proxy available' });
    return reply.send(result);
  });

  app.post('/v1/infrastructure/proxy/release', async (req: FastifyRequest<{ Body: ReleaseProxyBody }>, reply) => {
    const { allocation_id, success, response_ms } = req.body;
    if (!allocation_id) return reply.status(400).send({ error: 'allocation_id is required' });
    await proxyFarmManager.releaseProxy(allocation_id, success, response_ms);
    return reply.send({ released: true });
  });

  app.post('/v1/infrastructure/proxy/flag', async (req: FastifyRequest<{ Body: FlagProxyBody }>, reply) => {
    const { proxy_id, domain, reason } = req.body;
    if (!proxy_id || !domain) return reply.status(400).send({ error: 'proxy_id and domain are required' });
    await proxyFarmManager.flagProxy(proxy_id, domain, reason);
    return reply.send({ flagged: true });
  });

  // --- IP Reputation ---
  app.get('/v1/infrastructure/reputation/report', async (_req, reply) => {
    const report = await ipReputationManager.generateReport();
    return reply.send(report);
  });

  app.get('/v1/infrastructure/reputation/:ip', async (req: FastifyRequest<{ Params: { ip: string } }>, reply) => {
    const record = await ipReputationManager.getOrCreate(req.params.ip);
    return reply.send(record);
  });

  app.post('/v1/infrastructure/reputation/:ip/success', async (req: FastifyRequest<{ Params: { ip: string }; Body: { domain: string; response_ms: number } }>, reply) => {
    const { domain, response_ms } = req.body;
    const record = await ipReputationManager.recordSuccess(req.params.ip, domain, response_ms);
    return reply.send(record);
  });

  app.post('/v1/infrastructure/reputation/:ip/block', async (req: FastifyRequest<{ Params: { ip: string }; Body: { domain: string; reason: string } }>, reply) => {
    const { domain, reason } = req.body;
    const record = await ipReputationManager.recordBlock(req.params.ip, domain, reason);
    return reply.send(record);
  });

  app.get('/v1/infrastructure/reputation/:ip/check', async (req: FastifyRequest<{ Params: { ip: string }; Querystring: { domain: string } }>, reply) => {
    const check = await ipReputationManager.canMakeRequest(req.params.ip, req.query.domain);
    return reply.send(check);
  });

  // --- Browser Farm ---
  app.get('/v1/infrastructure/browser/stats', async (_req, reply) => {
    return reply.send(browserFarmManager.getStats());
  });

  app.post('/v1/infrastructure/browser/allocate', async (req: FastifyRequest<{ Body: AllocateBrowserBody }>, reply) => {
    const { browser_type, stealth_level, domain, country_code } = req.body;
    const result = await browserFarmManager.allocateBrowser({
      browserType: browser_type,
      stealthLevel: stealth_level,
      domain,
      countryCode: country_code,
    });
    if (!result) return reply.status(503).send({ error: 'No suitable browser available' });
    return reply.send(result);
  });

  // --- Session Farm ---
  app.get('/v1/infrastructure/session/stats', async (_req, reply) => {
    return reply.send(sessionFarmManager.getStats());
  });

  app.post('/v1/infrastructure/session/create', async (req: FastifyRequest<{ Body: CreateSessionBody }>, reply) => {
    const { domain, type, proxy_id, browser_instance_id, fingerprint_id } = req.body;
    if (!domain) return reply.status(400).send({ error: 'domain is required' });
    const session = await sessionFarmManager.createSession(domain, {
      type: type as any,
      proxyId: proxy_id,
      browserInstanceId: browser_instance_id,
      fingerprintId: fingerprint_id,
    });
    return reply.send(session);
  });

  // --- Mobile Emulation ---
  app.get('/v1/infrastructure/mobile/stats', async (_req, reply) => {
    return reply.send(mobileEmulationManager.getStats());
  });

  app.post('/v1/infrastructure/mobile/profile', async (req: FastifyRequest<{ Body: { device?: string; country_code?: string } }>, reply) => {
    const profile = mobileEmulationManager.generateProfile({
      device: req.body.device as any,
      countryCode: req.body.country_code,
    });
    return reply.send(profile);
  });

  // --- High-Level Operations ---
  app.post('/v1/infrastructure/prepare/netflix', async (req: FastifyRequest<{ Body: PrepareNetflixBody }>, reply) => {
    try {
      const result = await infrastructureManager.prepareForNetflix(req.body.country_code);
      return reply.send(result);
    } catch (err: any) {
      return reply.status(503).send({ error: err.message });
    }
  });

  app.post('/v1/infrastructure/prepare/google', async (req: FastifyRequest<{ Body: PrepareGoogleBody }>, reply) => {
    try {
      const result = await infrastructureManager.prepareForGoogle(req.body.country_code);
      return reply.send(result);
    } catch (err: any) {
      return reply.status(503).send({ error: err.message });
    }
  });
}
