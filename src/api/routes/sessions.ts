/**
 * Session Management API Routes -- Create, list, inspect, terminate, and
 * refresh persistent sticky sessions with geo-consistent proxy assignment.
 *
 * Endpoints
 * ---------
 *   POST   /v1/sessions             -- Create a new sticky session
 *   GET    /v1/sessions             -- List user's active sessions
 *   GET    /v1/sessions/:id         -- Get session status
 *   DELETE /v1/sessions/:id         -- Terminate a session
 *   POST   /v1/sessions/:id/refresh -- Refresh session TTL
 *
 * All endpoints require authentication via authMiddleware.
 */

import { FastifyInstance } from 'fastify';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { sessionManager } from '../../session';
import { createChildLogger } from '../../utils/logger';
import { z } from 'zod';

const logger = createChildLogger('api:sessions');

// --- Request Validation Schemas ------------------------------------------------

const CreateSessionSchema = z.object({
  proxyTier: z.enum(['residential', 'mobile', 'datacenter', 'isp']).optional().default('residential'),
  proxyCountry: z.string().min(2).max(2).optional(),
  proxyCity: z.string().optional(),
  proxyAsn: z.string().optional(),
  domain: z.string().optional(),
  ttlMinutes: z.number().int().min(1).max(60).optional().default(10),
});

// --- Route Registration --------------------------------------------------------

export async function sessionRoutes(app: FastifyInstance) {
  // -- POST /v1/sessions -- Create a new sticky session ------------------------

  app.post('/v1/sessions', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = CreateSessionSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        success: false,
        error: 'Validation error',
        details: body.error.issues.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      });
    }

    const { apiKey } = request as AuthenticatedRequest;
    const data = body.data;

    try {
      const session = await sessionManager.createSession({
        userId: apiKey.userId,
        proxyTier: data.proxyTier,
        proxyCountry: data.proxyCountry,
        proxyCity: data.proxyCity,
        proxyAsn: data.proxyAsn,
        domain: data.domain,
        ttlMinutes: data.ttlMinutes,
      });

      return reply.status(201).send({
        success: true,
        data: {
          sessionId: session.sessionId,
          proxyId: session.proxyId,
          proxyCountry: session.proxyCountry,
          proxyCity: session.proxyCity,
          proxyAsn: session.proxyAsn,
          proxyTier: session.proxyTier,
          fingerprintProfile: session.fingerprintProfile,
          ttlMs: session.ttlMs,
          createdAt: new Date(session.createdAt).toISOString(),
          expiresAt: new Date(session.lastAccessedAt + session.ttlMs).toISOString(),
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message, userId: apiKey.userId }, 'Failed to create session');

      // User session limit exceeded
      if (error.message.includes('maximum')) {
        return reply.status(429).send({
          success: false,
          error: error.message,
        });
      }

      // No proxy available
      if (error.message.includes('No available proxy')) {
        return reply.status(503).send({
          success: false,
          error: 'No proxy available for the specified criteria. Try different geo parameters or tier.',
        });
      }

      return reply.status(500).send({
        success: false,
        error: 'Failed to create session. Please try again.',
      });
    }
  });

  // -- GET /v1/sessions -- List user's active sessions --------------------------

  app.get('/v1/sessions', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;

    try {
      const sessions = await sessionManager.listUserSessions(apiKey.userId);

      return reply.send({
        success: true,
        data: sessions,
        total: sessions.length,
      });
    } catch (error: any) {
      logger.error({ error: error.message, userId: apiKey.userId }, 'Failed to list sessions');
      return reply.status(500).send({
        success: false,
        error: 'Failed to list sessions.',
      });
    }
  });

  // -- GET /v1/sessions/:id -- Get session status ------------------------------

  app.get('/v1/sessions/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };

    try {
      const session = await sessionManager.getSession(id);

      if (!session) {
        return reply.status(404).send({
          success: false,
          error: 'Session not found or has expired.',
        });
      }

      // Verify ownership -- sessions belong to the user who created them
      if (session.userId !== apiKey.userId) {
        return reply.status(403).send({
          success: false,
          error: 'You do not have access to this session.',
        });
      }

      const totalRequests = session.requestCount;
      const successRate = totalRequests > 0 ? session.successCount / totalRequests : 0;
      const avgResponseMs = totalRequests > 0 ? Math.round(session.totalResponseMs / totalRequests) : 0;

      return reply.send({
        success: true,
        data: {
          sessionId: session.sessionId,
          proxyId: session.proxyId,
          proxyCountry: session.proxyCountry,
          proxyCity: session.proxyCity,
          proxyAsn: session.proxyAsn,
          proxyTier: session.proxyTier,
          fingerprintProfile: session.fingerprintProfile,
          metrics: {
            requestCount: session.requestCount,
            successCount: session.successCount,
            failureCount: session.failureCount,
            successRate: Math.round(successRate * 1000) / 1000,
            avgResponseMs,
            bandwidthBytes: session.bandwidthBytes,
            creditsConsumed: session.creditsConsumed,
          },
          ttlMs: session.ttlMs,
          createdAt: new Date(session.createdAt).toISOString(),
          lastAccessedAt: new Date(session.lastAccessedAt).toISOString(),
          expiresAt: new Date(session.lastAccessedAt + session.ttlMs).toISOString(),
          isActive: Date.now() - session.lastAccessedAt <= session.ttlMs,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message, sessionId: id }, 'Failed to get session');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get session status.',
      });
    }
  });

  // -- DELETE /v1/sessions/:id -- Terminate a session --------------------------

  app.delete('/v1/sessions/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };

    try {
      // Check session exists and belongs to the user before terminating
      const session = await sessionManager.getSession(id);

      if (!session) {
        return reply.status(404).send({
          success: false,
          error: 'Session not found or has already expired.',
        });
      }

      if (session.userId !== apiKey.userId) {
        return reply.status(403).send({
          success: false,
          error: 'You do not have access to this session.',
        });
      }

      await sessionManager.terminateSession(id);

      return reply.send({
        success: true,
        data: { sessionId: id, terminated: true },
      });
    } catch (error: any) {
      logger.error({ error: error.message, sessionId: id }, 'Failed to terminate session');
      return reply.status(500).send({
        success: false,
        error: 'Failed to terminate session.',
      });
    }
  });

  // -- POST /v1/sessions/:id/refresh -- Refresh session TTL --------------------

  app.post('/v1/sessions/:id/refresh', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };

    try {
      // Verify ownership first
      const existingSession = await sessionManager.getSession(id);

      if (!existingSession) {
        return reply.status(404).send({
          success: false,
          error: 'Session not found or has expired.',
        });
      }

      if (existingSession.userId !== apiKey.userId) {
        return reply.status(403).send({
          success: false,
          error: 'You do not have access to this session.',
        });
      }

      const session = await sessionManager.refreshSession(id);

      if (!session) {
        return reply.status(404).send({
          success: false,
          error: 'Session could not be refreshed. It may have expired.',
        });
      }

      return reply.send({
        success: true,
        data: {
          sessionId: session.sessionId,
          lastAccessedAt: new Date(session.lastAccessedAt).toISOString(),
          expiresAt: new Date(session.lastAccessedAt + session.ttlMs).toISOString(),
          ttlMs: session.ttlMs,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message, sessionId: id }, 'Failed to refresh session');
      return reply.status(500).send({
        success: false,
        error: 'Failed to refresh session.',
      });
    }
  });
}
