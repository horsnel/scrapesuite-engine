import subprocess, os, sys

def run(cmd, timeout=600, check=False, env=None):
    run_env = None
    if env:
        run_env = os.environ.copy()
        run_env.update(env)
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout, env=run_env)
    if check and result.returncode != 0:
        print(f"ERROR: {cmd[:60]} returned {result.returncode}: {result.stderr[:300]}")
        raise RuntimeError(f"Command failed: {cmd}")
    return result

# Step 1: Install deps
print("STEP 1: Installing system deps...")
run("apt-get update -qq", timeout=120)
run("apt-get install -y -qq postgresql postgresql-contrib", timeout=180)
run("apt-get install -y -qq redis-server", timeout=120)
run("apt-get install -y -qq chromium-browser || apt-get install -y -qq chromium", timeout=180)
run("""
if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1)" != "v22" ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y -qq nodejs
fi
""", timeout=180)
node_ver = run("node -v").stdout.strip()
print(f"  Node.js {node_ver}")

# Step 2: Start services
print("STEP 2: Starting services...")
run("service postgresql start", check=True)
for sql in ["CREATE USER scrapesuite WITH PASSWORD 'scrapesuite';", "CREATE DATABASE scrapesuite OWNER scrapesuite;", "GRANT ALL PRIVILEGES ON DATABASE scrapesuite TO scrapesuite;"]:
    run(f'sudo -u postgres psql -c "{sql}" 2>/dev/null || true')
run("redis-server --daemonize yes", check=True)
pg_ok = run("pg_isready -q").returncode == 0
redis_ok = run("redis-cli ping").stdout.strip() == "PONG"
print(f"  PostgreSQL: {'OK' if pg_ok else 'FAIL'}, Redis: {'OK' if redis_ok else 'FAIL'}")

# Step 3: Build engine
print("STEP 3: Building engine...")
REPO_URL = "https://github.com/horsnel/scrapesuite-engine.git"
REPO_DIR = "/content/scrapesuite-engine"
if not os.path.isdir(REPO_DIR):
    run(f"git clone --depth 1 {REPO_URL} {REPO_DIR}", check=True, timeout=120)
else:
    run(f"cd {REPO_DIR} && git pull", timeout=60)
os.chdir(REPO_DIR)
run("npm install", check=True, timeout=300)
run("npx prisma generate", check=True, timeout=60)
db_env = {"DATABASE_URL": "postgresql://scrapesuite:scrapesuite@localhost:5432/scrapesuite"}
run("npx prisma db push --skip-generate --accept-data-loss", check=True, timeout=120, env=db_env)
run("npx playwright install chromium", timeout=300)
run("npx playwright install-deps chromium", timeout=300)
run("npx tsc", check=True, timeout=300)
print("  Engine built successfully")
print("SETUP_COMPLETE")
