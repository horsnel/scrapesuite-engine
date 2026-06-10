import subprocess, time
def run(cmd, check=False, timeout=300):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"Exit {r.returncode}: {r.stderr[:200]}")
    return r

run("apt-get update -qq 2>/dev/null", timeout=120)
run("apt-get install -y -qq postgresql-14 postgresql-contrib-14 redis-server chromium 2>&1 | tail -3", timeout=300)
run("pg_ctlcluster 14 main start", check=True, timeout=30)
time.sleep(2)
pg_ok = run("pg_isready -q").returncode == 0
print(f"PG ready: {pg_ok}")
run("redis-server --daemonize yes", check=True, timeout=10)
rd = run("redis-cli ping").stdout.strip()
print(f"Redis: {rd}")
for sql in ["CREATE USER scrapesuite WITH PASSWORD 'scrapesuite';", "CREATE DATABASE scrapesuite OWNER scrapesuite;", "GRANT ALL PRIVILEGES ON DATABASE scrapesuite TO scrapesuite;"]:
    run('sudo -u postgres psql -c "' + sql + '" 2>/dev/null || true')
print("SERVICES_READY")
