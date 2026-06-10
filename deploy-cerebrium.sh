#!/bin/bash
# ─── ScrapeSuite Engine — Cerebrium Deployment Script ────────────────────────
#
# Usage:
#   ./deploy-cerebrium.sh              # Full setup + deploy
#   ./deploy-cerebrium.sh --setup-only # Only set up external services
#   ./deploy-cerebrium.sh --deploy     # Skip setup, just deploy
#   ./deploy-cerebrium.sh --status     # Check deployment status
#
# Prerequisites:
#   - Cerebrium account (https://cerebrium.ai)
#   - cerebrium CLI installed (pip install cerebrium)
#   - Node.js 20+ for local build verification
# ─────────────────────────────────────────────────────────────────────────────

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         ScrapeSuite Engine → Cerebrium Deployment          ║"
echo "║     Production-grade web scraping on serverless infra       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Parse Arguments ──────────────────────────────────────────────────────────
SETUP_ONLY=false
DEPLOY_ONLY=false
CHECK_STATUS=false

for arg in "$@"; do
  case $arg in
    --setup-only) SETUP_ONLY=true ;;
    --deploy) DEPLOY_ONLY=true ;;
    --status) CHECK_STATUS=true ;;
    --help) echo "Usage: $0 [--setup-only|--deploy|--status|--help]"; exit 0 ;;
  esac
done

# ── Check Status ─────────────────────────────────────────────────────────────
if [ "$CHECK_STATUS" = true ]; then
  echo -e "${CYAN}Checking deployment status...${NC}"
  cerebrium apps list 2>&1 || true
  cerebrium logs scrapesuite-engine --tail 20 2>&1 || true
  exit 0
fi

# ── Step 1: Verify Prerequisites ────────────────────────────────────────────
echo -e "${YELLOW}Step 1: Verifying prerequisites...${NC}"

if ! command -v cerebrium &> /dev/null; then
  echo -e "${RED}Error: cerebrium CLI not found. Install with: pip install cerebrium${NC}"
  exit 1
fi

if ! command -v node &> /dev/null; then
  echo -e "${RED}Error: Node.js not found. Install Node.js 20+ first.${NC}"
  exit 1
fi

echo -e "${GREEN}  ✓ cerebrium CLI found${NC}"
echo -e "${GREEN}  ✓ Node.js $(node -v) found${NC}"

# ── Step 2: Build Check ─────────────────────────────────────────────────────
if [ "$DEPLOY_ONLY" = false ]; then
  echo -e "${YELLOW}Step 2: Running TypeScript compile check...${NC}"

  if npx tsc --noEmit 2>&1; then
    echo -e "${GREEN}  ✓ TypeScript compiles cleanly${NC}"
  else
    echo -e "${RED}  ✗ TypeScript errors found. Fix before deploying.${NC}"
    exit 1
  fi
fi

# ── Step 3: Cerebrium Login ─────────────────────────────────────────────────
if [ "$DEPLOY_ONLY" = false ]; then
  echo -e "${YELLOW}Step 3: Checking Cerebrium authentication...${NC}"

  if cerebrium apps list &> /dev/null 2>&1; then
    echo -e "${GREEN}  ✓ Already logged in to Cerebrium${NC}"
  else
    echo -e "${CYAN}  Opening Cerebrium login...${NC}"
    cerebrium login
  fi
fi

# ── Step 4: External Services Setup ─────────────────────────────────────────
if [ "$DEPLOY_ONLY" = false ]; then
  echo ""
  echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║  External Services Required                                 ║${NC}"
  echo -e "${CYAN}╠══════════════════════════════════════════════════════════════╣${NC}"
  echo -e "${CYAN}║                                                              ║${NC}"
  echo -e "${CYAN}║  ScrapeSuite needs PostgreSQL and Redis.                    ║${NC}"
  echo -e "${CYAN}║  Cerebrium doesn't provide these — use free cloud tiers:    ║${NC}"
  echo -e "${CYAN}║                                                              ║${NC}"
  echo -e "${CYAN}║  PostgreSQL (pick one):                                      ║${NC}"
  echo -e "${CYAN}║    • Neon (neon.tech) — 0.5GB free, serverless              ║${NC}"
  echo -e "${CYAN}║    • Supabase (supabase.com) — 500MB free                   ║${NC}"
  echo -e "${CYAN}║    • Aiven (aiven.io) — Free tier available                 ║${NC}"
  echo -e "${CYAN}║                                                              ║${NC}"
  echo -e "${CYAN}║  Redis (pick one):                                           ║${NC}"
  echo -e "${CYAN}║    • Upstash (upstash.com) — 10K commands/day free          ║${NC}"
  echo -e "${CYAN}║    • Redis Cloud (redis.com) — 30MB free tier               ║${NC}"
  echo -e "${CYAN}║    • Aiven (aiven.io) — Free tier available                 ║${NC}"
  echo -e "${CYAN}║                                                              ║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""

  # Check if secrets are already set
  echo -e "${YELLOW}Step 4: Setting up Cerebrium secrets...${NC}"
  echo -e "${CYAN}  After creating your database and Redis instances, add the following${NC}"
  echo -e "${CYAN}  secrets in the Cerebrium Dashboard (Settings → Secrets):${NC}"
  echo ""
  echo -e "  ${GREEN}DATABASE_URL${NC}    = postgresql://user:pass@host:5432/scrapesuite?sslmode=require"
  echo -e "  ${GREEN}REDIS_URL${NC}       = redis://default:pass@host:6379"
  echo -e "  ${GREEN}JWT_SECRET${NC}      = $(openssl rand -hex 32 2>/dev/null || echo 'generate-with-openssl-rand-hex-32')"
  echo ""
  echo -e "  ${YELLOW}Optional secrets (for production scraping):${NC}"
  echo -e "  ${GREEN}ANTHROPIC_API_KEY${NC}  = your-anthropic-key"
  echo -e "  ${GREEN}TWOCAPTCHA_API_KEY${NC} = your-2captcha-key"
  echo ""

  if [ "$SETUP_ONLY" = true ]; then
    echo -e "${CYAN}Set up your external services and secrets, then run:${NC}"
    echo -e "  ${GREEN}./deploy-cerebrium.sh --deploy${NC}"
    exit 0
  fi

  read -p "Have you set up all required secrets in Cerebrium Dashboard? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Please set up secrets first, then re-run with --deploy${NC}"
    exit 0
  fi
fi

# ── Step 5: Deploy ──────────────────────────────────────────────────────────
echo -e "${YELLOW}Step 5: Deploying to Cerebrium...${NC}"
echo ""
echo -e "${CYAN}  This will:${NC}"
echo -e "${CYAN}  1. Package your application files${NC}"
echo -e "${CYAN}  2. Build the Docker image on Cerebrium${NC}"
echo -e "${CYAN}  3. Deploy with auto-scaling (1-5 replicas)${NC}"
echo -e "${CYAN}  4. Run Prisma migrations on startup${NC}"
echo ""

cerebrium deploy --disable-confirmation

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Deployment Complete!                                       ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║                                                              ║${NC}"
echo -e "${GREEN}║  Your ScrapeSuite Engine is now live on Cerebrium!          ║${NC}"
echo -e "${GREEN}║                                                              ║${NC}"
echo -e "${GREEN}║  Next steps:                                                 ║${NC}"
echo -e "${GREEN}║  1. Seed the database:                                       ║${NC}"
echo -e "${GREEN}║     POST https://<app-url>/internal/seed                    ║${NC}"
echo -e "${GREEN}║     Header: X-Seed-Secret: <your-jwt-secret>                ║${NC}"
echo -e "${GREEN}║                                                              ║${NC}"
echo -e "${GREEN}║  2. Test the API:                                            ║${NC}"
echo -e "${GREEN}║     GET https://<app-url>/health                            ║${NC}"
echo -e "${GREEN}║     GET https://<app-url>/v1                                 ║${NC}"
echo -e "${GREEN}║                                                              ║${NC}"
echo -e "${GREEN}║  3. Make your first scrape:                                  ║${NC}"
echo -e "${GREEN}║     POST https://<app-url>/v1/scrape                        ║${NC}"
echo -e "${GREEN}║     Authorization: Bearer <api-key-from-seed>                ║${NC}"
echo -e "${GREEN}║                                                              ║${NC}"
echo -e "${GREEN}║  View logs: cerebrium logs scrapesuite-engine               ║${NC}"
echo -e "${GREEN}║                                                              ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
