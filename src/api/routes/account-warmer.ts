/**
 * Account Warmer API Routes — ScrapeSuite Engine
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { accountWarmerManager } from '../../account-warmer/manager';
import { accountPoolManager } from '../../account-warmer/account-pool';
import { warmingEngine } from '../../account-warmer/warming-engine';
import type { ServiceType } from '../../account-warmer/types';

export async function accountWarmerRoutes(app: FastifyInstance): Promise<void> {

  // Initialize the account warmer
  app.post('/v1/account-warmer/initialize', async (_req, reply) => {
    await accountWarmerManager.initialize();
    return reply.send({ success: true });
  });

  // Shutdown the account warmer
  app.post('/v1/account-warmer/shutdown', async (_req, reply) => {
    await accountWarmerManager.shutdown();
    return reply.send({ success: true });
  });

  // Get warmer statistics
  app.get('/v1/account-warmer/stats', async (_req, reply) => {
    return reply.send(accountWarmerManager.getStats());
  });

  // Allocate an account for scraping
  app.post('/v1/account-warmer/allocate', async (req: FastifyRequest<{
    Body: { region?: string; service: string; requiresHighTrust?: boolean; maxSessionDuration?: number };
  }>, reply) => {
    if (!req.body || !req.body.service) return reply.status(400).send({ error: 'service is required' });

    const allocation = await accountWarmerManager.allocateAccount({
      region: req.body.region,
      service: req.body.service as ServiceType,
      requiresHighTrust: req.body.requiresHighTrust || false,
    });

    if (!allocation) return reply.status(503).send({ error: 'No eligible accounts available' });
    return reply.send(allocation);
  });

  // Release an account after a session
  app.post('/v1/account-warmer/release/:accountId', async (req: FastifyRequest<{
    Params: { accountId: string };
    Body: {
      durationMs: number;
      servicesVisited: string[];
      pagesVisited: number;
      searchesPerformed: number;
      recaptchaEncountered: boolean;
      recaptchaScore: number | null;
      flagged: boolean;
    };
  }>, reply) => {
    if (!req.body) return reply.status(400).send({ error: 'Session data is required' });
    await accountWarmerManager.releaseAccount(req.params.accountId, {
      durationMs: req.body.durationMs || 0,
      servicesVisited: (req.body.servicesVisited || []) as ServiceType[],
      pagesVisited: req.body.pagesVisited || 0,
      searchesPerformed: req.body.searchesPerformed || 0,
      recaptchaEncountered: req.body.recaptchaEncountered || false,
      recaptchaScore: req.body.recaptchaScore,
      flagged: req.body.flagged || false,
    });
    return reply.send({ success: true });
  });

  // Provision a new account
  app.post('/v1/account-warmer/provision', async (req: FastifyRequest<{
    Body: { region: string; proxyEndpointId: string; fingerprintId: string };
  }>, reply) => {
    if (!req.body || !req.body.region) return reply.status(400).send({ error: 'region is required' });
    const account = await accountWarmerManager.provisionAccount({
      region: req.body.region,
      proxyEndpointId: req.body.proxyEndpointId || `proxy-${req.body.region.toLowerCase()}`,
      fingerprintId: req.body.fingerprintId || `fp-${Date.now()}`,
    });
    return reply.send(account);
  });

  // Get all accounts
  app.get('/v1/account-warmer/accounts', async (_req, reply) => {
    return reply.send(accountPoolManager.getAllAccounts());
  });

  // Get accounts by status
  app.get('/v1/account-warmer/accounts/status/:status', async (req: FastifyRequest<{ Params: { status: string } }>, reply) => {
    const accounts = accountPoolManager.getAccountsByStatus(req.params.status as any);
    return reply.send(accounts);
  });

  // Get a specific account
  app.get('/v1/account-warmer/accounts/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const account = accountPoolManager.getAccount(req.params.id);
    if (!account) return reply.status(404).send({ error: 'Account not found' });
    return reply.send(account);
  });

  // Assess account health
  app.get('/v1/account-warmer/accounts/:id/health', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const assessment = accountWarmerManager.assessAccountHealth(req.params.id);
    if (!assessment) return reply.status(404).send({ error: 'Account not found' });
    return reply.send(assessment);
  });

  // Get full health report
  app.get('/v1/account-warmer/health-report', async (_req, reply) => {
    const report = await accountWarmerManager.getAccountHealthReport();
    return reply.send(report);
  });

  // Get warmup plan
  app.get('/v1/account-warmer/plan', async (_req, reply) => {
    return reply.send(warmingEngine.getDefaultPlan());
  });

  // Get next warmup activity for an account
  app.get('/v1/account-warmer/accounts/:id/next-activity', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const activity = accountWarmerManager.getNextWarmupActivity(req.params.id);
    if (!activity) return reply.status(404).send({ error: 'No activity available' });
    return reply.send(activity);
  });

  // Run health checks on all accounts
  app.post('/v1/account-warmer/health-check', async (_req, reply) => {
    await accountWarmerManager.runHealthChecks();
    return reply.send({ success: true });
  });

  // Get pool stats
  app.get('/v1/account-warmer/pool/stats', async (_req, reply) => {
    return reply.send(accountPoolManager.getStats());
  });
}
