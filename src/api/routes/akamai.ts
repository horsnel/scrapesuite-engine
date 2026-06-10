/**
 * Akamai API Routes — ScrapeSuite Engine
 *
 * REST API endpoints for Akamai Bot Manager bypass including
 * sensor data generation, Hydra challenge solving, and evasion management.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { akamaiManager, sensorGenerator, hydraSolver, botManagerEvader } from '../../akamai';
import type { SensorVersion, HydraChallengeType } from '../../akamai/types';

interface GenerateSensorBody {
  domain: string;
  page_url: string;
  request_id?: string;
  session_id?: string;
  viewport_width?: number;
  viewport_height?: number;
}

interface SolveHydraBody {
  id: string;
  type: HydraChallengeType;
  domain: string;
  parameters?: Record<string, any>;
  time_limit?: number;
  attempts_remaining?: number;
}

interface ApplyEvasionsBody {
  domain: string;
  url: string;
  request_id: string;
  session_id: string;
  detections?: Array<{ method: string; confidence: number; indicators: string[] }>;
}

interface PrepareRequestBody {
  domain: string;
  url: string;
  request_id: string;
  session_id: string;
}

export async function akamaiRoutes(app: FastifyInstance): Promise<void> {

  // Generate Akamai sensor data payload
  app.post('/v1/akamai/sensor/generate', async (req: FastifyRequest<{ Body: GenerateSensorBody }>, reply) => {
    const { domain, page_url, request_id, session_id, viewport_width, viewport_height } = req.body;
    if (!domain || !page_url) {
      return reply.status(400).send({ error: 'domain and page_url are required' });
    }
    const payload = await sensorGenerator.generatePayload({
      domain,
      pageUrl: page_url,
      requestId: request_id,
      sessionId: session_id,
      viewportWidth: viewport_width,
      viewportHeight: viewport_height,
    });
    return reply.send(payload);
  });

  // Validate a sensor payload
  app.post('/v1/akamai/sensor/validate', async (req: FastifyRequest<{ Body: { data: string; version: string; request_id: string; session_id: string; page_url: string } }>, reply) => {
    const result = sensorGenerator.validatePayload({
      data: req.body.data,
      version: req.body.version as SensorVersion,
      timestamp: Date.now(),
      requestId: req.body.request_id,
      validated: false,
      sessionId: req.body.session_id,
      pageUrl: req.body.page_url,
    });
    return reply.send(result);
  });

  // Get cached sensor payload
  app.get('/v1/akamai/sensor/cached/:domain/:sessionId', async (req: FastifyRequest<{ Params: { domain: string; sessionId: string } }>, reply) => {
    const payload = await sensorGenerator.getCachedPayload(req.params.domain, req.params.sessionId);
    if (!payload) return reply.status(404).send({ error: 'No cached payload found' });
    return reply.send(payload);
  });

  // Solve a Hydra challenge
  app.post('/v1/akamai/hydra/solve', async (req: FastifyRequest<{ Body: SolveHydraBody }>, reply) => {
    const { id, type, domain, parameters, time_limit, attempts_remaining } = req.body;
    if (!id || !type || !domain) {
      return reply.status(400).send({ error: 'id, type, and domain are required' });
    }
    const solution = await hydraSolver.solve({
      id,
      type,
      phase: 'challenge',
      parameters: parameters || {},
      receivedAt: Date.now(),
      timeLimit: time_limit || 30000,
      attemptsRemaining: attempts_remaining || 3,
      domain,
    });
    return reply.send(solution);
  });

  // Get Hydra solver stats
  app.get('/v1/akamai/hydra/stats', async (_req, reply) => {
    return reply.send(hydraSolver.getStats());
  });

  // Apply evasion strategies (proactive)
  app.post('/v1/akamai/evade/proactive', async (req: FastifyRequest<{ Body: ApplyEvasionsBody }>, reply) => {
    const { domain, url, request_id, session_id } = req.body;
    if (!domain || !url) {
      return reply.status(400).send({ error: 'domain and url are required' });
    }
    const results = await botManagerEvader.proactiveEvade(domain, url, request_id, session_id);
    return reply.send({ evasions: results });
  });

  // Apply evasion strategies (reactive to detections)
  app.post('/v1/akamai/evade/reactive', async (req: FastifyRequest<{ Body: ApplyEvasionsBody }>, reply) => {
    const { domain, url, request_id, session_id, detections } = req.body;
    if (!domain || !url) {
      return reply.status(400).send({ error: 'domain and url are required' });
    }
    const results = await botManagerEvader.reactiveEvade(
      (detections || []).map(d => ({
        method: d.method as any,
        confidence: d.confidence,
        indicators: d.indicators,
        timestamp: Date.now(),
        domain,
      })),
      domain, url, request_id, session_id
    );
    return reply.send({ evasions: results });
  });

  // Get evasion stats
  app.get('/v1/akamai/evade/stats', async (_req, reply) => {
    return reply.send(botManagerEvader.getStats());
  });

  // Full anti-Akamai pipeline for a request
  app.post('/v1/akamai/prepare', async (req: FastifyRequest<{ Body: PrepareRequestBody }>, reply) => {
    const { domain, url, request_id, session_id } = req.body;
    if (!domain || !url) {
      return reply.status(400).send({ error: 'domain and url are required' });
    }
    const result = await akamaiManager.prepareRequest({
      domain,
      url,
      requestId: request_id,
      sessionId: session_id,
    });
    return reply.send(result);
  });

  // Get overall Akamai stats
  app.get('/v1/akamai/stats', async (_req, reply) => {
    return reply.send(akamaiManager.getStats());
  });
}
