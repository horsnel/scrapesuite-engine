#!/usr/bin/env python3
"""
ScrapeSuite Engine — Google Colab Test Suite
=============================================
Run with: colab run --gpu T4 colab-test.py
Or:       colab run colab-test.py  (CPU only)

This script:
1. Installs PostgreSQL & Redis
2. Clones & builds the ScrapeSuite Engine
3. Runs the engine server
4. Executes test requests against real API endpoints
5. Reports success rates and performance metrics

Exit codes:
  0 — All critical tests passed
  1 — One or more critical tests failed or setup error
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# ============================================================
# CONFIGURATION
# ============================================================

REPO_URL = "https://github.com/horsnel/scrapesuite-engine.git"
REPO_DIR = "/content/scrapesuite-engine"
ENGINE_PORT = 3000
ENGINE_HOST = f"http://localhost:{ENGINE_PORT}"
HEALTH_TIMEOUT = 45  # seconds to wait for the server to become healthy

# Colab typically has 2 CPU cores / 12 GB RAM — keep concurrency low
BROWSER_POOL_MAX = "2"
BROWSER_MAX_CONTEXTS = "3"

# ============================================================
# RESULT TRACKING
# ============================================================


@dataclass
class TestResult:
    """Single test result."""
    name: str
    success: bool
    status: int = 0
    duration_ms: int = 0
    detail: str = ""
    error: str = ""


@dataclass
class TestSuite:
    """Aggregates results across all tests."""
    results: List[TestResult] = field(default_factory=list)

    def add(self, result: TestResult) -> None:
        self.results.append(result)

    @property
    def total(self) -> int:
        return len(self.results)

    @property
    def passed(self) -> int:
        return sum(1 for r in self.results if r.success)

    @property
    def failed(self) -> int:
        return self.total - self.passed

    @property
    def success_rate(self) -> float:
        return (self.passed / self.total * 100) if self.total > 0 else 0.0


suite = TestSuite()

# ============================================================
# UTILITY FUNCTIONS
# ============================================================


def run(cmd: str, check: bool = False, timeout: int = 600) -> subprocess.CompletedProcess:
    """Run a shell command, capturing output.

    Args:
        cmd: Shell command string.
        check: If True, raise on non-zero exit code.
        timeout: Max seconds before killing the process.

    Returns:
        CompletedProcess instance.
    """
    result = subprocess.run(
        cmd,
        shell=True,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if check and result.returncode != 0:
        print(f"  [ERROR] Command failed: {cmd}")
        print(f"  stderr: {result.stderr[:800]}")
        raise RuntimeError(f"Command exited {result.returncode}: {cmd}")
    return result


def api_request(
    endpoint: str,
    method: str = "GET",
    data: Optional[Dict[str, Any]] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: int = 30,
) -> Dict[str, Any]:
    """Make an HTTP request to the engine API.

    Args:
        endpoint: Path relative to ENGINE_HOST (e.g. /health).
        method: HTTP method.
        data: JSON-serializable body (sent as application/json).
        headers: Additional request headers.
        timeout: Request timeout in seconds.

    Returns:
        Dict with at least 'success' (bool) and 'status' (int).
    """
    url = f"{ENGINE_HOST}{endpoint}"
    req_headers = {"Content-Type": "application/json"}
    if headers:
        req_headers.update(headers)

    try:
        body = json.dumps(data).encode() if data else None
        req = urllib.request.Request(
            url, data=body, headers=req_headers, method=method
        )
        start = time.monotonic()
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed_ms = int((time.monotonic() - start) * 1000)
            resp_data = json.loads(resp.read().decode())
            return {
                "success": True,
                "status": resp.status,
                "data": resp_data,
                "duration_ms": elapsed_ms,
            }
    except urllib.error.HTTPError as exc:
        body_text = ""
        try:
            body_text = exc.read().decode()[:500]
        except Exception:
            pass
        elapsed_ms = int((time.monotonic() - start) * 1000) if "start" in dir() else 0
        return {
            "success": False,
            "status": exc.code,
            "error": body_text,
            "duration_ms": elapsed_ms,
        }
    except Exception as exc:
        return {
            "success": False,
            "status": 0,
            "error": str(exc)[:300],
            "duration_ms": 0,
        }


def record(
    name: str,
    result: Dict[str, Any],
    critical: bool = True,
) -> TestResult:
    """Record a test result and print it.

    Args:
        name: Human-readable test name.
        result: Dict returned by api_request().
        critical: Whether failure is critical for overall exit code.

    Returns:
        The TestResult that was recorded.
    """
    ok = result.get("success", False)
    status = result.get("status", 0)
    duration = result.get("duration_ms", 0)
    error = result.get("error", "")
    detail = ""
    data = result.get("data", {})
    if isinstance(data, dict):
        # Extract useful one-liner details from common response shapes
        if "signals" in data:
            detail = f"signals={len(data.get('signals', []))}"
        elif "msToken" in data:
            detail = f"msToken={data['msToken'][:20]}..."
        elif "profile" in data:
            detail = f"profile={data.get('profile', {}).get('name', 'N/A')}"

    icon = "PASS" if ok else "FAIL"
    tag = "CRITICAL" if critical and not ok else ""
    line = f"  [{icon}] {name}  (HTTP {status}, {duration}ms)"
    if detail:
        line += f"  {detail}"
    if tag:
        line += f"  ** {tag} **"
    if not ok and error:
        line += f"\n         Error: {error[:120]}"
    print(line)

    tr = TestResult(
        name=name,
        success=ok,
        status=status,
        duration_ms=duration,
        detail=detail,
        error=error,
    )
    suite.add(tr)
    return tr


# ============================================================
# STEP 1: INSTALL SYSTEM DEPENDENCIES
# ============================================================


def install_system_deps() -> None:
    """Install PostgreSQL, Redis, Chromium, and optional TLS tools."""
    print("=" * 64)
    print("STEP 1: Installing system dependencies")
    print("=" * 64)

    run("apt-get update -qq", timeout=120)

    # PostgreSQL
    run("apt-get install -y -qq postgresql postgresql-contrib", timeout=180)

    # Redis
    run("apt-get install -y -qq redis-server", timeout=120)

    # Chromium (for Playwright)
    run(
        "apt-get install -y -qq chromium-browser || apt-get install -y -qq chromium",
        timeout=180,
    )

    # curl-impersonate — attempt apt, then manual GitHub release
    run(
        "apt-get install -y -qq curl-impersonate-chrome 2>/dev/null || true",
        timeout=60,
    )
    run(
        """
        if ! command -v curl-impersonate-chrome &>/dev/null; then
            echo "Installing curl-impersonate from GitHub releases ..."
            CURL_IMP_VERSION="0.6.1"
            ARCH=$(uname -m)
            if [ "$ARCH" = "x86_64" ]; then
                curl -sL "https://github.com/lwthiker/curl-impersonate/releases/download/v${CURL_IMP_VERSION}/curl-impersonate-v${CURL_IMP_VERSION}.x86_64-linux-gnu.tar.gz" \
                    -o /tmp/curl-impersonate.tar.gz \
                && tar -xzf /tmp/curl-impersonate.tar.gz -C /usr/local/ \
                && rm -f /tmp/curl-impersonate.tar.gz \
                || echo "curl-impersonate manual install failed (non-fatal)"
            else
                echo "Unsupported arch ${ARCH} for curl-impersonate (non-fatal)"
            fi
        fi
        """,
        timeout=120,
    )

    # Node.js (Colab may not ship it, or may ship an outdated version)
    run(
        """
        if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1)" != "v22" ]; then
            curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
            && apt-get install -y -qq nodejs
        fi
        """,
        timeout=180,
    )

    node_ver = run("node -v").stdout.strip()
    npm_ver = run("npm -v").stdout.strip()
    print(f"  Node.js {node_ver}, npm {npm_ver}")
    print("  [OK] System dependencies installed\n")


# ============================================================
# STEP 2: START SERVICES
# ============================================================


def start_services() -> None:
    """Start PostgreSQL and Redis, create the database."""
    print("=" * 64)
    print("STEP 2: Starting services")
    print("=" * 64)

    # PostgreSQL
    run("service postgresql start", check=True)
    # Create user & database (idempotent)
    for sql in [
        "CREATE USER scrapesuite WITH PASSWORD 'scrapesuite';",
        "CREATE DATABASE scrapesuite OWNER scrapesuite;",
        "GRANT ALL PRIVILEGES ON DATABASE scrapesuite TO scrapesuite;",
    ]:
        run(f"sudo -u postgres psql -c \"{sql}\" 2>/dev/null || true")

    # Redis
    run("redis-server --daemonize yes", check=True)

    # Verify
    pg_ok = run("pg_isready -q").returncode == 0
    redis_ok = run("redis-cli ping").stdout.strip() == "PONG"
    print(f"  PostgreSQL: {'OK' if pg_ok else 'FAIL'}")
    print(f"  Redis:      {'OK' if redis_ok else 'FAIL'}")

    if not (pg_ok and redis_ok):
        raise RuntimeError("Required services failed to start")

    print("  [OK] Services started\n")


# ============================================================
# STEP 3: CLONE & BUILD ENGINE
# ============================================================


def build_engine() -> None:
    """Clone the repository and build the ScrapeSuite Engine."""
    print("=" * 64)
    print("STEP 3: Building ScrapeSuite Engine")
    print("=" * 64)

    # Clone (shallow for speed)
    if not os.path.isdir(REPO_DIR):
        run(f"git clone --depth 1 {REPO_URL} {REPO_DIR}", check=True, timeout=120)
    os.chdir(REPO_DIR)

    # Install Node.js dependencies
    print("  Installing npm dependencies ...")
    run("npm install", check=True, timeout=300)

    # Generate Prisma client
    print("  Generating Prisma client ...")
    run("npx prisma generate", check=True, timeout=60)

    # Push database schema
    print("  Pushing database schema ...")
    env = os.environ.copy()
    env["DATABASE_URL"] = "postgresql://scrapesuite:scrapesuite@localhost:5432/scrapesuite"
    run(
        "npx prisma db push --skip-generate --accept-data-loss",
        check=True,
        timeout=120,
    )

    # Install Playwright browsers
    print("  Installing Playwright Chromium ...")
    run("npx playwright install chromium", timeout=300)
    run("npx playwright install-deps chromium", timeout=300)

    # Build TypeScript
    print("  Compiling TypeScript ...")
    run("npx tsc", check=True, timeout=300)

    print("  [OK] Engine built successfully\n")


# ============================================================
# STEP 4: START ENGINE SERVER
# ============================================================

engine_process: Optional[subprocess.Popen] = None


def start_engine() -> bool:
    """Start the Fastify engine server and wait until healthy.

    Returns:
        True if the server is healthy, False otherwise.
    """
    global engine_process
    print("=" * 64)
    print("STEP 4: Starting engine server")
    print("=" * 64)

    os.chdir(REPO_DIR)

    # Determine Chromium path
    chromium_path = "/usr/bin/chromium-browser"
    if not os.path.isfile(chromium_path):
        chromium_path = "/usr/bin/chromium"
    if not os.path.isfile(chromium_path):
        # Fallback: let Playwright find its own bundled browser
        chromium_path = ""

    env = os.environ.copy()
    env.update(
        {
            "NODE_ENV": "production",
            "PORT": str(ENGINE_PORT),
            "HOST": "0.0.0.0",
            "MODE": "all",  # start both API server and workers
            "DATABASE_URL": "postgresql://scrapesuite:scrapesuite@localhost:5432/scrapesuite",
            "REDIS_URL": "redis://localhost:6379",
            "JWT_SECRET": "colab-test-secret-do-not-use-in-prod",
            "BROWSER_POOL_MAX": BROWSER_POOL_MAX,
            "BROWSER_MAX_CONTEXTS": BROWSER_MAX_CONTEXTS,
        }
    )
    if chromium_path:
        env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"] = chromium_path

    engine_process = subprocess.Popen(
        ["node", "dist/index.js"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    # Wait for the health endpoint
    print(f"  Waiting up to {HEALTH_TIMEOUT}s for /health ...")
    for attempt in range(1, HEALTH_TIMEOUT + 1):
        try:
            req = urllib.request.Request(f"{ENGINE_HOST}/health")
            with urllib.request.urlopen(req, timeout=2) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode())
                    uptime = data.get("uptime", 0)
                    print(f"  Healthy after {attempt}s  (uptime={uptime:.1f}s)")
                    print("  [OK] Engine server started\n")
                    return True
        except Exception:
            pass
        # Check if process crashed
        if engine_process.poll() is not None:
            stdout, stderr = engine_process.communicate(timeout=5)
            print(f"  [FAIL] Engine process exited with code {engine_process.returncode}")
            print(f"  stdout: {stdout.decode()[:600]}")
            print(f"  stderr: {stderr.decode()[:600]}")
            return False
        time.sleep(1)

    # Timeout
    print(f"  [FAIL] Engine did not become healthy within {HEALTH_TIMEOUT}s")
    if engine_process and engine_process.poll() is None:
        engine_process.terminate()
        try:
            engine_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            engine_process.kill()
    return False


def stop_engine() -> None:
    """Gracefully stop the engine server."""
    global engine_process
    if engine_process is None:
        return
    print("\nStopping engine server ...")
    engine_process.terminate()
    try:
        engine_process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        engine_process.kill()
        try:
            engine_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
    engine_process = None
    print("  Engine stopped.")


# ============================================================
# STEP 5: RUN TESTS
# ============================================================


def test_health() -> None:
    """Test the health and root API endpoints."""
    print("--- Health & Discovery ---")

    # Health check
    result = api_request("/health")
    record("GET /health", result, critical=True)
    if result.get("success"):
        data = result.get("data", {})
        print(f"         status={data.get('status')}  uptime={data.get('uptime', 0):.1f}s  "
              f"memory={data.get('memoryUsage', '?')}MB")

    # API documentation
    result = api_request("/v1")
    record("GET /v1 (API docs)", result, critical=False)


def test_fusion_reactor() -> None:
    """Test Fusion Reactor signal detection and cascade."""
    print("\n--- Fusion Reactor ---")

    # Status
    record(
        "GET /v1/fusion-reactor/status",
        api_request("/v1/fusion-reactor/status"),
        critical=True,
    )

    # Detect signals
    record(
        "POST /v1/fusion-reactor/detect",
        api_request(
            "/v1/fusion-reactor/detect",
            "POST",
            {
                "url": "https://www.tiktok.com",
                "statusCode": 403,
                "headers": {"server": "cloudflare", "cf-ray": "abc123"},
                "body": "<html>challenge-platform</html>",
            },
        ),
    )

    # Quick check
    record(
        "POST /v1/fusion-reactor/quick-check",
        api_request(
            "/v1/fusion-reactor/quick-check",
            "POST",
            {
                "url": "https://www.tiktok.com",
                "statusCode": 403,
                "headers": {"server": "cloudflare"},
                "body": "",
            },
        ),
    )

    # Full process (cascade)
    record(
        "POST /v1/fusion-reactor/process",
        api_request(
            "/v1/fusion-reactor/process",
            "POST",
            {
                "url": "https://www.tiktok.com",
                "statusCode": 403,
                "headers": {"server": "cloudflare", "cf-ray": "x555"},
                "body": "<html>challenge-platform</html>",
            },
        ),
    )

    # Recommendations
    record(
        "GET /v1/fusion-reactor/recommendations/www.tiktok.com/generic",
        api_request("/v1/fusion-reactor/recommendations/www.tiktok.com/generic"),
    )

    # Rules
    record(
        "GET /v1/fusion-reactor/rules",
        api_request("/v1/fusion-reactor/rules"),
    )

    # Detector stats
    record(
        "GET /v1/fusion-reactor/detector/stats",
        api_request("/v1/fusion-reactor/detector/stats"),
    )

    # Reaction engine stats
    record(
        "GET /v1/fusion-reactor/engine/stats",
        api_request("/v1/fusion-reactor/engine/stats"),
    )


def test_tiktok() -> None:
    """Test TikTok platform module."""
    print("\n--- TikTok Platform ---")

    # Initialize
    record(
        "POST /v1/tiktok/initialize",
        api_request("/v1/tiktok/initialize", "POST"),
        critical=True,
    )

    # Quick-sign a URL
    record(
        "POST /v1/tiktok/sign",
        api_request(
            "/v1/tiktok/sign",
            "POST",
            {
                "url": "https://www.tiktok.com/api/recommend/?count=6",
                "deviceType": "desktop",
            },
        ),
    )

    # Full sign
    record(
        "POST /v1/tiktok/sign/full",
        api_request(
            "/v1/tiktok/sign/full",
            "POST",
            {
                "url": "https://www.tiktok.com/api/recommend/",
                "method": "GET",
                "queryString": "count=6",
                "deviceType": "desktop",
            },
        ),
    )

    # msToken — GET fresh
    record(
        "GET /v1/tiktok/mstoken",
        api_request("/v1/tiktok/mstoken"),
    )

    # msToken — rotate
    record(
        "POST /v1/tiktok/mstoken/rotate",
        api_request("/v1/tiktok/mstoken/rotate", "POST"),
    )

    # Device rotate
    record(
        "POST /v1/tiktok/device/rotate",
        api_request("/v1/tiktok/device/rotate", "POST", {"deviceType": "desktop"}),
    )

    # Feed simulation
    record(
        "GET /v1/tiktok/feed/simulate",
        api_request("/v1/tiktok/feed/simulate"),
    )

    # Session prepare
    record(
        "POST /v1/tiktok/session/prepare",
        api_request(
            "/v1/tiktok/session/prepare",
            "POST",
            {"deviceType": "desktop", "proxyTier": "residential"},
        ),
    )

    # Stats endpoints
    for label, path in [
        ("TikTok stats", "/v1/tiktok/stats"),
        ("X-Bogus stats", "/v1/tiktok/xbogus/stats"),
        ("msToken stats", "/v1/tiktok/mstoken/stats"),
        ("Device stats", "/v1/tiktok/device/stats"),
        ("Signature stats", "/v1/tiktok/signature/stats"),
        ("Feed stats", "/v1/tiktok/feed/stats"),
    ]:
        record(f"GET {path}", api_request(path))


def test_youtube() -> None:
    """Test YouTube platform module."""
    print("\n--- YouTube Platform ---")

    # Initialize
    record(
        "POST /v1/youtube/initialize",
        api_request("/v1/youtube/initialize", "POST"),
        critical=True,
    )

    # Sign a YouTube API request
    record(
        "POST /v1/youtube/sign",
        api_request(
            "/v1/youtube/sign",
            "POST",
            {
                "url": "https://www.youtube.com/youtubei/v1/player",
                "method": "POST",
                "requestBody": {
                    "context": {
                        "client": {
                            "clientName": "WEB",
                            "clientVersion": "2.20240101.00.00",
                        }
                    },
                    "videoId": "dQw4w9WgXcQ",
                },
            },
        ),
    )

    # Simulate watch
    record(
        "POST /v1/youtube/simulate/watch",
        api_request(
            "/v1/youtube/simulate/watch",
            "POST",
            {"videoId": "dQw4w9WgXcQ", "durationSeconds": 10},
        ),
    )

    # Evade detection
    record(
        "POST /v1/youtube/evade",
        api_request(
            "/v1/youtube/evade",
            "POST",
            {
                "statusCode": 403,
                "headers": {"server": "YouTube"},
                "responseBody": "bot detection",
            },
        ),
    )

    # Session prepare
    record(
        "POST /v1/youtube/session/prepare",
        api_request(
            "/v1/youtube/session/prepare",
            "POST",
            {"platform": "web", "proxyTier": "residential"},
        ),
    )

    # Stats
    record("GET /v1/youtube/stats", api_request("/v1/youtube/stats"))


def test_reddit() -> None:
    """Test Reddit platform module."""
    print("\n--- Reddit Platform ---")

    # Initialize
    record(
        "POST /v1/reddit/initialize",
        api_request("/v1/reddit/initialize", "POST"),
        critical=True,
    )

    # Session prepare
    record(
        "POST /v1/reddit/session/prepare",
        api_request(
            "/v1/reddit/session/prepare",
            "POST",
            {"target": "listing", "proxyTier": "residential", "useOAuth": False},
        ),
    )

    # Evade rate limit
    record(
        "POST /v1/reddit/evade-rate-limit",
        api_request(
            "/v1/reddit/evade-rate-limit",
            "POST",
            {"statusCode": 429, "headers": {"x-ratelimit-remaining": "0"}},
        ),
    )

    # Simulate browsing
    record(
        "POST /v1/reddit/simulate",
        api_request(
            "/v1/reddit/simulate",
            "POST",
            {"section": "listing", "durationSeconds": 5},
        ),
    )

    # Stats
    record("GET /v1/reddit/stats", api_request("/v1/reddit/stats"))


def test_quantum_tls() -> None:
    """Test Quantum TLS module."""
    print("\n--- Quantum TLS ---")

    # List profiles
    record(
        "GET /v1/tls/profiles",
        api_request("/v1/tls/profiles"),
        critical=True,
    )

    # Get connection config for a domain
    record(
        "GET /v1/tls/connection?domain=www.tiktok.com",
        api_request("/v1/tls/connection?domain=www.tiktok.com"),
    )

    # Get Node.js TLS options for a domain
    record(
        "GET /v1/tls/options?domain=www.tiktok.com",
        api_request("/v1/tls/options?domain=www.tiktok.com"),
    )

    # Rotate profile
    record(
        "POST /v1/tls/rotate",
        api_request("/v1/tls/rotate", "POST", {"strategy": "weighted"}),
    )

    # TLS stats
    record(
        "GET /v1/tls/stats",
        api_request("/v1/tls/stats"),
    )

    # Quantum readiness
    record(
        "GET /v1/tls/quantum-readiness",
        api_request("/v1/tls/quantum-readiness"),
    )


def test_self_improver() -> None:
    """Test Self-Improver / Real-Time Learner."""
    print("\n--- Self-Improver ---")

    # Initialize
    record(
        "POST /v1/self-improver/initialize",
        api_request("/v1/self-improver/initialize", "POST"),
    )

    # Record an observation (full)
    record(
        "POST /v1/self-improver/observe",
        api_request(
            "/v1/self-improver/observe",
            "POST",
            {
                "url": "https://www.tiktok.com/api/recommend/",
                "domain": "www.tiktok.com",
                "outcome": "success",
                "detectedPlatform": "cloudflare",
                "durationMs": 450,
            },
        ),
    )

    # Quick observation
    record(
        "POST /v1/self-improver/observe/quick",
        api_request(
            "/v1/self-improver/observe/quick",
            "POST",
            {
                "url": "https://www.reddit.com/r/programming",
                "domain": "www.reddit.com",
                "outcome": "blocked",
                "platform": "cloudflare",
                "statusCode": 403,
                "durationMs": 1200,
            },
        ),
    )

    # Query observations
    record(
        "GET /v1/self-improver/observations?limit=5",
        api_request("/v1/self-improver/observations?limit=5"),
    )

    # Success rate
    record(
        "GET /v1/self-improver/success-rate/www.tiktok.com",
        api_request("/v1/self-improver/success-rate/www.tiktok.com"),
    )

    # Best strategies
    record(
        "GET /v1/self-improver/best-strategies/www.tiktok.com",
        api_request("/v1/self-improver/best-strategies/www.tiktok.com"),
    )

    # Domain model
    record(
        "GET /v1/self-improver/domain-model/www.tiktok.com",
        api_request("/v1/self-improver/domain-model/www.tiktok.com"),
    )

    # Failure patterns
    record(
        "GET /v1/self-improver/patterns",
        api_request("/v1/self-improver/patterns"),
    )

    # Stats
    record(
        "GET /v1/self-improver/stats",
        api_request("/v1/self-improver/stats"),
    )


def test_real_time_learner() -> None:
    """Test Real-Time Learner (cascade learning)."""
    print("\n--- Real-Time Learner ---")

    # Record outcome
    record(
        "POST /v1/learner/outcome",
        api_request(
            "/v1/learner/outcome",
            "POST",
            {
                "domain": "www.tiktok.com",
                "platform": "tiktok",
                "signalCategory": "cloudflare",
                "reactionType": "proxy_rotate",
                "outcome": "success",
                "responseTimeMs": 320,
            },
        ),
    )

    # Best reaction
    record(
        "GET /v1/learner/best-reaction/tiktok/cloudflare",
        api_request("/v1/learner/best-reaction/tiktok/cloudflare"),
    )

    # Cascade depth
    record(
        "GET /v1/learner/cascade-depth/www.tiktok.com",
        api_request("/v1/learner/cascade-depth/www.tiktok.com"),
    )

    # Domain model
    record(
        "GET /v1/learner/domain-model/www.tiktok.com",
        api_request("/v1/learner/domain-model/www.tiktok.com"),
    )

    # Patterns
    record(
        "GET /v1/learner/patterns",
        api_request("/v1/learner/patterns"),
    )

    # Stats
    record(
        "GET /v1/learner/stats",
        api_request("/v1/learner/stats"),
    )


def test_infrastructure_endpoints() -> None:
    """Test infrastructure & operational endpoints."""
    print("\n--- Infrastructure ---")

    # Proxy stats
    record(
        "GET /v1/proxy/stats",
        api_request("/v1/proxy/stats"),
    )

    # IP Pool stats
    record(
        "GET /ip-pool/stats",
        api_request("/ip-pool/stats"),
    )

    # Rate limit status
    record(
        "GET /v1/rate-limits",
        api_request("/v1/rate-limits"),
    )

    # Sessions (will fail without auth, but endpoint should respond)
    result = api_request("/v1/sessions")
    # 401/403 is expected — the endpoint exists
    ok = result.get("status") in (401, 403) or result.get("success")
    record(
        "GET /v1/sessions (auth required)",
        {**result, "success": ok},
    )

    # Templates
    record(
        "GET /v1/templates",
        api_request("/v1/templates"),
    )

    # Analytics
    result = api_request("/v1/analytics/usage")
    ok = result.get("status") in (401, 403) or result.get("success")
    record(
        "GET /v1/analytics/usage (auth required)",
        {**result, "success": ok},
    )

    # DCIM stats
    record(
        "GET /v1/dcim/stats",
        api_request("/v1/dcim/stats"),
    )

    # Device Farm stats
    record(
        "GET /v1/device-farm/stats",
        api_request("/v1/device-farm/stats"),
    )

    # Akamai stats
    record(
        "GET /v1/akamai/stats",
        api_request("/v1/akamai/stats"),
    )


def test_seed_and_scrape() -> None:
    """Test the internal seed endpoint and a basic scrape job."""
    print("\n--- Seed & Scrape ---")

    # Seed the database with a test user & API key
    seed_result = api_request(
        "/internal/seed",
        "POST",
        headers={"X-Seed-Secret": "colab-test-secret-do-not-use-in-prod"},
    )
    record("POST /internal/seed", seed_result, critical=True)

    api_key = ""
    if seed_result.get("success"):
        data = seed_result.get("data", {})
        api_key = data.get("apiKey", "")
        print(f"         Seeded API key: {api_key[:20]}...")
        print(f"         Credits: {data.get('credits', 'N/A')}")

    if not api_key:
        print("  [SKIP] Cannot test scrape without API key (seed failed)")
        return

    auth_headers = {"Authorization": f"Bearer {api_key}"}

    # Submit a simple scrape job (httpbin is reliable and fast)
    scrape_result = api_request(
        "/v1/scrape",
        "POST",
        {
            "url": "https://httpbin.org/get",
            "strategy": "http",
            "timeout": 15000,
        },
        headers=auth_headers,
        timeout=20,
    )
    record("POST /v1/scrape (httpbin)", scrape_result, critical=True)

    if scrape_result.get("success"):
        job_id = scrape_result.get("data", {}).get("id", "")
        print(f"         Job ID: {job_id}")

        # Poll for completion (up to 30 seconds)
        for _ in range(15):
            time.sleep(2)
            status_result = api_request(
                f"/v1/jobs/{job_id}",
                headers=auth_headers,
            )
            if status_result.get("success"):
                job_status = status_result.get("data", {}).get("status", "")
                if job_status == "done":
                    record(
                        f"GET /v1/jobs/{job_id[:12]}... (done)",
                        status_result,
                    )
                    break
                elif job_status == "failed":
                    record(
                        f"GET /v1/jobs/{job_id[:12]}... (failed)",
                        {**status_result, "success": False},
                    )
                    break
        else:
            record(
                f"GET /v1/jobs/{job_id[:12]}... (timeout)",
                {"success": False, "status": 0, "error": "Job did not complete in 30s"},
            )

    # List jobs
    record(
        "GET /v1/jobs",
        api_request("/v1/jobs", headers=auth_headers),
    )


# ============================================================
# STEP 6: REPORT RESULTS
# ============================================================


def print_summary() -> None:
    """Print a summary of all test results."""
    print("\n" + "=" * 64)
    print("TEST SUMMARY")
    print("=" * 64)

    # Group by status
    passed = [r for r in suite.results if r.success]
    failed = [r for r in suite.results if not r.success]

    for r in suite.results:
        icon = "PASS" if r.success else "FAIL"
        line = f"  [{icon}] {r.name}"
        if r.status:
            line += f"  (HTTP {r.status})"
        if r.duration_ms:
            line += f"  {r.duration_ms}ms"
        print(line)

    print(f"\n  Total: {suite.total}   Passed: {suite.passed}   Failed: {suite.failed}")
    print(f"  Success Rate: {suite.success_rate:.1f}%")

    if failed:
        print(f"\n  Failed tests:")
        for r in failed:
            print(f"    - {r.name}: {r.error[:100] if r.error else 'no error detail'}")

    # Performance summary
    durations = [r.duration_ms for r in suite.results if r.duration_ms > 0]
    if durations:
        print(f"\n  Latency (ms): min={min(durations)}  max={max(durations)}  "
              f"avg={sum(durations) // len(durations)}")


# ============================================================
# MAIN
# ============================================================


def main() -> int:
    """Entry point — runs all setup steps and tests.

    Returns:
        Exit code: 0 if all critical tests passed, 1 otherwise.
    """
    print("+" + "=" * 62 + "+")
    print("|    ScrapeSuite Engine — Google Colab Test Suite            |")
    print("+" + "=" * 62 + "+")
    print(f"  Repo:   {REPO_URL}")
    print(f"  Port:   {ENGINE_PORT}")
    print(f"  Time:   {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}")
    print()

    start_time = time.monotonic()

    try:
        # ── Setup ──────────────────────────────────────────────
        install_system_deps()
        start_services()
        build_engine()

        if not start_engine():
            print("\n[FAIL] Engine failed to start. Aborting tests.")
            return 1

        # ── Tests ──────────────────────────────────────────────
        print("=" * 64)
        print("STEP 5: Running test suite")
        print("=" * 64 + "\n")

        test_health()
        test_fusion_reactor()
        test_tiktok()
        test_youtube()
        test_reddit()
        test_quantum_tls()
        test_self_improver()
        test_real_time_learner()
        test_infrastructure_endpoints()
        test_seed_and_scrape()

    except KeyboardInterrupt:
        print("\n\n[INTERRUPTED] Test run cancelled by user.")
        return 1

    except Exception as exc:
        print(f"\n[FATAL] {exc}")
        import traceback
        traceback.print_exc()
        return 1

    finally:
        # ── Cleanup ────────────────────────────────────────────
        stop_engine()

    # ── Report ─────────────────────────────────────────────────
    elapsed = time.monotonic() - start_time
    print_summary()
    print(f"\n  Total wall time: {elapsed:.1f}s")

    # Determine exit code based on critical failures
    critical_failures = sum(
        1 for r in suite.results
        if not r.success
    )
    if critical_failures > 0:
        print(f"\n[FAIL] {critical_failures} test(s) failed.")
        return 1

    print("\n[OK] All tests passed!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
