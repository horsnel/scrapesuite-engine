import subprocess, time
def run(cmd, timeout=300):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)

# Install with full output
r = run("apt-get update 2>&1 | tail -5", timeout=120)
print("Update:", r.returncode)

r = run("apt-get install -y postgresql-14 redis-server 2>&1 | tail -10", timeout=300)
print("Install:", r.returncode, r.stdout[-300:] if r.stdout else "")

# Check what's installed
r = run("which pg_ctlcluster pg_ctl postgres redis-server 2>/dev/null")
print("Binaries:", r.stdout.strip())

# Try alternative PG startup
r = run("dpkg -l | grep postgresql | head -5")
print("PG packages:", r.stdout.strip()[:500])

# If pg not found, try just "postgresql"
if "pg_ctlcluster" not in r.stdout:
    print("Trying generic postgresql package...")
    r = run("apt-get install -y postgresql 2>&1 | tail -5", timeout=120)
    print("Install2:", r.returncode)
    r = run("which pg_ctlcluster 2>/dev/null")
    print("pg_ctlcluster:", r.stdout.strip())

r = run("pg_lsclusters 2>/dev/null")
print("Clusters:", r.stdout.strip())

if r.stdout.strip():
    # Start the cluster
    for line in r.stdout.strip().split("\n"):
        parts = line.strip().split()
        if len(parts) >= 2 and "down" in line:
            ver, cluster = parts[0], parts[1]
            r2 = run(f"pg_ctlcluster {ver} {cluster} start")
            print(f"Started {ver}/{cluster}:", r2.returncode)

time.sleep(2)
r = run("pg_isready -q")
print(f"PG ready: {r.returncode == 0}")

# Redis
r = run("redis-server --daemonize yes 2>&1")
print(f"Redis start: {r.returncode}")
r = run("redis-cli ping")
print(f"Redis ping: {r.stdout.strip()}")

# Create database
for sql in ["CREATE USER scrapesuite WITH PASSWORD 'scrapesuite';", "CREATE DATABASE scrapesuite OWNER scrapesuite;", "GRANT ALL PRIVILEGES ON DATABASE scrapesuite TO scrapesuite;"]:
    run('sudo -u postgres psql -c "' + sql + '" 2>/dev/null || true')

print("SERVICES_READY")
