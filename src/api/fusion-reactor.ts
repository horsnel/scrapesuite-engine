/**
 * Fusion Reactor API Routes -- ScrapeSuite Engine
 *
 * REST API endpoints for the real-time fusion reactor system.
 */

import type { FastifyInstance } from 'fastify';
import { fusionReactor, signalDetector, reactionEngine } from '../fusion-reactor';
import type { ResponseContext } from '../fusion-reactor';

export async function fusionReactorRoutes(app: FastifyInstance): Promise<void> {
  // Get fusion reactor status
  app.get('/v1/fusion-reactor/status', async () => {
    return fusionReactor.getStatus();
  });

  // Detect signals from a response
  app.post('/v1/fusion-reactor/detect', async (request) => {
    const body = request.body as ResponseContext;
    const signals = signalDetector.detectSignals(body);
    return { signals, count: signals.length };
  });

  // Process a response through the full fusion reactor pipeline
  app.post('/v1/fusion-reactor/process', async (request) => {
    const body = request.body as ResponseContext;
    const wave = await fusionReactor.processResponse(body);
    return { wave, detected: wave !== null };
  });

  // Quick check if signals are present
  app.post('/v1/fusion-reactor/quick-check', async (request) => {
    const body = request.body as ResponseContext;
    const hasSignals = fusionReactor.quickCheck(body);
    return { hasSignals };
  });

  // Get recommended reactions for a domain/platform
  app.get('/v1/fusion-reactor/recommendations/:domain/:platform', async (request) => {
    const { domain, platform } = request.params as { domain: string; platform: string };
    const reactions = fusionReactor.getRecommendedReactions(domain, platform as any);
    return { domain, platform, recommendations: reactions };
  });

  // Get all chain reaction rules
  app.get('/v1/fusion-reactor/rules', async () => {
    return { rules: fusionReactor.getRules() };
  });

  // Add a custom chain reaction rule
  app.post('/v1/fusion-reactor/rules', async (request) => {
    const rule = request.body as any;
    fusionReactor.addRule(rule);
    return { success: true, ruleId: rule.id };
  });

  // Remove a chain reaction rule
  app.delete('/v1/fusion-reactor/rules/:ruleId', async (request) => {
    const { ruleId } = request.params as { ruleId: string };
    const removed = fusionReactor.removeRule(ruleId);
    return { success: removed };
  });

  // Get signal detector stats
  app.get('/v1/fusion-reactor/detector/stats', async () => {
    return signalDetector.getStats();
  });

  // Get reaction engine stats
  app.get('/v1/fusion-reactor/engine/stats', async () => {
    return reactionEngine.getStats();
  });

  // Get neutron economy
  app.get('/v1/fusion-reactor/neutron-economy', async () => {
    return reactionEngine.getNeutronEconomy();
  });
}
