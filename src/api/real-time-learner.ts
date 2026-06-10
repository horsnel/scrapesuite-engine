/**
 * Real-Time Learner API Routes -- ScrapeSuite Engine
 *
 * REST API endpoints for the real-time cascade learning system.
 */

import type { FastifyInstance } from 'fastify';
import { realTimeLearner } from '../self-improver/real-time-learner';
import type { ReactionOutcome } from '../self-improver/real-time-learner';

export async function realTimeLearnerRoutes(app: FastifyInstance): Promise<void> {
  // Record a reaction outcome
  app.post('/v1/learner/outcome', async (request) => {
    const outcome = request.body as ReactionOutcome;
    realTimeLearner.recordOutcome(outcome);
    return { recorded: true };
  });

  // Get best reaction for a platform + signal
  app.get('/v1/learner/best-reaction/:platform/:signalCategory', async (request) => {
    const { platform, signalCategory } = request.params as { platform: string; signalCategory: string };
    const reaction = realTimeLearner.getBestReaction(platform as any, signalCategory as any);
    return { platform, signalCategory, bestReaction: reaction };
  });

  // Get optimal cascade depth for a domain
  app.get('/v1/learner/cascade-depth/:domain', async (request) => {
    const { domain } = request.params as { domain: string };
    const depth = realTimeLearner.getOptimalCascadeDepth(domain);
    return { domain, optimalCascadeDepth: depth };
  });

  // Get domain reaction model
  app.get('/v1/learner/domain-model/:domain', async (request) => {
    const { domain } = request.params as { domain: string };
    const model = realTimeLearner.getDomainModel(domain);
    return model || { domain, notFound: true };
  });

  // Get all learned patterns
  app.get('/v1/learner/patterns', async () => {
    return { patterns: realTimeLearner.getPatterns() };
  });

  // Get patterns by platform
  app.get('/v1/learner/patterns/:platform', async (request) => {
    const { platform } = request.params as { platform: string };
    return { patterns: realTimeLearner.getPatternsByPlatform(platform as any) };
  });

  // Get learner stats
  app.get('/v1/learner/stats', async () => {
    return realTimeLearner.getStats();
  });

  // Load state from cache
  app.post('/v1/learner/load', async () => {
    await realTimeLearner.loadState();
    return { loaded: true };
  });
}
