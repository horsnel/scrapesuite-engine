# Task 10: API Routes for ScrapeSuite Engine

## Agent: API-Routes

## Work Log

- Read worklog.md and all previous agents' context (Tasks 1-8)
- Read existing codebase: api/index.ts (buildServer, route registration pattern), api/routes/serp.ts, api/routes/proxy-stats.ts (coding style reference), api/middleware/auth.ts, api/middleware/credits.ts
- Read module APIs: session/index.ts (SessionManager), templates/index.ts (TemplateRegistry), collector/index.ts (CollectorManager), rate-limiter/index.ts (AdaptiveRateLimiter)
- Created src/api/routes/sessions.ts (~200 lines) — 5 endpoints for session management
- Created src/api/routes/templates.ts (~130 lines) — 3 endpoints for template discovery
- Created src/api/routes/collectors.ts (~430 lines) — 11 endpoints for collector/dataset management
- Created src/api/routes/rate-limits.ts (~90 lines) — 2 endpoints for rate limit status
- Updated src/api/index.ts — Added 4 imports, 4 route registrations, documentation endpoint updates

## Route Files Created

### 1. sessions.ts
- POST /v1/sessions — Create session with proxy tier/country/city/ASN/domain/TTL options
- GET /v1/sessions — List user's active sessions
- GET /v1/sessions/:id — Get session status with metrics (ownership check)
- DELETE /v1/sessions/:id — Terminate session (ownership check)
- POST /v1/sessions/:id/refresh — Refresh session TTL (sliding window)
- All routes: authMiddleware, ownership verification for :id routes
- Proper error handling: 429 for session limit, 503 for no proxy, 403/404

### 2. templates.ts
- GET /v1/templates — List all templates (via templateRegistry.listTemplates)
- GET /v1/templates/:id — Get template details (via templateRegistry.getTemplate)
- POST /v1/templates/detect — Detect template for URL (via templateRegistry.detectTemplate)
- All routes: authMiddleware
- Returns detected: false with message when no template matches

### 3. collectors.ts
- POST /v1/collectors — Create with full schema validation
- GET /v1/collectors — List user's collectors
- GET /v1/collectors/:id — Get details (ownership check via helper)
- PATCH /v1/collectors/:id — Partial update with validation
- DELETE /v1/collectors/:id — Delete (ownership check)
- POST /v1/collectors/:id/run — Run collector (authMiddleware + checkCredits, 5 credits/URL)
- GET /v1/collectors/:id/datasets — List datasets (?limit param)
- GET /v1/collectors/:id/datasets/latest — Get latest dataset
- GET /v1/datasets/:id — Get dataset by ID (ownership check)
- GET /v1/datasets/:id/delta — Get delta vs previous run
- GET /v1/datasets/:id/export — Export as JSON or CSV (?format=json|csv, Content-Disposition header)
- Shared verifyOwnership helper to reduce code duplication
- Credit deduction on run based on actual URLs processed

### 4. rate-limits.ts
- GET /v1/rate-limits/:domain — Get domain rate limit status (Business plan only)
- GET /v1/rate-limits — Get all throttled domains (Business plan only)
- All routes: authMiddleware + plan check (403 for non-business)

### 5. api/index.ts Updates
- Added 4 new imports: sessionRoutes, templateRoutes, collectorRoutes, rateLimitRoutes
- Registered all 4 route modules after existing routes
- Updated /v1 documentation endpoint with 4 new endpoint groups (sessions, templates, collectors, rateLimits)
- Added 4 new feature descriptions (stickySessions, scraperTemplates, collectors, adaptiveRateLimiting)

## Verification
- TypeScript compilation passes with zero errors (npx tsc --noEmit)
