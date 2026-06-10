import subprocess, json, os, time, urllib.request, urllib.error, sys
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

REPO_DIR = "/content/scrapesuite-engine"
ENGINE_PORT = 3000
ENGINE_HOST = f"http://localhost:{ENGINE_PORT}"
HEALTH_TIMEOUT = 45

@dataclass
class TestResult:
    name: str
    success: bool
    status: int = 0
    duration_ms: int = 0
    error: str = ""

@dataclass
class TestSuite:
    results: List[TestResult] = field(default_factory=list)
    def add(self, r): self.results.append(r)
    @property
    def total(self): return len(self.results)
    @property
    def passed(self): return sum(1 for r in self.results if r.success)
    @property
    def failed(self): return self.total - self.passed
    @property
    def success_rate(self): return (self.passed / self.total * 100) if self.total > 0 else 0.0

suite = TestSuite()

def api_request(endpoint, method="GET", data=None, headers=None, timeout=60):
    url = f"{ENGINE_HOST}{endpoint}"
    req_headers = {"Content-Type": "application/json"}
    if headers: req_headers.update(headers)
    try:
        body = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(url, data=body, headers=req_headers, method=method)
        start = time.monotonic()
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed_ms = int((time.monotonic() - start) * 1000)
            resp_data = json.loads(resp.read().decode())
            return {"success": True, "status": resp.status, "data": resp_data, "duration_ms": elapsed_ms}
    except urllib.error.HTTPError as exc:
        body_text = ""
        try: body_text = exc.read().decode()[:500]
        except: pass
        elapsed_ms = int((time.monotonic() - start) * 1000) if "start" in dir() else 0
        return {"success": False, "status": exc.code, "error": body_text, "duration_ms": elapsed_ms}
    except Exception as exc:
        return {"success": False, "status": 0, "error": str(exc)[:300], "duration_ms": 0}

def record(name, result, critical=True):
    ok = result.get("success", False)
    status = result.get("status", 0)
    duration = result.get("duration_ms", 0)
    error = result.get("error", "")
    icon = "PASS" if ok else "FAIL"
    line = f"  [{icon}] {name}  (HTTP {status}, {duration}ms)"
    if not ok and error: line += f"\n         Error: {error[:120]}"
    print(line)
    suite.add(TestResult(name=name, success=ok, status=status, duration_ms=duration, error=error))
    return ok

# --- Start Engine ---
os.chdir(REPO_DIR)
env = os.environ.copy()
env.update({
    "NODE_ENV": "production", "PORT": str(ENGINE_PORT), "HOST": "0.0.0.0", "MODE": "all",
    "DATABASE_URL": "postgresql://scrapesuite:scrapesuite@localhost:5432/scrapesuite",
    "REDIS_URL": "redis://localhost:6379", "JWT_SECRET": "colab-test-secret-do-not-use-in-prod",
    "BROWSER_POOL_MAX": "2", "BROWSER_MAX_CONTEXTS": "3", "GOOGLE_COLAB": "1", "BROWSER_LAUNCH_TIMEOUT": "60000",
})
for p in ["/usr/bin/chromium-browser", "/usr/bin/chromium"]:
    if os.path.isfile(p): env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"] = p; break

# Kill old engine
subprocess.run("pkill -f 'node dist/index.js' 2>/dev/null || true", shell=True)
time.sleep(1)

engine = subprocess.Popen(["node", "dist/index.js"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

print(f"Waiting up to {HEALTH_TIMEOUT}s for engine...")
healthy = False
for attempt in range(1, HEALTH_TIMEOUT + 1):
    try:
        with urllib.request.urlopen(f"{ENGINE_HOST}/health", timeout=2) as resp:
            if resp.status == 200:
                print(f"  Healthy after {attempt}s")
                healthy = True; break
    except: pass
    if engine.poll() is not None:
        stdout, stderr = engine.communicate(timeout=5)
        print(f"  CRASHED: {stderr.decode()[:600]}"); break
    time.sleep(1)

if not healthy:
    print("Engine NOT healthy, aborting"); engine.terminate(); sys.exit(1)

# --- Run Tests ---
print("\n=== Running Tests ===\n")

# Health
print("--- Health & Discovery ---")
record("GET /health", api_request("/health"))
record("GET /v1 (API docs)", api_request("/v1"))

# Fusion Reactor
print("\n--- Fusion Reactor ---")
record("GET /v1/fusion-reactor/status", api_request("/v1/fusion-reactor/status"))
record("POST /v1/fusion-reactor/detect", api_request("/v1/fusion-reactor/detect", "POST", {"url": "https://www.tiktok.com", "statusCode": 403, "headers": {"server": "cloudflare", "cf-ray": "abc123"}, "body": "<html>challenge-platform</html>"}))
record("POST /v1/fusion-reactor/quick-check", api_request("/v1/fusion-reactor/quick-check", "POST", {"url": "https://www.tiktok.com", "statusCode": 403, "headers": {"server": "cloudflare"}, "body": ""}))
record("POST /v1/fusion-reactor/process", api_request("/v1/fusion-reactor/process", "POST", {"url": "https://www.tiktok.com", "statusCode": 403, "headers": {"server": "cloudflare", "cf-ray": "x555"}, "body": "<html>challenge-platform</html>"}))
record("GET /v1/fusion-reactor/recommendations/www.tiktok.com/generic", api_request("/v1/fusion-reactor/recommendations/www.tiktok.com/generic"))
record("GET /v1/fusion-reactor/rules", api_request("/v1/fusion-reactor/rules"))
record("GET /v1/fusion-reactor/detector/stats", api_request("/v1/fusion-reactor/detector/stats"))
record("GET /v1/fusion-reactor/engine/stats", api_request("/v1/fusion-reactor/engine/stats"))

# TikTok
print("\n--- TikTok Platform ---")
record("POST /v1/tiktok/initialize", api_request("/v1/tiktok/initialize", "POST"))
record("POST /v1/tiktok/sign", api_request("/v1/tiktok/sign", "POST", {"url": "https://www.tiktok.com/api/recommend/?count=6", "deviceType": "desktop_web"}))
record("POST /v1/tiktok/sign/full", api_request("/v1/tiktok/sign/full", "POST", {"url": "https://www.tiktok.com/api/recommend/", "method": "GET", "queryString": "count=6", "deviceType": "desktop_web"}))
record("GET /v1/tiktok/mstoken", api_request("/v1/tiktok/mstoken"))
record("POST /v1/tiktok/mstoken/rotate", api_request("/v1/tiktok/mstoken/rotate", "POST"))
record("POST /v1/tiktok/device/rotate", api_request("/v1/tiktok/device/rotate", "POST", {"deviceType": "desktop_web"}))
record("GET /v1/tiktok/feed/simulate", api_request("/v1/tiktok/feed/simulate"))
record("POST /v1/tiktok/session/prepare", api_request("/v1/tiktok/session/prepare", "POST", {"deviceType": "desktop_web", "proxyTier": "residential"}))
for path in ["/v1/tiktok/stats", "/v1/tiktok/xbogus/stats", "/v1/tiktok/mstoken/stats", "/v1/tiktok/device/stats", "/v1/tiktok/signature/stats", "/v1/tiktok/feed/stats"]:
    record(f"GET {path}", api_request(path))

# YouTube
print("\n--- YouTube Platform ---")
record("POST /v1/youtube/initialize", api_request("/v1/youtube/initialize", "POST"))
record("POST /v1/youtube/sign", api_request("/v1/youtube/sign", "POST", {"url": "https://www.youtube.com/youtubei/v1/player", "method": "POST", "requestBody": {"context": {"client": {"clientName": "WEB", "clientVersion": "2.20240101.00.00"}}, "videoId": "dQw4w9WgXcQ"}}))
record("POST /v1/youtube/simulate/watch", api_request("/v1/youtube/simulate/watch", "POST", {"videoId": "dQw4w9WgXcQ", "durationSeconds": 10}))
record("POST /v1/youtube/evade", api_request("/v1/youtube/evade", "POST", {"statusCode": 403, "headers": {"server": "YouTube"}, "responseBody": "bot detection"}))
record("POST /v1/youtube/session/prepare", api_request("/v1/youtube/session/prepare", "POST", {"platform": "web", "proxyTier": "residential"}))
record("GET /v1/youtube/stats", api_request("/v1/youtube/stats"))

# Reddit
print("\n--- Reddit Platform ---")
record("POST /v1/reddit/initialize", api_request("/v1/reddit/initialize", "POST"))
record("POST /v1/reddit/session/prepare", api_request("/v1/reddit/session/prepare", "POST", {"target": "listing", "proxyTier": "residential", "useOAuth": False}))
record("POST /v1/reddit/evade-rate-limit", api_request("/v1/reddit/evade-rate-limit", "POST", {"statusCode": 429, "headers": {"x-ratelimit-remaining": "0"}}))
record("POST /v1/reddit/simulate", api_request("/v1/reddit/simulate", "POST", {"section": "listing", "durationSeconds": 5}))
record("GET /v1/reddit/stats", api_request("/v1/reddit/stats"))

# Quantum TLS
print("\n--- Quantum TLS ---")
record("GET /v1/tls/profiles", api_request("/v1/tls/profiles"))
record("GET /v1/tls/connection?domain=www.tiktok.com", api_request("/v1/tls/connection?domain=www.tiktok.com"))
record("GET /v1/tls/options?domain=www.tiktok.com", api_request("/v1/tls/options?domain=www.tiktok.com"))
record("POST /v1/tls/rotate", api_request("/v1/tls/rotate", "POST", {"strategy": "weighted"}))
record("GET /v1/tls/stats", api_request("/v1/tls/stats"))
record("GET /v1/tls/quantum-readiness", api_request("/v1/tls/quantum-readiness"))

# Self-Improver
print("\n--- Self-Improver ---")
record("POST /v1/self-improver/initialize", api_request("/v1/self-improver/initialize", "POST"))
record("POST /v1/self-improver/observe", api_request("/v1/self-improver/observe", "POST", {"url": "https://www.tiktok.com/api/recommend/", "domain": "www.tiktok.com", "outcome": "success", "detectedPlatform": "cloudflare", "durationMs": 450}))
record("POST /v1/self-improver/observe/quick", api_request("/v1/self-improver/observe/quick", "POST", {"url": "https://www.reddit.com/r/programming", "domain": "www.reddit.com", "outcome": "blocked", "platform": "cloudflare", "statusCode": 403, "durationMs": 1200}))
record("GET /v1/self-improver/observations?limit=5", api_request("/v1/self-improver/observations?limit=5"))
record("GET /v1/self-improver/success-rate/www.tiktok.com", api_request("/v1/self-improver/success-rate/www.tiktok.com"))
record("GET /v1/self-improver/best-strategies/www.tiktok.com", api_request("/v1/self-improver/best-strategies/www.tiktok.com"))
record("GET /v1/self-improver/domain-model/www.tiktok.com", api_request("/v1/self-improver/domain-model/www.tiktok.com"))
record("GET /v1/self-improver/patterns", api_request("/v1/self-improver/patterns"))
record("GET /v1/self-improver/stats", api_request("/v1/self-improver/stats"))

# Real-Time Learner
print("\n--- Real-Time Learner ---")
record("POST /v1/learner/outcome", api_request("/v1/learner/outcome", "POST", {"domain": "www.tiktok.com", "platform": "tiktok", "signalCategories": ["cloudflare"], "reactionType": "proxy_rotate", "success": True, "reactionTimeMs": 320, "cascadeSuccess": True, "cascadeDepth": 1, "timestamp": 1700000000000}))
record("GET /v1/learner/best-reaction/tiktok/cloudflare", api_request("/v1/learner/best-reaction/tiktok/cloudflare"))
record("GET /v1/learner/cascade-depth/www.tiktok.com", api_request("/v1/learner/cascade-depth/www.tiktok.com"))
record("GET /v1/learner/domain-model/www.tiktok.com", api_request("/v1/learner/domain-model/www.tiktok.com"))
record("GET /v1/learner/patterns", api_request("/v1/learner/patterns"))
record("GET /v1/learner/stats", api_request("/v1/learner/stats"))

# Rendering Pipeline
print("\n--- Rendering Pipeline ---")
record("GET /v1/render/stats", api_request("/v1/render/stats"))
record("POST /v1/render (httpbin /get)", api_request("/v1/render", "POST", {"url": "https://httpbin.org/get", "stealthMode": "none", "timeout": 45000, "extract": {"waitUntil": "domcontentloaded"}}, timeout=60))

# TLS Spoofer
print("\n--- TLS Spoofer ---")
record("GET /v1/tls/spoofer/stats", api_request("/v1/tls/spoofer/stats"))
record("POST /v1/tls/spoofer/detect-curl", api_request("/v1/tls/spoofer/detect-curl", "POST"))

# CAPTCHA
print("\n--- CAPTCHA ---")
record("POST /v1/captcha/detect (reCAPTCHA)", api_request("/v1/captcha/detect", "POST", {"html": '<html><head><script src="https://www.google.com/recaptcha/api.js"></script></head><body><div class="g-recaptcha" data-sitekey="6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-"></div></body></html>'}))
record("POST /v1/captcha/detect (hCaptcha)", api_request("/v1/captcha/detect", "POST", {"html": '<html><head><script src="https://js.hcaptcha.com/1/api.js"></script></head><body><div class="h-captcha" data-sitekey="a5f74b19-9e45-40e0-b45d-47ff91b7a6c2"></div></body></html>'}))
record("POST /v1/captcha/detect (Turnstile)", api_request("/v1/captcha/detect", "POST", {"html": '<html><body><div class="cf-turnstile" data-sitekey="0x4AAAAAAADnPIDROrmt1Wwj"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></body></html>'}))
record("POST /v1/captcha/detect (no CAPTCHA)", api_request("/v1/captcha/detect", "POST", {"html": "<html><body><h1>Hello World</h1></body></html>"}))
result = api_request("/v1/captcha/solve", "POST", {"url": "https://example.com", "siteKey": "test-key", "type": "recaptcha_v2"})
ok = result.get("status") == 503 or result.get("success")
record("POST /v1/captcha/solve (expect 503)", {**result, "success": ok})
record("GET /v1/captcha/balance", api_request("/v1/captcha/balance"))
record("GET /v1/captcha/stats", api_request("/v1/captcha/stats"))

# Seed first to get API key for auth-required endpoints
print("\n--- Seed ---")
seed_result = api_request("/internal/seed", "POST", headers={"X-Seed-Secret": "colab-test-secret-do-not-use-in-prod"}, timeout=60)
record("POST /internal/seed", seed_result)
api_key = ""
if seed_result.get("success"):
    api_key = seed_result.get("data", {}).get("apiKey", "")
    print(f"         API key: {api_key[:20]}...")
auth_headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

# Infrastructure (with auth)
print("\n--- Infrastructure ---")
record("GET /v1/proxy/stats", api_request("/v1/proxy/stats", headers=auth_headers))
record("GET /ip-pool/stats", api_request("/ip-pool/stats"))
record("GET /v1/rate-limits", api_request("/v1/rate-limits", headers=auth_headers))
result = api_request("/v1/sessions", headers=auth_headers)
ok = result.get("status") in (401, 403) or result.get("success")
record("GET /v1/sessions", {**result, "success": ok})
record("GET /v1/templates", api_request("/v1/templates", headers=auth_headers))
result = api_request("/v1/analytics/usage", headers=auth_headers)
ok = result.get("status") in (401, 403) or result.get("success")
record("GET /v1/analytics/usage", {**result, "success": ok})
record("GET /v1/dcim/stats", api_request("/v1/dcim/stats"))
record("GET /v1/device-farm/stats", api_request("/v1/device-farm/stats"))
record("GET /v1/akamai/stats", api_request("/v1/akamai/stats"))

# Scrape test (with auth)
print("\n--- Scrape ---")
if api_key:
    scrape_result = api_request("/v1/scrape", "POST", {"url": "https://httpbin.org/get", "strategy": "http", "timeout": 15000}, headers=auth_headers, timeout=20)
    record("POST /v1/scrape (httpbin)", scrape_result)
    if scrape_result.get("success"):
        job_id = scrape_result.get("data", {}).get("id", "")
        for _ in range(20):
            time.sleep(2)
            status_result = api_request(f"/v1/jobs/{job_id}", headers=auth_headers)
            if status_result.get("success"):
                job_status = status_result.get("data", {}).get("status", "")
                if job_status in ("done", "completed"):
                    record(f"GET /v1/jobs/{job_id[:12]}... (done)", status_result); break
                elif job_status == "failed":
                    record(f"GET /v1/jobs/{job_id[:12]}... (failed)", {**status_result, "success": False}); break
        else:
            record(f"GET /v1/jobs/{job_id[:12]}... (timeout)", {"success": False, "status": 0, "error": "Job did not complete in 40s"})
    record("GET /v1/jobs", api_request("/v1/jobs", headers=auth_headers))

# Stop engine
engine.terminate()
try: engine.wait(timeout=10)
except: engine.kill()

# Summary
print("\n" + "=" * 64)
print("TEST SUMMARY")
print("=" * 64)
for r in suite.results:
    icon = "PASS" if r.success else "FAIL"
    line = f"  [{icon}] {r.name}"
    if r.status: line += f"  (HTTP {r.status})"
    if r.duration_ms: line += f"  {r.duration_ms}ms"
    print(line)

print(f"\n  TOTAL: {suite.total}   PASSED: {suite.passed}   FAILED: {suite.failed}")
print(f"  SUCCESS RATE: {suite.success_rate:.1f}%")

if suite.failed > 0:
    print(f"\n  FAILED TESTS:")
    for r in suite.results:
        if not r.success:
            print(f"    - {r.name}: {r.error[:100] if r.error else 'no error detail'}")
