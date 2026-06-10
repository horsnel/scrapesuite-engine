#!/bin/sh
# ScrapeSuite Engine — Production startup script
# Runs Prisma migrations then starts the app

echo "[$(date)] === ScrapeSuite Engine Starting ==="

# Accept MODE from command argument (overrides env var)
if [ -n "$1" ]; then
  export MODE="$1"
fi

echo "[$(date)] MODE=$MODE PORT=$PORT NODE_ENV=$NODE_ENV"

# Run Prisma database push to create/update tables
echo "[$(date)] Running Prisma database push..."
npx prisma db push --skip-generate --accept-data-loss 2>&1
PRISMA_EXIT=$?
if [ $PRISMA_EXIT -ne 0 ]; then
  echo "[$(date)] WARNING: Prisma db push exited with code $PRISMA_EXIT, continuing anyway..."
else
  echo "[$(date)] Prisma db push completed successfully"
fi

# Start the application
echo "[$(date)] Starting ScrapeSuite Engine (MODE=$MODE)..."
exec node dist/index.js
