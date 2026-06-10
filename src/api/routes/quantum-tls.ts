/**
 * Quantum TLS API Routes -- ScrapeSuite Engine
 *
 * REST API endpoints for quantum-resistant TLS profile management,
 * connection configuration, rotation, and readiness assessment.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { quantumTLSManager } from '../../quantum-tls';
import { RotationStrategy, TLSVersion } from '../../quantum-tls/types';

interface ListProfilesQuery {
  quantum_resistant?: string;
  tls_version?: TLSVersion;
}

interface CreateProfileBody {
  name: string;
  tls_version: TLSVersion;
  cipher_suites: string[];
  extensions: number[];
  supported_groups: string[];
  signature_algorithms: string[];
  alpn_protocols: string[];
  is_quantum_resistant?: boolean;
  popularity_score?: number;
}

interface GetConnectionQuery {
  domain: string;
  country?: string;
}

interface RotateProfileBody {
  strategy?: RotationStrategy;
  avoid_repetition_count?: number;
  prefer_quantum_resistant?: boolean;
}

export async function quantumTLSRoutes(app: FastifyInstance): Promise<void> {

  // List TLS profiles
  app.get('/v1/tls/profiles', async (req: FastifyRequest<{ Querystring: ListProfilesQuery }>, reply) => {
    const { quantum_resistant, tls_version } = req.query;
    const filter: any = {};
    if (quantum_resistant !== undefined) filter.quantum_resistant = quantum_resistant === 'true';
    if (tls_version) filter.tls_version = tls_version;

    const profiles = await quantumTLSManager.listProfiles(filter);
    return reply.send({ profiles });
  });

  // Get a specific profile
  app.get('/v1/tls/profiles/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const profile = await quantumTLSManager.getProfile(req.params.id);
    if (!profile) return reply.status(404).send({ error: 'Profile not found' });
    return reply.send(profile);
  });

  // Create a custom TLS profile
  app.post('/v1/tls/profiles', async (req: FastifyRequest<{ Body: CreateProfileBody }>, reply) => {
    const { name, tls_version, cipher_suites, extensions, supported_groups, signature_algorithms, alpn_protocols, is_quantum_resistant, popularity_score } = req.body;
    if (!name || !cipher_suites?.length || !supported_groups?.length) {
      return reply.status(400).send({ error: 'name, cipher_suites, and supported_groups are required' });
    }
    const profile = await quantumTLSManager.createProfile({
      name,
      tls_version: tls_version ?? 'TLS_1_3',
      cipher_suites,
      extensions: extensions ?? [],
      supported_groups,
      signature_algorithms: signature_algorithms ?? [],
      alpn_protocols: alpn_protocols ?? ['h2', 'http/1.1'],
      is_quantum_resistant: is_quantum_resistant ?? false,
      popularity_score: popularity_score ?? 50,
    });
    return reply.status(201).send(profile);
  });

  // Get connection configuration for a domain
  app.get('/v1/tls/connection', async (req: FastifyRequest<{ Querystring: GetConnectionQuery }>, reply) => {
    const { domain, country } = req.query;
    if (!domain) {
      return reply.status(400).send({ error: 'domain is required' });
    }
    const config = await quantumTLSManager.getConnectionConfig(domain, country);
    return reply.send(config);
  });

  // Get Node.js TLS options for a domain
  app.get('/v1/tls/options', async (req: FastifyRequest<{ Querystring: GetConnectionQuery }>, reply) => {
    const { domain, country } = req.query;
    if (!domain) {
      return reply.status(400).send({ error: 'domain is required' });
    }
    const options = await quantumTLSManager.getConnectionOptions(domain, country);
    return reply.send(options);
  });

  // Rotate to a new profile
  app.post('/v1/tls/rotate', async (req: FastifyRequest<{ Body: RotateProfileBody }>, reply) => {
    const { strategy, avoid_repetition_count, prefer_quantum_resistant } = req.body;
    const profile = await quantumTLSManager.rotateProfile({
      strategy: strategy ?? 'weighted',
      interval_ms: 0,
      avoid_repetition_count: avoid_repetition_count ?? 3,
      prefer_quantum_resistant: prefer_quantum_resistant ?? false,
    });
    return reply.send(profile);
  });

  // Release a connection
  app.post('/v1/tls/release/:profileId', async (req: FastifyRequest<{ Params: { profileId: string } }>, reply) => {
    await quantumTLSManager.releaseConnection(req.params.profileId);
    return reply.send({ status: 'released' });
  });

  // Get TLS statistics
  app.get('/v1/tls/stats', async (_req, reply) => {
    const stats = await quantumTLSManager.getStats();
    return reply.send(stats);
  });

  // Get quantum readiness assessment
  app.get('/v1/tls/quantum-readiness', async (_req, reply) => {
    const readiness = await quantumTLSManager.getQuantumReadiness();
    return reply.send(readiness);
  });
}
