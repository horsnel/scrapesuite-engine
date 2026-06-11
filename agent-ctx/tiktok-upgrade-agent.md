# Task: Upgrade TikTok Platform Scraper with Real Playwright Automation

## Summary

Upgraded three core TikTok platform files in `/home/z/my-project/scrapesuite-engine/src/platforms/tiktok/` from simulated/placeholder implementations to REAL Playwright browser automation using the shared browser pool.

## Files Modified

### 1. `feed-simulator.ts`
- **Before**: Purely simulated feed browsing - generated fake video IDs and random interactions with no real browser interaction
- **After**: 
  - New `runBrowserSession()` method that acquires a stealth browser from the pool, navigates to TikTok, scrolls through videos, and extracts live data
  - `navigateToTikTok()` - Real navigation with wait strategies for SPA hydration
  - `simulateSection()` / `simulateFYP()` - Real FYP browsing with keyboard ArrowDown scrolling
  - `simulateSearch()` - Navigates to `/search?q=...` and extracts results
  - `extractCurrentVideoData()` - Evaluates JS in browser to extract video metadata from DOM
  - `extractSearchResults()` - Evaluates JS to extract search result videos
  - `detectAntiBotBarriers()` - Checks for login modal and CAPTCHA iframes
  - `dismissLoginModal()` - Attempts to close login popups
  - `simulateInteraction()` - Clicks real like/share/follow/comment buttons
  - `scrollToNextVideo()` - Uses keyboard ArrowDown (TikTok's primary navigation)
  - New `ExtractedVideoData` interface for structured video data output
  - All selectors use current 2024-2025 TikTok `data-e2e` attributes
  - Always releases browser in `finally` blocks
  - Legacy `generateSession()` and `generatePlaywrightSequence()` kept as fallback

### 2. `xbogus-signer.ts`
- **Before**: Custom murmur-hash algorithm only, no real signing
- **After**:
  - Three-tier signing strategy:
    1. **CDN Extractor** (primary): Uses `xbogusCDNExtractor.extractAndExecute()` to extract TikTok's real algorithm from CDN and execute in a sandbox
    2. **Browser Pool** (secondary): Acquires a browser from the pool, navigates to TikTok, and evaluates the signing function in TikTok's real JS context (tries `byted_acrawler.sign`, `_bytedAcrawler.sign`, webpack modules)
    3. **Fallback** (tertiary): Original murmur-hash algorithm when browser is unavailable
  - New `initialize()` method to initialize the CDN extractor
  - New `quickSign()` convenience method
  - New `signUrl()` method that appends X-Bogus and msToken to a URL
  - Tracks statistics per signing source (cdn/browser-pool/fallback)
  - Always releases browser in `finally` blocks

### 3. `manager.ts`
- **Before**: No actual scraping methods - only signing, token rotation, and session preparation
- **After**:
  - New `scrapeProfile(username)` - Scrapes a TikTok profile:
    - Tries signed API first (`/api/user/detail/`)
    - Falls back to browser: navigates to `https://www.tiktok.com/@username`, extracts profile data and video grid
  - New `scrapeVideo(videoUrl)` - Scrapes a video:
    - Tries signed API first (`/api/video/detail/`)
    - Falls back to browser: navigates to the video URL, extracts metadata from DOM
  - New `scrapeSearch(query)` - Performs a search:
    - Tries signed API first (`/api/search/general/full/`)
    - Falls back to browser: navigates to `/search?q=...`, scrolls and extracts results
  - New `simulateFeedLive()` - Delegates to `feedSimulator.runBrowserSession()`
  - `handleAntiBotOnPage()` - Shared method for detecting/dismissing login walls and CAPTCHAs
  - New exported types: `ScrapedProfile`, `ScrapedProfileVideo`, `ScrapedVideo`, `ScrapedSearchResult`
  - All browser interactions use `browserPool.acquire()` with `stealthMode=true`
  - All browser leases released in `finally` blocks
  - API signing uses XBogus + msToken + ttwid algorithms

## Key Design Decisions

1. **API-first with browser fallback**: Each scrape method tries the signed API first (faster, less resource-intensive), then falls back to browser scraping if the API returns errors or is blocked
2. **Stealth browser contexts**: All browser acquisitions use `stealthMode=true` to inject anti-detection scripts
3. **Proper resource cleanup**: Every `browserPool.acquire()` is paired with a `browserPool.release()` in a `finally` block
4. **Selector resilience**: Uses `data-e2e` attributes (TikTok's test selectors) which are more stable than class names
5. **Backward compatibility**: Kept all existing method signatures (`generateSession()`, `simulateFeed()`, etc.) as synchronous fallbacks
6. **Circular dependency handling**: The `xbogus-signer` ↔ `xbogus-cdn-extractor` circular import works because both use singleton patterns with lazy initialization

## Compilation Status

All three modified files compile without errors against the project's tsconfig.json. Pre-existing errors in other files (api/routes, reddit, whatsapp) are unrelated.
