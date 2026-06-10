/**
 * IP Pool Management API Routes -- OVERDRIVE EDITION
 *
 * Endpoints for monitoring and managing the Smart IP Pool:
 *  - Pool statistics (utilization, composition, health)
 *  - Domain pre-warming
 *  - IP reputation lookup
 *  - Blacklist management
 *  - Provider composition
 *  - Pool auto-scaling control
 *  - Nuclear Fusion reactor control (ignition, status, Q-factor, afterburner)
 *  - Chain reaction, breeding, quantum tunnel, plasma, containment
 *  - Free proxy discovery, TOR pool, bulk sessions, validation
 *  - Subnet expander and rotating session factory
 *  - CAPTCHA solver (5 providers, 12+ types)
 *  - Web Unlocker (5 stealth levels, challenge library)
 *  - Domain intelligence and adaptive strategy
 *  - Cost optimization
 *  - Module health monitoring
 *  - Unified dashboard
 */

import type { FastifyInstance } from 'fastify';
import { proxyManager } from '../../proxy/manager';
import { smartIPPool } from '../../proxy/ip-pool';
import { ipReputationTracker } from '../../proxy/reputation';
import { proxyAggregator } from '../../proxy/aggregator';
import { residentialProxyManager } from '../../proxy/residential-providers';
import { megaPool } from '../../proxy/mega-pool';

export async function ipPoolRoutes(app: FastifyInstance) {
  // ===========================================================================
  // CORE POOL STATISTICS
  // ===========================================================================

  // --- GET /ip-pool/stats -- Comprehensive pool statistics ----------------

  app.get('/ip-pool/stats', async (_request, reply) => {
    try {
      const stats = await proxyManager.getEnhancedPoolStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/smart-stats -- Smart IP Pool specific stats -----------

  app.get('/ip-pool/smart-stats', async (_request, reply) => {
    try {
      const [stats, state] = await Promise.all([
        smartIPPool.getPoolStats(),
        Promise.resolve(smartIPPool.getPoolState()),
      ]);
      return { success: true, data: { stats, state } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/composition -- Provider composition -------------------

  app.get('/ip-pool/composition', async (_request, reply) => {
    try {
      const composition = await proxyAggregator.getComposition();
      return { success: true, data: composition };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/providers -- Provider health and stats ---------------

  app.get('/ip-pool/providers', async (_request, reply) => {
    try {
      const stats = residentialProxyManager.getProviderStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/prewarm -- Pre-warm IPs for a domain ----------------

  app.post('/ip-pool/prewarm', async (request, reply) => {
    try {
      const { domain, tier, country } = request.body as {
        domain: string;
        tier?: 'residential' | 'mobile' | 'datacenter' | 'isp';
        country?: string;
      };

      if (!domain) {
        return reply.status(400).send({ success: false, error: 'domain is required' });
      }

      const warmed = await proxyManager.prewarmDomain(domain, tier, country);
      return { success: true, data: { domain, warmed, tier: tier || 'residential', country } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/reputation/:proxyId -- IP reputation lookup ----------

  app.get('/ip-pool/reputation/:proxyId', async (request, reply) => {
    try {
      const { proxyId } = request.params as { proxyId: string };
      const stats = await ipReputationTracker.getProxyStats(proxyId);
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/reputation/:proxyId/:domain -- Domain-specific verdict

  app.get('/ip-pool/reputation/:proxyId/:domain', async (request, reply) => {
    try {
      const { proxyId, domain } = request.params as { proxyId: string; domain: string };
      const verdict = await ipReputationTracker.getVerdict(proxyId, domain);
      return { success: true, data: verdict };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/blacklist -- Manually blacklist an IP ---------------

  app.post('/ip-pool/blacklist', async (request, reply) => {
    try {
      const { proxyId, domain, reason, cooldownMs } = request.body as {
        proxyId: string;
        domain: string;
        reason: string;
        cooldownMs?: number;
      };

      if (!proxyId || !domain || !reason) {
        return reply.status(400).send({ success: false, error: 'proxyId, domain, and reason are required' });
      }

      await ipReputationTracker.blacklistProxy(proxyId, domain, reason, cooldownMs);
      return { success: true, data: { proxyId, domain, reason, blacklisted: true } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/unblacklist -- Manually unblacklist an IP -----------

  app.post('/ip-pool/unblacklist', async (request, reply) => {
    try {
      const { proxyId, domain } = request.body as {
        proxyId: string;
        domain: string;
      };

      if (!proxyId || !domain) {
        return reply.status(400).send({ success: false, error: 'proxyId and domain are required' });
      }

      await ipReputationTracker.unblacklistProxy(proxyId, domain);
      return { success: true, data: { proxyId, domain, blacklisted: false } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/blacklist/:domain -- Blacklisted IPs for a domain ----

  app.get('/ip-pool/blacklist/:domain', async (request, reply) => {
    try {
      const { domain } = request.params as { domain: string };
      const blacklisted = await ipReputationTracker.getBlacklistedForDomain(domain);
      return { success: true, data: { domain, blacklisted, count: blacklisted.length } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/services/start -- Start all pool services -----------

  app.post('/ip-pool/services/start', async (_request, reply) => {
    try {
      proxyManager.startAllServices();
      return { success: true, data: { message: 'All pool services started (including Nuclear Fusion OVERDRIVE system)' } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/services/stop -- Stop all pool services -------------

  app.post('/ip-pool/services/stop', async (_request, reply) => {
    try {
      proxyManager.stopAllServices();
      return { success: true, data: { message: 'All pool services stopped' } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // ===========================================================================
  // UNIFIED DASHBOARD & INTELLIGENCE
  // ===========================================================================

  // --- GET /ip-pool/unified -- Unified pool stats from ALL 19 modules ----

  app.get('/ip-pool/unified', async (_request, reply) => {
    try {
      const stats = await proxyManager.getUnifiedPoolStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/dashboard -- Real-time dashboard snapshot ------------

  app.get('/ip-pool/dashboard', async (_request, reply) => {
    try {
      const [unified, cached] = await Promise.all([
        proxyManager.getUnifiedPoolStats(),
        Promise.resolve(proxyManager.getCachedStats()),
      ]);
      return { success: true, data: { unified, cached } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/module-health -- Module health across all 19 modules -

  app.get('/ip-pool/module-health', async (_request, reply) => {
    try {
      const health = proxyManager.getModuleHealthStatus();
      return { success: true, data: health };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/domain-intelligence -- Domain intelligence summary ---

  app.get('/ip-pool/domain-intelligence', async (_request, reply) => {
    try {
      const intel = proxyManager.getDomainIntelligenceSummary();
      return { success: true, data: intel };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/domain-intelligence/:domain -- Domain-specific intel --

  app.get('/ip-pool/domain-intelligence/:domain', async (request, reply) => {
    try {
      const { domain } = request.params as { domain: string };
      const intel = proxyManager.getDomainIntelligence(domain);
      return { success: true, data: { domain, ...intel } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/cost-optimization -- Cost optimization summary --------

  app.get('/ip-pool/cost-optimization', async (_request, reply) => {
    try {
      const cost = proxyManager.getCostOptimization('*');
      return { success: true, data: cost };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/diagnostic -- Full diagnostic report -----------------

  app.get('/ip-pool/diagnostic', async (_request, reply) => {
    try {
      const diag = await proxyManager.getDiagnosticReport();
      return { success: true, data: diag };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // ===========================================================================
  // Nuclear Fusion System -- Reactor Control & Monitoring (OVERDRIVE)
  // ===========================================================================

  // --- GET /ip-pool/fusion/status -- Fusion reactor status ---------------

  app.get('/ip-pool/fusion/status', async (_request, reply) => {
    try {
      const status = await proxyManager.getFusionStatus();
      return { success: true, data: status };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/fusion/ignite -- Ignite the Nuclear Fusion reactor --

  app.post('/ip-pool/fusion/ignite', async (request, reply) => {
    try {
      const { targetQFactor, maxReactionRate, neutronModeration } = request.body as {
        targetQFactor?: number;
        maxReactionRate?: number;
        neutronModeration?: number;
      };
      const result = await proxyManager.igniteFusion({ targetQFactor, maxReactionRate, neutronModeration });
      return { success: true, data: result };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/fusion/shutdown -- Graceful fusion shutdown ---------

  app.post('/ip-pool/fusion/shutdown', async (_request, reply) => {
    try {
      await proxyManager.shutdownFusion();
      return { success: true, data: { message: 'Fusion reactor shut down' } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/fusion/scram -- Emergency SCRAM --------------------

  app.post('/ip-pool/fusion/scram', async (_request, reply) => {
    try {
      await proxyManager.scramFusion();
      return { success: true, data: { message: 'SCRAM activated -- all fusion operations halted' } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/fusion/q-factor -- Q-factor measurement --------------

  app.get('/ip-pool/fusion/q-factor', async (_request, reply) => {
    try {
      const { fusionCore } = await import('../../proxy/fusion-core');
      const qFactor = fusionCore.getQFactor();
      return { success: true, data: { qFactor, selfSustaining: qFactor > 1.0, afterburner: qFactor > 5.0 } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/fusion/milestones -- Fusion milestones --------------

  app.get('/ip-pool/fusion/milestones', async (_request, reply) => {
    try {
      const { fusionCore } = await import('../../proxy/fusion-core');
      const milestones = await fusionCore.getMilestones();
      return { success: true, data: milestones };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/fusion/inject-fuel -- Inject fuel into reactor -----

  app.post('/ip-pool/fusion/inject-fuel', async (request, reply) => {
    try {
      const { fuelType, amount } = request.body as { fuelType: string; amount: number };
      if (!fuelType || !amount) {
        return reply.status(400).send({ success: false, error: 'fuelType and amount are required' });
      }
      const { fusionCore } = await import('../../proxy/fusion-core');
      const injected = await fusionCore.injectFuel(fuelType, amount);
      return { success: true, data: { fuelType, requested: amount, injected } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/fusion/adjust-rate -- Adjust reaction rate ----------

  app.post('/ip-pool/fusion/adjust-rate', async (request, reply) => {
    try {
      const { rate } = request.body as { rate: number };
      if (rate === undefined) {
        return reply.status(400).send({ success: false, error: 'rate is required (0.1 to 5.0)' });
      }
      const { fusionCore } = await import('../../proxy/fusion-core');
      fusionCore.adjustReactionRate(rate);
      return { success: true, data: { rate, message: 'Reaction rate adjusted' } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/fusion/recommendations -- Optimization recommendations

  app.get('/ip-pool/fusion/recommendations', async (_request, reply) => {
    try {
      const { fusionCore } = await import('../../proxy/fusion-core');
      const recommendations = await fusionCore.getFusionRecommendations();
      return { success: true, data: { recommendations } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // ===========================================================================
  // Mega Pool -- Unified Pool Across All Sources
  // ===========================================================================

  // --- GET /ip-pool/mega/stats -- Mega pool statistics -------------------

  app.get('/ip-pool/mega/stats', async (_request, reply) => {
    try {
      const stats = await megaPool.getStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/mega/size -- Total effective IP count ----------------

  app.get('/ip-pool/mega/size', async (_request, reply) => {
    try {
      const size = await megaPool.getTotalPoolSize();
      return { success: true, data: { totalEffectiveIPs: size } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/mega/fusion-readiness -- Fusion readiness check -----

  app.get('/ip-pool/mega/fusion-readiness', async (_request, reply) => {
    try {
      const readiness = await megaPool.getFusionReadiness();
      return { success: true, data: readiness };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // ===========================================================================
  // Sub-Module Stats Endpoints
  // ===========================================================================

  // --- GET /ip-pool/discovery/stats -- Free proxy discovery stats --------

  app.get('/ip-pool/discovery/stats', async (_request, reply) => {
    try {
      const { freeProxyDiscovery } = await import('../../proxy/free-proxy-discovery');
      const stats = freeProxyDiscovery.getStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/discovery/run -- Trigger manual discovery cycle -----

  app.post('/ip-pool/discovery/run', async (_request, reply) => {
    try {
      const { freeProxyDiscovery } = await import('../../proxy/free-proxy-discovery');
      const result = await freeProxyDiscovery.runDiscoveryCycle();
      return { success: true, data: result };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/discovery/fast-mode -- Toggle fast discovery mode ---

  app.post('/ip-pool/discovery/fast-mode', async (request, reply) => {
    try {
      const { enabled } = request.body as { enabled: boolean };
      const { freeProxyDiscovery } = await import('../../proxy/free-proxy-discovery');
      if (enabled) {
        freeProxyDiscovery.enableFastMode();
      } else {
        freeProxyDiscovery.disableFastMode();
      }
      return { success: true, data: { fastMode: enabled } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/tor/stats -- TOR pool stats -------------------------

  app.get('/ip-pool/tor/stats', async (_request, reply) => {
    try {
      const { torPool } = await import('../../proxy/tor-pool');
      const stats = torPool.getStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/tor/diagnostic -- TOR pool diagnostic report --------

  app.get('/ip-pool/tor/diagnostic', async (_request, reply) => {
    try {
      const { torPool } = await import('../../proxy/tor-pool');
      const report = torPool.getDiagnosticReport();
      return { success: true, data: report };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/bulk-sessions/stats -- Bulk session stats ------------

  app.get('/ip-pool/bulk-sessions/stats', async (_request, reply) => {
    try {
      const { bulkSessionManager } = await import('../../proxy/bulk-sessions');
      const stats = bulkSessionManager.getStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/bulk-sessions/dashboard -- Bulk session dashboard ----

  app.get('/ip-pool/bulk-sessions/dashboard', async (_request, reply) => {
    try {
      const { bulkSessionManager } = await import('../../proxy/bulk-sessions');
      const dashboard = bulkSessionManager.getDashboardData();
      return { success: true, data: dashboard };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/bulk-sessions/force-replenish -- Force replenish ---

  app.post('/ip-pool/bulk-sessions/force-replenish', async (_request, reply) => {
    try {
      const { bulkSessionManager } = await import('../../proxy/bulk-sessions');
      await bulkSessionManager.forceReplenish();
      return { success: true, data: { message: 'Force replenish triggered' } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/validation/stats -- Validation pipeline stats --------

  app.get('/ip-pool/validation/stats', async (_request, reply) => {
    try {
      const { validationPipeline } = await import('../../proxy/validation-pipeline');
      const stats = validationPipeline.getStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/subnet/stats -- Subnet expander stats ---------------

  app.get('/ip-pool/subnet/stats', async (_request, reply) => {
    try {
      const { subnetExpander } = await import('../../proxy/subnet-expander');
      const stats = subnetExpander.getStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/subnet/capacity/:country -- Capacity for a country --

  app.get('/ip-pool/subnet/capacity/:country', async (request, reply) => {
    try {
      const { country } = request.params as { country: string };
      const { subnetExpander } = await import('../../proxy/subnet-expander');
      const capacity = subnetExpander.getCapacityByCountry(country);
      return { success: true, data: { country, capacity } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/subnet/diversity -- Diversity score -----------------

  app.get('/ip-pool/subnet/diversity', async (_request, reply) => {
    try {
      const { subnetExpander } = await import('../../proxy/subnet-expander');
      const diversity = subnetExpander.getDiversityScore();
      return { success: true, data: { diversityScore: diversity } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/subnet/dashboard -- Subnet expander dashboard --------

  app.get('/ip-pool/subnet/dashboard', async (_request, reply) => {
    try {
      const { subnetExpander } = await import('../../proxy/subnet-expander');
      const dashboard = subnetExpander.getDashboard();
      return { success: true, data: dashboard };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/rotating-sessions/stats -- Rotating session stats ----

  app.get('/ip-pool/rotating-sessions/stats', async (_request, reply) => {
    try {
      const { rotatingSessionFactory } = await import('../../proxy/rotating-session-factory');
      const stats = rotatingSessionFactory.getStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/rotating-sessions/dashboard -- Session factory dashboard

  app.get('/ip-pool/rotating-sessions/dashboard', async (_request, reply) => {
    try {
      const { rotatingSessionFactory } = await import('../../proxy/rotating-session-factory');
      const dashboard = rotatingSessionFactory.getDashboardSnapshot();
      return { success: true, data: dashboard };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // ===========================================================================
  // Chain Reaction, Breeder, Quantum Tunnel, Plasma, Containment
  // ===========================================================================

  // --- GET /ip-pool/chain-reaction/stats -- Chain reaction stats ---------

  app.get('/ip-pool/chain-reaction/stats', async (_request, reply) => {
    try {
      const { chainReaction } = await import('../../proxy/chain-reaction');
      const stats = chainReaction.getStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/chain-reaction/seed -- Seed a chain reaction --------

  app.post('/ip-pool/chain-reaction/seed', async (request, reply) => {
    try {
      const { proxies } = request.body as { proxies: Array<{ url: string; id?: string }> };
      if (!proxies || proxies.length === 0) {
        return reply.status(400).send({ success: false, error: 'proxies array is required (each with url field)' });
      }
      const { chainReaction } = await import('../../proxy/chain-reaction');
      await chainReaction.seedReaction(proxies);
      return { success: true, data: { seeded: proxies.length, message: 'Chain reaction seeded' } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/chain-reaction/subnet-graph -- Hot subnet analysis --

  app.get('/ip-pool/chain-reaction/subnet-graph', async (_request, reply) => {
    try {
      const { chainReaction } = await import('../../proxy/chain-reaction');
      const graph = await chainReaction.getSubnetGraph();
      const entries = Array.from(graph.entries()).map(([subnet, data]) => ({ subnet, ...data }));
      return { success: true, data: { subnets: entries, total: entries.length } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/breeder/stats -- Breeder reactor stats --------------

  app.get('/ip-pool/breeder/stats', async (_request, reply) => {
    try {
      const { breederReactor } = await import('../../proxy/breeder-reactor');
      const stats = breederReactor.getStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/breeder/breed -- Trigger manual breeding ------------

  app.post('/ip-pool/breeder/breed', async (request, reply) => {
    try {
      const { proxyId } = request.body as { proxyId?: string };
      const { breederReactor } = await import('../../proxy/breeder-reactor');
      if (proxyId) {
        const result = await breederReactor.breedFromProxy(proxyId);
        return { success: true, data: result };
      }
      breederReactor.startBreeding();
      const result = { message: 'Breeding started' };
      return { success: true, data: result };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/quantum-tunnel/stats -- Quantum tunnel stats --------

  app.get('/ip-pool/quantum-tunnel/stats', async (_request, reply) => {
    try {
      const { quantumTunnel } = await import('../../proxy/quantum-tunnel');
      const stats = quantumTunnel.getStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/quantum-tunnel/enumerate -- DNS enumeration --------

  app.post('/ip-pool/quantum-tunnel/enumerate', async (request, reply) => {
    try {
      const { domain } = request.body as { domain: string };
      if (!domain) {
        return reply.status(400).send({ success: false, error: 'domain is required' });
      }
      const { quantumTunnel } = await import('../../proxy/quantum-tunnel');
      const results = await quantumTunnel.dnsEnumerate(domain);
      return { success: true, data: { domain, endpoints: results, count: results.length } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/plasma/stats -- Plasma state stats ------------------

  app.get('/ip-pool/plasma/stats', async (_request, reply) => {
    try {
      const { plasmaState } = await import('../../proxy/plasma-state');
      const stats = plasmaState.getStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/containment/stats -- Containment shield stats -------

  app.get('/ip-pool/containment/stats', async (_request, reply) => {
    try {
      const { containmentShield } = await import('../../proxy/containment');
      const stats = containmentShield.getStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/containment/purge -- Purge low-quality proxies -----

  app.post('/ip-pool/containment/purge', async (request, reply) => {
    try {
      const { threshold } = request.body as { threshold?: number };
      const { containmentShield } = await import('../../proxy/containment');
      const purged = await containmentShield.purgeLowQuality(threshold ?? 30);
      return { success: true, data: { purged, threshold: threshold ?? 30 } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/containment/scram -- Emergency SCRAM shutdown ------

  app.post('/ip-pool/containment/scram', async (_request, reply) => {
    try {
      const { containmentShield } = await import('../../proxy/containment');
      containmentShield.scram();
      return { success: true, data: { message: 'SCRAM activated -- all discovery halted' } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // ===========================================================================
  // CAPTCHA Solver -- 5 Providers, 12+ Types, Circuit Breakers
  // ===========================================================================

  // --- GET /ip-pool/captcha/stats -- CAPTCHA solver statistics -----------

  app.get('/ip-pool/captcha/stats', async (_request, reply) => {
    try {
      const stats = await proxyManager.getCaptchaStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/captcha/solve -- Solve a CAPTCHA --------------------

  app.post('/ip-pool/captcha/solve', async (request, reply) => {
    try {
      const { type, siteKey, pageUrl, domain, proxyUrl, action, minScore, imageData } = request.body as {
        type: string;
        siteKey: string;
        pageUrl: string;
        domain?: string;
        proxyUrl?: string;
        action?: string;
        minScore?: number;
        imageData?: string;
      };

      if (!type || !siteKey || !pageUrl) {
        return reply.status(400).send({ success: false, error: 'type, siteKey, and pageUrl are required' });
      }

      const result = await proxyManager.solveCaptcha({ type: type as any, siteKey, pageUrl, domain, proxyUrl, action, minScore, imageData });
      return { success: result.success, data: result };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/captcha/detect -- Detect CAPTCHAs in HTML -----------

  app.post('/ip-pool/captcha/detect', async (request, reply) => {
    try {
      const { html } = request.body as { html: string };
      if (!html) {
        return reply.status(400).send({ success: false, error: 'html is required' });
      }
      const { captchaSolver } = await import('../../proxy/captcha-solver');
      const detected = captchaSolver.detectCaptcha(html);
      return { success: true, data: { detected, count: detected.length } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/captcha/balances -- Get provider account balances ----

  app.get('/ip-pool/captcha/balances', async (_request, reply) => {
    try {
      const { captchaSolver } = await import('../../proxy/captcha-solver');
      const balances = await captchaSolver.getBalances();
      return { success: true, data: balances };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/captcha/intelligence -- Solver intelligence report --

  app.get('/ip-pool/captcha/intelligence', async (_request, reply) => {
    try {
      const { captchaSolver } = await import('../../proxy/captcha-solver');
      const intel = captchaSolver.getIntelligenceReport('recaptcha_v2');
      return { success: true, data: intel };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // ===========================================================================
  // Web Unlocker -- 5 Stealth Levels, Challenge Library, Intelligence
  // ===========================================================================

  // --- GET /ip-pool/unlocker/stats -- Web Unlocker statistics ------------

  app.get('/ip-pool/unlocker/stats', async (_request, reply) => {
    try {
      const stats = await proxyManager.getWebUnlockerStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/unlocker/unlock -- Unlock a web page ----------------

  app.post('/ip-pool/unlocker/unlock', async (request, reply) => {
    try {
      const { url, domain, strategy, stealthLevel, proxyUrl, proxyTier, proxyCountry, headers, waitForSelector, timeout, solveCaptcha, sessionId, maxRetries } = request.body as {
        url: string;
        domain?: string;
        strategy?: 'http' | 'browser' | 'stealth' | 'auto';
        stealthLevel?: 'light' | 'medium' | 'maximum';
        proxyUrl?: string;
        proxyTier?: 'residential' | 'mobile' | 'datacenter' | 'isp';
        proxyCountry?: string;
        headers?: Record<string, string>;
        waitForSelector?: string;
        timeout?: number;
        solveCaptcha?: boolean;
        sessionId?: string;
        maxRetries?: number;
      };

      if (!url) {
        return reply.status(400).send({ success: false, error: 'url is required' });
      }

      const result = await proxyManager.unlockPage({
        url, domain, strategy, stealthLevel, proxyUrl, proxyTier, proxyCountry,
        headers, waitForSelector, timeout, solveCaptcha, sessionId, maxRetries,
      });
      return { success: result.success, data: result };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/unlocker/detect -- Detect anti-bot on a page --------

  app.post('/ip-pool/unlocker/detect', async (request, reply) => {
    try {
      const { html, headers: pageHeaders } = request.body as { html: string; headers?: Record<string, string> };
      if (!html) {
        return reply.status(400).send({ success: false, error: 'html is required' });
      }
      const { WebUnlocker } = await import('../../proxy/web-unlocker');
      const detection = WebUnlocker.detectAntiBot(html, pageHeaders || {});
      return { success: true, data: detection };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // ===========================================================================
  // Total IP Count
  // ===========================================================================

  // --- GET /ip-pool/total-ips -- Total effective IPs across all sources --

  app.get('/ip-pool/total-ips', async (_request, reply) => {
    try {
      const totalIPs = await proxyManager.getTotalEffectiveIPs();
      return { success: true, data: { totalEffectiveIPs: totalIPs } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // ===========================================================================
  // CDP-Level Fingerprint Injection -- Protocol-Level Anti-Detection
  // ===========================================================================

  // --- GET /ip-pool/cdp/stats -- CDP injection engine statistics ----------

  app.get('/ip-pool/cdp/stats', async (_request, reply) => {
    try {
      const { cdpInjectionEngine } = await import('../../anti-bot/cdp-injection');
      const stats = cdpInjectionEngine.getStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/cdp/profile/:domain -- Get CDP profile for a domain --

  app.get('/ip-pool/cdp/profile/:domain', async (request, reply) => {
    try {
      const { domain } = request.params as { domain: string };
      const { cdpInjectionEngine } = await import('../../anti-bot/cdp-injection');
      const profile = cdpInjectionEngine.getProfile(domain);
      if (!profile) {
        return reply.status(404).send({ success: false, error: 'No CDP profile found for domain' });
      }
      return { success: true, data: profile };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/cdp/rotate -- Force-rotate CDP profile for a domain -

  app.post('/ip-pool/cdp/rotate', async (request, reply) => {
    try {
      const { domain } = request.body as { domain: string };
      if (!domain) {
        return reply.status(400).send({ success: false, error: 'domain is required' });
      }
      const { cdpInjectionEngine } = await import('../../anti-bot/cdp-injection');
      const newProfile = cdpInjectionEngine.rotateProfile(domain);
      return { success: true, data: { domain, profileId: newProfile.id, rotated: true } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/cdp/record-block -- Record a block for CDP profile --

  app.post('/ip-pool/cdp/record-block', async (request, reply) => {
    try {
      const { domain } = request.body as { domain: string };
      if (!domain) {
        return reply.status(400).send({ success: false, error: 'domain is required' });
      }
      const { cdpInjectionEngine } = await import('../../anti-bot/cdp-injection');
      cdpInjectionEngine.recordBlock(domain);
      return { success: true, data: { domain, recorded: true } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/cdp/record-success -- Record success for CDP profile

  app.post('/ip-pool/cdp/record-success', async (request, reply) => {
    try {
      const { domain } = request.body as { domain: string };
      if (!domain) {
        return reply.status(400).send({ success: false, error: 'domain is required' });
      }
      const { cdpInjectionEngine } = await import('../../anti-bot/cdp-injection');
      cdpInjectionEngine.recordSuccess(domain);
      return { success: true, data: { domain, recorded: true } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/cdp/context-options/:domain -- Get CDP context options -

  app.get('/ip-pool/cdp/context-options/:domain', async (request, reply) => {
    try {
      const { domain } = request.params as { domain: string };
      const { cdpInjectionEngine } = await import('../../anti-bot/cdp-injection');
      const options = cdpInjectionEngine.getContextOptions(domain);
      return { success: true, data: options };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // ===========================================================================
  // Deep Browser Patcher -- Header Order, Timing, Font Protection
  // ===========================================================================

  // --- GET /ip-pool/deep-patcher/stats -- Deep patcher statistics --------

  app.get('/ip-pool/deep-patcher/stats', async (_request, reply) => {
    try {
      const { deepBrowserPatcher } = await import('../../anti-bot/deep-patcher');
      const stats = deepBrowserPatcher.getStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/deep-patcher/header-order/:browser -- Header order for browser

  app.get('/ip-pool/deep-patcher/header-order/:browser', async (request, reply) => {
    try {
      const { browser } = request.params as { browser: string };
      const { deepBrowserPatcher } = await import('../../anti-bot/deep-patcher');
      const order = deepBrowserPatcher.getHeaderOrder(browser as any);
      return { success: true, data: { browser, headerOrder: order } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/deep-patcher/fonts/:os -- Font list for OS ----------

  app.get('/ip-pool/deep-patcher/fonts/:os', async (request, reply) => {
    try {
      const { os } = request.params as { os: string };
      const { deepBrowserPatcher } = await import('../../anti-bot/deep-patcher');
      const fonts = deepBrowserPatcher.getFontList(os as any);
      return { success: true, data: { os, systemFonts: fonts.system.length, commonFonts: fonts.common.length, fonts } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // ===========================================================================
  // TLS Fingerprint Engine -- JA3/JA4 Profile Management
  // ===========================================================================

  // --- GET /ip-pool/tls/stats -- TLS fingerprint engine statistics -------

  app.get('/ip-pool/tls/stats', async (_request, reply) => {
    try {
      const { tlsFingerprintEngine } = await import('../../anti-bot/tls-fingerprint');
      const stats = tlsFingerprintEngine.getStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/tls/profiles -- List available TLS profiles ---------

  app.get('/ip-pool/tls/profiles', async (_request, reply) => {
    try {
      const { tlsFingerprintEngine } = await import('../../anti-bot/tls-fingerprint');
      const profiles = tlsFingerprintEngine.getAvailableProfiles();
      return { success: true, data: { totalProfiles: profiles.length, profiles } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/tls/user-agent -- Get a random TLS user-agent -------

  app.get('/ip-pool/tls/user-agent', async (request, reply) => {
    try {
      const { browser } = request.query as { browser?: string };
      const { tlsFingerprintEngine } = await import('../../anti-bot/tls-fingerprint');
      const userAgent = tlsFingerprintEngine.getUserAgent(browser as any);
      return { success: true, data: { userAgent } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- POST /ip-pool/tls/reset-blocks -- Reset all TLS block counts ----

  app.post('/ip-pool/tls/reset-blocks', async (_request, reply) => {
    try {
      const { tlsFingerprintEngine } = await import('../../anti-bot/tls-fingerprint');
      tlsFingerprintEngine.resetBlockCounts();
      return { success: true, data: { message: 'TLS profile block counts reset' } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // ===========================================================================
  // Fingerprint Consistency Engine -- Cross-Signal Validation
  // ===========================================================================

  // --- GET /ip-pool/fingerprint/stats -- Fingerprint consistency stats ---

  app.get('/ip-pool/fingerprint/stats', async (_request, reply) => {
    try {
      const { fingerprintConsistencyEngine } = await import('../../anti-bot/fingerprint-consistency');
      const stats = fingerprintConsistencyEngine.getStats();
      return { success: true, data: stats };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // --- GET /ip-pool/fingerprint/profile/:domain -- Get fingerprint for domain

  app.get('/ip-pool/fingerprint/profile/:domain', async (request, reply) => {
    try {
      const { domain } = request.params as { domain: string };
      const { fingerprintConsistencyEngine } = await import('../../anti-bot/fingerprint-consistency');
      const profile = fingerprintConsistencyEngine.getProfile(domain);
      const validation = fingerprintConsistencyEngine.validate(profile);
      return { success: true, data: { domain, profile, validation } };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
}
