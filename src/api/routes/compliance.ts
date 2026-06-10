/**
 * Compliance API Routes -- PII detection/redaction, GDPR, CCPA, audit logging,
 * data retention, legal hold, and robots.txt compliance.
 *
 * Endpoints
 * ---------
 *   POST   /v1/compliance/pii/detect              -- Detect PII in text
 *   POST   /v1/compliance/pii/redact               -- Redact PII in text
 *   GET    /v1/compliance/audit-log                 -- Query audit log
 *   POST   /v1/compliance/gdpr/access-request       -- Submit GDPR access request
 *   POST   /v1/compliance/gdpr/erasure-request      -- Submit GDPR erasure request
 *   POST   /v1/compliance/ccpa/request              -- Submit CCPA request
 *   GET    /v1/compliance/ccpa/catalog/:consumerId  -- Get consumer data catalog
 *   POST   /v1/compliance/ccpa/do-not-sell          -- Set Do Not Sell flag
 *   GET    /v1/compliance/retention/policies         -- Get retention policies
 *   POST   /v1/compliance/retention/policies         -- Add retention policy
 *   POST   /v1/compliance/legal-hold                 -- Apply legal hold
 *   DELETE /v1/compliance/legal-hold/:holdId         -- Release legal hold
 *   POST   /v1/compliance/robots/check              -- Check robots.txt compliance for URL
 */

import { FastifyInstance } from 'fastify';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import {
  complianceEngine,
  AuditEventType,
  CCPARequestType,
} from '../../compliance';
import { createChildLogger } from '../../utils/logger';
import { z } from 'zod';

const logger = createChildLogger('api:compliance');

// --- Request Validation Schemas ------------------------------------------------

const DetectPIISchema = z.object({
  text: z.string().min(1),
});

const RedactPIISchema = z.object({
  text: z.string().min(1),
});

const GDPRAccessRequestSchema = z.object({
  subjectIdentifier: z.string().min(1),
  requestorEmail: z.string().email(),
});

const GDPRErasureRequestSchema = z.object({
  subjectIdentifier: z.string().min(1),
  requestorEmail: z.string().email(),
});

const CCPARequestSchema = z.object({
  type: z.enum(['know', 'delete', 'opt_out_sale', 'non_discrimination']),
  consumerIdentifier: z.string().min(1),
});

const DoNotSellSchema = z.object({
  consumerIdentifier: z.string().min(1),
});

const RetentionPolicySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  retentionDays: z.number().int().min(1),
  autoDelete: z.boolean().optional().default(false),
  appliesTo: z.array(z.string()).min(1),
});

const LegalHoldSchema = z.object({
  caseId: z.string().min(1),
  requestor: z.string().min(1),
  requestorEmail: z.string().email(),
  reason: z.string().min(1),
  scope: z.object({
    dataRecordIds: z.array(z.string()).optional(),
    urls: z.array(z.string()).optional(),
    domains: z.array(z.string()).optional(),
    consumerIdentifiers: z.array(z.string()).optional(),
  }),
  metadata: z.record(z.any()).optional(),
});

const RobotsCheckSchema = z.object({
  url: z.string().url(),
  userAgent: z.string().optional().default('ScrapeSuite'),
  overrideRobots: z.boolean().optional().default(false),
});

// --- Route Registration --------------------------------------------------------

export async function complianceRoutes(app: FastifyInstance) {
  // -- POST /v1/compliance/pii/detect -- Detect PII in text ---------------------

  app.post('/v1/compliance/pii/detect', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = DetectPIISchema.safeParse(request.body);
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

    try {
      const detections = complianceEngine.detectPII(body.data.text);

      // Audit log
      await complianceEngine.audit(AuditEventType.PII_DETECTED, (request as AuthenticatedRequest).apiKey.userId, {
        detectionCount: detections.length,
        categories: [...new Set(detections.map((d) => d.category))],
      });

      return reply.send({
        success: true,
        data: {
          detectionsFound: detections.length,
          detections: detections.map((d) => ({
            category: d.category,
            match: d.match,
            startIndex: d.startIndex,
            endIndex: d.endIndex,
            confidence: d.confidence,
            redacted: d.redacted,
            strategy: d.strategy,
          })),
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'PII detection failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to detect PII.',
      });
    }
  });

  // -- POST /v1/compliance/pii/redact -- Redact PII in text ---------------------

  app.post('/v1/compliance/pii/redact', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = RedactPIISchema.safeParse(request.body);
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

    try {
      const { redactedText, detections } = complianceEngine.redactText(body.data.text);

      // Audit log
      await complianceEngine.audit(AuditEventType.PII_REDACTED, (request as AuthenticatedRequest).apiKey.userId, {
        redactionCount: detections.length,
        categories: [...new Set(detections.map((d) => d.category))],
      });

      return reply.send({
        success: true,
        data: {
          redactedText,
          detectionsFound: detections.length,
          detections: detections.map((d) => ({
            category: d.category,
            startIndex: d.startIndex,
            endIndex: d.endIndex,
            confidence: d.confidence,
            strategy: d.strategy,
          })),
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'PII redaction failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to redact PII.',
      });
    }
  });

  // -- GET /v1/compliance/audit-log -- Query audit log ---------------------------

  app.get('/v1/compliance/audit-log', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const query = request.query as {
      userId?: string;
      domain?: string;
      eventType?: string;
      startDate?: string;
      endDate?: string;
      limit?: string;
    };

    try {
      const filters: any = {};
      if (query.userId) filters.userId = query.userId;
      if (query.domain) filters.domain = query.domain;
      if (query.eventType) filters.eventType = query.eventType;
      if (query.startDate) filters.startDate = new Date(query.startDate);
      if (query.endDate) filters.endDate = new Date(query.endDate);
      if (query.limit) filters.limit = Math.min(parseInt(query.limit, 10), 500);

      // Default to the requesting user's events if no userId filter
      if (!filters.userId) filters.userId = apiKey.userId;

      const entries = await complianceEngine.queryAuditLogs(filters);

      return reply.send({
        success: true,
        data: entries,
        total: entries.length,
      });
    } catch (error: any) {
      logger.error({ error: error.message, userId: apiKey.userId }, 'Audit log query failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to query audit log.',
      });
    }
  });

  // -- POST /v1/compliance/gdpr/access-request -- Submit GDPR access request -----

  app.post('/v1/compliance/gdpr/access-request', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = GDPRAccessRequestSchema.safeParse(request.body);
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

    try {
      const dsr = await complianceEngine.requestDataAccess(
        body.data.subjectIdentifier,
        body.data.requestorEmail,
      );

      await complianceEngine.audit(AuditEventType.DATA_SUBJECT_REQUEST, apiKey.userId, {
        requestId: dsr.id,
        type: 'access',
        subjectIdentifier: body.data.subjectIdentifier,
      });

      return reply.status(201).send({
        success: true,
        data: {
          id: dsr.id,
          status: dsr.status,
          deadline: dsr.deadline,
          recordsFound: dsr.dataCollected.length,
          notes: dsr.notes,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'GDPR access request failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to process GDPR access request.',
      });
    }
  });

  // -- POST /v1/compliance/gdpr/erasure-request -- Submit GDPR erasure request ---

  app.post('/v1/compliance/gdpr/erasure-request', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = GDPRErasureRequestSchema.safeParse(request.body);
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

    try {
      const dsr = await complianceEngine.requestErasure(
        body.data.subjectIdentifier,
        body.data.requestorEmail,
      );

      await complianceEngine.audit(AuditEventType.DATA_SUBJECT_REQUEST, apiKey.userId, {
        requestId: dsr.id,
        type: 'erasure',
        subjectIdentifier: body.data.subjectIdentifier,
      });

      return reply.status(201).send({
        success: true,
        data: {
          id: dsr.id,
          status: dsr.status,
          deadline: dsr.deadline,
          recordsProcessed: dsr.dataCollected.length,
          notes: dsr.notes,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'GDPR erasure request failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to process GDPR erasure request.',
      });
    }
  });

  // -- POST /v1/compliance/ccpa/request -- Submit CCPA request -------------------

  app.post('/v1/compliance/ccpa/request', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = CCPARequestSchema.safeParse(request.body);
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

    try {
      const type = body.data.type as CCPARequestType;
      const ccpaRequest = await complianceEngine.submitCCPARequest(
        type,
        body.data.consumerIdentifier,
      );

      await complianceEngine.audit(AuditEventType.CCPA_REQUEST, apiKey.userId, {
        requestId: ccpaRequest.id,
        type: body.data.type,
        consumerIdentifier: body.data.consumerIdentifier,
      });

      return reply.status(201).send({
        success: true,
        data: {
          id: ccpaRequest.id,
          type: ccpaRequest.type,
          status: ccpaRequest.status,
          deadline: ccpaRequest.deadline,
          doNotSell: ccpaRequest.doNotSell,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'CCPA request failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to process CCPA request.',
      });
    }
  });

  // -- GET /v1/compliance/ccpa/catalog/:consumerId -- Get consumer data catalog --

  app.get('/v1/compliance/ccpa/catalog/:consumerId', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { consumerId } = request.params as { consumerId: string };

    try {
      const catalog = await complianceEngine.getConsumerCatalog(consumerId);

      return reply.send({
        success: true,
        data: catalog,
        total: catalog.length,
      });
    } catch (error: any) {
      logger.error({ error: error.message, consumerId }, 'CCPA catalog lookup failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get consumer data catalog.',
      });
    }
  });

  // -- POST /v1/compliance/ccpa/do-not-sell -- Set Do Not Sell flag --------------

  app.post('/v1/compliance/ccpa/do-not-sell', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = DoNotSellSchema.safeParse(request.body);
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

    try {
      await complianceEngine.setDoNotSell(body.data.consumerIdentifier);

      await complianceEngine.audit(AuditEventType.CCPA_REQUEST, apiKey.userId, {
        type: 'do_not_sell',
        consumerIdentifier: body.data.consumerIdentifier,
      });

      return reply.send({
        success: true,
        data: {
          consumerIdentifier: body.data.consumerIdentifier,
          doNotSell: true,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Do Not Sell flag failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to set Do Not Sell flag.',
      });
    }
  });

  // -- GET /v1/compliance/retention/policies -- Get retention policies ------------

  app.get('/v1/compliance/retention/policies', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      const policies = complianceEngine.getDataSubjectRequests();

      return reply.send({
        success: true,
        data: policies,
        total: policies.length,
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to get retention policies');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get retention policies.',
      });
    }
  });

  // -- POST /v1/compliance/retention/policies -- Add retention policy -------------

  app.post('/v1/compliance/retention/policies', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = RetentionPolicySchema.safeParse(request.body);
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

    try {
      const policy = await complianceEngine.addRetentionPolicy(body.data);

      return reply.status(201).send({
        success: true,
        data: policy,
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to add retention policy');
      return reply.status(500).send({
        success: false,
        error: 'Failed to add retention policy.',
      });
    }
  });

  // -- POST /v1/compliance/legal-hold -- Apply legal hold -------------------------

  app.post('/v1/compliance/legal-hold', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = LegalHoldSchema.safeParse(request.body);
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

    try {
      const hold = await complianceEngine.applyLegalHold({
        caseId: body.data.caseId,
        requestor: body.data.requestor,
        requestorEmail: body.data.requestorEmail,
        reason: body.data.reason,
        scope: body.data.scope,
        metadata: body.data.metadata,
      });

      await complianceEngine.audit(AuditEventType.LEGAL_HOLD_APPLIED, apiKey.userId, {
        holdId: hold.id,
        caseId: hold.caseId,
      });

      return reply.status(201).send({
        success: true,
        data: hold,
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to apply legal hold');
      return reply.status(500).send({
        success: false,
        error: 'Failed to apply legal hold.',
      });
    }
  });

  // -- DELETE /v1/compliance/legal-hold/:holdId -- Release legal hold ------------

  app.delete('/v1/compliance/legal-hold/:holdId', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { holdId } = request.params as { holdId: string };
    const { apiKey } = request as AuthenticatedRequest;

    try {
      const hold = await complianceEngine.releaseLegalHold(holdId);

      if (!hold) {
        return reply.status(404).send({
          success: false,
          error: 'Legal hold not found.',
        });
      }

      await complianceEngine.audit(AuditEventType.LEGAL_HOLD_RELEASED, apiKey.userId, {
        holdId,
        caseId: hold.caseId,
      });

      return reply.send({
        success: true,
        data: { holdId, released: true },
      });
    } catch (error: any) {
      logger.error({ error: error.message, holdId }, 'Failed to release legal hold');
      return reply.status(500).send({
        success: false,
        error: 'Failed to release legal hold.',
      });
    }
  });

  // -- POST /v1/compliance/robots/check -- Check robots.txt compliance for URL ---

  app.post('/v1/compliance/robots/check', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = RobotsCheckSchema.safeParse(request.body);
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

    try {
      const result = await complianceEngine.checkRobotsCompliance(
        body.data.url,
        body.data.userAgent,
        body.data.overrideRobots,
      );

      if (result.overrideLogged) {
        await complianceEngine.audit(AuditEventType.ROBOTS_OVERRIDE, apiKey.userId, {
          url: body.data.url,
          userAgent: body.data.userAgent,
        });
      }

      return reply.send({
        success: true,
        data: result,
      });
    } catch (error: any) {
      logger.error({ error: error.message, url: body.data.url }, 'Robots compliance check failed');
      return reply.status(500).send({
        success: false,
        error: 'Failed to check robots.txt compliance.',
      });
    }
  });
}
