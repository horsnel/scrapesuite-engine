# Task 5: Add Anti-Captcha Provider & CAPTCHA Challenge Detector

**Agent**: captcha-provider-agent
**Date**: 2025-03-04

## Summary

Enhanced `/home/z/my-project/scrapesuite-engine/src/captcha/index.ts` (from ~396 lines to ~887 lines) by adding:

### 1. AntiCaptchaProvider Class (lines 310-453)
- Implements `CaptchaProvider` interface following the same pattern as TwoCaptchaProvider and CapSolverProvider
- API base URL: `https://api.anti-captcha.com`
- Endpoints: `/createTask`, `/getTaskResult`, `/getBalance`
- API key from env: `ANTICAPTCHA_API_KEY`
- Supported task types:
  - `RecaptchaV2TaskProxyless`
  - `RecaptchaV3TaskProxyless`
  - `HCaptchaTaskProxyless`
  - `AntiTurnstileTaskProxyless`
  - `FunCaptchaTaskProxyless`
  - `ImageToTextTask`
- Request format: `{ clientKey, task: { type, websiteURL, websiteKey, ... } }`
- Response handling: checks `errorId`, polls for `status: 'ready'`, extracts solution from `gRecaptchaResponse`/`token`/`text`/`captchaKey`
- Cost structure: recaptcha_v2: $0.002, recaptcha_v3: $0.002, hcaptcha: $0.001, turnstile: $0.002, funcaptcha: $0.02, image: $0.0006
- Proxy support with Anti-Captcha's specific format (proxyType, proxyAddress, proxyPort, proxyLogin, proxyPassword)

### 2. CaptchaChallengeDetector Class (lines 464-793)
- `CaptchaDetection` interface exported with `hasCaptcha`, `types`, `siteKeys`, `confidence` fields
- `detectOnPage(page: Playwright.Page)` method - detects CAPTCHAs on a live browser page using DOM selectors
- `detectFromHTML(html: string)` method - detects CAPTCHAs from raw HTML content using regex patterns
- Detection for 5 CAPTCHA types:
  - **reCAPTCHA v2**: iframe src with `google.com/recaptcha`, div.g-recaptcha with data-sitekey, script src with `google.com/recaptcha/api.js`
  - **reCAPTCHA v3**: same script with `render=` parameter (site key as value), `grecaptcha.execute()` calls, invisible badge detection
  - **hCaptcha**: iframe src with `hcaptcha.com`, div.h-captcha with data-sitekey, hCaptcha script
  - **Turnstile**: div.cf-turnstile with data-sitekey, script with `challenges.cloudflare.com/turnstile`
  - **FunCaptcha**: iframe with `funcaptcha.com` or `arkoselabs.com`, extracts pk/public_key params
- Confidence calculation: 0.3 per detected type + 0.2 per site key, capped at 1.0

### 3. Updated CaptchaSolver Class (lines 797-883)
- Added `antiCaptcha: AntiCaptchaProvider` field
- Provider priority order: CapSolver (cheapest) → Anti-Captcha → 2Captcha
- Updated error message to include `ANTICAPTCHA_API_KEY`

### 4. Singleton Export (line 886)
- `export const captchaChallengeDetector = new CaptchaChallengeDetector();`

## Verification
- TypeScript compilation: ZERO errors in `src/captcha/index.ts`
- Pre-existing errors in Prisma/pino imports are unrelated
- All existing TwoCaptchaProvider and CapSolverProvider code preserved unchanged
