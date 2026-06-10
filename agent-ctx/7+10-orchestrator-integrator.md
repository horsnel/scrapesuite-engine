# Task 7+10: Orchestrator Integration

## Agent: Orchestrator-Integrator

## Task
Upgrade the Orchestrator to integrate all new modules that have been built (rate limiter, session manager, templates, output pipeline).

## Work Completed

### 1. Created Output Pipeline Module (`src/output/index.ts`)
- New module (~330 lines) since it didn't exist yet
- HTML → Markdown conversion with regex-based heuristics
- HTML cleaning (strip scripts, styles, nav, footer, ads)
- Plain text extraction
- Parsed content extraction (structured object with title, description, headings, etc.)
- Compression ratio tracking for analytics
- Exported `OutputPipeline` class and `outputPipeline` singleton
- Graceful error handling — never throws, always returns something usable

### 2. Updated Types (`src/types/index.ts`)
- Added `templateId?: string` to `ScrapeRequest`, `BatchScrapeRequest`, `ScrapeJobData`
- Added `outputFormat?: 'raw' | 'markdown' | 'cleaned' | 'text' | 'parsed'` to `ScrapeRequest`, `BatchScrapeRequest`, `ScrapeJobData`
- Added `outputFormat?` and `outputCompressionRatio?` to `ScrapeResult` and `ScrapeJobResult`

### 3. Upgraded Orchestrator (`src/orchestrator/index.ts`)
Major integration of 4 new modules with full backward compatibility:

- **Adaptive Rate Limiter**: Replaced simple Redis counter with `adaptiveRateLimiter.acquireToken()` and `recordResponse()`. Fallback to old method on errors.
- **Session Manager**: When sessionId provided, gets/creates session for geo-consistent proxy + fingerprint. Records request outcomes.
- **Smart Retry with Proxy + Fingerprint Rotation**: 429 → wait cooldown + different proxy + stealth; 403+anti-bot → rotate proxy AND fingerprint + stealth; 503 → different proxy after delay; CAPTCHA fail → rotate proxy + stealth. MAX_RETRIES increased to 3.
- **Template Extraction**: templateId specified or extract="auto" triggers template registry detection and extraction.
- **Output Pipeline**: outputFormat triggers processing through the output pipeline with compression ratio tracking.

### 4. Updated API Routes
- `scrape.ts`: Added `templateId` and `outputFormat` to Zod schema and job data
- `batch.ts`: Same additions to batch schema and job data

## Key Design Decisions
- All new features are **additive** — existing functionality preserved
- All new module integrations wrapped in try/catch — if a module fails, orchestrator continues
- Session lookup happens before proxy selection (session provides its own proxy)
- Template extraction runs before standard structured parsing (can coexist)
- NL extraction skips when extract="auto" (reserved for template auto-detection)
- Output pipeline processes HTML as the final step before billing/persisting

## TypeScript Verification
- `npx tsc --noEmit` passes with zero errors
