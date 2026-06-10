/**
 * Device Farm API Routes — ScrapeSuite Engine
 *
 * REST API endpoints for device fingerprint management including
 * fingerprint allocation, consistency checking, and statistics.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { fingerprintDatabase, consistencyEngine } from '../../device-farm';

interface GetFingerprintQuery {
  domain: string;
  category?: string;
}

interface ValidateFingerprintBody {
  fingerprint_id: string;
}

interface ReportBody {
  fingerprint_id: string;
  domain: string;
}

export async function deviceFarmRoutes(app: FastifyInstance): Promise<void> {

  // Get a fingerprint suitable for a domain
  app.get('/v1/device-farm/fingerprint', async (req: FastifyRequest<{ Querystring: GetFingerprintQuery }>, reply) => {
    const { domain } = req.query;
    if (!domain) return reply.status(400).send({ error: 'domain query parameter is required' });
    const fingerprint = fingerprintDatabase.getFingerprint(domain);
    if (!fingerprint) return reply.status(404).send({ error: 'No suitable fingerprint available' });
    return reply.send(fingerprint);
  });

  // Get fingerprint by ID
  app.get('/v1/device-farm/fingerprint/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const fingerprint = fingerprintDatabase.getById(req.params.id);
    if (!fingerprint) return reply.status(404).send({ error: 'Fingerprint not found' });
    return reply.send(fingerprint);
  });

  // Validate fingerprint consistency
  app.post('/v1/device-farm/validate', async (req: FastifyRequest<{ Body: ValidateFingerprintBody }>, reply) => {
    const { fingerprint_id } = req.body;
    const fp = fingerprintDatabase.getById(fingerprint_id);
    if (!fp) return reply.status(404).send({ error: 'Fingerprint not found' });
    const report = consistencyEngine.validate(fp);
    return reply.send(report);
  });

  // Validate and auto-fix fingerprint
  app.post('/v1/device-farm/validate-and-fix', async (req: FastifyRequest<{ Body: ValidateFingerprintBody }>, reply) => {
    const { fingerprint_id } = req.body;
    const fp = fingerprintDatabase.getById(fingerprint_id);
    if (!fp) return reply.status(404).send({ error: 'Fingerprint not found' });
    const result = consistencyEngine.validateAndFix(fp);
    return reply.send(result);
  });

  // Quick check if fingerprint will pass for a domain
  app.get('/v1/device-farm/check', async (req: FastifyRequest<{ Querystring: { fingerprint_id: string; domain: string } }>, reply) => {
    const fp = fingerprintDatabase.getById(req.query.fingerprint_id);
    if (!fp) return reply.status(404).send({ error: 'Fingerprint not found' });
    const likely = consistencyEngine.isLikelyToPass(fp, req.query.domain);
    return reply.send({ likely_to_pass: likely, fingerprint_id: req.query.fingerprint_id, domain: req.query.domain });
  });

  // Report a fingerprint block
  app.post('/v1/device-farm/report/block', async (req: FastifyRequest<{ Body: ReportBody }>, reply) => {
    const { fingerprint_id, domain } = req.body;
    fingerprintDatabase.reportBlock(fingerprint_id, domain);
    return reply.send({ reported: true });
  });

  // Report a fingerprint success
  app.post('/v1/device-farm/report/success', async (req: FastifyRequest<{ Body: ReportBody }>, reply) => {
    const { fingerprint_id, domain } = req.body;
    fingerprintDatabase.reportSuccess(fingerprint_id, domain);
    return reply.send({ reported: true });
  });

  // Get consistency rules
  app.get('/v1/device-farm/rules', async (_req, reply) => {
    return reply.send(consistencyEngine.getRules());
  });

  // Get fingerprint database stats
  app.get('/v1/device-farm/stats', async (_req, reply) => {
    return reply.send(fingerprintDatabase.getStats());
  });
}
