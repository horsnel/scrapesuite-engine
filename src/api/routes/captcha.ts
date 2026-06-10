/**
 * CAPTCHA API Routes -- ScrapeSuite Engine
 *
 * REST API endpoints for CAPTCHA detection, solving,
 * provider balance checking, and solver statistics.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { captchaSolver, captchaChallengeDetector } from '../../captcha';
import type { CaptchaDetection } from '../../captcha';
import { createChildLogger } from '../../utils/logger';

const logger = createChildLogger('api:captcha');

// --- Request/Response Interfaces -----------------------------------------------

interface DetectCaptchaBody {
  html: string;
}

interface SolveCaptchaBody {
  url: string;
  siteKey: string;
  type: 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile' | 'funcaptcha' | 'image';
  action?: string;
  minScore?: number;
  imageData?: string;
  proxyUrl?: string;
}

// --- Route Registration --------------------------------------------------------

export async function captchaRoutes(app: FastifyInstance): Promise<void> {

  // POST /v1/captcha/detect — Detect CAPTCHAs in HTML
  app.post('/v1/captcha/detect', async (req: FastifyRequest<{ Body: DetectCaptchaBody }>, reply: FastifyReply) => {
    const body = req.body;

    if (!body?.html) {
      return reply.status(400).send({
        success: false,
        error: 'html is required',
      });
    }

    try {
      const detection: CaptchaDetection = captchaChallengeDetector.detectFromHTML(body.html);

      return reply.send({
        success: true,
        data: detection,
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'CAPTCHA detection failed');
      return reply.status(500).send({
        success: false,
        error: err.message || 'CAPTCHA detection failed',
      });
    }
  });

  // POST /v1/captcha/solve — Solve a CAPTCHA
  app.post('/v1/captcha/solve', async (req: FastifyRequest<{ Body: SolveCaptchaBody }>, reply: FastifyReply) => {
    const body = req.body;

    if (!body?.url || !body?.siteKey || !body?.type) {
      return reply.status(400).send({
        success: false,
        error: 'url, siteKey, and type are required',
      });
    }

    const validTypes = ['recaptcha_v2', 'recaptcha_v3', 'hcaptcha', 'turnstile', 'funcaptcha', 'image'];
    if (!validTypes.includes(body.type)) {
      return reply.status(400).send({
        success: false,
        error: `Invalid CAPTCHA type. Must be one of: ${validTypes.join(', ')}`,
      });
    }

    try {
      if (!captchaSolver.isConfigured) {
        return reply.status(503).send({
          success: false,
          error: 'No CAPTCHA solving providers configured. Set TWOCAPTCHA_API_KEY, CAPSOLVER_API_KEY, or ANTICAPTCHA_API_KEY.',
        });
      }

      const result = await captchaSolver.solve({
        url: body.url,
        siteKey: body.siteKey,
        type: body.type,
        action: body.action,
        minScore: body.minScore,
        imageData: body.imageData,
        proxyUrl: body.proxyUrl,
      });

      return reply.send({
        success: result.success,
        data: {
          token: result.token,
          solveTimeMs: result.solveTimeMs,
          cost: result.cost,
          provider: result.provider,
        },
      });
    } catch (err: any) {
      logger.error({ type: body.type, error: err.message }, 'CAPTCHA solve failed');
      return reply.status(500).send({
        success: false,
        error: err.message || 'CAPTCHA solve failed',
      });
    }
  });

  // GET /v1/captcha/balance — Get provider balances
  app.get('/v1/captcha/balance', async (_req, reply) => {
    try {
      const balances = await captchaSolver.getBalances();
      return reply.send({
        success: true,
        data: balances,
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to get CAPTCHA balances');
      return reply.status(500).send({
        success: false,
        error: err.message || 'Failed to get CAPTCHA balances',
      });
    }
  });

  // GET /v1/captcha/stats — Get solver statistics
  app.get('/v1/captcha/stats', async (_req, reply) => {
    try {
      const isConfigured = captchaSolver.isConfigured;
      const balances = await captchaSolver.getBalances();
      const providerNames = Object.keys(balances);

      return reply.send({
        success: true,
        data: {
          isConfigured,
          providers: providerNames,
          providerCount: providerNames.length,
          balances,
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to get CAPTCHA stats');
      return reply.status(500).send({
        success: false,
        error: err.message || 'Failed to get CAPTCHA stats',
      });
    }
  });
}
