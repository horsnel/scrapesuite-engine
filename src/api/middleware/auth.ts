import { FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../utils/db';
import { hashApiKey } from '../../utils/credits';
import { createChildLogger } from '../../utils/logger';

const logger = createChildLogger('auth');

export interface AuthenticatedRequest extends FastifyRequest {
  apiKey: {
    id: string;
    userId: string;
    plan: string;
    creditsRemaining: number;
  };
  user?: {
    id: string;
    plan: string;
  };
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  // Extract API key from various sources
  let apiKey: string | undefined;

  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    apiKey = authHeader.substring(7);
  } else if (request.headers['x-api-key']) {
    apiKey = request.headers['x-api-key'] as string;
  } else if ((request.query as any).apikey) {
    apiKey = (request.query as any).apikey;
  }

  if (!apiKey) {
    return reply.status(401).send({
      success: false,
      error: 'API key required. Provide via Authorization: Bearer <key>, X-API-Key header, or ?apikey= query param',
    });
  }

  try {
    // Hash the provided key and look it up
    const keyHash = hashApiKey(apiKey);
    let keyRecord = await db.apiKey.findUnique({ where: { keyHash } });

    // Fallback: try direct key match for convenience (e.g. during development)
    if (!keyRecord) {
      keyRecord = await db.apiKey.findFirst({
        where: { keyHash: apiKey },
      });
    }

    if (!keyRecord) {
      logger.warn({ keyPrefix: apiKey.substring(0, 8) }, 'Invalid API key');
      return reply.status(401).send({ success: false, error: 'Invalid API key' });
    }

    // Attach to request
    (request as AuthenticatedRequest).apiKey = {
      id: keyRecord.id,
      userId: keyRecord.userId,
      plan: keyRecord.plan,
      creditsRemaining: keyRecord.creditsRemaining,
    };
  } catch (error) {
    logger.error({ error }, 'Auth middleware error');
    return reply.status(500).send({ success: false, error: 'Authentication failed' });
  }
}
