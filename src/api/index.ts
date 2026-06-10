import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import crypto from 'crypto';
import { scrapeRoutes } from './routes/scrape';
import { extractRoutes } from './routes/extract';
import { monitorRoutes } from './routes/monitor';
import { batchRoutes } from './routes/batch';
import { analyticsRoutes } from './routes/analytics';
import { webhookRoutes } from './routes/webhooks';
import { structuredRoutes } from './routes/structured';
import { serpRoutes } from './routes/serp';
import { proxyStatsRoutes } from './routes/proxy-stats';
import { sessionRoutes } from './routes/sessions';
import { templateRoutes } from './routes/templates';
import { collectorRoutes } from './routes/collectors';
import { rateLimitRoutes } from './routes/rate-limits';
import { ipPoolRoutes } from './routes/ip-pool';
import { innovationRoutes } from './routes/innovations';
import { authenticatedScrapingRoutes } from './routes/authenticated-scraping';
import { llmPipelineRoutes } from './routes/llm-pipeline';
import { datasetCatalogRoutes } from './routes/dataset-catalog';
import { dcimRoutes } from './routes/dcim';
import { quantumTLSRoutes } from './routes/quantum-tls';
import { multimodalRoutes } from './routes/multimodal';
import { infrastructureRoutes } from './routes/infrastructure';
import { akamaiRoutes } from './routes/akamai';
import { deviceFarmRoutes } from './routes/device-farm';
import { googleSuiteRoutes } from './routes/google-suite';
import { netflixSuiteRoutes } from './routes/netflix-suite';
import { akamaiUpdaterRoutes } from './routes/akamai-updater';
import { accountWarmerRoutes } from './routes/account-warmer';
import { selfImproverRoutes } from './routes/self-improver';
import { fusionReactorRoutes } from './fusion-reactor';
import { tiktokRoutes } from './tiktok';
import { youtubeRoutes } from './youtube';
import { redditRoutes } from './reddit';
import { realTimeLearnerRoutes } from './real-time-learner';
import { renderingPipelineRoutes } from './routes/rendering-pipeline';
import { tlsSpooferRoutes } from './routes/tls-spoofer';
import { captchaRoutes } from './routes/captcha';
import { proxyManager } from '../proxy/manager';
import { monitorScheduler } from '../scheduler/monitor';
import { browserPool } from '../browser-pool';
import { statsTracker } from '../stats';
import { getQueueMetrics } from '../workers/queue';
import { webhookDispatcher } from '../scheduler/webhooks';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('api');

// --- Server Builder ------------------------------------------------------------

export async function buildServer() {
  const app = Fastify({
    logger: false,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'reqId',
    ignoreTrailingSlash: true,
    trustProxy: true,
  });

  // -- Security & CORS ----------------------------------------------------------

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-Id'],
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    maxAge: 86400,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  });

  // -- Rate Limiting ------------------------------------------------------------

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      const apiKeyHeader = request.headers['x-api-key'] as string;
      const authHeader = request.headers.authorization;
      const queryApikey = (request.query as any)?.apikey as string;

      if (apiKeyHeader) return `key:${apiKeyHeader}`;
      if (authHeader?.startsWith('Bearer ')) return `key:${authHeader.substring(7)}`;
      if (queryApikey) return `key:${queryApikey}`;
      return `ip:${request.ip}`;
    },
    errorResponseBuilder: (_request, context) => ({
      success: false,
      error: 'Rate limit exceeded. Please slow down your requests.',
      retryAfter: Math.ceil(Number(context.after) / 1000),
    }),
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });

  // -- Global Error Handler ----------------------------------------------------

  app.setErrorHandler((error: Error, request: FastifyRequest, reply: FastifyReply) => {
    const fastifyError = error as any;

    if (fastifyError.validation) {
      return reply.status(400).send({
        success: false,
        error: 'Request validation error',
        details: fastifyError.validation,
      });
    }

    if (fastifyError.statusCode === 429) {
      return reply.status(429).send({
        success: false,
        error: 'Rate limit exceeded. Please slow down your requests.',
      });
    }

    logger.error(
      { error: error.message, stack: error.stack, url: request.url, method: request.method, statusCode: fastifyError.statusCode },
      'Unhandled request error',
    );

    const statusCode = fastifyError.statusCode || 500;
    return reply.status(statusCode).send({
      success: false,
      error: statusCode === 500 ? 'Internal server error' : error.message || 'Unknown error',
    });
  });

  // -- 404 Handler -------------------------------------------------------------

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      success: false,
      error: 'Endpoint not found',
      hint: 'Visit GET /v1 for available endpoints',
    });
  });

  // -- Health Route (enhanced) --------------------------------------------------

  app.get('/health', async () => {
    let queueMetrics: any = null;
    let proxyStats: any = null;
    let browserPoolStats: any = null;
    let realtimeStats: any = null;

    try { queueMetrics = await getQueueMetrics(); } catch {}
    try { proxyStats = await proxyManager.getPoolStats(); } catch {}
    try { browserPoolStats = browserPool.getStats(); } catch {}
    try { realtimeStats = await statsTracker.getRealTimeStats(); } catch {}

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      queues: queueMetrics,
      proxies: proxyStats,
      browserPool: browserPoolStats,
      realtime: realtimeStats,
    };
  });

  // -- SSE Endpoint for Real-time Job Progress ---------------------------------

  app.get('/v1/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);

    const pingInterval = setInterval(() => {
      try {
        reply.raw.write(`event: ping\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
      } catch {
        clearInterval(pingInterval);
      }
    }, 30_000);

    request.raw.on('close', () => {
      clearInterval(pingInterval);
    });
  });

  // -- Seed Route (protected by JWT_SECRET) ------------------------------------

  app.post('/internal/seed', async (request, reply) => {
    const secret = request.headers['x-seed-secret'] as string;
    if (secret !== process.env.JWT_SECRET) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const bcrypt = await import('bcryptjs');
    const { randomUUID } = await import('crypto');
    const { db } = await import('../utils/db');

    try {
      const passwordHash = await bcrypt.hash('Scrape2026!', 12);
      const userId = randomUUID();
      const user = await db.user.upsert({
        where: { email: 'admin@scrapesuite.com' },
        update: {},
        create: { id: userId, email: 'admin@scrapesuite.com', name: 'Admin', passwordHash, plan: 'business' },
      });

      const rawKey = 'ss_live_' + randomUUID().replace(/-/g, '');
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      await db.apiKey.upsert({
        where: { keyHash },
        update: {},
        create: { id: randomUUID(), userId: user.id, keyHash, plan: 'business', creditsRemaining: 5000000 },
      });

      // Seed diverse proxies across tiers, countries, cities, ASNs
      const proxyProviders = ['brightdata', 'oxylabs', 'smartproxy', 'iproyal'];
      const tiers = ['residential', 'datacenter', 'mobile', 'isp'] as const;
      const countries = ['US', 'GB', 'DE', 'FR', 'JP', 'BR', 'IN', 'CA', 'AU', 'SG'];
      const cities = ['New York', 'London', 'Frankfurt', 'Paris', 'Tokyo', 'Sao Paulo', 'Mumbai', 'Toronto', 'Sydney', 'Singapore'];
      const asns = ['AS7922', 'AS2856', 'AS3320', 'AS3215', 'AS4713', 'AS28573', 'AS9498', 'AS577', 'AS4804', 'AS7470'];

      for (let i = 0; i < 50; i++) {
        const proxyId = `seed-proxy-${i}`;
        const tier = tiers[i % 4];
        const countryIdx = i % countries.length;
        const provider = proxyProviders[i % proxyProviders.length];

        await db.proxy.upsert({
          where: { id: proxyId },
          update: {},
          create: {
            id: proxyId,
            url: `http://proxy-${i}.example.com:8080`,
            tier,
            country: countries[countryIdx],
            city: cities[countryIdx],
            asn: asns[countryIdx],
            isp: `ISP-${countries[countryIdx]}`,
            provider,
            successRate: 0.7 + Math.random() * 0.3,
            p95Latency: 500 + Math.floor(Math.random() * 2000),
          },
        });
      }

      return reply.send({
        success: true,
        user: { email: user.email, plan: user.plan },
        apiKey: rawKey,
        credits: 5000000,
        seededProxies: 50,
        proxyFeatures: ['residential', 'datacenter', 'mobile', 'isp', 'geotargeting', 'asn-targeting', 'city-targeting'],
      });
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // -- API Documentation Route -------------------------------------------------

  app.get('/v1', async () => ({
    name: 'ScrapeSuite API',
    version: '3.1.0',
    documentation: 'https://docs.scrapesuite.dev',
    endpoints: {
      scraping: [
        'POST   /v1/scrape            -- Submit a URL to scrape',
        'POST   /v1/scrape/batch      -- Submit multiple URLs (batch)',
        'POST   /v1/screenshot        -- Take a screenshot of a URL',
        'GET    /v1/jobs               -- List recent scrape jobs',
        'GET    /v1/jobs/:id           -- Check job status',
        'GET    /v1/results/:id        -- Get completed results',
        'GET    /v1/batch/:id          -- Get batch status',
        'GET    /v1/events             -- SSE stream for real-time updates',
      ],
      extraction: [
        'POST   /v1/extract            -- Extract data from HTML (NL)',
        'POST   /v1/extract/batch      -- Batch extraction',
      ],
      structuredData: [
        'POST   /v1/structured         -- Parse structured data (schema.org, OG)',
        'GET    /v1/structured/parsers -- List available parsers',
      ],
      serp: [
        'POST   /v1/serp               -- Execute a search engine query',
        'GET    /v1/serp/engines       -- List available search engines',
      ],
      monitoring: [
        'POST   /v1/monitor            -- Create a monitor',
        'GET    /v1/monitors           -- List monitors',
        'GET    /v1/monitor/:id        -- Get monitor details',
        'PATCH  /v1/monitor/:id        -- Update a monitor',
        'DELETE /v1/monitor/:id        -- Delete a monitor',
        'GET    /v1/monitor/:id/snapshots -- Get monitor snapshots',
      ],
      webhooks: [
        'POST   /v1/webhooks           -- Create a webhook',
        'GET    /v1/webhooks           -- List webhooks',
        'GET    /v1/webhooks/:id       -- Get webhook details',
        'PATCH  /v1/webhooks/:id       -- Update a webhook',
        'DELETE /v1/webhooks/:id       -- Delete a webhook',
        'POST   /v1/webhooks/:id/test  -- Test a webhook',
      ],
      proxyAndInfra: [
        'GET    /v1/proxy/stats        -- Get proxy pool statistics',
        'GET    /v1/proxy/countries    -- List available proxy countries',
        'POST   /v1/proxy/test         -- Test a proxy with a URL',
        'GET    /v1/captcha/balance    -- Get CAPTCHA solver balances',
        'GET    /v1/cost-estimate      -- Estimate cost for a request',
      ],
      analytics: [
        'GET    /v1/analytics/usage    -- Get usage statistics',
        'GET    /v1/analytics/domains  -- Get domain intelligence data',
      ],
      sessions: [
        'POST   /v1/sessions             -- Create a new sticky session',
        'GET    /v1/sessions             -- List user\'s active sessions',
        'GET    /v1/sessions/:id         -- Get session status',
        'DELETE /v1/sessions/:id         -- Terminate a session',
        'POST   /v1/sessions/:id/refresh -- Refresh session TTL',
      ],
      templates: [
        'GET    /v1/templates           -- List all available templates',
        'GET    /v1/templates/:id       -- Get template details',
        'POST   /v1/templates/detect    -- Detect which template applies to a URL',
      ],
      collectors: [
        'POST   /v1/collectors                    -- Create a collector',
        'GET    /v1/collectors                    -- List user\'s collectors',
        'GET    /v1/collectors/:id                -- Get collector details',
        'PATCH  /v1/collectors/:id                -- Update collector',
        'DELETE /v1/collectors/:id                -- Delete collector',
        'POST   /v1/collectors/:id/run            -- Run a collector (5 credits/URL)',
        'GET    /v1/collectors/:id/datasets       -- List datasets for collector',
        'GET    /v1/collectors/:id/datasets/latest -- Get latest dataset',
        'GET    /v1/datasets/:id                  -- Get dataset',
        'GET    /v1/datasets/:id/delta            -- Get delta vs previous run',
        'GET    /v1/datasets/:id/export           -- Export dataset (?format=json|csv)',
      ],
      rateLimits: [
        'GET    /v1/rate-limits/:domain  -- Get rate limit status for a domain (Business plan)',
        'GET    /v1/rate-limits          -- Get all currently throttled domains (Business plan)',
      ],
      ipPool: [
        'GET    /ip-pool/stats           -- Comprehensive pool statistics (legacy + smart + aggregator)',
        'GET    /ip-pool/smart-stats     -- Smart IP Pool specific stats and state',
        'GET    /ip-pool/composition     -- Provider composition with cost and health info',
        'GET    /ip-pool/providers       -- Residential provider health and stats',
        'POST   /ip-pool/prewarm         -- Pre-warm IPs for a domain',
        'GET    /ip-pool/reputation/:id  -- IP reputation lookup',
        'GET    /ip-pool/reputation/:id/:domain -- Domain-specific reputation verdict',
        'POST   /ip-pool/blacklist       -- Manually blacklist an IP for a domain',
        'POST   /ip-pool/unblacklist     -- Manually unblacklist an IP',
        'GET    /ip-pool/blacklist/:domain -- Blacklisted IPs for a domain',
        'POST   /ip-pool/services/start  -- Start all pool management services',
        'POST   /ip-pool/services/stop   -- Stop all pool management services',
      ],
    },
    features: {
      successOnlyBilling: 'Only successful requests are charged (Bright Data model)',
      proxyRotation: 'Smart proxy rotation with residential, datacenter, mobile, and ISP tiers',
      geotargeting: 'Country, city, and ASN-level proxy targeting',
      proxySupport: 'Actual proxy routing via undici ProxyAgent (HTTP/HTTPS/SOCKS)',
      antiBotStealth: 'AI-powered anti-bot detection with stealth browser mode',
      captchaSolving: 'Auto CAPTCHA solving via 2Captcha and CapSolver',
      robotsCompliance: 'Automatic robots.txt checking and compliance',
      structuredData: 'Pre-built parsers for Amazon, Google SERP, and generic schema.org',
      serpApi: 'Dedicated SERP API for Google, Bing, Yahoo, DuckDuckGo with engine-specific parsers',
      webhooks: 'Real-time notifications for job events with retry logic',
      nlExtraction: 'Natural language extraction powered by Claude AI',
      browserPool: 'Shared browser pool with auto-scaling and idle recycling',
      requestDeduplication: 'Concurrent identical requests are deduplicated automatically',
      bandwidthTracking: 'Full bandwidth usage tracking per job and API key',
      screenshotApi: 'Take full-page or viewport screenshots via browser pool',
      concurrentLimits: 'Per-user concurrent request limits based on plan tier',
      batchProcessing: 'Submit up to 100 URLs at once',
      stickySessions: 'Persistent sessions with geo-consistent proxy assignment and fingerprint pinning',
      scraperTemplates: '10 pre-built extraction templates for popular sites (Amazon, Google, LinkedIn, etc.)',
      collectors: 'Recurring structured data collection with delta detection and CSV/JSON export',
      adaptiveRateLimiting: 'Per-domain adaptive rate control with token-bucket burst and cross-domain throttling',
      smartIPPool: 'Unified mega-pool with reputation-aware IP selection, auto-scaling, IP cooling, and multi-provider aggregation',
      ipReputation: 'Per-domain IP reputation tracking with automatic blacklisting and cooldown periods',
      proxyAggregator: 'Cost-optimized multi-provider aggregation with dynamic priority rebalancing',
      ipPrewarming: 'Proactive IP pre-warming for high-traffic domains',
    },
    authentication: 'Provide API key via Authorization: Bearer <key>, X-API-Key header, or ?apikey= query param',
  }));

  // -- Register Route Modules --------------------------------------------------

  await app.register(scrapeRoutes);
  await app.register(extractRoutes);
  await app.register(monitorRoutes);
  await app.register(batchRoutes);
  await app.register(analyticsRoutes);
  await app.register(webhookRoutes);
  await app.register(structuredRoutes);
  await app.register(serpRoutes);
  await app.register(proxyStatsRoutes);
  await app.register(sessionRoutes);
  await app.register(templateRoutes);
  await app.register(collectorRoutes);
  await app.register(rateLimitRoutes);
  await app.register(ipPoolRoutes);
  await app.register(innovationRoutes);
  await app.register(authenticatedScrapingRoutes);
  await app.register(llmPipelineRoutes);
  await app.register(datasetCatalogRoutes);
  await app.register(dcimRoutes);
  await app.register(quantumTLSRoutes);
  await app.register(multimodalRoutes);
  await app.register(infrastructureRoutes);
  await app.register(akamaiRoutes);
  await app.register(deviceFarmRoutes);
  await app.register(googleSuiteRoutes);
  await app.register(netflixSuiteRoutes);
  await app.register(akamaiUpdaterRoutes);
  await app.register(accountWarmerRoutes);
  await app.register(selfImproverRoutes);
  await app.register(fusionReactorRoutes);
  await app.register(tiktokRoutes);
  await app.register(youtubeRoutes);
  await app.register(redditRoutes);
  await app.register(realTimeLearnerRoutes);
  await app.register(renderingPipelineRoutes);
  await app.register(tlsSpooferRoutes);
  await app.register(captchaRoutes);

  return app;
}

// --- Server Starter ----------------------------------------------------------

export async function startServer() {
  const app = await buildServer();
  const port = parseInt(process.env.PORT || '3001', 10);
  const host = process.env.HOST || '0.0.0.0';

  try {
    await app.listen({ port, host });
    logger.info(
      { port, host, nodeEnv: process.env.NODE_ENV || 'development', pid: process.pid },
      'ScrapeSuite API server started',
    );

    // Initialize browser pool
    try {
      await browserPool.initialize();
      logger.info('Browser pool initialized');
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Browser pool initialization failed -- will launch on demand');
    }

    // Start all proxy pool services (health checks, pool monitor, reputation decay, aggregator rebalancing)
    proxyManager.startAllServices();

    // Start monitor scheduler
    monitorScheduler.start();

    // Start stats tracker
    statsTracker.start();

    // Start webhook dispatcher
    webhookDispatcher.start();

    // Start adaptive rate limiter cleanup
    const { adaptiveRateLimiter } = await import('../rate-limiter');
    adaptiveRateLimiter.startCleanup();
    logger.info('Adaptive rate limiter started');

    // Start session manager cleanup
    const { sessionManager } = await import('../session');
    sessionManager.startCleanup();
    logger.info('Session manager started');

  } catch (err) {
    logger.error(err, 'Failed to start server');
    process.exit(1);
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received, closing server...');
    try {
      const { adaptiveRateLimiter } = await import('../rate-limiter');
      const { sessionManager } = await import('../session');
      adaptiveRateLimiter.stopCleanup();
      sessionManager.stopCleanup();
      proxyManager.stopAllServices();
      monitorScheduler.stop();
      statsTracker.stop();
      await webhookDispatcher.stop();
      await browserPool.shutdown();
      await app.close();
      logger.info('Server closed gracefully');
      process.exit(0);
    } catch (err) {
      logger.error(err, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return app;
}
