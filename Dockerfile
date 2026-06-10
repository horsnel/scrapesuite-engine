# ─── ScrapeSuite Engine — Fly.io Production Dockerfile ──────────────────────
# Multi-stage build: install deps → build → production image

# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder

# Install OpenSSL for Prisma
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install build dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY prisma ./prisma/
COPY src ./src/
RUN npx prisma generate && npm run build

# ── Stage 2: Production ─────────────────────────────────────────────────────
FROM node:20-slim

# Install Playwright browser dependencies + OpenSSL for Prisma
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libxshmfence1 \
    fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --only=production

# Install prisma CLI for startup migrations
RUN npm install prisma@^6.8.0

# Copy Prisma schema and generate client
COPY prisma ./prisma/
RUN npx prisma generate

# Copy built JavaScript from builder
COPY --from=builder /app/dist ./dist/

# Install Playwright Chromium
RUN npx playwright install chromium

# Create data directory for volume mount
RUN mkdir -p /data

# Copy startup script
COPY start.sh ./
RUN chmod +x start.sh

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright

# Start with migration script
CMD ["./start.sh"]
