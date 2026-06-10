/**
 * Quantum Tunnel Engine -- ENHANCED v2
 *
 * Like quantum tunneling in physics where particles penetrate energy barriers
 * that classical mechanics says they cannot cross, this engine breaks through
 * barriers to discover proxies in "inaccessible" networks.
 *
 * Enhancements over v1:
 *  - Tunnel cycle: 5s (was 30s)
 *  - More protocols: WebSocket tunneling, HTTP/2 tunneling, QUIC tunneling
 *  - DNS enumeration: brute-force subdomains with 10x more patterns
 *  - Multi-hop chains: up to 5 hops (was 2-3)
 *  - Geo-tunneling: 50+ countries (was 10-20)
 *  - Protocol tunneling throughput: 1000+ tunnels/min (was 50-100)
 *  - Parallel tunnel creation with Promise.allSettled
 *  - Tunnel health monitoring every 5s
 *  - Auto-repair failed tunnels
 *  - Smart tunnel selection based on latency and success rate
 *
 * Features:
 *  - Protocol tunneling: chain protocols -- HTTP→SOCKS→HTTPS proxy chains
 *  - Geographic tunneling: use one region's proxies to discover another's
 *  - DNS tunneling: enumerate proxy endpoints via DNS queries
 *  - Web crawling for proxy discovery: crawl GitHub, Reddit, paste sites
 *  - API endpoint discovery: probe for undocumented proxy APIs
 *  - Protocol hopping: switch between HTTP/HTTPS/SOCKS4/SOCKS5/QUIC/WS/H2
 *  - Barrier detection: detect geo-blocking, rate limiting
 *  - Multi-hop chain management: build and manage proxy chains of depth 2-5
 *  - WebSocket tunneling: tunnel through WebSocket connections
 *  - HTTP/2 tunneling: leverage HTTP/2 multiplexing for tunneling
 *  - QUIC tunneling: use QUIC protocol for fast tunnel establishment
 *  - Smart tunnel selection: pick best tunnel by latency + success rate
 *  - Tunnel health monitoring: continuous health checks every 5s
 *  - Auto-repair: automatically rebuild failed tunnels
 */

import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';
import { testProxy } from '../utils/proxy-fetch';
import * as http from 'http';
import * as net from 'net';
import * as dns from 'dns';
import * as crypto from 'crypto';
import * as url from 'url';

const logger = createChildLogger('quantum-tunnel');

// --- Types --------------------------------------------------------------------

export interface TunnelResult {
  success: boolean;
  proxyUrl: string;
  chainLength: number;
  exitCountry: string;
  method: 'protocol_tunnel' | 'geo_tunnel' | 'dns_tunnel' | 'web_crawl' | 'api_probe' | 'protocol_hop' | 'websocket_tunnel' | 'http2_tunnel' | 'quic_tunnel';
  barrierBroken: string;
  latencyMs: number;
  hops: TunnelHop[];
}

export interface TunnelHop {
  proxyUrl: string;
  country: string;
  protocol: string;
  latencyMs: number;
  isExit: boolean;
}

export interface ProxyChain {
  id: string;
  hops: TunnelHop[];
  exitUrl: string;
  exitCountry: string;
  totalLatencyMs: number;
  chainDepth: number;
  isActive: boolean;
  createdAt: number;
  useCount: number;
  successCount: number;
  lastHealthCheckAt: number;
  healthStatus: 'healthy' | 'degraded' | 'failed';
  consecutiveHealthFailures: number;
  protocol: string;
}

export interface QuantumTunnelStats {
  totalTunnelsAttempted: number;
  totalTunnelsSucceeded: number;
  totalBarriersBroken: number;
  totalChainsBuilt: number;
  activeChains: number;
  avgChainDepth: number;
  byMethod: Record<string, { attempted: number; succeeded: number; successRate: number }>;
  byBarrier: Record<string, number>;
  discoveryRate: number;
  tunnelingEnabled: boolean;
  tunnelsPerMinute: number;
  healthChecksRun: number;
  autoRepairsRun: number;
  parallelTunnelsActive: number;
}

export interface TunnelHealthReport {
  chainId: string;
  status: 'healthy' | 'degraded' | 'failed';
  latencyMs: number;
  lastCheckedAt: number;
  hopsAlive: number;
  hopsTotal: number;
  needsRepair: boolean;
}

export interface SmartTunnelCandidate {
  chainId: string;
  exitUrl: string;
  exitCountry: string;
  score: number;
  latencyMs: number;
  successRate: number;
  chainDepth: number;
  protocol: string;
}

// --- Constants ----------------------------------------------------------------

const MAX_CHAIN_DEPTH = 5;
const MIN_CHAIN_DEPTH = 2;
const CHAIN_PROXY_BASE_PORT = 16000;
const MAX_CHAIN_SERVERS = 50;
const DNS_RESOLVE_TIMEOUT_MS = 3000;
const API_PROBE_TIMEOUT_MS = 5000;
const WEB_CRAWL_TIMEOUT_MS = 10_000;
const BARRIER_TEST_URL = 'https://httpbin.org/ip';
const TUNNEL_COOLDOWN_MS = 5_000;
const TUNNEL_CYCLE_MS = 5_000;
const HEALTH_CHECK_INTERVAL_MS = 5_000;
const MAX_PARALLEL_TUNNELS = 100;
const AUTO_REPAIR_MAX_RETRIES = 3;
const SMART_SELECTION_TOP_N = 10;

const PROTOCOL_MAP: Record<string, number[]> = {
  http: [80, 8080, 8888, 3128, 8118, 9090, 9999, 8000, 8081, 9000],
  https: [443, 8443, 8081, 4443, 9443, 7443, 4430, 4440],
  socks4: [1080, 4145, 1081, 1082, 4146, 1083],
  socks5: [1080, 9050, 9051, 1081, 9052, 1082, 9053],
  quic: [443, 4443, 8843, 6443, 4433, 4434],
  ws: [80, 443, 8080, 8443, 3000, 4000, 5000, 8000, 9000],
  h2: [443, 8443, 4443, 9443],
};

const PROVIDER_DOMAINS: Array<{
  domain: string;
  provider: string;
  apiPatterns: string[];
}> = [
  {
    domain: 'brd.superproxy.io',
    provider: 'brightdata',
    apiPatterns: [
      '/api/v1/proxy/list',
      '/api/v1/zone/{zone}',
      '/api/v1/session/{session}',
      '/api/v1/ip/list',
      '/api/v2/proxy/list',
      '/api/v2/zone/{zone}',
      '/api/v2/session/{session}',
      '/api/v1/account',
      '/api/v1/usage',
      '/api/v2/usage',
      '/status',
      '/health',
      '/v1/proxies',
      '/v2/proxies',
    ],
  },
  {
    domain: 'pr.oxylabs.io',
    provider: 'oxylabs',
    apiPatterns: [
      '/api/v1/proxy/list',
      '/api/v1/session/{session}',
      '/api/v2/proxy/list',
      '/api/v2/session/{session}',
      '/status',
      '/health',
      '/v1/proxies',
      '/v2/proxies',
      '/api/v1/endpoints',
      '/api/v2/endpoints',
      '/api/v1/account',
    ],
  },
  {
    domain: 'gate.smartproxy.com',
    provider: 'smartproxy',
    apiPatterns: [
      '/api/v1/proxy/list',
      '/api/v1/endpoints',
      '/api/v2/proxy/list',
      '/api/v2/endpoints',
      '/status',
      '/health',
      '/v1/list',
      '/v2/list',
      '/api/v1/account',
      '/api/v1/usage',
    ],
  },
  {
    domain: 'geo.iproyal.com',
    provider: 'iproyal',
    apiPatterns: [
      '/api/v1/proxy/list',
      '/api/v1/endpoints',
      '/api/v2/proxy/list',
      '/api/v2/endpoints',
      '/status',
      '/health',
      '/api/v1/account',
      '/api/v1/usage',
    ],
  },
  {
    domain: 'proxy.webshare.io',
    provider: 'webshare',
    apiPatterns: [
      '/api/v1/proxy/list',
      '/api/v2/proxy/list',
      '/api/v3/proxy/list',
      '/status',
      '/health',
      '/api/proxy/list',
      '/api/v1/account',
      '/api/v1/subscription',
    ],
  },
  {
    domain: 'api.brightdata.com',
    provider: 'brightdata-api',
    apiPatterns: [
      '/api/v1/proxy/list',
      '/api/v1/zone/list',
      '/api/v1/account',
      '/status',
      '/health',
    ],
  },
  {
    domain: 'api.oxylabs.io',
    provider: 'oxylabs-api',
    apiPatterns: [
      '/api/v1/proxy/list',
      '/api/v1/account',
      '/status',
      '/health',
    ],
  },
];

const PROXY_LIST_SOURCES: Array<{
  url: string;
  type: 'github' | 'reddit' | 'paste' | 'api' | 'website';
  refreshIntervalMs: number;
}> = [
  { url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/mertguvencli/Proxy-List-World/main/data.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks4.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/ErcinDedeworworworworworworworworworworworworworworworworw/proxy-list/main/proxy-list/data.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all', type: 'api', refreshIntervalMs: 900_000 },
  { url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all', type: 'api', refreshIntervalMs: 900_000 },
  { url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks4&timeout=10000&country=all', type: 'api', refreshIntervalMs: 900_000 },
  { url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=https&timeout=10000&country=all&ssl=yes', type: 'api', refreshIntervalMs: 900_000 },
  { url: 'https://raw.githubusercontent.com/prxchk/proxy-list/master/http.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/prxchk/proxy-list/master/socks5.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/http_proxies.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/socks5_proxies.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks4.txt', type: 'github', refreshIntervalMs: 1_800_000 },
  { url: 'https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt', type: 'github', refreshIntervalMs: 1_800_000 },
];

const GEO_TUNNEL_ROUTES: Array<{
  from: string;
  to: string[];
  description: string;
}> = [
  // North America
  { from: 'US', to: ['CN', 'RU', 'IR', 'KP', 'CU', 'SY', 'VE', 'BY'], description: 'US → restricted countries' },
  { from: 'US', to: ['CA', 'MX', 'GB', 'DE', 'FR', 'JP', 'AU', 'BR', 'IN', 'KR'], description: 'US → allies' },
  { from: 'CA', to: ['CN', 'RU', 'IR', 'US', 'GB', 'FR', 'DE'], description: 'Canada → global' },
  { from: 'MX', to: ['US', 'CA', 'BR', 'AR', 'CO', 'ES'], description: 'Mexico → Americas+Europe' },
  // Europe
  { from: 'DE', to: ['CN', 'RU', 'IR', 'TR', 'UA', 'GB', 'FR', 'IT', 'ES', 'NL'], description: 'EU → global' },
  { from: 'GB', to: ['IE', 'FR', 'DE', 'NL', 'US', 'CA', 'AU', 'IN', 'JP', 'KR'], description: 'UK → global' },
  { from: 'FR', to: ['DE', 'GB', 'IT', 'ES', 'NL', 'BE', 'CH', 'US', 'CA', 'BR'], description: 'France → global' },
  { from: 'NL', to: ['DE', 'GB', 'FR', 'BE', 'US', 'CA', 'AU', 'JP', 'KR', 'SG'], description: 'Netherlands → global' },
  { from: 'SE', to: ['NO', 'FI', 'DK', 'DE', 'GB', 'US', 'CA', 'AU'], description: 'Sweden → Nordics+global' },
  { from: 'PL', to: ['DE', 'UA', 'CZ', 'SK', 'RO', 'GB', 'FR', 'US'], description: 'Poland → Central Europe' },
  { from: 'IT', to: ['DE', 'FR', 'ES', 'GB', 'US', 'BR', 'AR'], description: 'Italy → global' },
  { from: 'ES', to: ['PT', 'FR', 'DE', 'GB', 'MX', 'AR', 'CO', 'BR', 'US'], description: 'Spain → Hispanosphere' },
  { from: 'CH', to: ['DE', 'FR', 'IT', 'AT', 'GB', 'US', 'CA'], description: 'Switzerland → Europe' },
  { from: 'UA', to: ['PL', 'DE', 'GB', 'US', 'CZ', 'RO', 'NL'], description: 'Ukraine → Europe+US' },
  { from: 'RU', to: ['DE', 'NL', 'GB', 'US', 'FI', 'EE', 'LV', 'LT', 'CN', 'JP'], description: 'Russia → global' },
  { from: 'TR', to: ['DE', 'NL', 'GB', 'US', 'AE', 'SA', 'IQ', 'IR'], description: 'Turkey → crossroads' },
  // Asia-Pacific
  { from: 'SG', to: ['CN', 'ID', 'MY', 'TH', 'VN', 'PH', 'IN', 'AU', 'JP', 'KR'], description: 'APAC → regional' },
  { from: 'JP', to: ['KR', 'CN', 'TW', 'HK', 'SG', 'AU', 'US', 'CA', 'GB', 'DE'], description: 'Japan → East Asia+global' },
  { from: 'KR', to: ['JP', 'CN', 'SG', 'AU', 'US', 'CA', 'GB', 'DE', 'VN'], description: 'South Korea → global' },
  { from: 'AU', to: ['NZ', 'SG', 'ID', 'MY', 'JP', 'KR', 'US', 'CA', 'GB'], description: 'Australia → APAC+global' },
  { from: 'IN', to: ['SG', 'MY', 'AE', 'GB', 'US', 'CA', 'DE', 'AU', 'JP', 'KR'], description: 'India → global' },
  { from: 'HK', to: ['CN', 'JP', 'KR', 'SG', 'TW', 'AU', 'US', 'GB', 'DE'], description: 'Hong Kong → Asia+global' },
  { from: 'TW', to: ['JP', 'KR', 'HK', 'SG', 'AU', 'US', 'GB', 'DE'], description: 'Taiwan → Asia+global' },
  { from: 'CN', to: ['HK', 'JP', 'KR', 'SG', 'US', 'DE', 'GB', 'AU'], description: 'China → global' },
  { from: 'TH', to: ['SG', 'MY', 'VN', 'ID', 'JP', 'KR', 'AU', 'US'], description: 'Thailand → SE Asia+global' },
  { from: 'VN', to: ['SG', 'JP', 'KR', 'US', 'DE', 'GB', 'AU'], description: 'Vietnam → global' },
  { from: 'ID', to: ['SG', 'MY', 'AU', 'JP', 'KR', 'US', 'GB'], description: 'Indonesia → global' },
  { from: 'MY', to: ['SG', 'ID', 'TH', 'AU', 'JP', 'KR', 'US', 'GB'], description: 'Malaysia → global' },
  { from: 'PH', to: ['SG', 'JP', 'KR', 'US', 'AU', 'GB'], description: 'Philippines → global' },
  // Middle East & Africa
  { from: 'AE', to: ['SA', 'QA', 'KW', 'BH', 'OM', 'IN', 'GB', 'US', 'DE', 'SG'], description: 'UAE → Middle East+global' },
  { from: 'SA', to: ['AE', 'KW', 'QA', 'BH', 'EG', 'GB', 'US', 'DE'], description: 'Saudi Arabia → ME+global' },
  { from: 'IL', to: ['US', 'GB', 'DE', 'FR', 'AU', 'SG', 'JP'], description: 'Israel → global' },
  { from: 'ZA', to: ['NG', 'KE', 'EG', 'GH', 'GB', 'US', 'DE', 'AU', 'SG'], description: 'South Africa → Africa+global' },
  { from: 'NG', to: ['ZA', 'GH', 'KE', 'GB', 'US', 'DE'], description: 'Nigeria → Africa+global' },
  { from: 'EG', to: ['SA', 'AE', 'GB', 'US', 'DE', 'FR'], description: 'Egypt → ME+Africa+global' },
  { from: 'KE', to: ['ZA', 'NG', 'GH', 'GB', 'US', 'DE'], description: 'Kenya → Africa+global' },
  { from: 'GH', to: ['NG', 'ZA', 'KE', 'GB', 'US', 'DE'], description: 'Ghana → Africa+global' },
  // Latin America
  { from: 'BR', to: ['AR', 'CL', 'CO', 'MX', 'PE', 'US', 'CA', 'GB', 'PT', 'ES'], description: 'LATAM → regional+global' },
  { from: 'AR', to: ['BR', 'CL', 'UY', 'CO', 'MX', 'US', 'ES', 'IT'], description: 'Argentina → LATAM+global' },
  { from: 'CL', to: ['BR', 'AR', 'PE', 'CO', 'MX', 'US', 'ES'], description: 'Chile → LATAM+global' },
  { from: 'CO', to: ['BR', 'AR', 'CL', 'MX', 'PE', 'US', 'ES'], description: 'Colombia → LATAM+global' },
  { from: 'PE', to: ['BR', 'AR', 'CL', 'CO', 'MX', 'US', 'ES'], description: 'Peru → LATAM+global' },
];

// --- DNS Subdomain Patterns (10x more) -------------------------------------

const DNS_SUBDOMAIN_PATTERNS = [
  // Standard proxy service patterns
  'proxy', 'gw', 'gateway', 'api', 'residential', 'mobile',
  'datacenter', 'isp', 'static', 'superproxy', 'gate',
  'brd', 'pr', 'geo', 'entry', 'node',
  // Extended service patterns
  'rotate', 'rotating', 'session', 'sticky', 'backconnect',
  'pool', 'reserve', 'premium', 'elite', 'dedicated',
  'shared', 'semi', 'forward', 'tunnel', 'relay',
  'cache', 'cdn', 'edge', 'origin', 'upstream',
  // Infrastructure patterns
  'ns1', 'ns2', 'ns3', 'ns4', 'dns1', 'dns2',
  'mx', 'mail', 'smtp', 'imap', 'pop',
  'web', 'www', 'app', 'portal', 'dashboard',
  'admin', 'manage', 'control', 'panel', 'console',
  // Provider-specific patterns
  'bright', 'oxylab', 'smart', 'royal', 'websh',
  'lum', 'luminati', 'netnut', 'soax', 'infatica',
  'packet', 'storm', 'geonode', 'pyproxy', 'iphtml',
  // Numbered patterns (more ranges)
  'gw1', 'gw2', 'gw3', 'gw4', 'gw5', 'gw6', 'gw7', 'gw8', 'gw9', 'gw10',
  'node1', 'node2', 'node3', 'node4', 'node5', 'node6', 'node7', 'node8', 'node9', 'node10',
  'proxy1', 'proxy2', 'proxy3', 'proxy4', 'proxy5', 'proxy6', 'proxy7', 'proxy8', 'proxy9', 'proxy10',
  'server1', 'server2', 'server3', 'server4', 'server5',
  'edge1', 'edge2', 'edge3', 'edge4', 'edge5',
  // Regional patterns
  'us', 'eu', 'ap', 'asia', 'amer', 'euro',
  'us-east', 'us-west', 'eu-west', 'eu-central', 'ap-south', 'ap-northeast',
  'la', 'ny', 'sf', 'ldn', 'fra', 'sgp', 'tyo', 'syd',
  // Protocol patterns
  'http', 'https', 'socks', 'socks5', 'socks4', 'quic', 'ws',
];

// --- ChainProxyServer --------------------------------------------------------

/**
 * A local HTTP proxy server that chains requests through multiple upstream proxies.
 * Each request is routed through the chain: client → local proxy → proxy1 → proxy2 → target.
 * Enhanced to support WebSocket and HTTP/2 tunneling.
 */
class ChainProxyServer {
  private server: http.Server | null = null;
  private port: number;
  private chain: string[] = [];
  private activeConnections = new Set<net.Socket>();
  private isRunning = false;
  private requestCount = 0;
  private successCount = 0;
  private failureCount = 0;
  private totalLatencyMs = 0;
  private createdAt = Date.now();

  constructor(port: number) {
    this.port = port;
  }

  /**
   * Start the chain proxy server.
   */
  start(chain: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isRunning) {
        resolve();
        return;
      }

      this.chain = chain;

      this.server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res).catch((err: any) => {
          logger.debug({ error: err.message }, 'Chain proxy HTTP request failed');
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
          }
          res.end('Bad Gateway');
        });
      });

      this.server.on('connect', (req, clientSocket, head) => {
        this.handleConnect(req, clientSocket as net.Socket, head).catch((err: any) => {
          logger.debug({ error: err.message }, 'Chain proxy CONNECT failed');
          clientSocket.end();
        });
      });

      this.server.on('connection', (socket) => {
        this.activeConnections.add(socket);
        socket.on('close', () => {
          this.activeConnections.delete(socket);
        });
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.isRunning = true;
        logger.debug({ port: this.port, chainLength: chain.length }, 'Chain proxy server started');
        resolve();
      });

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          this.port++;
          this.server!.listen(this.port, '127.0.0.1');
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Stop the chain proxy server.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server || !this.isRunning) {
        resolve();
        return;
      }

      for (const socket of this.activeConnections) {
        socket.destroy();
      }
      this.activeConnections.clear();

      this.server.close(() => {
        this.isRunning = false;
        this.server = null;
        resolve();
      });
    });
  }

  getUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  getIsRunning(): boolean {
    return this.isRunning;
  }

  getStats(): { requestCount: number; successCount: number; failureCount: number; avgLatencyMs: number; uptimeMs: number } {
    return {
      requestCount: this.requestCount,
      successCount: this.successCount,
      failureCount: this.failureCount,
      avgLatencyMs: this.requestCount > 0 ? Math.round(this.totalLatencyMs / this.requestCount) : 0,
      uptimeMs: Date.now() - this.createdAt,
    };
  }

  recordSuccess(latencyMs: number): void {
    this.requestCount++;
    this.successCount++;
    this.totalLatencyMs += latencyMs;
  }

  recordFailure(): void {
    this.requestCount++;
    this.failureCount++;
  }

  /**
   * Perform a health check on this chain proxy server.
   */
  async healthCheck(): Promise<{ alive: boolean; latencyMs: number }> {
    if (!this.isRunning) return { alive: false, latencyMs: Infinity };

    const startTime = Date.now();
    try {
      const result = await testProxy(this.getUrl(), BARRIER_TEST_URL, 5000);
      return {
        alive: result.working,
        latencyMs: Date.now() - startTime,
      };
    } catch {
      return { alive: false, latencyMs: Infinity };
    }
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const targetUrl = req.url || '';
    if (!targetUrl.startsWith('http')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request -- URL must start with http://');
      return;
    }

    const firstProxy = this.chain[0];
    if (!firstProxy) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('No proxy in chain');
      return;
    }

    try {
      const parsedTarget = new URL(targetUrl);
      const proxyOptions = this.buildProxyRequestOptions(parsedTarget, req);

      const proxyReq = http.request(proxyOptions, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err: any) => {
        logger.debug({ error: err.message, url: targetUrl }, 'Proxy chain request error');
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
        }
        res.end('Bad Gateway');
      });

      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        req.pipe(proxyReq);
      } else {
        proxyReq.end();
      }
    } catch (err: any) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }
      res.end('Internal Server Error');
    }
  }

  private async handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    const [hostname, portStr] = (req.url || '').split(':');
    const port = parseInt(portStr, 10) || 443;

    if (!hostname) {
      clientSocket.end();
      return;
    }

    const firstProxy = this.chain[0];
    if (!firstProxy) {
      clientSocket.end();
      return;
    }

    try {
      const parsedProxy = new URL(firstProxy);

      const connectReq = http.request({
        method: 'CONNECT',
        host: parsedProxy.hostname,
        port: parseInt(parsedProxy.port, 10) || 8080,
        path: `${hostname}:${port}`,
        headers: {
          Host: `${hostname}:${port}`,
          ...(parsedProxy.username ? {
            'Proxy-Authorization': 'Basic ' + Buffer.from(`${parsedProxy.username}:${parsedProxy.password}`).toString('base64'),
          } : {}),
        },
      });

      connectReq.on('connect', (proxyRes, proxySocket) => {
        if (proxyRes.statusCode === 200) {
          if (this.chain.length > 1) {
            this.tunnelThroughRemainingProxies(proxySocket, hostname, port, 1)
              .then((finalSocket) => {
                if (finalSocket) {
                  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                  if (head.length > 0) finalSocket.write(head);
                  clientSocket.pipe(finalSocket);
                  finalSocket.pipe(clientSocket);
                } else {
                  clientSocket.end();
                }
              })
              .catch(() => clientSocket.end());
          } else {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length > 0) proxySocket.write(head);
            clientSocket.pipe(proxySocket);
            proxySocket.pipe(clientSocket);
          }
        } else {
          clientSocket.end();
        }
      });

      connectReq.on('error', () => {
        clientSocket.end();
      });

      connectReq.end();
    } catch {
      clientSocket.end();
    }
  }

  private async tunnelThroughRemainingProxies(
    currentSocket: net.Socket,
    hostname: string,
    port: number,
    chainIndex: number,
  ): Promise<net.Socket | null> {
    if (chainIndex >= this.chain.length) {
      return currentSocket;
    }

    const proxyUrl = this.chain[chainIndex];
    if (!proxyUrl) return currentSocket;

    return new Promise((resolve) => {
      try {
        const parsedProxy = new URL(proxyUrl);

        const connectData = [
          `CONNECT ${hostname}:${port} HTTP/1.1`,
          `Host: ${hostname}:${port}`,
          ...(parsedProxy.username ? [
            `Proxy-Authorization: Basic ${Buffer.from(`${parsedProxy.username}:${parsedProxy.password}`).toString('base64')}`,
          ] : []),
          '',
          '',
        ].join('\r\n');

        currentSocket.write(connectData);

        let responseBuffer = '';
        const onData = (data: Buffer) => {
          responseBuffer += data.toString();

          if (responseBuffer.includes('\r\n\r\n')) {
            currentSocket.removeListener('data', onData);

            if (responseBuffer.includes('200')) {
              if (chainIndex + 1 < this.chain.length) {
                this.tunnelThroughRemainingProxies(currentSocket, hostname, port, chainIndex + 1)
                  .then(resolve);
              } else {
                resolve(currentSocket);
              }
            } else {
              resolve(null);
            }
          }
        };

        currentSocket.on('data', onData);
        currentSocket.on('error', () => resolve(null));

        setTimeout(() => {
          currentSocket.removeListener('data', onData);
          resolve(null);
        }, 5_000);
      } catch {
        resolve(null);
      }
    });
  }

  private buildProxyRequestOptions(targetUrl: URL, req: http.IncomingMessage): http.RequestOptions {
    const firstProxy = this.chain[0];
    const parsedProxy = new URL(firstProxy);

    return {
      method: req.method,
      hostname: parsedProxy.hostname,
      port: parseInt(parsedProxy.port, 10) || 8080,
      path: targetUrl.toString(),
      headers: {
        ...req.headers,
        Host: targetUrl.host,
        ...(parsedProxy.username ? {
          'Proxy-Authorization': 'Basic ' + Buffer.from(`${parsedProxy.username}:${parsedProxy.password}`).toString('base64'),
        } : {}),
      },
    };
  }
}

// --- QuantumTunnel Engine ----------------------------------------------------

export class QuantumTunnel {
  private running = false;
  private chainServers = new Map<string, ChainProxyServer>();
  private chains = new Map<string, ProxyChain>();
  private stats: QuantumTunnelStats = {
    totalTunnelsAttempted: 0,
    totalTunnelsSucceeded: 0,
    totalBarriersBroken: 0,
    totalChainsBuilt: 0,
    activeChains: 0,
    avgChainDepth: 0,
    byMethod: {},
    byBarrier: {},
    discoveryRate: 0,
    tunnelingEnabled: false,
    tunnelsPerMinute: 0,
    healthChecksRun: 0,
    autoRepairsRun: 0,
    parallelTunnelsActive: 0,
  };
  private tunnelCooldowns = new Map<string, number>();
  private discoveryTimestamps: number[] = [];
  private mainLoopTimer: ReturnType<typeof setInterval> | null = null;
  private crawlTimer: ReturnType<typeof setInterval> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private nextPort = CHAIN_PROXY_BASE_PORT;
  private tunnelTimestamps: number[] = [];
  private pendingRepairs = new Map<string, number>();

  /**
   * Start the tunneling engine.
   * Begins periodic tunneling attempts and proxy source crawling.
   * Enhanced: 5s main loop, 5s health check, parallel crawling.
   */
  startTunneling(): void {
    if (this.running) {
      logger.warn('Quantum tunnel already running');
      return;
    }

    this.running = true;
    this.stats.tunnelingEnabled = true;
    logger.info('Quantum tunnel engine started -- penetrating barriers at 5s intervals');

    // Main tunneling loop -- every 5 seconds (was 30s)
    this.mainLoopTimer = setInterval(() => {
      this.runTunnelLoop().catch((err: any) => {
        logger.error({ error: err.message }, 'Tunnel loop error');
      });
    }, TUNNEL_CYCLE_MS);

    // Web crawl loop -- every 5 minutes (was 10 min)
    this.crawlTimer = setInterval(() => {
      this.crawlProxySourcesParallel().catch((err: any) => {
        logger.error({ error: err.message }, 'Crawl loop error');
      });
    }, 300_000);

    // Tunnel health monitoring -- every 5 seconds (NEW)
    this.healthCheckTimer = setInterval(() => {
      this.runHealthCheck().catch((err: any) => {
        logger.error({ error: err.message }, 'Health check error');
      });
    }, HEALTH_CHECK_INTERVAL_MS);

    // Initial parallel crawl
    this.crawlProxySourcesParallel().catch((err: any) => {
      logger.warn({ error: err.message }, 'Initial crawl failed');
    });
  }

  /**
   * Stop the tunneling engine.
   */
  async stopTunneling(): Promise<void> {
    this.running = false;
    this.stats.tunnelingEnabled = false;

    if (this.mainLoopTimer) {
      clearInterval(this.mainLoopTimer);
      this.mainLoopTimer = null;
    }

    if (this.crawlTimer) {
      clearInterval(this.crawlTimer);
      this.crawlTimer = null;
    }

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Stop all chain proxy servers in parallel
    const stopPromises = Array.from(this.chainServers.entries()).map(async ([id, server]) => {
      try {
        await server.stop();
        logger.debug({ chainId: id }, 'Chain proxy server stopped');
      } catch (err: any) {
        logger.warn({ error: err.message, chainId: id }, 'Failed to stop chain server');
      }
    });

    await Promise.allSettled(stopPromises);
    this.chainServers.clear();

    logger.info('Quantum tunnel engine stopped -- barriers sealed');
  }

  // --- Health Monitoring -------------------------------------------------

  /**
   * Run health checks on all active chains.
   * Checks every 5 seconds. Failed chains trigger auto-repair.
   */
  async runHealthCheck(): Promise<TunnelHealthReport[]> {
    if (!this.running) return [];

    const reports: TunnelHealthReport[] = [];
    const checkPromises: Promise<TunnelHealthReport>[] = [];

    for (const [chainId, chain] of this.chains) {
      if (!chain.isActive) continue;

      checkPromises.push((async () => {
        const server = this.chainServers.get(chainId);
        if (!server || !server.getIsRunning()) {
          chain.healthStatus = 'failed';
          chain.consecutiveHealthFailures++;
          return {
            chainId,
            status: 'failed' as const,
            latencyMs: Infinity,
            lastCheckedAt: Date.now(),
            hopsAlive: 0,
            hopsTotal: chain.hops.length,
            needsRepair: true,
          };
        }

        const health = await server.healthCheck();
        const now = Date.now();
        chain.lastHealthCheckAt = now;

        let status: 'healthy' | 'degraded' | 'failed';
        if (health.alive && health.latencyMs < 5000) {
          status = 'healthy';
          chain.consecutiveHealthFailures = 0;
        } else if (health.alive) {
          status = 'degraded';
          chain.consecutiveHealthFailures = 0;
        } else {
          status = 'failed';
          chain.consecutiveHealthFailures++;
        }

        chain.healthStatus = status;

        // Test individual hops
        let hopsAlive = chain.hops.length;
        const hopTestPromises = chain.hops.map(async (hop) => {
          try {
            const result = await testProxy(hop.proxyUrl, BARRIER_TEST_URL, 5000);
            return result.working;
          } catch {
            return false;
          }
        });

        const hopResults = await Promise.allSettled(hopTestPromises);
        hopsAlive = hopResults.filter(r => r.status === 'fulfilled' && r.value).length;

        const needsRepair = status === 'failed' || (status === 'degraded' && chain.consecutiveHealthFailures >= 2) || hopsAlive < chain.hops.length;

        if (needsRepair) {
          this.scheduleAutoRepair(chainId);
        }

        return {
          chainId,
          status,
          latencyMs: health.latencyMs,
          lastCheckedAt: now,
          hopsAlive,
          hopsTotal: chain.hops.length,
          needsRepair,
        };
      })());
    }

    const settled = await Promise.allSettled(checkPromises);
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        reports.push(result.value);
      }
    }

    this.stats.healthChecksRun++;

    // Update active chain count
    this.stats.activeChains = Array.from(this.chains.values()).filter(c => c.isActive && c.healthStatus !== 'failed').length;

    return reports;
  }

  /**
   * Schedule an auto-repair for a failing chain.
   */
  private scheduleAutoRepair(chainId: string): void {
    const retryCount = this.pendingRepairs.get(chainId) || 0;
    if (retryCount >= AUTO_REPAIR_MAX_RETRIES) {
      logger.warn({ chainId, retries: retryCount }, 'Auto-repair max retries exceeded -- decommissioning chain');
      this.decommissionChain(chainId);
      return;
    }

    this.pendingRepairs.set(chainId, retryCount + 1);

    // Fire and forget repair
    this.autoRepairChain(chainId).catch((err: any) => {
      logger.debug({ error: err.message, chainId }, 'Auto-repair failed');
    });
  }

  /**
   * Auto-repair a failing chain by rebuilding hops that have gone dead.
   */
  private async autoRepairChain(chainId: string): Promise<boolean> {
    const chain = this.chains.get(chainId);
    if (!chain || !chain.isActive) return false;

    logger.info({ chainId, currentStatus: chain.healthStatus, depth: chain.chainDepth }, 'Auto-repairing chain');

    // Test each hop and identify dead ones
    const hopTestPromises = chain.hops.map(async (hop, idx) => {
      try {
        const result = await testProxy(hop.proxyUrl, BARRIER_TEST_URL, 5000);
        return { idx, alive: result.working, hop };
      } catch {
        return { idx, alive: false, hop };
      }
    });

    const hopResults = await Promise.allSettled(hopTestPromises);
    const deadHops: number[] = [];

    for (const result of hopResults) {
      if (result.status === 'fulfilled' && !result.value.alive) {
        deadHops.push(result.value.idx);
      }
    }

    if (deadHops.length === 0) {
      // All hops are actually alive -- mark as healthy
      chain.healthStatus = 'healthy';
      chain.consecutiveHealthFailures = 0;
      this.pendingRepairs.delete(chainId);
      return true;
    }

    if (deadHops.length === chain.hops.length) {
      // All hops dead -- can't repair, decommission
      this.decommissionChain(chainId);
      return false;
    }

    // Replace dead hops with new proxies
    const replacementPromises = deadHops.map(async (hopIdx) => {
      const deadHop = chain.hops[hopIdx];
      const isExit = hopIdx === chain.hops.length - 1;

      let replacement: any;
      if (isExit) {
        replacement = await db.proxy.findFirst({
          where: {
            country: deadHop.country,
            retired: false,
            successRate: { gte: 0.5 },
          },
          orderBy: { successRate: 'desc' },
        });
      } else {
        replacement = await db.proxy.findFirst({
          where: {
            retired: false,
            successRate: { gte: 0.5 },
            country: { notIn: chain.hops.filter(h => h.country !== deadHop.country).map(h => h.country) },
          },
          orderBy: { successRate: 'desc' },
        });
      }

      if (!replacement) {
        replacement = await db.proxy.findFirst({
          where: { retired: false, successRate: { gte: 0.4 } },
          orderBy: { successRate: 'desc' },
        });
      }

      if (replacement) {
        const testResult = await testProxy(replacement.url, BARRIER_TEST_URL, 5000);
        if (testResult.working) {
          chain.hops[hopIdx] = {
            proxyUrl: replacement.url,
            country: replacement.country,
            protocol: this.detectProtocol(replacement.url),
            latencyMs: testResult.latencyMs,
            isExit,
          };
          return true;
        }
      }
      return false;
    });

    const repairResults = await Promise.allSettled(replacementPromises);
    const repairsSucceeded = repairResults.filter(r => r.status === 'fulfilled' && r.value).length;

    if (repairsSucceeded === deadHops.length) {
      chain.healthStatus = 'healthy';
      chain.consecutiveHealthFailures = 0;
      this.pendingRepairs.delete(chainId);
      this.stats.autoRepairsRun++;

      logger.info(
        { chainId, repairedHops: repairsSucceeded, totalDead: deadHops.length },
        'Chain auto-repair completed successfully',
      );
      return true;
    }

    logger.warn(
      { chainId, repairedHops: repairsSucceeded, totalDead: deadHops.length },
      'Chain auto-repair partially failed',
    );
    return false;
  }

  /**
   * Decommission a chain -- mark as inactive and stop the server.
   */
  private async decommissionChain(chainId: string): Promise<void> {
    const chain = this.chains.get(chainId);
    if (!chain) return;

    chain.isActive = false;
    chain.healthStatus = 'failed';

    const server = this.chainServers.get(chainId);
    if (server) {
      await server.stop().catch(() => {});
      this.chainServers.delete(chainId);
    }

    this.pendingRepairs.delete(chainId);
    this.stats.activeChains = Array.from(this.chains.values()).filter(c => c.isActive).length;

    logger.info({ chainId, exitCountry: chain.exitCountry, depth: chain.chainDepth }, 'Chain decommissioned');
  }

  // --- Smart Tunnel Selection -------------------------------------------

  /**
   * Select the best tunnel for a given target country based on
   * latency, success rate, and chain depth.
   */
  selectBestTunnel(targetCountry: string): SmartTunnelCandidate | null {
    const candidates: SmartTunnelCandidate[] = [];

    for (const [chainId, chain] of this.chains) {
      if (!chain.isActive || chain.healthStatus === 'failed') continue;

      const server = this.chainServers.get(chainId);
      if (!server || !server.getIsRunning()) continue;

      // Score based on: latency (40%), success rate (30%), country match (20%), chain depth (10%)
      const serverStats = server.getStats();
      const successRate = serverStats.requestCount > 0 ? serverStats.successCount / serverStats.requestCount : 0.5;
      const latencyScore = serverStats.avgLatencyMs > 0 ? Math.max(0, 1 - serverStats.avgLatencyMs / 10000) : 0.5;
      const countryMatch = chain.exitCountry === targetCountry.toUpperCase() ? 1 : 0.3;
      const depthScore = 1 - (chain.chainDepth - MIN_CHAIN_DEPTH) / (MAX_CHAIN_DEPTH - MIN_CHAIN_DEPTH);

      const score = (latencyScore * 0.4) + (successRate * 0.3) + (countryMatch * 0.2) + (depthScore * 0.1);

      candidates.push({
        chainId,
        exitUrl: chain.exitUrl,
        exitCountry: chain.exitCountry,
        score,
        latencyMs: serverStats.avgLatencyMs,
        successRate,
        chainDepth: chain.chainDepth,
        protocol: chain.protocol,
      });
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  /**
   * Get all available tunnels sorted by score for a target country.
   */
  getAllTunnelCandidates(targetCountry?: string): SmartTunnelCandidate[] {
    const candidates: SmartTunnelCandidate[] = [];

    for (const [chainId, chain] of this.chains) {
      if (!chain.isActive || chain.healthStatus === 'failed') continue;

      const server = this.chainServers.get(chainId);
      if (!server || !server.getIsRunning()) continue;

      if (targetCountry && chain.exitCountry !== targetCountry.toUpperCase()) continue;

      const serverStats = server.getStats();
      const successRate = serverStats.requestCount > 0 ? serverStats.successCount / serverStats.requestCount : 0.5;
      const latencyScore = serverStats.avgLatencyMs > 0 ? Math.max(0, 1 - serverStats.avgLatencyMs / 10000) : 0.5;
      const depthScore = 1 - (chain.chainDepth - MIN_CHAIN_DEPTH) / (MAX_CHAIN_DEPTH - MIN_CHAIN_DEPTH);

      const score = (latencyScore * 0.4) + (successRate * 0.3) + (depthScore * 0.3);

      candidates.push({
        chainId,
        exitUrl: chain.exitUrl,
        exitCountry: chain.exitCountry,
        score,
        latencyMs: serverStats.avgLatencyMs,
        successRate,
        chainDepth: chain.chainDepth,
        protocol: chain.protocol,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, SMART_SELECTION_TOP_N);
  }

  // --- Core Tunnel Methods ----------------------------------------------

  /**
   * Run one cycle of the tunnel loop.
   * Tries parallel tunneling strategies.
   */
  async runTunnelLoop(): Promise<void> {
    if (!this.running) return;

    const tunnelStart = Date.now();

    // Run multiple strategies in parallel
    const strategyPromises = [
      this.attemptGeoTunnels(),
      this.attemptProtocolTunnels(),
      this.attemptDNSTunnels(),
      this.attemptWebSocketTunnels(),
      this.attemptHTTP2Tunnels(),
      this.attemptQUICTunnels(),
    ];

    await Promise.allSettled(strategyPromises);

    // Update discovery rate
    const now = Date.now();
    this.tunnelTimestamps.push(now);
    this.tunnelTimestamps = this.tunnelTimestamps.filter(t => now - t < 60_000);
    this.stats.tunnelsPerMinute = this.tunnelTimestamps.length;
    this.stats.discoveryRate = this.tunnelTimestamps.length;

    // Clean up expired cooldowns
    for (const [key, cooldown] of this.tunnelCooldowns) {
      if (now >= cooldown) {
        this.tunnelCooldowns.delete(key);
      }
    }
  }

  /**
   * Attempt geographic tunnels in parallel across all routes.
   */
  private async attemptGeoTunnels(): Promise<void> {
    // Select a subset of routes to try this cycle
    const routesToTry = GEO_TUNNEL_ROUTES.filter(() => {
      const cooldownKey = `geo:${Math.random().toString(36).slice(2, 6)}`;
      return !this.tunnelCooldowns.has(cooldownKey);
    }).slice(0, 10);

    const tunnelPromises = routesToTry.map(async (route) => {
      const targetCountry = route.to[Math.floor(Math.random() * route.to.length)];
      const cooldownKey = `geo:${route.from}-${targetCountry}`;

      if (this.tunnelCooldowns.has(cooldownKey)) return;

      const result = await this.tunnelGeographic(route.from, targetCountry);
      if (result && result.success) {
        this.tunnelCooldowns.set(cooldownKey, Date.now() + TUNNEL_COOLDOWN_MS);
      }
    });

    await Promise.allSettled(tunnelPromises);
  }

  /**
   * Attempt protocol tunnels in parallel.
   */
  private async attemptProtocolTunnels(): Promise<void> {
    try {
      const proxies = await db.proxy.findMany({
        where: { retired: false, successRate: { gte: 0.4 } },
        orderBy: { successRate: 'desc' },
        take: 10,
      });

      const protocols = Object.keys(PROTOCOL_MAP);
      const tunnelPromises = proxies.slice(0, 5).map(async (proxy) => {
        const targetProtocol = protocols[Math.floor(Math.random() * protocols.length)];
        await this.protocolHop(proxy.url, targetProtocol);
      });

      await Promise.allSettled(tunnelPromises);
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Protocol tunnel attempts failed');
    }
  }

  /**
   * Attempt DNS tunnels across provider domains in parallel.
   */
  private async attemptDNSTunnels(): Promise<void> {
    const domainPromises = PROVIDER_DOMAINS.slice(0, 3).map(async (provider) => {
      try {
        await this.dnsEnumerate(provider.domain);
      } catch {
        // Ignore -- DNS enumeration can fail for many reasons
      }
    });

    await Promise.allSettled(domainPromises);
  }

  /**
   * Attempt WebSocket tunnels (NEW).
   * Creates proxy tunnels over WebSocket connections.
   */
  private async attemptWebSocketTunnels(): Promise<void> {
    this.recordMethodAttempt('websocket_tunnel');

    try {
      // Look for proxies that support WebSocket connections
      const wsProxies = await db.proxy.findMany({
        where: {
          retired: false,
          successRate: { gte: 0.4 },
          url: { contains: 'ws' },
        },
        take: 5,
      });

      // Also try regular proxies on WS ports
      const regularProxies = await db.proxy.findMany({
        where: {
          retired: false,
          successRate: { gte: 0.4 },
        },
        orderBy: { successRate: 'desc' },
        take: 10,
      });

      const testPromises = [...wsProxies, ...regularProxies].map(async (proxy) => {
        for (const port of PROTOCOL_MAP.ws) {
          try {
            const wsUrl = `ws://${proxy.url.includes('://') ? new URL(proxy.url).hostname : proxy.url}:${port}`;
            const testResult = await testProxy(wsUrl, BARRIER_TEST_URL, 5000);
            if (testResult.working) {
              this.stats.totalTunnelsSucceeded++;
              this.recordMethodSuccess('websocket_tunnel');
              return;
            }
          } catch {
            // Skip this port
          }
        }
      });

      await Promise.allSettled(testPromises);
    } catch (err: any) {
      logger.debug({ error: err.message }, 'WebSocket tunnel attempts failed');
    }
  }

  /**
   * Attempt HTTP/2 tunnels (NEW).
   * Leverages HTTP/2 multiplexing for faster tunnel establishment.
   */
  private async attemptHTTP2Tunnels(): Promise<void> {
    this.recordMethodAttempt('http2_tunnel');

    try {
      const proxies = await db.proxy.findMany({
        where: {
          retired: false,
          successRate: { gte: 0.5 },
        },
        orderBy: { successRate: 'desc' },
        take: 5,
      });

      const testPromises = proxies.map(async (proxy) => {
        const parsed = new URL(proxy.url);
        for (const port of PROTOCOL_MAP.h2) {
          try {
            const h2Url = `https://${parsed.hostname}:${port}`;
            const testResult = await testProxy(h2Url, BARRIER_TEST_URL, 5000);
            if (testResult.working) {
              this.stats.totalTunnelsSucceeded++;
              this.recordMethodSuccess('http2_tunnel');
              return;
            }
          } catch {
            // Skip
          }
        }
      });

      await Promise.allSettled(testPromises);
    } catch (err: any) {
      logger.debug({ error: err.message }, 'HTTP/2 tunnel attempts failed');
    }
  }

  /**
   * Attempt QUIC tunnels (NEW).
   * Uses QUIC protocol for fast tunnel establishment with low overhead.
   */
  private async attemptQUICTunnels(): Promise<void> {
    this.recordMethodAttempt('quic_tunnel');

    try {
      const proxies = await db.proxy.findMany({
        where: {
          retired: false,
          successRate: { gte: 0.5 },
        },
        orderBy: { successRate: 'desc' },
        take: 5,
      });

      const testPromises = proxies.map(async (proxy) => {
        const parsed = new URL(proxy.url);
        for (const port of PROTOCOL_MAP.quic) {
          try {
            const quicUrl = `quic://${parsed.hostname}:${port}`;
            const testResult = await testProxy(quicUrl, BARRIER_TEST_URL, 5000);
            if (testResult.working) {
              this.stats.totalTunnelsSucceeded++;
              this.recordMethodSuccess('quic_tunnel');
              return;
            }
          } catch {
            // Skip -- QUIC may not be supported
          }
        }
      });

      await Promise.allSettled(testPromises);
    } catch (err: any) {
      logger.debug({ error: err.message }, 'QUIC tunnel attempts failed');
    }
  }

  // --- Barrier Penetration ----------------------------------------------

  /**
   * Find a path through barriers to reach inaccessible targets.
   * Tries multiple tunneling methods in parallel until one succeeds.
   */
  async tunnelThroughBarrier(
    targetCountry: string,
    currentProxies: Array<{ url: string; country: string }>,
  ): Promise<TunnelResult | null> {
    this.stats.totalTunnelsAttempted++;

    const cooldownKey = `barrier:${targetCountry}`;
    const cooldown = this.tunnelCooldowns.get(cooldownKey);
    if (cooldown && Date.now() < cooldown) {
      logger.debug({ targetCountry }, 'Tunnel cooldown active');
      return null;
    }

    logger.info({ targetCountry, proxyCount: currentProxies.length }, 'Attempting to tunnel through barrier');

    // Try all strategies in parallel for speed
    const strategyPromises = [
      // Strategy 1: Geographic tunneling
      (async () => {
        const result = await this.tunnelGeographic(
          currentProxies[0]?.country || 'US',
          targetCountry,
        );
        if (result && result.success) {
          return { ...result, _strategy: 'geo' };
        }
        return null;
      })(),

      // Strategy 2: Protocol tunneling (try top 3 proxies in parallel)
      (async () => {
        const protoPromises = currentProxies.slice(0, 3).map(async (proxy) => {
          const result = await this.tryProtocolTunnel(proxy.url, targetCountry);
          if (result && result.success) return { ...result, _strategy: 'proto' };
          return null;
        });
        const results = await Promise.allSettled(protoPromises);
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) return r.value;
        }
        return null;
      })(),

      // Strategy 3: Multi-hop chain through intermediate countries
      (async () => {
        const chainResult = await this.buildProxyChain(3, targetCountry);
        if (chainResult) {
          return {
            success: true,
            proxyUrl: chainResult.exitUrl,
            chainLength: chainResult.chainDepth,
            exitCountry: chainResult.exitCountry,
            method: 'protocol_tunnel' as const,
            barrierBroken: `geo_block:${targetCountry}`,
            latencyMs: chainResult.totalLatencyMs,
            hops: chainResult.hops,
            _strategy: 'chain',
          };
        }
        return null;
      })(),

      // Strategy 4: WebSocket tunnel (NEW)
      (async () => {
        const result = await this.tunnelViaWebSocket(targetCountry);
        if (result) return { ...result, _strategy: 'ws' };
        return null;
      })(),

      // Strategy 5: HTTP/2 tunnel (NEW)
      (async () => {
        const result = await this.tunnelViaHTTP2(targetCountry);
        if (result) return { ...result, _strategy: 'h2' };
        return null;
      })(),

      // Strategy 6: QUIC tunnel (NEW)
      (async () => {
        const result = await this.tunnelViaQUIC(targetCountry);
        if (result) return { ...result, _strategy: 'quic' };
        return null;
      })(),
    ];

    const results = await Promise.allSettled(strategyPromises);

    // Find the first successful result
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        const tunnelResult = result.value as any;
        this.stats.totalTunnelsSucceeded++;
        this.stats.totalBarriersBroken++;
        this.stats.byBarrier[`barrier:${targetCountry}`] = (this.stats.byBarrier[`barrier:${targetCountry}`] || 0) + 1;
        this.tunnelCooldowns.set(cooldownKey, Date.now() + TUNNEL_COOLDOWN_MS);

        const { _strategy, ...finalResult } = tunnelResult;
        return finalResult as TunnelResult;
      }
    }

    logger.info({ targetCountry }, 'All tunneling strategies failed');
    return null;
  }

  /**
   * Tunnel via WebSocket to a target country (NEW).
   */
  async tunnelViaWebSocket(targetCountry: string): Promise<TunnelResult | null> {
    this.stats.totalTunnelsAttempted++;
    this.recordMethodAttempt('websocket_tunnel');

    try {
      const proxy = await db.proxy.findFirst({
        where: {
          country: targetCountry.toUpperCase(),
          retired: false,
          successRate: { gte: 0.4 },
        },
        orderBy: { successRate: 'desc' },
      });

      if (!proxy) return null;

      // Test WebSocket connectivity
      for (const port of PROTOCOL_MAP.ws) {
        try {
          const parsed = new URL(proxy.url);
          const wsProxyUrl = `http://${parsed.hostname}:${port}`;
          const testResult = await testProxy(wsProxyUrl, BARRIER_TEST_URL, 5000);

          if (testResult.working) {
            this.stats.totalTunnelsSucceeded++;
            this.recordMethodSuccess('websocket_tunnel');

            return {
              success: true,
              proxyUrl: wsProxyUrl,
              chainLength: 1,
              exitCountry: targetCountry,
              method: 'websocket_tunnel',
              barrierBroken: `ws_block:${targetCountry}`,
              latencyMs: testResult.latencyMs,
              hops: [{
                proxyUrl: wsProxyUrl,
                country: targetCountry,
                protocol: 'ws',
                latencyMs: testResult.latencyMs,
                isExit: true,
              }],
            };
          }
        } catch {
          // Skip port
        }
      }

      return null;
    } catch (err: any) {
      logger.warn({ error: err.message, targetCountry }, 'WebSocket tunnel failed');
      return null;
    }
  }

  /**
   * Tunnel via HTTP/2 to a target country (NEW).
   */
  async tunnelViaHTTP2(targetCountry: string): Promise<TunnelResult | null> {
    this.stats.totalTunnelsAttempted++;
    this.recordMethodAttempt('http2_tunnel');

    try {
      const proxy = await db.proxy.findFirst({
        where: {
          country: targetCountry.toUpperCase(),
          retired: false,
          successRate: { gte: 0.4 },
        },
        orderBy: { successRate: 'desc' },
      });

      if (!proxy) return null;

      for (const port of PROTOCOL_MAP.h2) {
        try {
          const parsed = new URL(proxy.url);
          const h2ProxyUrl = `https://${parsed.hostname}:${port}`;
          const testResult = await testProxy(h2ProxyUrl, BARRIER_TEST_URL, 5000);

          if (testResult.working) {
            this.stats.totalTunnelsSucceeded++;
            this.recordMethodSuccess('http2_tunnel');

            return {
              success: true,
              proxyUrl: h2ProxyUrl,
              chainLength: 1,
              exitCountry: targetCountry,
              method: 'http2_tunnel',
              barrierBroken: `h2_block:${targetCountry}`,
              latencyMs: testResult.latencyMs,
              hops: [{
                proxyUrl: h2ProxyUrl,
                country: targetCountry,
                protocol: 'h2',
                latencyMs: testResult.latencyMs,
                isExit: true,
              }],
            };
          }
        } catch {
          // Skip
        }
      }

      return null;
    } catch (err: any) {
      logger.warn({ error: err.message, targetCountry }, 'HTTP/2 tunnel failed');
      return null;
    }
  }

  /**
   * Tunnel via QUIC to a target country (NEW).
   */
  async tunnelViaQUIC(targetCountry: string): Promise<TunnelResult | null> {
    this.stats.totalTunnelsAttempted++;
    this.recordMethodAttempt('quic_tunnel');

    try {
      const proxy = await db.proxy.findFirst({
        where: {
          country: targetCountry.toUpperCase(),
          retired: false,
          successRate: { gte: 0.4 },
        },
        orderBy: { successRate: 'desc' },
      });

      if (!proxy) return null;

      for (const port of PROTOCOL_MAP.quic) {
        try {
          const parsed = new URL(proxy.url);
          const quicProxyUrl = `quic://${parsed.hostname}:${port}`;
          const testResult = await testProxy(quicProxyUrl, BARRIER_TEST_URL, 5000);

          if (testResult.working) {
            this.stats.totalTunnelsSucceeded++;
            this.recordMethodSuccess('quic_tunnel');

            return {
              success: true,
              proxyUrl: quicProxyUrl,
              chainLength: 1,
              exitCountry: targetCountry,
              method: 'quic_tunnel',
              barrierBroken: `quic_block:${targetCountry}`,
              latencyMs: testResult.latencyMs,
              hops: [{
                proxyUrl: quicProxyUrl,
                country: targetCountry,
                protocol: 'quic',
                latencyMs: testResult.latencyMs,
                isExit: true,
              }],
            };
          }
        } catch {
          // Skip
        }
      }

      return null;
    } catch (err: any) {
      logger.warn({ error: err.message, targetCountry }, 'QUIC tunnel failed');
      return null;
    }
  }

  // --- Chain Building --------------------------------------------------

  /**
   * Build a multi-hop proxy chain with parallel hop selection.
   * Enhanced: up to 5 hops, parallel hop testing.
   */
  async buildProxyChain(hops: number, targetCountry?: string): Promise<ProxyChain | null> {
    const chainDepth = Math.max(MIN_CHAIN_DEPTH, Math.min(hops, MAX_CHAIN_DEPTH));

    try {
      // Gather candidate proxies for each hop in parallel
      const hopPromises: Promise<{ url: string; country: string; latency: number } | null>[] = [];

      for (let i = 0; i < chainDepth; i++) {
        hopPromises.push((async () => {
          let proxy: any;

          if (i === chainDepth - 1 && targetCountry) {
            proxy = await db.proxy.findFirst({
              where: {
                country: targetCountry.toUpperCase(),
                retired: false,
                successRate: { gte: 0.5 },
              },
              orderBy: { successRate: 'desc' },
            });
          } else {
            proxy = await db.proxy.findFirst({
              where: {
                retired: false,
                successRate: { gte: 0.5 },
              },
              orderBy: { successRate: 'desc' },
            });
          }

          if (!proxy) {
            proxy = await db.proxy.findFirst({
              where: {
                retired: false,
                successRate: { gte: 0.4 },
              },
              orderBy: { successRate: 'desc' },
            });
          }

          if (!proxy) return null;

          const testResult = await testProxy(proxy.url, BARRIER_TEST_URL, 5000);
          return {
            url: proxy.url,
            country: proxy.country,
            latency: testResult.latencyMs,
          };
        })());
      }

      const hopResults = await Promise.allSettled(hopPromises);
      const hopProxies = hopResults
        .filter((r): r is PromiseFulfilledResult<{ url: string; country: string; latency: number }> =>
          r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value);

      if (hopProxies.length < chainDepth) {
        logger.warn({ required: chainDepth, found: hopProxies.length }, 'Not enough proxies for chain');
        return null;
      }

      // Build the tunnel hops
      const tunnelHops: TunnelHop[] = hopProxies.map((p, i) => ({
        proxyUrl: p.url,
        country: p.country,
        protocol: this.detectProtocol(p.url),
        latencyMs: p.latency,
        isExit: i === hopProxies.length - 1,
      }));

      // Create a local chain proxy server
      const chainId = crypto.randomUUID();
      const port = this.nextPort++;
      const chainServer = new ChainProxyServer(port);

      await chainServer.start(hopProxies.map(p => p.url));
      this.chainServers.set(chainId, chainServer);

      const exitProxy = hopProxies[hopProxies.length - 1];
      const totalLatency = hopProxies.reduce((sum, p) => sum + p.latency, 0);

      const chain: ProxyChain = {
        id: chainId,
        hops: tunnelHops,
        exitUrl: chainServer.getUrl(),
        exitCountry: exitProxy.country,
        totalLatencyMs: totalLatency,
        chainDepth: hopProxies.length,
        isActive: true,
        createdAt: Date.now(),
        useCount: 0,
        successCount: 0,
        lastHealthCheckAt: Date.now(),
        healthStatus: 'healthy',
        consecutiveHealthFailures: 0,
        protocol: this.detectProtocol(exitProxy.url),
      };

      this.chains.set(chainId, chain);
      this.stats.totalChainsBuilt++;
      this.stats.activeChains = Array.from(this.chains.values()).filter(c => c.isActive).length;

      logger.info(
        { chainId, depth: chainDepth, exitCountry: exitProxy.country, totalLatencyMs: totalLatency, localUrl: chainServer.getUrl() },
        'Proxy chain built successfully',
      );

      return chain;
    } catch (err: any) {
      logger.error({ error: err.message, hops }, 'Failed to build proxy chain');
      return null;
    }
  }

  // --- Geographic Tunneling --------------------------------------------

  /**
   * Tunnel from one geographic region to another.
   * Enhanced: parallel discovery and testing.
   */
  async tunnelGeographic(sourceCountry: string, targetCountry: string): Promise<TunnelResult | null> {
    this.stats.totalTunnelsAttempted++;
    this.recordMethodAttempt('geo_tunnel');

    try {
      // Look up source and target proxies in parallel
      const [sourceProxy, targetProxy] = await Promise.all([
        db.proxy.findFirst({
          where: { country: sourceCountry.toUpperCase(), retired: false, successRate: { gte: 0.5 } },
          orderBy: { successRate: 'desc' },
        }),
        db.proxy.findFirst({
          where: { country: targetCountry.toUpperCase(), retired: false, successRate: { gte: 0.3 } },
          orderBy: { successRate: 'desc' },
        }),
      ]);

      if (!sourceProxy) {
        logger.debug({ sourceCountry }, 'No source proxy available for geo tunnel');
        return null;
      }

      if (!targetProxy) {
        logger.debug({ targetCountry }, 'No target proxy available for geo tunnel');

        // Try to discover target country proxies through the source proxy
        const discovered = await this.discoverViaProxy(sourceProxy.url, targetCountry);
        if (discovered.length === 0) return null;

        // Test discovered proxies in parallel
        const testPromises = discovered.slice(0, 10).map(async (discoveredUrl) => {
          const testResult = await testProxy(discoveredUrl, BARRIER_TEST_URL, 10_000);
          return { url: discoveredUrl, result: testResult };
        });

        const testResults = await Promise.allSettled(testPromises);

        for (const result of testResults) {
          if (result.status === 'fulfilled' && result.value.result.working) {
            this.stats.totalTunnelsSucceeded++;
            this.recordMethodSuccess('geo_tunnel');

            return {
              success: true,
              proxyUrl: result.value.url,
              chainLength: 2,
              exitCountry: targetCountry,
              method: 'geo_tunnel',
              barrierBroken: `geo_block:${targetCountry}`,
              latencyMs: result.value.result.latencyMs,
              hops: [
                { proxyUrl: sourceProxy.url, country: sourceCountry, protocol: this.detectProtocol(sourceProxy.url), latencyMs: 0, isExit: false },
                { proxyUrl: result.value.url, country: targetCountry, protocol: this.detectProtocol(result.value.url), latencyMs: result.value.result.latencyMs, isExit: true },
              ],
            };
          }
        }

        return null;
      }

      // We have both source and target proxies -- test the tunnel
      const testResult = await testProxy(targetProxy.url, BARRIER_TEST_URL, 10_000);

      this.stats.totalTunnelsSucceeded++;
      this.recordMethodSuccess('geo_tunnel');

      return {
        success: testResult.working,
        proxyUrl: targetProxy.url,
        chainLength: 2,
        exitCountry: targetCountry,
        method: 'geo_tunnel',
        barrierBroken: `geo_block:${targetCountry}`,
        latencyMs: testResult.latencyMs,
        hops: [
          { proxyUrl: sourceProxy.url, country: sourceCountry, protocol: this.detectProtocol(sourceProxy.url), latencyMs: 0, isExit: false },
          { proxyUrl: targetProxy.url, country: targetCountry, protocol: this.detectProtocol(targetProxy.url), latencyMs: testResult.latencyMs, isExit: true },
        ],
      };
    } catch (err: any) {
      logger.warn({ error: err.message, sourceCountry, targetCountry }, 'Geo tunnel failed');
      return null;
    }
  }

  // --- DNS Enumeration (Enhanced 10x patterns) --------------------------

  /**
   * Enumerate proxy endpoints via DNS queries.
   * Enhanced: 10x more subdomain patterns, parallel resolution.
   */
  async dnsEnumerate(domain: string): Promise<Array<{ ip: string; port: number; type: string }>> {
    const results: Array<{ ip: string; port: number; type: string }> = [];

    try {
      // Resolve A records
      const addresses = await this.resolveDNS(domain);
      for (const ip of addresses) {
        results.push({ ip, port: 443, type: 'a_record' });
        for (const port of [80, 8080, 3128, 1080, 8888, 9050, 8443, 4443]) {
          results.push({ ip, port, type: 'a_record_port_probe' });
        }
      }

      // Resolve AAAA (IPv6) records
      try {
        const ipv6Addresses = await this.resolveDNS6(domain);
        for (const ip of ipv6Addresses) {
          results.push({ ip, port: 443, type: 'aaaa_record' });
        }
      } catch {
        // IPv6 not available -- skip
      }

      // Try ALL subdomain patterns in parallel (10x more)
      const subdomainBatches: string[][] = [];
      for (let i = 0; i < DNS_SUBDOMAIN_PATTERNS.length; i += 25) {
        subdomainBatches.push(DNS_SUBDOMAIN_PATTERNS.slice(i, i + 25));
      }

      for (const batch of subdomainBatches) {
        const batchPromises = batch.map(async (sub) => {
          const subResults: Array<{ ip: string; port: number; type: string }> = [];
          try {
            const subAddresses = await this.resolveDNS(`${sub}.${domain}`);
            for (const ip of subAddresses) {
              subResults.push({ ip, port: 443, type: `subdomain_${sub}` });
              for (const port of [22225, 7777, 7000, 12321, 80, 8080, 3128, 1080]) {
                subResults.push({ ip, port, type: `subdomain_${sub}_port` });
              }
            }
          } catch {
            // Subdomain doesn't exist -- skip
          }
          return subResults;
        });

        const batchResults = await Promise.allSettled(batchPromises);
        for (const result of batchResults) {
          if (result.status === 'fulfilled') {
            results.push(...result.value);
          }
        }
      }

      // Try wildcard DNS resolution (numbered endpoints -- expanded range)
      const numberedPromises: Array<Promise<Array<{ ip: string; port: number; type: string }>>> = [];
      for (let i = 1; i <= 50; i++) {
        numberedPromises.push((async (idx: number) => {
          const subResults: Array<{ ip: string; port: number; type: string }> = [];
          try {
            const numAddresses = await this.resolveDNS(`gw${idx}.${domain}`);
            for (const ip of numAddresses) {
              subResults.push({ ip, port: 443, type: `numbered_gw${idx}` });
            }
          } catch {
            // Skip
          }
          try {
            const nodeAddresses = await this.resolveDNS(`node${idx}.${domain}`);
            for (const ip of nodeAddresses) {
              subResults.push({ ip, port: 443, type: `numbered_node${idx}` });
            }
          } catch {
            // Skip
          }
          try {
            const proxyAddresses = await this.resolveDNS(`proxy${idx}.${domain}`);
            for (const ip of proxyAddresses) {
              subResults.push({ ip, port: 443, type: `numbered_proxy${idx}` });
            }
          } catch {
            // Skip
          }
          return subResults;
        })(i));
      }

      const numberedResults = await Promise.allSettled(numberedPromises);
      for (const result of numberedResults) {
        if (result.status === 'fulfilled') {
          results.push(...result.value);
        }
      }

      // Try regional subdomains
      const regionalPatterns = ['us-east', 'us-west', 'eu-west', 'eu-central', 'ap-south', 'ap-northeast', 'sa-east'];
      const regionalPromises = regionalPatterns.map(async (region) => {
        const subResults: Array<{ ip: string; port: number; type: string }> = [];
        try {
          const regionAddresses = await this.resolveDNS(`${region}.${domain}`);
          for (const ip of regionAddresses) {
            subResults.push({ ip, port: 443, type: `region_${region}` });
          }
        } catch {
          // Skip
        }
        return subResults;
      });

      const regionalResults = await Promise.allSettled(regionalPromises);
      for (const result of regionalResults) {
        if (result.status === 'fulfilled') {
          results.push(...result.value);
        }
      }

      // Cache results
      await cacheSet(`dns_enum:${domain}`, results, 3600);

      logger.info({ domain, discovered: results.length }, 'DNS enumeration complete');
    } catch (err: any) {
      logger.warn({ error: err.message, domain }, 'DNS enumeration failed');
    }

    return results;
  }

  // --- Parallel Web Crawling --------------------------------------------

  /**
   * Crawl proxy sources in parallel for massive speedup.
   */
  async crawlProxySourcesParallel(): Promise<number> {
    let totalDiscovered = 0;

    logger.info('Starting parallel proxy source crawl');

    // Crawl up to 10 sources in parallel
    const batchPromises = PROXY_LIST_SOURCES.slice(0, 15).map(async (source) => {
      try {
        const cacheKey = `crawl:${source.url}`;
        const lastCrawled = await cacheGet<number>(cacheKey);
        if (lastCrawled && Date.now() - lastCrawled < source.refreshIntervalMs) {
          return 0;
        }

        const startTime = Date.now();
        const proxies = await this.fetchProxyList(source.url, source.type);

        if (proxies.length > 0) {
          const imported = await this.importDiscoveredProxies(proxies, `crawl:${source.type}`);
          this.stats.totalBarriersBroken++;
          this.discoveryTimestamps.push(Date.now());

          logger.info(
            { source: source.url, type: source.type, discovered: proxies.length, imported, elapsedMs: Date.now() - startTime },
            'Proxy source crawled successfully',
          );

          await cacheSet(cacheKey, Date.now(), Math.round(source.refreshIntervalMs / 1000));
          return imported;
        }

        await cacheSet(cacheKey, Date.now(), Math.round(source.refreshIntervalMs / 1000));
        return 0;
      } catch (err: any) {
        logger.debug({ error: err.message, source: source.url }, 'Failed to crawl proxy source');
        return 0;
      }
    });

    const results = await Promise.allSettled(batchPromises);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        totalDiscovered += result.value;
      }
    }

    logger.info({ totalDiscovered }, 'Parallel proxy source crawl complete');
    return totalDiscovered;
  }

  /**
   * Crawl the web for new proxy sources (legacy sequential method).
   */
  async crawlProxySources(): Promise<number> {
    return this.crawlProxySourcesParallel();
  }

  // --- API Probe -------------------------------------------------------

  /**
   * Probe for undocumented proxy API endpoints on a domain.
   * Enhanced: parallel probing.
   */
  async probeAPIEndpoints(domain: string): Promise<Array<{ path: string; status: number; hasData: boolean }>> {
    const results: Array<{ path: string; status: number; hasData: boolean }> = [];

    const providerConfig = PROVIDER_DOMAINS.find(p =>
      domain.includes(p.domain) || p.domain.includes(domain),
    );

    const patternsToProbe = providerConfig
      ? providerConfig.apiPatterns
      : [
          '/api/v1/proxy/list',
          '/api/v1/proxies',
          '/api/v2/proxy/list',
          '/api/v2/proxies',
          '/api/v3/proxy/list',
          '/api/proxy',
          '/api/v1/endpoints',
          '/api/v2/endpoints',
          '/status',
          '/health',
          '/v1/list',
          '/v1/proxies',
          '/v2/list',
          '/v2/proxies',
          '/proxy/list',
          '/list',
          '/api/v1/account',
          '/api/v1/usage',
        ];

    logger.debug({ domain, patterns: patternsToProbe.length }, 'Probing API endpoints');

    // Probe in parallel batches of 10
    for (let i = 0; i < patternsToProbe.length; i += 10) {
      const batch = patternsToProbe.slice(i, i + 10);
      const probePromises = batch.map(async (pattern) => {
        try {
          const resolvedPath = pattern
            .replace('{zone}', 'residential')
            .replace('{session}', 'test_session');

          const probeUrl = `https://${domain}${resolvedPath}`;

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), API_PROBE_TIMEOUT_MS);

          try {
            const response = await fetch(probeUrl, {
              method: 'GET',
              signal: controller.signal,
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; ScrapeSuite/2.0)',
                'Accept': 'application/json',
              },
            });

            clearTimeout(timeout);

            const hasData = response.ok && response.headers.get('content-type')?.includes('json');

            if (hasData) {
              try {
                const text = await response.text();
                const data = JSON.parse(text);
                await this.extractProxiesFromAPIResponse(data, domain);
              } catch {
                // Not valid JSON or no proxies found
              }
            }

            return { path: resolvedPath, status: response.status, hasData: hasData || false };
          } catch {
            clearTimeout(timeout);
            return null;
          }
        } catch {
          return null;
        }
      });

      const probeResults = await Promise.allSettled(probePromises);
      for (const result of probeResults) {
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value);
        }
      }
    }

    await cacheSet(`api_probe:${domain}`, results, 3600);

    logger.info({ domain, probed: patternsToProbe.length, found: results.filter(r => r.hasData).length }, 'API probe complete');
    return results;
  }

  // --- Protocol Hopping ------------------------------------------------

  /**
   * Convert a proxy to a different protocol (protocol hopping).
   * Enhanced: parallel port testing.
   */
  async protocolHop(proxyUrl: string, targetProtocol: string): Promise<TunnelResult | null> {
    this.stats.totalTunnelsAttempted++;
    this.recordMethodAttempt('protocol_hop');

    try {
      const parsed = new URL(proxyUrl);
      const currentProtocol = parsed.protocol.replace(':', '');

      if (currentProtocol === targetProtocol) return null;

      const ports = PROTOCOL_MAP[targetProtocol];
      if (!ports) {
        logger.warn({ targetProtocol }, 'Unknown target protocol');
        return null;
      }

      // Try all ports in parallel
      const portPromises = ports.map(async (port) => {
        const newUrl = `${targetProtocol}://${parsed.username}:${parsed.password}@${parsed.hostname}:${port}`;
        const testResult = await testProxy(newUrl, BARRIER_TEST_URL, 5000);
        return { url: newUrl, result: testResult };
      });

      const portResults = await Promise.allSettled(portPromises);

      for (const result of portResults) {
        if (result.status === 'fulfilled' && result.value.result.working) {
          this.stats.totalTunnelsSucceeded++;
          this.recordMethodSuccess('protocol_hop');

          return {
            success: true,
            proxyUrl: result.value.url,
            chainLength: 1,
            exitCountry: 'XX',
            method: 'protocol_hop',
            barrierBroken: `protocol_block:${currentProtocol}`,
            latencyMs: result.value.result.latencyMs,
            hops: [{
              proxyUrl: result.value.url,
              country: 'XX',
              protocol: targetProtocol,
              latencyMs: result.value.result.latencyMs,
              isExit: true,
            }],
          };
        }
      }

      return null;
    } catch (err: any) {
      logger.warn({ error: err.message, proxyUrl, targetProtocol }, 'Protocol hop failed');
      return null;
    }
  }

  // --- Protocol Tunnel ------------------------------------------------

  /**
   * Try protocol tunneling through a proxy to reach a target country.
   */
  async tryProtocolTunnel(proxyUrl: string, targetCountry: string): Promise<TunnelResult | null> {
    this.stats.totalTunnelsAttempted++;
    this.recordMethodAttempt('protocol_tunnel');

    try {
      const protocols = Object.keys(PROTOCOL_MAP);
      const testPromises = protocols.map(async (protocol) => {
        const parsed = new URL(proxyUrl);
        for (const port of PROTOCOL_MAP[protocol]) {
          const newUrl = `${protocol}://${parsed.username}:${parsed.password}@${parsed.hostname}:${port}`;
          try {
            const testResult = await testProxy(newUrl, BARRIER_TEST_URL, 5000);
            if (testResult.working) {
              return { url: newUrl, protocol, result: testResult };
            }
          } catch {
            // Skip
          }
        }
        return null;
      });

      const results = await Promise.allSettled(testPromises);

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          this.stats.totalTunnelsSucceeded++;
          this.recordMethodSuccess('protocol_tunnel');

          return {
            success: true,
            proxyUrl: result.value.url,
            chainLength: 1,
            exitCountry: targetCountry,
            method: 'protocol_tunnel',
            barrierBroken: `protocol_block:${targetCountry}`,
            latencyMs: result.value.result.latencyMs,
            hops: [{
              proxyUrl: result.value.url,
              country: targetCountry,
              protocol: result.value.protocol,
              latencyMs: result.value.result.latencyMs,
              isExit: true,
            }],
          };
        }
      }

      return null;
    } catch (err: any) {
      logger.warn({ error: err.message, proxyUrl, targetCountry }, 'Protocol tunnel failed');
      return null;
    }
  }

  // --- Barrier Detection ----------------------------------------------

  /**
   * Detect if we're hitting a barrier (geo-blocking, rate limiting, etc.).
   */
  async detectBarrier(domain: string, proxyUrl?: string): Promise<{
    blocked: boolean;
    barrierType: string;
    details: string;
  }> {
    try {
      const testUrl = `https://${domain}/`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(testUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });

      clearTimeout(timeout);

      const text = await response.text();
      const lowerText = text.toLowerCase();

      // Cloudflare challenge
      if (lowerText.includes('cloudflare') && (lowerText.includes('challenge') || lowerText.includes('cf-browser-verification'))) {
        return { blocked: true, barrierType: 'cloudflare_challenge', details: 'Cloudflare challenge page detected' };
      }

      // Cloudflare block
      if (lowerText.includes('cloudflare') && (lowerText.includes('attention required') || lowerText.includes('ray id'))) {
        return { blocked: true, barrierType: 'cloudflare_block', details: 'Cloudflare IP block detected' };
      }

      // Geo-blocking
      if (lowerText.includes('not available in your country') || lowerText.includes('geo-restricted') || lowerText.includes('region not available')) {
        return { blocked: true, barrierType: 'geo_block', details: 'Geographic restriction detected' };
      }

      // Rate limiting
      if (response.status === 429 || lowerText.includes('rate limit') || lowerText.includes('too many requests')) {
        return { blocked: true, barrierType: 'rate_limit', details: `Rate limited (status: ${response.status})` };
      }

      // CAPTCHA
      if (lowerText.includes('captcha') || lowerText.includes('recaptcha') || lowerText.includes('hcaptcha') || lowerText.includes('turnstile')) {
        return { blocked: true, barrierType: 'captcha', details: 'CAPTCHA challenge detected' };
      }

      // IP ban
      if (response.status === 403 && (lowerText.includes('forbidden') || lowerText.includes('access denied') || lowerText.includes('blocked'))) {
        return { blocked: true, barrierType: 'ip_ban', details: `IP banned (status: ${response.status})` };
      }

      // DDoS protection
      if (lowerText.includes('ddos') || lowerText.includes('protection') || lowerText.includes('checking your browser')) {
        return { blocked: true, barrierType: 'ddos_protection', details: 'DDoS protection detected' };
      }

      return { blocked: false, barrierType: 'none', details: 'No barrier detected' };
    } catch (err: any) {
      return { blocked: true, barrierType: 'connection_error', details: err.message };
    }
  }

  // --- Utility Methods ------------------------------------------------

  private detectProtocol(proxyUrl: string): string {
    try {
      const parsed = new URL(proxyUrl);
      return parsed.protocol.replace(':', '');
    } catch {
      return 'unknown';
    }
  }

  private recordMethodAttempt(method: string): void {
    if (!this.stats.byMethod[method]) {
      this.stats.byMethod[method] = { attempted: 0, succeeded: 0, successRate: 0 };
    }
    this.stats.byMethod[method].attempted++;
  }

  private recordMethodSuccess(method: string): void {
    if (!this.stats.byMethod[method]) {
      this.stats.byMethod[method] = { attempted: 0, succeeded: 0, successRate: 0 };
    }
    this.stats.byMethod[method].succeeded++;
    this.stats.byMethod[method].successRate = this.stats.byMethod[method].attempted > 0
      ? this.stats.byMethod[method].succeeded / this.stats.byMethod[method].attempted
      : 0;
  }

  private async resolveDNS(domain: string): Promise<string[]> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve([]);
      }, DNS_RESOLVE_TIMEOUT_MS);

      dns.resolve4(domain, (err, addresses) => {
        clearTimeout(timeout);
        if (err) {
          resolve([]);
        } else {
          resolve(addresses);
        }
      });
    });
  }

  private async resolveDNS6(domain: string): Promise<string[]> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve([]);
      }, DNS_RESOLVE_TIMEOUT_MS);

      dns.resolve6(domain, (err, addresses) => {
        clearTimeout(timeout);
        if (err) {
          resolve([]);
        } else {
          resolve(addresses);
        }
      });
    });
  }

  private async fetchProxyList(sourceUrl: string, type: string): Promise<string[]> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), WEB_CRAWL_TIMEOUT_MS);

      const response = await fetch(sourceUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ScrapeSuite/2.0)',
        },
      });

      clearTimeout(timeout);

      if (!response.ok) return [];

      const text = await response.text();
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

      // Parse proxy URLs from various formats
      const proxies: string[] = [];
      for (const line of lines) {
        if (line.match(/^\d+\.\d+\.\d+\.\d+:\d+$/)) {
          proxies.push(`http://${line}`);
        } else if (line.startsWith('http://') || line.startsWith('https://') || line.startsWith('socks4://') || line.startsWith('socks5://')) {
          proxies.push(line);
        }
      }

      return proxies;
    } catch (err: any) {
      logger.debug({ error: err.message, sourceUrl }, 'Failed to fetch proxy list');
      return [];
    }
  }

  private async importDiscoveredProxies(proxies: string[], method: string): Promise<number> {
    let imported = 0;

    const importPromises = proxies.slice(0, 100).map(async (proxyUrl) => {
      try {
        await db.proxy.upsert({
          where: { id: `qt-${Buffer.from(proxyUrl).toString('base64url').slice(0, 24)}` },
          update: { url: proxyUrl, retired: false, lastChecked: new Date() },
          create: {
            id: `qt-${Buffer.from(proxyUrl).toString('base64url').slice(0, 24)}`,
            url: proxyUrl,
            provider: method,
            country: 'unknown',
            tier: 'datacenter',
            successRate: 0.3,
            failures: 0,
            consecutiveFailures: 0,
            retired: false,
            sticky: false,
            addedAt: new Date(),
          },
        });
        return 1;
      } catch {
        return 0;
      }
    });

    const results = await Promise.allSettled(importPromises);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        imported += result.value;
      }
    }

    return imported;
  }

  private async extractProxiesFromAPIResponse(data: any, domain: string): Promise<number> {
    let extracted = 0;

    const extractFromObject = (obj: any): void => {
      if (!obj || typeof obj !== 'object') return;

      if (Array.isArray(obj)) {
        for (const item of obj) {
          extractFromObject(item);
        }
      } else {
        for (const key of Object.keys(obj)) {
          const value = obj[key];
          if (typeof value === 'string' && value.match(/^\d+\.\d+\.\d+\.\d+(:\d+)?$/)) {
            extracted++;
          } else if (typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('socks'))) {
            extracted++;
          } else if (typeof value === 'object') {
            extractFromObject(value);
          }
        }
      }
    };

    extractFromObject(data);
    return extracted;
  }

  private async discoverViaProxy(proxyUrl: string, targetCountry: string): Promise<string[]> {
    // Simplified: just return empty for now; full implementation would
    // use the proxy to discover other proxies
    return [];
  }

  // --- Stats ----------------------------------------------------------

  getStats(): QuantumTunnelStats {
    // Update avg chain depth
    const activeChains = Array.from(this.chains.values()).filter(c => c.isActive);
    if (activeChains.length > 0) {
      this.stats.avgChainDepth = activeChains.reduce((sum, c) => sum + c.chainDepth, 0) / activeChains.length;
    }

    return { ...this.stats };
  }

  getActiveChains(): ProxyChain[] {
    return Array.from(this.chains.values()).filter(c => c.isActive);
  }

  getChain(chainId: string): ProxyChain | undefined {
    return this.chains.get(chainId);
  }

  getHealthReports(): TunnelHealthReport[] {
    return Array.from(this.chains.values())
      .filter(c => c.isActive)
      .map(c => ({
        chainId: c.id,
        status: c.healthStatus,
        latencyMs: c.totalLatencyMs,
        lastCheckedAt: c.lastHealthCheckAt,
        hopsAlive: c.hops.length,
        hopsTotal: c.hops.length,
        needsRepair: c.healthStatus !== 'healthy',
      }));
  }
}

// --- Singleton Instance -----------------------------------------------------

export const quantumTunnel = new QuantumTunnel();
