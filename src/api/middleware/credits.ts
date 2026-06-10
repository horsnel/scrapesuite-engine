import { FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../utils/db';
import { AuthenticatedRequest } from './auth';
import { createChildLogger } from '../../utils/logger';

const logger = createChildLogger('credits');

/**
 * Deduct credits from an API key atomically.
 * Uses Prisma's atomic decrement to prevent race conditions.
 *
 * @returns true if deduction succeeded (balance remains >= 0), false otherwise
 */
export async function deductCredits(
  userId: string,
  apiKeyId: string,
  amount: number,
): Promise<boolean> {
  try {
    // Use a transaction to ensure atomic deduction and validate balance
    const result = await db.$transaction(async (tx) => {
      const key = await tx.apiKey.findUnique({
        where: { id: apiKeyId },
        select: { creditsRemaining: true },
      });

      if (!key || key.creditsRemaining < amount) {
        return null; // Signal insufficient credits
      }

      const updated = await tx.apiKey.update({
        where: { id: apiKeyId },
        data: { creditsRemaining: { decrement: amount } },
      });

      return updated;
    });

    if (!result) {
      logger.warn({ apiKeyId, amount }, 'Insufficient credits for deduction');
      return false;
    }

    logger.info(
      { apiKeyId, amount, remaining: result.creditsRemaining },
      'Credits deducted',
    );
    return result.creditsRemaining >= 0;
  } catch (error) {
    logger.error({ error, apiKeyId, amount }, 'Credit deduction failed');
    return false;
  }
}

/**
 * Pre-flight credit check middleware.
 * Returns 402 if the user has zero or negative credits remaining.
 * This is a lightweight check -- actual deduction happens after job completion.
 */
export async function checkCredits(request: FastifyRequest, reply: FastifyReply) {
  const { apiKey } = request as AuthenticatedRequest;

  if (apiKey.creditsRemaining <= 0) {
    return reply.status(402).send({
      success: false,
      error: 'Insufficient credits. Please upgrade your plan at https://scrapesuite.dev/dashboard',
      creditsRemaining: 0,
    });
  }
}
