import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('captcha');

// --- Types --------------------------------------------------------------------

export interface CaptchaSolveRequest {
  url: string;
  siteKey: string;
  type: 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile' | 'funcaptcha' | 'image';
  action?: string;
  minScore?: number;
  imageData?: string;
  proxyUrl?: string;
}

export interface CaptchaSolveResult {
  success: boolean;
  token: string;
  solveTimeMs: number;
  cost: number;
  provider: string;
}

interface CaptchaProvider {
  name: string;
  solve(request: CaptchaSolveRequest): Promise<CaptchaSolveResult>;
  getBalance(): Promise<number>;
}

// --- 2Captcha Provider -------------------------------------------------------

class TwoCaptchaProvider implements CaptchaProvider {
  name = '2captcha';
  private apiKey: string;
  private baseUrl = 'https://api.2captcha.com';

  constructor() {
    this.apiKey = process.env.TWOCAPTCHA_API_KEY || '';
    if (!this.apiKey) {
      logger.warn('TWOCAPTCHA_API_KEY not set -- 2Captcha provider disabled');
    }
  }

  get isConfigured(): boolean {
    return !!this.apiKey;
  }

  async solve(request: CaptchaSolveRequest): Promise<CaptchaSolveResult> {
    if (!this.isConfigured) throw new Error('2Captcha not configured');

    const startTime = Date.now();

    const submitParams: Record<string, string> = {
      key: this.apiKey,
      json: '1',
      soft_id: '5527',
    };

    switch (request.type) {
      case 'recaptcha_v2':
        submitParams.method = 'userrecaptcha';
        submitParams.googlekey = request.siteKey;
        submitParams.pageurl = request.url;
        break;
      case 'recaptcha_v3':
        submitParams.method = 'userrecaptcha';
        submitParams.googlekey = request.siteKey;
        submitParams.pageurl = request.url;
        submitParams.version = 'v3';
        if (request.action) submitParams.action = request.action;
        if (request.minScore) submitParams.min_score = String(request.minScore);
        break;
      case 'hcaptcha':
        submitParams.method = 'hcaptcha';
        submitParams.sitekey = request.siteKey;
        submitParams.pageurl = request.url;
        break;
      case 'turnstile':
        submitParams.method = 'turnstile';
        submitParams.sitekey = request.siteKey;
        submitParams.pageurl = request.url;
        break;
      case 'image':
        submitParams.method = 'base64';
        submitParams.body = request.imageData || '';
        break;
      default:
        throw new Error(`2Captcha: unsupported type ${request.type}`);
    }

    if (request.proxyUrl) {
      try {
        const proxyUrl = new URL(request.proxyUrl);
        submitParams.proxy = `${proxyUrl.hostname}:${proxyUrl.port}`;
        submitParams.proxytype = proxyUrl.protocol === 'https:' ? 'HTTPS' : 'HTTP';
        if (proxyUrl.username) {
          submitParams.proxy += `:${proxyUrl.username}:${proxyUrl.password}`;
        }
      } catch {}
    }

    const submitResponse = await fetch(`${this.baseUrl}/in.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(submitParams).toString(),
    });

    const submitData = await submitResponse.json() as any;
    if (submitData.status !== 1) {
      throw new Error(`2Captcha submit failed: ${submitData.request || submitData.error_text}`);
    }

    const taskId = submitData.request;

    for (let i = 0; i < 24; i++) {
      await this.sleep(5000);

      const resultParams = new URLSearchParams({
        key: this.apiKey,
        action: 'get',
        id: taskId,
        json: '1',
      });

      const resultResponse = await fetch(`${this.baseUrl}/res.php?${resultParams}`);
      const resultData = await resultResponse.json() as any;

      if (resultData.status === 1) {
        const solveTimeMs = Date.now() - startTime;
        const cost = this.calculateCost(request.type);

        return {
          success: true,
          token: resultData.request,
          solveTimeMs,
          cost,
          provider: this.name,
        };
      }

      if (resultData.request !== 'CAPCHA_NOT_READY') {
        throw new Error(`2Captcha solve failed: ${resultData.request}`);
      }
    }

    throw new Error('2Captcha solve timeout (120s)');
  }

  async getBalance(): Promise<number> {
    if (!this.isConfigured) return 0;
    try {
      const response = await fetch(
        `${this.baseUrl}/res.php?key=${this.apiKey}&action=getbalance&json=1`,
      );
      const data = await response.json() as any;
      return data.request ? parseFloat(data.request) : 0;
    } catch { return 0; }
  }

  private calculateCost(type: string): number {
    const costs: Record<string, number> = {
      recaptcha_v2: 0.003, recaptcha_v3: 0.003, hcaptcha: 0.003,
      turnstile: 0.003, funcaptcha: 0.02, image: 0.001,
    };
    return costs[type] || 0.003;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// --- CapSolver Provider ------------------------------------------------------

class CapSolverProvider implements CaptchaProvider {
  name = 'capsolver';
  private apiKey: string;
  private baseUrl = 'https://api.capsolver.com';

  constructor() {
    this.apiKey = process.env.CAPSOLVER_API_KEY || '';
    if (!this.apiKey) {
      logger.warn('CAPSOLVER_API_KEY not set -- CapSolver provider disabled');
    }
  }

  get isConfigured(): boolean {
    return !!this.apiKey;
  }

  async solve(request: CaptchaSolveRequest): Promise<CaptchaSolveResult> {
    if (!this.isConfigured) throw new Error('CapSolver not configured');

    const startTime = Date.now();

    const taskPayload: Record<string, any> = {};

    switch (request.type) {
      case 'recaptcha_v2':
        taskPayload.type = 'ReCaptchaV2TaskProxyLess';
        taskPayload.websiteURL = request.url;
        taskPayload.websiteKey = request.siteKey;
        break;
      case 'recaptcha_v3':
        taskPayload.type = 'ReCaptchaV3TaskProxyLess';
        taskPayload.websiteURL = request.url;
        taskPayload.websiteKey = request.siteKey;
        if (request.action) taskPayload.pageAction = request.action;
        if (request.minScore) taskPayload.minScore = request.minScore;
        break;
      case 'hcaptcha':
        taskPayload.type = 'HCaptchaTaskProxyLess';
        taskPayload.websiteURL = request.url;
        taskPayload.websiteKey = request.siteKey;
        break;
      case 'turnstile':
        taskPayload.type = 'AntiTurnstileTaskProxyLess';
        taskPayload.websiteURL = request.url;
        taskPayload.websiteKey = request.siteKey;
        break;
      case 'image':
        taskPayload.type = 'ImageToTextTask';
        taskPayload.body = request.imageData;
        break;
      default:
        throw new Error(`CapSolver: unsupported type ${request.type}`);
    }

    if (request.proxyUrl) {
      taskPayload.proxyUrl = request.proxyUrl;
      if (taskPayload.type.includes('ProxyLess')) {
        taskPayload.type = taskPayload.type.replace('ProxyLess', '');
      }
    }

    const createResponse = await fetch(`${this.baseUrl}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: this.apiKey, task: taskPayload }),
    });

    const createData = await createResponse.json() as any;
    if (createData.errorId && createData.errorId !== 0) {
      throw new Error(`CapSolver create task failed: ${createData.errorDescription}`);
    }

    const taskId = createData.taskId;

    for (let i = 0; i < 60; i++) {
      await this.sleep(2000);

      const resultResponse = await fetch(`${this.baseUrl}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: this.apiKey, taskId }),
      });

      const resultData = await resultResponse.json() as any;

      if (resultData.status === 'ready') {
        const solveTimeMs = Date.now() - startTime;
        const cost = this.calculateCost(request.type);

        const token = resultData.solution?.gRecaptchaResponse
          || resultData.solution?.captchaKey
          || resultData.solution?.token
          || resultData.solution?.text
          || '';

        return { success: true, token, solveTimeMs, cost, provider: this.name };
      }

      if (resultData.errorId && resultData.errorId !== 0) {
        throw new Error(`CapSolver solve failed: ${resultData.errorDescription}`);
      }
    }

    throw new Error('CapSolver solve timeout (120s)');
  }

  async getBalance(): Promise<number> {
    if (!this.isConfigured) return 0;
    try {
      const response = await fetch(`${this.baseUrl}/getBalance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: this.apiKey }),
      });
      const data = await response.json() as any;
      return data.balance || 0;
    } catch { return 0; }
  }

  private calculateCost(type: string): number {
    const costs: Record<string, number> = {
      recaptcha_v2: 0.002, recaptcha_v3: 0.002, hcaptcha: 0.002,
      turnstile: 0.002, funcaptcha: 0.015, image: 0.0008,
    };
    return costs[type] || 0.002;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// --- Anti-Captcha Provider ---------------------------------------------------

class AntiCaptchaProvider implements CaptchaProvider {
  name = 'anticaptcha';
  private apiKey: string;
  private baseUrl = 'https://api.anti-captcha.com';

  constructor() {
    this.apiKey = process.env.ANTICAPTCHA_API_KEY || '';
    if (!this.apiKey) {
      logger.warn('ANTICAPTCHA_API_KEY not set -- Anti-Captcha provider disabled');
    }
  }

  get isConfigured(): boolean {
    return !!this.apiKey;
  }

  async solve(request: CaptchaSolveRequest): Promise<CaptchaSolveResult> {
    if (!this.isConfigured) throw new Error('Anti-Captcha not configured');

    const startTime = Date.now();

    const taskPayload: Record<string, any> = {};

    switch (request.type) {
      case 'recaptcha_v2':
        taskPayload.type = 'RecaptchaV2TaskProxyless';
        taskPayload.websiteURL = request.url;
        taskPayload.websiteKey = request.siteKey;
        break;
      case 'recaptcha_v3':
        taskPayload.type = 'RecaptchaV3TaskProxyless';
        taskPayload.websiteURL = request.url;
        taskPayload.websiteKey = request.siteKey;
        if (request.action) taskPayload.pageAction = request.action;
        if (request.minScore) taskPayload.minScore = request.minScore;
        break;
      case 'hcaptcha':
        taskPayload.type = 'HCaptchaTaskProxyless';
        taskPayload.websiteURL = request.url;
        taskPayload.websiteKey = request.siteKey;
        break;
      case 'turnstile':
        taskPayload.type = 'AntiTurnstileTaskProxyless';
        taskPayload.websiteURL = request.url;
        taskPayload.websiteKey = request.siteKey;
        break;
      case 'funcaptcha':
        taskPayload.type = 'FunCaptchaTaskProxyless';
        taskPayload.websiteURL = request.url;
        taskPayload.websiteKey = request.siteKey;
        break;
      case 'image':
        taskPayload.type = 'ImageToTextTask';
        taskPayload.body = request.imageData;
        break;
      default:
        throw new Error(`Anti-Captcha: unsupported type ${request.type}`);
    }

    if (request.proxyUrl) {
      try {
        const proxyUrl = new URL(request.proxyUrl);
        taskPayload.proxyType = proxyUrl.protocol === 'https:' ? 'https' : 'http';
        taskPayload.proxyAddress = proxyUrl.hostname;
        taskPayload.proxyPort = parseInt(proxyUrl.port, 10);
        if (proxyUrl.username) {
          taskPayload.proxyLogin = proxyUrl.username;
          taskPayload.proxyPassword = proxyUrl.password;
        }
      } catch {}
    }

    const createResponse = await fetch(`${this.baseUrl}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: this.apiKey, task: taskPayload }),
    });

    const createData = await createResponse.json() as any;
    if (createData.errorId && createData.errorId !== 0) {
      throw new Error(`Anti-Captcha create task failed: ${createData.errorDescription || createData.errorCode}`);
    }

    const taskId = createData.taskId;

    for (let i = 0; i < 60; i++) {
      await this.sleep(2000);

      const resultResponse = await fetch(`${this.baseUrl}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: this.apiKey, taskId }),
      });

      const resultData = await resultResponse.json() as any;

      if (resultData.status === 'ready') {
        const solveTimeMs = Date.now() - startTime;
        const cost = this.calculateCost(request.type);

        const token = resultData.solution?.gRecaptchaResponse
          || resultData.solution?.token
          || resultData.solution?.text
          || resultData.solution?.captchaKey
          || '';

        return { success: true, token, solveTimeMs, cost, provider: this.name };
      }

      if (resultData.errorId && resultData.errorId !== 0) {
        throw new Error(`Anti-Captcha solve failed: ${resultData.errorDescription || resultData.errorCode}`);
      }
    }

    throw new Error('Anti-Captcha solve timeout (120s)');
  }

  async getBalance(): Promise<number> {
    if (!this.isConfigured) return 0;
    try {
      const response = await fetch(`${this.baseUrl}/getBalance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: this.apiKey }),
      });
      const data = await response.json() as any;
      return data.balance || 0;
    } catch { return 0; }
  }

  private calculateCost(type: string): number {
    const costs: Record<string, number> = {
      recaptcha_v2: 0.002, recaptcha_v3: 0.002, hcaptcha: 0.001,
      turnstile: 0.002, funcaptcha: 0.02, image: 0.0006,
    };
    return costs[type] || 0.002;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// --- CAPTCHA Challenge Detector -----------------------------------------------

export interface CaptchaDetection {
  hasCaptcha: boolean;
  types: Array<'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile' | 'funcaptcha'>;
  siteKeys: Array<{ type: string; siteKey: string; iframeUrl?: string }>;
  confidence: number;
}

export class CaptchaChallengeDetector {
  /**
   * Detect CAPTCHAs on a Playwright page.
   * Checks for reCAPTCHA iframes, hCaptcha iframes, Turnstile widgets, etc.
   */
  async detectOnPage(page: import('playwright').Page): Promise<CaptchaDetection> {
    const detection: CaptchaDetection = {
      hasCaptcha: false,
      types: [],
      siteKeys: [],
      confidence: 0,
    };

    try {
      // --- reCAPTCHA v2 / v3 ---
      const recaptchaIframes = await page.$$('iframe[src*="google.com/recaptcha"]');
      for (const iframe of recaptchaIframes) {
        const src = await iframe.getAttribute('src') || '';
        const siteKeyMatch = src.match(/[?&]k=([^&]+)/);
        const siteKey = siteKeyMatch ? siteKeyMatch[1] : '';

        // v3 has render= parameter and typically uses invisible badge
        const isV3 = src.includes('render=') || src.includes('invisible');
        const type = isV3 ? 'recaptcha_v3' : 'recaptcha_v2';

        if (!detection.types.includes(type)) {
          detection.types.push(type);
        }
        if (siteKey) {
          detection.siteKeys.push({ type, siteKey, iframeUrl: src });
        }
      }

      // Check for g-recaptcha div with data-sitekey
      const gRecaptchaDivs = await page.$$('div.g-recaptcha[data-sitekey]');
      for (const div of gRecaptchaDivs) {
        const siteKey = await div.getAttribute('data-sitekey') || '';
        if (!detection.types.includes('recaptcha_v2')) {
          detection.types.push('recaptcha_v2');
        }
        if (siteKey && !detection.siteKeys.some(sk => sk.siteKey === siteKey && sk.type === 'recaptcha_v2')) {
          detection.siteKeys.push({ type: 'recaptcha_v2', siteKey });
        }
      }

      // Check for reCAPTCHA script tag
      const recaptchaScript = await page.$('script[src*="google.com/recaptcha/api.js"]');
      if (recaptchaScript) {
        const src = await recaptchaScript.getAttribute('src') || '';
        const renderParam = src.match(/[?&]render=([^&]+)/);

        if (renderParam && renderParam[1] !== 'explicit' && renderParam[1] !== 'onload') {
          // Site key in render parameter indicates v3
          if (!detection.types.includes('recaptcha_v3')) {
            detection.types.push('recaptcha_v3');
          }
          if (!detection.siteKeys.some(sk => sk.siteKey === renderParam[1])) {
            detection.siteKeys.push({ type: 'recaptcha_v3', siteKey: renderParam[1] });
          }
        } else {
          // Standard v2
          if (!detection.types.includes('recaptcha_v2')) {
            detection.types.push('recaptcha_v2');
          }
        }
      }

      // Check for grecaptcha.execute() calls in inline scripts
      const hasV3Execute = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script:not([src])'));
        for (const s of scripts) {
          if (s.textContent && s.textContent.includes('grecaptcha.execute')) {
            return true;
          }
        }
        return false;
      });
      if (hasV3Execute && !detection.types.includes('recaptcha_v3')) {
        detection.types.push('recaptcha_v3');
      }

      // --- hCaptcha ---
      const hcaptchaIframes = await page.$$('iframe[src*="hcaptcha.com"]');
      for (const iframe of hcaptchaIframes) {
        const src = await iframe.getAttribute('src') || '';
        const siteKeyMatch = src.match(/[?&]sitekey=([^&]+)/);
        const siteKey = siteKeyMatch ? siteKeyMatch[1] : '';

        if (!detection.types.includes('hcaptcha')) {
          detection.types.push('hcaptcha');
        }
        if (siteKey) {
          detection.siteKeys.push({ type: 'hcaptcha', siteKey, iframeUrl: src });
        }
      }

      // Check for h-captcha div with data-sitekey
      const hCaptchaDivs = await page.$$('div.h-captcha[data-sitekey]');
      for (const div of hCaptchaDivs) {
        const siteKey = await div.getAttribute('data-sitekey') || '';
        if (!detection.types.includes('hcaptcha')) {
          detection.types.push('hcaptcha');
        }
        if (siteKey && !detection.siteKeys.some(sk => sk.siteKey === siteKey && sk.type === 'hcaptcha')) {
          detection.siteKeys.push({ type: 'hcaptcha', siteKey });
        }
      }

      // Check for hCaptcha script
      const hcaptchaScript = await page.$('script[src*="hcaptcha.com"]');
      if (hcaptchaScript && !detection.types.includes('hcaptcha')) {
        detection.types.push('hcaptcha');
      }

      // --- Turnstile (Cloudflare) ---
      const turnstileDivs = await page.$$('div.cf-turnstile[data-sitekey]');
      for (const div of turnstileDivs) {
        const siteKey = await div.getAttribute('data-sitekey') || '';
        if (!detection.types.includes('turnstile')) {
          detection.types.push('turnstile');
        }
        if (siteKey && !detection.siteKeys.some(sk => sk.siteKey === siteKey && sk.type === 'turnstile')) {
          detection.siteKeys.push({ type: 'turnstile', siteKey });
        }
      }

      // Check for Turnstile script
      const turnstileScript = await page.$('script[src*="challenges.cloudflare.com/turnstile"]');
      if (turnstileScript && !detection.types.includes('turnstile')) {
        detection.types.push('turnstile');
      }

      // Also check for Turnstile without data-sitekey on div
      const turnstileDivsWithoutKey = await page.$$('div.cf-turnstile:not([data-sitekey])');
      if (turnstileDivsWithoutKey.length > 0 && !detection.types.includes('turnstile')) {
        detection.types.push('turnstile');
      }

      // --- FunCaptcha (Arkoselabs) ---
      const funcaptchaIframes = await page.$$('iframe[src*="funcaptcha.com"], iframe[src*="arkoselabs.com"]');
      for (const iframe of funcaptchaIframes) {
        const src = await iframe.getAttribute('src') || '';
        const siteKeyMatch = src.match(/[?&]pk=([^&]+)/) || src.match(/[?&]public_key=([^&]+)/);
        const siteKey = siteKeyMatch ? siteKeyMatch[1] : '';

        if (!detection.types.includes('funcaptcha')) {
          detection.types.push('funcaptcha');
        }
        if (siteKey) {
          detection.siteKeys.push({ type: 'funcaptcha', siteKey, iframeUrl: src });
        }
      }

      detection.hasCaptcha = detection.types.length > 0;
      detection.confidence = this.calculateConfidence(detection);
    } catch (err: any) {
      logger.error({ error: err.message }, 'CAPTCHA detection on page failed');
    }

    return detection;
  }

  /**
   * Detect CAPTCHAs from HTML content (without a browser).
   */
  detectFromHTML(html: string): CaptchaDetection {
    const detection: CaptchaDetection = {
      hasCaptcha: false,
      types: [],
      siteKeys: [],
      confidence: 0,
    };

    // --- reCAPTCHA v2 ---
    // iframe with google.com/recaptcha
    const recaptchaIframeMatch = html.match(/<iframe[^>]+src=["']([^"']*google\.com\/recaptcha[^"']*)["'][^>]*>/gi);
    if (recaptchaIframeMatch) {
      for (const iframeTag of recaptchaIframeMatch) {
        const srcMatch = iframeTag.match(/src=["']([^"']*)["']/);
        const src = srcMatch ? srcMatch[1] : '';
        const siteKeyMatch = src.match(/[?&]k=([^&]+)/);
        const siteKey = siteKeyMatch ? siteKeyMatch[1] : '';

        // v3 detection from iframe src
        const isV3 = src.includes('render=') || src.includes('invisible');
        const type = isV3 ? 'recaptcha_v3' : 'recaptcha_v2';

        if (!detection.types.includes(type)) {
          detection.types.push(type);
        }
        if (siteKey) {
          detection.siteKeys.push({ type, siteKey, iframeUrl: src });
        }
      }
    }

    // div.g-recaptcha with data-sitekey
    const gRecaptchaDivMatch = html.match(/<div[^>]+class=["'][^"']*g-recaptcha[^"']*["'][^>]*>/gi);
    if (gRecaptchaDivMatch) {
      if (!detection.types.includes('recaptcha_v2')) {
        detection.types.push('recaptcha_v2');
      }
      for (const divTag of gRecaptchaDivMatch) {
        const siteKeyMatch = divTag.match(/data-sitekey=["']([^"']+)["']/);
        if (siteKeyMatch && !detection.siteKeys.some(sk => sk.siteKey === siteKeyMatch[1] && sk.type === 'recaptcha_v2')) {
          detection.siteKeys.push({ type: 'recaptcha_v2', siteKey: siteKeyMatch[1] });
        }
      }
    }

    // reCAPTCHA script tag
    const recaptchaScriptMatch = html.match(/<script[^>]+src=["']([^"']*google\.com\/recaptcha\/api\.js[^"']*)["'][^>]*>/i);
    if (recaptchaScriptMatch) {
      const src = recaptchaScriptMatch[1];
      const renderMatch = src.match(/[?&]render=([^&"']+)/);
      if (renderMatch && renderMatch[1] !== 'explicit' && renderMatch[1] !== 'onload') {
        if (!detection.types.includes('recaptcha_v3')) {
          detection.types.push('recaptcha_v3');
        }
        if (!detection.siteKeys.some(sk => sk.siteKey === renderMatch[1])) {
          detection.siteKeys.push({ type: 'recaptcha_v3', siteKey: renderMatch[1] });
        }
      } else if (!detection.types.includes('recaptcha_v2')) {
        detection.types.push('recaptcha_v2');
      }
    }

    // grecaptcha.execute() calls in inline scripts
    if (html.includes('grecaptcha.execute')) {
      if (!detection.types.includes('recaptcha_v3')) {
        detection.types.push('recaptcha_v3');
      }
    }

    // --- hCaptcha ---
    const hcaptchaIframeMatch = html.match(/<iframe[^>]+src=["']([^"']*hcaptcha\.com[^"']*)["'][^>]*>/gi);
    if (hcaptchaIframeMatch) {
      if (!detection.types.includes('hcaptcha')) {
        detection.types.push('hcaptcha');
      }
      for (const iframeTag of hcaptchaIframeMatch) {
        const srcMatch = iframeTag.match(/src=["']([^"']*)["']/);
        const src = srcMatch ? srcMatch[1] : '';
        const siteKeyMatch = src.match(/[?&]sitekey=([^&"']+)/);
        if (siteKeyMatch) {
          detection.siteKeys.push({ type: 'hcaptcha', siteKey: siteKeyMatch[1], iframeUrl: src });
        }
      }
    }

    // div.h-captcha with data-sitekey
    const hCaptchaDivMatch = html.match(/<div[^>]+class=["'][^"']*h-captcha[^"']*["'][^>]*>/gi);
    if (hCaptchaDivMatch) {
      if (!detection.types.includes('hcaptcha')) {
        detection.types.push('hcaptcha');
      }
      for (const divTag of hCaptchaDivMatch) {
        const siteKeyMatch = divTag.match(/data-sitekey=["']([^"']+)["']/);
        if (siteKeyMatch && !detection.siteKeys.some(sk => sk.siteKey === siteKeyMatch[1] && sk.type === 'hcaptcha')) {
          detection.siteKeys.push({ type: 'hcaptcha', siteKey: siteKeyMatch[1] });
        }
      }
    }

    // hCaptcha script tag
    if (html.match(/<script[^>]+src=["'][^"']*hcaptcha\.com[^"']*["'][^>]*>/i)) {
      if (!detection.types.includes('hcaptcha')) {
        detection.types.push('hcaptcha');
      }
    }

    // --- Turnstile (Cloudflare) ---
    const turnstileDivMatch = html.match(/<div[^>]+class=["'][^"']*cf-turnstile[^"']*["'][^>]*>/gi);
    if (turnstileDivMatch) {
      if (!detection.types.includes('turnstile')) {
        detection.types.push('turnstile');
      }
      for (const divTag of turnstileDivMatch) {
        const siteKeyMatch = divTag.match(/data-sitekey=["']([^"']+)["']/);
        if (siteKeyMatch && !detection.siteKeys.some(sk => sk.siteKey === siteKeyMatch[1] && sk.type === 'turnstile')) {
          detection.siteKeys.push({ type: 'turnstile', siteKey: siteKeyMatch[1] });
        }
      }
    }

    // Turnstile script tag
    if (html.match(/<script[^>]+src=["'][^"']*challenges\.cloudflare\.com\/turnstile[^"']*["'][^>]*>/i)) {
      if (!detection.types.includes('turnstile')) {
        detection.types.push('turnstile');
      }
    }

    // --- FunCaptcha (Arkoselabs) ---
    const funcaptchaIframeMatch = html.match(/<iframe[^>]+src=["']([^"']*(?:funcaptcha\.com|arkoselabs\.com)[^"']*)["'][^>]*>/gi);
    if (funcaptchaIframeMatch) {
      if (!detection.types.includes('funcaptcha')) {
        detection.types.push('funcaptcha');
      }
      for (const iframeTag of funcaptchaIframeMatch) {
        const srcMatch = iframeTag.match(/src=["']([^"']*)["']/);
        const src = srcMatch ? srcMatch[1] : '';
        const siteKeyMatch = src.match(/[?&]pk=([^&"']+)/) || src.match(/[?&]public_key=([^&"']+)/);
        if (siteKeyMatch) {
          detection.siteKeys.push({ type: 'funcaptcha', siteKey: siteKeyMatch[1], iframeUrl: src });
        }
      }
    }

    detection.hasCaptcha = detection.types.length > 0;
    detection.confidence = this.calculateConfidence(detection);

    return detection;
  }

  /**
   * Calculate detection confidence based on number of signals found.
   * More site keys and types = higher confidence.
   */
  private calculateConfidence(detection: CaptchaDetection): number {
    if (!detection.hasCaptcha) return 0;

    let confidence = 0;
    // Each detected type contributes base confidence
    confidence += detection.types.length * 0.3;
    // Each extracted site key adds confidence
    confidence += detection.siteKeys.length * 0.2;
    // Cap at 1.0
    return Math.min(confidence, 1.0);
  }
}

// --- CAPTCHA Solver (Facade) -------------------------------------------------

export class CaptchaSolver {
  private providers: CaptchaProvider[] = [];
  private twoCaptcha: TwoCaptchaProvider;
  private capSolver: CapSolverProvider;
  private antiCaptcha: AntiCaptchaProvider;

  constructor() {
    this.twoCaptcha = new TwoCaptchaProvider();
    this.capSolver = new CapSolverProvider();
    this.antiCaptcha = new AntiCaptchaProvider();

    // Order: CapSolver (cheapest), Anti-Captcha, 2Captcha
    if (this.capSolver.isConfigured) this.providers.push(this.capSolver);
    if (this.antiCaptcha.isConfigured) this.providers.push(this.antiCaptcha);
    if (this.twoCaptcha.isConfigured) this.providers.push(this.twoCaptcha);
  }

  async solve(request: CaptchaSolveRequest): Promise<CaptchaSolveResult> {
    if (this.providers.length === 0) {
      throw new Error('No CAPTCHA solving providers configured. Set TWOCAPTCHA_API_KEY, CAPSOLVER_API_KEY, or ANTICAPTCHA_API_KEY.');
    }

    const cacheKey = `captcha:${request.type}:${request.siteKey}:${request.url}`;
    const cached = await cacheGet<{ token: string; solvedAt: number }>(cacheKey);
    if (cached && Date.now() - cached.solvedAt < 110_000) {
      logger.info({ type: request.type, siteKey: request.siteKey }, 'CAPTCHA token cache hit');
      return { success: true, token: cached.token, solveTimeMs: 0, cost: 0, provider: 'cache' };
    }

    let lastError: Error | null = null;

    for (const provider of this.providers) {
      try {
        const result = await provider.solve(request);
        await this.logSolve(request, result);
        await cacheSet(cacheKey, { token: result.token, solvedAt: Date.now() }, 110);
        logger.info(
          { provider: result.provider, type: request.type, solveTimeMs: result.solveTimeMs },
          'CAPTCHA solved',
        );
        return result;
      } catch (err: any) {
        lastError = err;
        logger.warn(
          { provider: provider.name, error: err.message, type: request.type },
          'CAPTCHA provider failed, trying next',
        );
      }
    }

    await this.logSolve(request, { success: false, token: '', solveTimeMs: 0, cost: 0, provider: 'none' });
    throw lastError || new Error('All CAPTCHA providers failed');
  }

  async getBalances(): Promise<Record<string, number>> {
    const balances: Record<string, number> = {};
    for (const provider of this.providers) {
      try { balances[provider.name] = await provider.getBalance(); }
      catch { balances[provider.name] = -1; }
    }
    return balances;
  }

  get isConfigured(): boolean {
    return this.providers.length > 0;
  }

  private async logSolve(request: CaptchaSolveRequest, result: CaptchaSolveResult): Promise<void> {
    try {
      await db.captchaLog.create({
        data: {
          id: crypto.randomUUID(),
          domain: new URL(request.url).hostname,
          captchaType: request.type as any,
          provider: result.provider,
          siteKey: request.siteKey,
          solved: result.success,
          solveTimeMs: result.solveTimeMs,
          cost: result.cost,
          token: result.success ? result.token.substring(0, 50) + '...' : null,
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to log CAPTCHA solve');
    }
  }
}

export const captchaSolver = new CaptchaSolver();
export const captchaChallengeDetector = new CaptchaChallengeDetector();
