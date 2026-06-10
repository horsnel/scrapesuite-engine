/**
 * TLS Spoofer API Routes -- ScrapeSuite Engine
 *
 * REST API endpoints for TLS fingerprint spoofing, including
 * spoofed requests, connections, statistics, and curl-impersonate detection.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { tlsSpoofer } from '../../quantum-tls/tls-spoofer';
import { quantumTLSManager } from '../../quantum-tls';
import type { SpoofedConnection, CurlImpersonateResult } from '../../quantum-tls/tls-spoofer';
import { createChildLogger } from '../../utils/logger';

const logger = createChildLogger('api:tls-spoofer');

// --- Request/Response Interfaces -----------------------------------------------

interface SpoofedRequestBody {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  profileId?: string;
  profileName?: string;
  proxyUrl?: string;
  timeout?: number;
}

interface SpoofedConnectionBody {
  hostname: string;
  port?: number;
  profileId?: string;
  profileName?: string;
  proxyUrl?: string;
}

interface DetectCurlBody {
  forceRedetect?: boolean;
}

// --- Route Registration --------------------------------------------------------

export async function tlsSpooferRoutes(app: FastifyInstance): Promise<void> {

  // POST /v1/tls/spoofed-request — Make request with spoofed TLS fingerprint
  app.post('/v1/tls/spoofed-request', async (req: FastifyRequest<{ Body: SpoofedRequestBody }>, reply: FastifyReply) => {
    const body = req.body;

    if (!body?.url) {
      return reply.status(400).send({
        success: false,
        error: 'url is required',
      });
    }

    try {
      // Resolve a TLS profile if specified
      let profile: any = undefined;

      if (body.profileId) {
        profile = await quantumTLSManager.getProfile(body.profileId);
        if (!profile) {
          return reply.status(404).send({
            success: false,
            error: `TLS profile not found: ${body.profileId}`,
          });
        }
      } else if (body.profileName) {
        // Try to find a profile by name via listProfiles
        const allProfiles = await quantumTLSManager.listProfiles({});
        profile = (allProfiles as any[]).find((p: any) => p.name === body.profileName);
        if (!profile) {
          return reply.status(404).send({
            success: false,
            error: `TLS profile not found with name: ${body.profileName}`,
          });
        }
      }

      const result: CurlImpersonateResult = await tlsSpoofer.requestWithSpoofedTLS(
        body.url,
        {
          method: body.method,
          headers: body.headers,
          body: body.body,
          profile,
          proxyUrl: body.proxyUrl,
          timeout: body.timeout,
        },
      );

      return reply.send({
        success: result.success,
        data: result,
      });
    } catch (err: any) {
      logger.error({ url: body.url, error: err.message }, 'Spoofed TLS request failed');
      return reply.status(500).send({
        success: false,
        error: err.message || 'Spoofed TLS request failed',
      });
    }
  });

  // POST /v1/tls/spoofed-connection — Create spoofed TLS connection
  app.post('/v1/tls/spoofed-connection', async (req: FastifyRequest<{ Body: SpoofedConnectionBody }>, reply: FastifyReply) => {
    const body = req.body;

    if (!body?.hostname) {
      return reply.status(400).send({
        success: false,
        error: 'hostname is required',
      });
    }

    try {
      const port = body.port ?? 443;

      // Resolve a TLS profile
      let profile: any = undefined;

      if (body.profileId) {
        profile = await quantumTLSManager.getProfile(body.profileId);
        if (!profile) {
          return reply.status(404).send({
            success: false,
            error: `TLS profile not found: ${body.profileId}`,
          });
        }
      } else if (body.profileName) {
        const allProfiles = await quantumTLSManager.listProfiles({});
        profile = (allProfiles as any[]).find((p: any) => p.name === body.profileName);
        if (!profile) {
          return reply.status(404).send({
            success: false,
            error: `TLS profile not found with name: ${body.profileName}`,
          });
        }
      }

      if (!profile) {
        // Get a default profile via the connection config
        const config = await quantumTLSManager.getConnectionConfig(body.hostname);
        if (config?.profile_id) {
          profile = await quantumTLSManager.getProfile(config.profile_id);
        }
        if (!profile) {
          return reply.status(400).send({
            success: false,
            error: 'No TLS profile specified and no default profile available. Specify profileId or profileName.',
          });
        }
      }

      const connection: SpoofedConnection = await tlsSpoofer.createSpoofedConnection(
        body.hostname,
        port,
        profile,
        body.proxyUrl,
      );

      // Don't return the raw socket — return connection metadata
      const connectionData = {
        negotiatedCipher: connection.negotiatedCipher,
        negotiatedVersion: connection.negotiatedVersion,
        ja3Hash: connection.ja3Hash,
        connectTimeMs: connection.connectTimeMs,
        profile: {
          id: connection.profile.id,
          name: connection.profile.name,
        },
        connected: true,
      };

      // Clean up the connection after returning metadata
      try {
        connection.tlsSocket.destroy();
      } catch {}

      return reply.send({
        success: true,
        data: connectionData,
      });
    } catch (err: any) {
      logger.error({ hostname: body.hostname, error: err.message }, 'Spoofed TLS connection failed');
      return reply.status(500).send({
        success: false,
        error: err.message || 'Spoofed TLS connection failed',
      });
    }
  });

  // GET /v1/tls/spoofer/stats — Get spoofer statistics
  app.get('/v1/tls/spoofer/stats', async (_req, reply) => {
    try {
      const stats = tlsSpoofer.getStats();
      return reply.send({
        success: true,
        data: stats,
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to get spoofer stats');
      return reply.status(500).send({
        success: false,
        error: err.message || 'Failed to get spoofer stats',
      });
    }
  });

  // POST /v1/tls/spoofer/detect-curl — Check if curl-impersonate is available
  app.post('/v1/tls/spoofer/detect-curl', async (req: FastifyRequest<{ Body: DetectCurlBody }>, reply) => {
    try {
      const { forceRedetect } = req.body || {};

      if (forceRedetect) {
        // Re-initialize the spoofer to force a fresh detection
        const TLSFingerprintSpoofer = (tlsSpoofer as any).constructor;
        // Reset the initialized flag so initialize() re-runs detection
        (tlsSpoofer as any).initialized = false;
        (tlsSpoofer as any).curlImpersonatePath = null;
        await tlsSpoofer.initialize();
      }

      const stats = tlsSpoofer.getStats();

      return reply.send({
        success: true,
        data: {
          available: stats.curlImpersonateAvailable,
          curlImpersonatePath: stats.curlImpersonatePath || null,
          lastDetectionAttempt: stats.lastCurlDetectAttempt || null,
          profileCacheSize: stats.profileCacheSize || 0,
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to detect curl-impersonate');
      return reply.status(500).send({
        success: false,
        error: err.message || 'Failed to detect curl-impersonate',
      });
    }
  });
}
