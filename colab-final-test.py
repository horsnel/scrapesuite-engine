import subprocess, os, time, json, urllib.request, urllib.error

def run(cmd, env=None, check=False, timeout=600):
    run_env = None
    if env:
        run_env = os.environ.copy()
        run_env.update(env)
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout, env=run_env)
    if check and r.returncode != 0:
        print(f"FAIL: {cmd}\n{r.stderr[:300]}")
        raise RuntimeError(f"Exit {r.returncode}")
    return r

def api(endpoint, method="GET", data=None, headers=None, timeout=30):
    url = f"http://localhost:3000{endpoint}"
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    # For POST/PUT with no data, send empty object to avoid "body cannot be empty"
    if method in ("POST", "PUT", "PATCH") and data is None:
        data = {}
    try:
        body = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(url, data=body, headers=h, method=method)
        s = time.monotonic()
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ms = int((time.monotonic() - s) * 1000)
            return {"ok": True, "status": resp.status, "data": json.loads(resp.read().decode()), "ms": ms}
    except urllib.error.HTTPError as e:
        ms = int((time.monotonic() - s) * 1000)
        return {"ok": False, "status": e.code, "error": e.read().decode()[:300], "ms": ms}
    except Exception as e:
        return {"ok": False, "status": 0, "error": str(e)[:200], "ms": 0}

total = 0
passed = 0

# Clone if needed, then pull latest
if not os.path.isdir("/content/scrapesuite-engine"):
    run("git clone --depth 1 https://github.com/horsnel/scrapesuite-engine.git /content/scrapesuite-engine", check=True, timeout=120)
os.chdir("/content/scrapesuite-engine")
print("Pulling latest...")
run("git pull", check=True, timeout=30)
print("Installing deps...")
run("npm install", check=True, timeout=300)
run("npx prisma generate", check=True, timeout=60)
db_env = {"DATABASE_URL": "postgresql://scrapesuite:scrapesuite@localhost:5432/scrapesuite"}
run("npx prisma db push --skip-generate --accept-data-loss", check=True, timeout=120, env=db_env)
print("Rebuilding...")
run("npx tsc", check=True, timeout=300)

print("Starting engine...")
env = os.environ.copy()
env.update({
    "NODE_ENV": "production", "PORT": "3000", "HOST": "0.0.0.0", "MODE": "all",
    "DATABASE_URL": "postgresql://scrapesuite:scrapesuite@localhost:5432/scrapesuite",
    "REDIS_URL": "redis://localhost:6379", "JWT_SECRET": "colab-test-secret",
    "BROWSER_POOL_MAX": "2", "BROWSER_MAX_CONTEXTS": "3",
})
proc = subprocess.Popen(["node", "dist/index.js"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

healthy = False
for i in range(60):
    try:
        with urllib.request.urlopen("http://localhost:3000/health", timeout=3) as resp:
            if resp.status == 200:
                d = json.loads(resp.read().decode())
                print(f"Engine healthy after {i+1}s!\n")
                healthy = True
                break
    except:
        pass
    if proc.poll() is not None:
        print(f"CRASH! exit={proc.returncode}")
        print(proc.stderr.read().decode()[-1000:])
        break
    time.sleep(1)

if not healthy:
    raise RuntimeError("Engine failed")


def t(name, r):
    global total, passed
    total += 1
    ok = r.get("ok", False)
    if ok:
        passed += 1
    icon = "PASS" if ok else "FAIL"
    print(f"  [{icon}] {name}  HTTP {r.get('status', 0)} {r.get('ms', 0)}ms")
    if not ok and r.get("error"):
        print(f"       {r['error'][:100]}")
    return ok


print("HEALTH")
t("GET /health", api("/health"))
t("GET /v1", api("/v1"))

print("\nFUSION REACTOR")
t("GET status", api("/v1/fusion-reactor/status"))
t("POST detect", api("/v1/fusion-reactor/detect", "POST", {"url": "https://www.tiktok.com", "statusCode": 403, "headers": {"server": "cloudflare"}, "body": "challenge"}))
t("POST quick-check", api("/v1/fusion-reactor/quick-check", "POST", {"url": "https://www.tiktok.com", "statusCode": 403}))
t("POST process", api("/v1/fusion-reactor/process", "POST", {"url": "https://www.tiktok.com", "statusCode": 403, "body": "challenge"}))
t("GET rules", api("/v1/fusion-reactor/rules"))
t("GET detector/stats", api("/v1/fusion-reactor/detector/stats"))
t("GET engine/stats", api("/v1/fusion-reactor/engine/stats"))

print("\nTIKTOK")
t("POST initialize", api("/v1/tiktok/initialize", "POST"))
t("POST sign", api("/v1/tiktok/sign", "POST", {"url": "https://www.tiktok.com/api/recommend/?count=6", "deviceType": "desktop"}))
t("GET mstoken", api("/v1/tiktok/mstoken"))
t("POST device/rotate", api("/v1/tiktok/device/rotate", "POST", {"deviceType": "desktop"}))
t("GET stats", api("/v1/tiktok/stats"))
t("GET xbogus/stats", api("/v1/tiktok/xbogus/stats"))

print("\nYOUTUBE")
t("POST initialize", api("/v1/youtube/initialize", "POST"))
t("POST sign", api("/v1/youtube/sign", "POST", {"url": "https://www.youtube.com/youtubei/v1/player", "method": "POST", "requestBody": {"context": {"client": {"clientName": "WEB", "clientVersion": "2.20240101"}}, "videoId": "dQw4w9WgXcQ"}}))
t("GET stats", api("/v1/youtube/stats"))

print("\nREDDIT")
t("POST initialize", api("/v1/reddit/initialize", "POST"))
t("POST evade-rate-limit", api("/v1/reddit/evade-rate-limit", "POST", {"statusCode": 429}))
t("GET stats", api("/v1/reddit/stats"))

print("\nQUANTUM TLS + SPOOFER")
t("GET profiles", api("/v1/tls/profiles"))
t("GET connection", api("/v1/tls/connection?domain=www.tiktok.com"))
t("GET stats", api("/v1/tls/stats"))
t("GET quantum-readiness", api("/v1/tls/quantum-readiness"))
t("POST rotate", api("/v1/tls/rotate", "POST", {"strategy": "weighted"}))
t("GET spoofer/stats", api("/v1/tls/spoofer/stats"))
t("POST detect-curl", api("/v1/tls/spoofer/detect-curl", "POST", {}))

print("\nRENDERING PIPELINE")
t("GET render/stats", api("/v1/render/stats"))
t("POST render", api("/v1/render", "POST", {"url": "https://httpbin.org/get", "stealthMode": "none", "timeout": 15000}, timeout=30))

print("\nCAPTCHA")
t("POST detect reCAPTCHA", api("/v1/captcha/detect", "POST", {"html": '<script src="https://www.google.com/recaptcha/api.js"></script><div class="g-recaptcha" data-sitekey="x"></div>'}))
t("POST detect hCaptcha", api("/v1/captcha/detect", "POST", {"html": '<script src="https://js.hcaptcha.com/1/api.js"></script>'}))
t("POST detect Turnstile", api("/v1/captcha/detect", "POST", {"html": '<div class="cf-turnstile"></div>'}))
t("POST detect none", api("/v1/captcha/detect", "POST", {"html": "<html><body>Hello</body></html>"}))
r = api("/v1/captcha/solve", "POST", {"url": "https://example.com", "siteKey": "t", "type": "recaptcha_v2"})
t("POST solve (expect 503)", {**r, "ok": r.get("status") == 503 or r.get("ok")})
t("GET stats", api("/v1/captcha/stats"))

print("\nSELF-IMPROVER + LEARNER")
t("POST improver/init", api("/v1/self-improver/initialize", "POST"))
t("POST observe", api("/v1/self-improver/observe", "POST", {"url": "https://www.tiktok.com", "domain": "www.tiktok.com", "outcome": "success", "detectedPlatform": "cloudflare", "durationMs": 450}))
t("GET observations", api("/v1/self-improver/observations?limit=5"))
t("GET improver/stats", api("/v1/self-improver/stats"))
t("POST learner/outcome", api("/v1/learner/outcome", "POST", {"domain": "www.tiktok.com", "platform": "tiktok", "signalCategory": "cloudflare", "reactionType": "proxy_rotate", "outcome": "success", "responseTimeMs": 320}))
t("GET best-reaction", api("/v1/learner/best-reaction/tiktok/cloudflare"))
t("GET learner/stats", api("/v1/learner/stats"))

print("\nINFRASTRUCTURE")
for ep in ["/ip-pool/stats", "/v1/dcim/stats", "/v1/akamai/stats"]:
    t(f"GET {ep}", api(ep))
# Auth-required endpoints - 401/403 is expected
for ep in ["/v1/proxy/stats", "/v1/rate-limits", "/v1/templates"]:
    r = api(ep)
    t(f"GET {ep} (auth)", {**r, "ok": r.get("status") in (401, 403) or r.get("ok")})
for ep in ["/v1/sessions", "/v1/analytics/usage"]:
    r = api(ep)
    t(f"GET {ep} (auth)", {**r, "ok": r.get("status") in (401, 403) or r.get("ok")})

print("\nSEED & SCRAPE")
seed = api("/internal/seed", "POST", headers={"X-Seed-Secret": "colab-test-secret"})
t("POST /internal/seed", seed)
if seed.get("ok"):
    ak = seed.get("data", {}).get("apiKey", "")
    if ak:
        t("POST /v1/scrape", api("/v1/scrape", "POST", {"url": "https://httpbin.org/get", "strategy": "http", "timeout": 15000}, headers={"Authorization": f"Bearer {ak}"}, timeout=20))

proc.terminate()

print(f"\n{'=' * 50}")
print(f"TOTAL: {total}  PASSED: {passed}  FAILED: {total - passed}")
print(f"SUCCESS RATE: {passed / total * 100:.1f}%")
print(f"{'=' * 50}")
