/**
 * Self-Improver API Routes — ScrapeSuite Engine
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { selfImproverManager } from '../../self-improver/manager';
import { observationCollector } from '../../self-improver/observation-collector';
import { failureAnalyzer } from '../../self-improver/failure-analyzer';
import { adaptationEngine } from '../../self-improver/adaptation-engine';
import type { Outcome, AntiBotPlatform, ScrapingContext, ResponseDetails, AppliedStrategy } from '../../self-improver/types';

interface ObserveBody {
  url: string;
  domain: string;
  outcome: Outcome;
  detectedPlatform?: AntiBotPlatform;
  strategiesApplied?: AppliedStrategy[];
  context?: ScrapingContext;
  response?: ResponseDetails;
  durationMs?: number;
}

interface QuickObserveBody {
  url: string;
  domain: string;
  outcome: Outcome;
  platform?: AntiBotPlatform;
  proxyTier?: string;
  tlsProfile?: string;
  statusCode?: number;
  captchaPresent?: boolean;
  errorMessage?: string;
  durationMs?: number;
}

export async function selfImproverRoutes(app: FastifyInstance): Promise<void> {

  // Initialize the self-improver
  app.post('/v1/self-improver/initialize', async (_req, reply) => {
    await selfImproverManager.initialize();
    return reply.send({ success: true, initialized: selfImproverManager.isInitialized() });
  });

  // Shutdown the self-improver
  app.post('/v1/self-improver/shutdown', async (_req, reply) => {
    await selfImproverManager.shutdown();
    return reply.send({ success: true });
  });

  // Get comprehensive statistics
  app.get('/v1/self-improver/stats', async (_req, reply) => {
    return reply.send(selfImproverManager.getStats());
  });

  // Record a full observation
  app.post('/v1/self-improver/observe', async (req: FastifyRequest<{ Body: ObserveBody }>, reply) => {
    const body = req.body;
    if (!body || !body.url || !body.domain || !body.outcome) {
      return reply.status(400).send({ error: 'url, domain, and outcome are required' });
    }
    const observation = await selfImproverManager.observe({
      url: body.url,
      domain: body.domain,
      timestamp: Date.now(),
      outcome: body.outcome,
      detectedPlatform: body.detectedPlatform || null,
      strategiesApplied: body.strategiesApplied || [],
      context: body.context || {
        proxyTier: 'unknown', proxyCountry: 'unknown', proxyAsn: 'unknown',
        tlsProfile: 'unknown', fingerprintId: 'unknown', accountId: null,
        sessionId: `obs-${Date.now()}`, requestRate: 0,
        timeSinceLastRequestMs: 0, previousRequestCount: 0,
        browserType: 'unknown', headless: true, referrerUrl: null,
      },
      response: body.response || {
        statusCode: body.outcome === 'success' ? 200 : 403,
        detectionHeaders: {}, captchaPresent: false, captchaType: null,
        bodyLength: 0, dataExtracted: body.outcome === 'success',
        errorMessage: null, akamaiSensorVersion: null, recaptchaScore: null,
      },
      durationMs: body.durationMs || 0,
    });
    return reply.send(observation);
  });

  // Quick observation recording
  app.post('/v1/self-improver/observe/quick', async (req: FastifyRequest<{ Body: QuickObserveBody }>, reply) => {
    const body = req.body;
    if (!body || !body.url || !body.domain || !body.outcome) {
      return reply.status(400).send({ error: 'url, domain, and outcome are required' });
    }
    const observation = await selfImproverManager.observeQuick({
      url: body.url,
      domain: body.domain,
      outcome: body.outcome,
      platform: body.platform,
      proxyTier: body.proxyTier,
      tlsProfile: body.tlsProfile,
      statusCode: body.statusCode,
      captchaPresent: body.captchaPresent,
      errorMessage: body.errorMessage,
      durationMs: body.durationMs,
    });
    return reply.send(observation);
  });

  // Query observations
  app.get('/v1/self-improver/observations', async (req: FastifyRequest<{
    Querystring: { domain?: string; outcome?: string; platform?: string; since?: string; limit?: string };
  }>, reply) => {
    const observations = selfImproverManager.queryObservations({
      domain: req.query.domain,
      outcome: req.query.outcome as Outcome | undefined,
      platform: req.query.platform as AntiBotPlatform | undefined,
      since: req.query.since ? parseInt(req.query.since, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
    });
    return reply.send(observations);
  });

  // Get success rate for a domain
  app.get('/v1/self-improver/success-rate/:domain', async (req: FastifyRequest<{
    Params: { domain: string };
    Querystring: { windowMs?: string };
  }>, reply) => {
    const windowMs = req.query.windowMs ? parseInt(req.query.windowMs, 10) : 3600000;
    const rate = selfImproverManager.getSuccessRate(req.params.domain, windowMs);
    return reply.send({ domain: req.params.domain, successRate: rate, windowMs });
  });

  // Get best strategies for a domain
  app.get('/v1/self-improver/best-strategies/:domain', async (req: FastifyRequest<{ Params: { domain: string } }>, reply) => {
    const strategies = selfImproverManager.getBestStrategies(req.params.domain);
    return reply.send(strategies);
  });

  // Get domain model
  app.get('/v1/self-improver/domain-model/:domain', async (req: FastifyRequest<{ Params: { domain: string } }>, reply) => {
    const model = selfImproverManager.getDomainModel(req.params.domain);
    if (!model) return reply.status(404).send({ error: 'No model found for this domain' });
    return reply.send(model);
  });

  // Get all domain models
  app.get('/v1/self-improver/domain-models', async (_req, reply) => {
    return reply.send(selfImproverManager.getAllDomainModels());
  });

  // Get recent failure analyses
  app.get('/v1/self-improver/analyses', async (req: FastifyRequest<{ Querystring: { limit?: string } }>, reply) => {
    const limit = parseInt(req.query.limit || '20', 10);
    return reply.send(selfImproverManager.getRecentAnalyses(limit));
  });

  // Get failure patterns
  app.get('/v1/self-improver/patterns', async (_req, reply) => {
    return reply.send(selfImproverManager.getFailurePatterns());
  });

  // Get adaptations
  app.get('/v1/self-improver/adaptations', async (req: FastifyRequest<{ Querystring: { status?: string } }>, reply) => {
    const adaptations = selfImproverManager.getAdaptations(req.query.status);
    return reply.send(adaptations);
  });

  // Manually trigger processing
  app.post('/v1/self-improver/process', async (_req, reply) => {
    const result = await selfImproverManager.processUnanalyzed();
    return reply.send(result);
  });

  // Get collector stats
  app.get('/v1/self-improver/collector/stats', async (_req, reply) => {
    return reply.send(observationCollector.getStats());
  });

  // Get analyzer stats
  app.get('/v1/self-improver/analyzer/stats', async (_req, reply) => {
    return reply.send(failureAnalyzer.getStats());
  });

  // Get adapter stats
  app.get('/v1/self-improver/adapter/stats', async (_req, reply) => {
    return reply.send(adaptationEngine.getStats());
  });
}
