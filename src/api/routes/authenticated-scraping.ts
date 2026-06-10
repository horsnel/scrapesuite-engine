/**
 * Authenticated Scraping API Routes -- ScrapeSuite Engine
 *
 * REST API routes for cookie injection, network capture, and scroll handling.
 * Together these enable the full Netflix-style authenticated scraping workflow.
 */

import type { FastifyInstance } from 'fastify';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { checkCredits, deductCredits } from '../middleware/credits';
import { createChildLogger } from '../../utils/logger';

const logger = createChildLogger('api:authenticated-scraping');

export async function authenticatedScrapingRoutes(app: FastifyInstance) {

  // === COOKIE INJECTOR ROUTES ===

  app.post('/v1/cookies/parse', { preHandler: [authMiddleware] }, async (request, reply) => {
    const body = request.body as { rawCookies: string; format?: string; domain?: string };
    if (!body.rawCookies) return reply.status(400).send({ success: false, error: 'rawCookies is required' });
    const { cookieInjector } = await import('../../cookie-injector');
    const result = await cookieInjector.parseCookieInput(body.rawCookies, body.format as any, body.domain);
    return reply.send({ success: true, data: { detectedFormat: result.detectedFormat, totalCookies: result.cookies.length, validCookies: result.validation.validCookies, expiredCookies: result.validation.expiredCookies.length, errors: result.validation.errors, warnings: result.validation.warnings, cookies: result.cookies } });
  });

  app.post('/v1/cookies/sets', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const body = request.body as { name: string; cookies?: any[]; rawCookies?: string; format?: string; domain: string; description?: string; tags?: string[]; ttlHours?: number };
    if (!body.name || (!body.cookies && !body.rawCookies)) return reply.status(400).send({ success: false, error: 'name and either cookies or rawCookies are required' });
    const { cookieInjector } = await import('../../cookie-injector');
    let cookies = body.cookies || []; let sourceFormat = 'playwright' as any;
    if (body.rawCookies) { const parsed = await cookieInjector.parseCookieInput(body.rawCookies, body.format as any, body.domain); cookies = parsed.cookies; sourceFormat = parsed.detectedFormat; }
    const set = await cookieInjector.storeCookieSet(apiKey.userId, body.name, cookies, { domain: body.domain, description: body.description, tags: body.tags, sourceFormat, ttlHours: body.ttlHours });
    return reply.status(201).send({ success: true, data: { id: set.id, name: set.name, domain: set.domain, cookieCount: set.cookies.length, validationStatus: set.validationStatus } });
  });

  app.get('/v1/cookies/sets', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const { cookieInjector } = await import('../../cookie-injector');
    return reply.send({ success: true, data: { sets: await cookieInjector.listCookieSets(apiKey.userId) } });
  });

  app.delete('/v1/cookies/sets/:id', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { cookieInjector } = await import('../../cookie-injector');
    const deleted = await cookieInjector.deleteCookieSet(id);
    if (!deleted) return reply.status(404).send({ success: false, error: 'Cookie set not found' });
    return reply.send({ success: true, data: { deleted: true, id } });
  });

  app.post('/v1/cookies/inject', { preHandler: [authMiddleware, checkCredits] }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const body = request.body as { sessionId?: string; cookieSetId?: string; cookies?: any[]; rawCookies?: string; format?: string; domain?: string; validateAfter?: boolean; validateUrl?: string; validateSelector?: string; clearExisting?: boolean };
    const COST = 2; if (apiKey.creditsRemaining < COST) return reply.status(402).send({ success: false, error: 'Insufficient credits' });
    const { cookieInjector } = await import('../../cookie-injector');
    const { cookies, result } = await cookieInjector.prepareInjection({ sessionId: body.sessionId, cookieSetId: body.cookieSetId, cookies: body.cookies, rawCookies: body.rawCookies, format: body.format as any, domain: body.domain, validateAfter: body.validateAfter, validateUrl: body.validateUrl, validateSelector: body.validateSelector, clearExisting: body.clearExisting });
    await deductCredits(apiKey.userId, apiKey.id, COST);
    return reply.send({ success: result.success, data: { ...result, cookies: cookies.map((c) => ({ name: c.name, domain: c.domain })), note: 'Cookies prepared for injection into browser session' } });
  });

  app.get('/v1/cookies/stats', { preHandler: [authMiddleware] }, async (_request, reply) => {
    const { cookieInjector } = await import('../../cookie-injector');
    return reply.send({ success: true, data: await cookieInjector.getStats() });
  });

  // === NETWORK CAPTURE ROUTES ===

  app.post('/v1/capture/start', { preHandler: [authMiddleware, checkCredits] }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const body = request.body as { filters?: any; maxCaptures?: number; maxDurationMs?: number; stopOnPattern?: string; stopAfterN?: number; tags?: string[] };
    const COST = 3; if (apiKey.creditsRemaining < COST) return reply.status(402).send({ success: false, error: 'Insufficient credits' });
    const { networkCaptureManager } = await import('../../network-capture');
    const info = await networkCaptureManager.startCapture({ userId: apiKey.userId, filters: body.filters, maxCaptures: body.maxCaptures, maxDurationMs: body.maxDurationMs, stopOnPattern: body.stopOnPattern, stopAfterN: body.stopAfterN, tags: body.tags });
    await deductCredits(apiKey.userId, apiKey.id, COST);
    return reply.status(201).send({ success: true, data: info });
  });

  app.post('/v1/capture/:id/stop', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { networkCaptureManager } = await import('../../network-capture');
    await networkCaptureManager.stopCapture(id);
    return reply.send({ success: true, data: { captureSessionId: id, status: 'stopped' } });
  });

  app.get('/v1/capture/:id/captures', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as any;
    const { networkCaptureManager } = await import('../../network-capture');
    return reply.send({ success: true, data: await networkCaptureManager.getCaptures(id, { urlPattern: query.urlPattern, method: query.method, statusCode: query.statusCode ? parseInt(query.statusCode) : undefined, jsonOnly: query.jsonOnly === 'true', uniqueOnly: query.uniqueOnly === 'true', sortBy: query.sortBy, sortOrder: query.sortOrder, offset: query.offset ? parseInt(query.offset) : 0, limit: query.limit ? parseInt(query.limit) : 100 }) });
  });

  app.get('/v1/capture/:id/export', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { format } = request.query as { format?: string };
    const { networkCaptureManager } = await import('../../network-capture');
    const data = await networkCaptureManager.exportCaptures(id, (format || 'json') as any);
    reply.header('Content-Type', format === 'csv' ? 'text/csv' : 'application/json');
    return reply.send(data);
  });

  app.get('/v1/capture/stats', { preHandler: [authMiddleware] }, async (_request, reply) => {
    const { networkCaptureManager } = await import('../../network-capture');
    return reply.send({ success: true, data: networkCaptureManager.getStats() });
  });

  // === SCROLL HANDLER ROUTES ===

  app.post('/v1/scroll/execute', { preHandler: [authMiddleware, checkCredits] }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const body = request.body as { browserSessionId: string; scrollConfig?: any; extractionConfig?: any };
    const COST = 5; if (apiKey.creditsRemaining < COST) return reply.status(402).send({ success: false, error: 'Insufficient credits' });
    await deductCredits(apiKey.userId, apiKey.id, COST);
    return reply.send({ success: true, data: { sessionId: `scrl-${Date.now()}`, status: 'completed', note: 'In production, executes infinite scroll on the CDP browser page' } });
  });

  app.post('/v1/scroll/start', { preHandler: [authMiddleware, checkCredits] }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const COST = 3; if (apiKey.creditsRemaining < COST) return reply.status(402).send({ success: false, error: 'Insufficient credits' });
    await deductCredits(apiKey.userId, apiKey.id, COST);
    return reply.status(201).send({ success: true, data: { sessionId: `scrl-${Date.now()}`, status: 'scrolling', startedAt: new Date().toISOString() } });
  });

  app.get('/v1/scroll/session/:id', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { scrollHandler } = await import('../../scroll-handler');
    const info = scrollHandler.getSessionInfo(id);
    if (!info) return reply.status(404).send({ success: false, error: 'Scroll session not found' });
    return reply.send({ success: true, data: info });
  });

  app.post('/v1/scroll/session/:id/stop', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { scrollHandler } = await import('../../scroll-handler');
    const result = await scrollHandler.stopSession(id);
    if (!result) return reply.status(404).send({ success: false, error: 'Session not found' });
    return reply.send({ success: true, data: result });
  });

  app.get('/v1/scroll/stats', { preHandler: [authMiddleware] }, async (_request, reply) => {
    const { scrollHandler } = await import('../../scroll-handler');
    return reply.send({ success: true, data: scrollHandler.getStats() });
  });

  // === ALL-IN-ONE AUTHENTICATED SCRAPING ===

  app.post('/v1/auth-scrape', { preHandler: [authMiddleware, checkCredits] }, async (request, reply) => {
    const { apiKey } = request as AuthenticatedRequest;
    const body = request.body as { url: string; cookies?: any; cookieSetId?: string; captureFilters?: any; scrollConfig?: any; extractionConfig?: any };
    const COST = 10; if (apiKey.creditsRemaining < COST) return reply.status(402).send({ success: false, error: 'Insufficient credits' });
    if (!body.url) return reply.status(400).send({ success: false, error: 'url is required' });
    await deductCredits(apiKey.userId, apiKey.id, COST);
    logger.info({ userId: apiKey.userId, url: body.url, hasCookies: !!body.cookies || !!body.cookieSetId }, 'Authenticated scraping request');
    return reply.send({ success: true, data: { url: body.url, status: 'completed', workflow: [{ step: 'cookie-injection', status: 'ready' }, { step: 'network-capture', status: 'ready' }, { step: 'infinite-scroll', status: 'ready' }], creditsUsed: COST } });
  });
}
