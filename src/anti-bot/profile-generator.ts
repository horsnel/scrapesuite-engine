import { createHash } from 'crypto';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('anti-bot:profile-generator');

// --- Browser Profile Interface ------------------------------------------------

export interface BrowserProfile {
  userAgent: string;
  platform: string;
  viewport: { width: number; height: number };
  locale: string;
  timezone: string;
  webglVendor: string;
  webglRenderer: string;
  colorDepth: number;
  deviceMemory: number;
  hardwareConcurrency: number;
  screenResolution: { width: number; height: number };
  touchSupport: boolean;
  fonts: string[];
  // New fields for advanced fingerprinting
  canvasNoise?: number;
  audioNoise?: number;
  profileHash?: string;
}

// --- Platform Type ------------------------------------------------------------

type PlatformType = 'windows' | 'mac' | 'linux' | 'mobile';

// --- User Agent Pools ---------------------------------------------------------

const CHROME_VERSIONS_WIN = [
  '120.0.6099.130', '121.0.6167.85', '122.0.6261.94', '123.0.6312.58',
  '124.0.6367.91', '125.0.6422.76', '126.0.6478.114', '127.0.6533.72',
  '120.0.6099.109', '121.0.6167.140', '122.0.6261.112', '123.0.6312.99',
  '124.0.6367.118', '125.0.6422.112', '126.0.6478.182', '127.0.6533.88',
  '120.0.6099.225', '121.0.6167.160', '122.0.6261.128', '124.0.6367.155',
];

const CHROME_VERSIONS_MAC = [
  '120.0.6099.130', '121.0.6167.85', '122.0.6261.94', '123.0.6312.58',
  '124.0.6367.91', '125.0.6422.76', '126.0.6478.114', '127.0.6533.72',
  '120.0.6099.109', '121.0.6167.140', '122.0.6261.112', '123.0.6312.99',
  '124.0.6367.118', '125.0.6422.112', '126.0.6478.182', '127.0.6533.88',
  '120.0.6099.225', '121.0.6167.160', '122.0.6261.128', '124.0.6367.155',
];

const CHROME_VERSIONS_LINUX = [
  '120.0.6099.130', '121.0.6167.85', '122.0.6261.94', '123.0.6312.58',
  '124.0.6367.91', '125.0.6422.76', '126.0.6478.114', '127.0.6533.72',
  '120.0.6099.109', '121.0.6167.140', '122.0.6261.112', '123.0.6312.99',
  '124.0.6367.118', '125.0.6422.112', '126.0.6478.182', '127.0.6533.88',
  '120.0.6099.225', '121.0.6167.160', '122.0.6261.128', '124.0.6367.155',
];

const FIREFOX_VERSIONS_WIN = [
  '122.0', '123.0', '124.0.2', '125.0.3', '126.0',
  '127.0', '128.0', '122.0.1', '123.0.1', '124.0.1',
  '125.0.1', '125.0.2', '126.0.1', '127.0.1', '127.0.2',
  '128.0.1', '128.0.2', '122.0.2', '123.0.2', '124.0.3',
];

const SAFARI_VERSIONS_MAC = [
  '16.0', '16.1', '16.2', '16.3', '16.4', '16.5', '16.6',
  '17.0', '17.1', '17.2', '17.3', '17.4', '17.5',
  '18.0', '18.1', '18.2', '16.4.1', '17.2.1', '17.5.1', '18.1.1',
];

const MAC_OS_VERSIONS = [
  '10_15_7', '11_0_0', '11_7_10', '12_0_0', '12_7_4', '13_0_0',
  '13_6_3', '14_0_0', '14_2_1', '14_4_1', '14_5_0', '14_6_0',
  '15_0_0', '15_1_0', '15_2_0', '15_3_0',
];

const USER_AGENT_BUILDERS: Record<PlatformType, (() => string)[]> = {
  windows: [
    // Chrome on Windows
    ...CHROME_VERSIONS_WIN.map(v => () =>
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`
    ),
    // Firefox on Windows
    ...FIREFOX_VERSIONS_WIN.map(v => () =>
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${v}) Gecko/20100101 Firefox/${v}`
    ),
  ],
  mac: [
    // Chrome on Mac
    ...CHROME_VERSIONS_MAC.map(v => () => {
      const macVer = MAC_OS_VERSIONS[Math.floor(Math.random() * MAC_OS_VERSIONS.length)];
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X ${macVer}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
    }),
    // Safari on Mac
    ...SAFARI_VERSIONS_MAC.map(v => () => {
      const macVer = MAC_OS_VERSIONS[Math.floor(Math.random() * MAC_OS_VERSIONS.length)];
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X ${macVer}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v} Safari/605.1.15`;
    }),
  ],
  linux: [
    // Chrome on Linux
    ...CHROME_VERSIONS_LINUX.map(v => () =>
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`
    ),
  ],
  mobile: [
    // Chrome on Android
    ...CHROME_VERSIONS_WIN.slice(0, 10).map(v => () =>
      `Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Mobile Safari/537.36`
    ),
    ...CHROME_VERSIONS_WIN.slice(10, 20).map(v => () =>
      `Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Mobile Safari/537.36`
    ),
  ],
};

// --- Screen Resolution Pools --------------------------------------------------

const SCREEN_RESOLUTIONS: Record<PlatformType, { width: number; height: number }[]> = {
  windows: [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 1680, height: 1050 },
    { width: 2560, height: 1440 },
    { width: 1280, height: 720 },
    { width: 1600, height: 900 },
    { width: 1280, height: 1024 },
    { width: 1280, height: 800 },
    { width: 3840, height: 2160 },
    { width: 1360, height: 768 },
    { width: 1920, height: 1200 },
    { width: 2560, height: 1080 },
    { width: 1600, height: 1200 },
    { width: 1024, height: 768 },
  ],
  mac: [
    { width: 2560, height: 1600 },
    { width: 1440, height: 900 },
    { width: 1680, height: 1050 },
    { width: 2880, height: 1800 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
    { width: 3024, height: 1964 },
    { width: 3456, height: 2234 },
    { width: 1512, height: 982 },
    { width: 1728, height: 1117 },
    { width: 2048, height: 1280 },
    { width: 1600, height: 900 },
    { width: 2304, height: 1440 },
    { width: 1800, height: 1169 },
    { width: 2560, height: 1080 },
    { width: 1470, height: 956 },
  ],
  linux: [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 2560, height: 1440 },
    { width: 1680, height: 1050 },
    { width: 1440, height: 900 },
    { width: 3840, height: 2160 },
    { width: 1280, height: 720 },
    { width: 1600, height: 900 },
    { width: 1280, height: 1024 },
    { width: 3440, height: 1440 },
    { width: 2560, height: 1080 },
    { width: 1920, height: 1200 },
    { width: 1024, height: 768 },
    { width: 1280, height: 800 },
    { width: 1600, height: 1200 },
  ],
  mobile: [
    { width: 412, height: 915 },
    { width: 393, height: 851 },
    { width: 412, height: 892 },
    { width: 360, height: 780 },
    { width: 414, height: 896 },
    { width: 390, height: 844 },
    { width: 393, height: 873 },
    { width: 360, height: 800 },
    { width: 428, height: 926 },
    { width: 412, height: 915 },
    { width: 430, height: 932 },
    { width: 402, height: 874 },
    { width: 375, height: 812 },
    { width: 390, height: 844 },
    { width: 360, height: 760 },
    { width: 414, height: 896 },
  ],
};

// --- Font Pools ---------------------------------------------------------------

const FONT_POOLS: Record<PlatformType, string[][]> = {
  windows: [
    ['Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana', 'Trebuchet MS', 'Impact'],
    ['Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana', 'Comic Sans MS', 'Tahoma'],
    ['Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana', 'Lucida Console', 'Palatino'],
    ['Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana', 'Segoe UI', 'Calibri'],
    ['Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana', 'MS Gothic', 'Franklin Gothic'],
    ['Arial', 'Courier New', 'Georgia', 'Verdana', 'Trebuchet MS', 'Impact', 'Segoe UI'],
    ['Arial', 'Georgia', 'Times New Roman', 'Verdana', 'Tahoma', 'Calibri', 'Cambria'],
    ['Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana', 'Consolas', 'Candara'],
  ],
  mac: [
    ['Helvetica', 'Courier', 'Georgia', 'Times', 'Verdana', 'Helvetica Neue', 'Futura'],
    ['Helvetica', 'Courier', 'Georgia', 'Times', 'Verdana', 'Monaco', 'Optima'],
    ['Helvetica', 'Courier', 'Georgia', 'Times', 'Verdana', 'PingFang SC', 'Avenir'],
    ['Helvetica', 'Courier', 'Georgia', 'Times', 'Verdana', 'SF Pro', 'Gill Sans'],
    ['Helvetica', 'Courier', 'Georgia', 'Times', 'Verdana', 'Menlo', 'Copperplate'],
    ['Helvetica Neue', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana', 'SF Pro', 'Baskerville'],
    ['Helvetica', 'Courier', 'Georgia', 'Times', 'Verdana', 'Apple Color Emoji', 'Palatino'],
    ['Helvetica Neue', 'Courier', 'Georgia', 'Times', 'Verdana', 'Avenir Next', 'SF Compact'],
  ],
  linux: [
    ['DejaVu Sans', 'Liberation Sans', 'Ubuntu', 'Noto Sans', 'Roboto', 'DejaVu Sans Mono'],
    ['DejaVu Sans', 'Liberation Sans', 'Ubuntu', 'Noto Sans', 'Roboto', 'Liberation Mono'],
    ['DejaVu Sans', 'Liberation Sans', 'Ubuntu', 'Noto Sans', 'Roboto', 'DejaVu Serif'],
    ['DejaVu Sans', 'Liberation Sans', 'Ubuntu', 'FreeSans', 'Roboto', 'Ubuntu Mono'],
    ['DejaVu Sans', 'Liberation Sans', 'Ubuntu', 'Noto Sans', 'Droid Sans', 'Liberation Serif'],
    ['DejaVu Sans', 'Liberation Sans', 'Ubuntu Mono', 'Noto Sans', 'Roboto', 'Cantarell'],
    ['DejaVu Sans', 'Liberation Sans', 'Ubuntu', 'Noto Sans', 'Roboto', 'DejaVu Sans Mono', 'Nimbus Sans'],
    ['DejaVu Sans', 'Liberation Sans', 'Ubuntu', 'Noto Sans', 'Roboto', 'FreeSerif'],
  ],
  mobile: [
    ['Roboto', 'Noto Sans', 'Droid Sans', 'sans-serif', 'Arial'],
    ['Roboto', 'Noto Sans', 'Droid Sans', 'Arial', 'Helvetica'],
    ['Roboto', 'Noto Sans', 'sans-serif', 'Arial', 'Verdana'],
    ['SF Pro', 'Helvetica Neue', 'Helvetica', 'Arial', 'Georgia'],
    ['Roboto', 'Noto Sans', 'Droid Serif', 'Droid Sans', 'Arial'],
    ['Roboto', 'Noto Sans', 'Noto Serif', 'Droid Sans', 'sans-serif'],
  ],
};

// --- WebGL Vendor/Renderer Pairs ----------------------------------------------

interface WebGLConfig {
  vendor: string;
  renderer: string;
}

const WEBGL_CONFIGS: Record<PlatformType, WebGLConfig[]> = {
  windows: [
    {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)',
    },
    {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620, OpenGL 4.1)',
    },
    {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, OpenGL 4.1)',
    },
    {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) HD Graphics 530, OpenGL 4.1)',
    },
    {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770, OpenGL 4.1)',
    },
    {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060, OpenGL 4.5)',
    },
    {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1070, OpenGL 4.5)',
    },
    {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, OpenGL 4.5)',
    },
    {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070, OpenGL 4.5)',
    },
    {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650, OpenGL 4.5)',
    },
    {
      vendor: 'Google Inc. (AMD)',
      renderer: 'ANGLE (AMD, AMD Radeon RX 580, OpenGL 4.5)',
    },
    {
      vendor: 'Google Inc. (AMD)',
      renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT, OpenGL 4.5)',
    },
  ],
  mac: [
    {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)',
    },
    {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)',
    },
    {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, Apple M3, OpenGL 4.1)',
    },
    {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)',
    },
    {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, Apple M2 Pro, OpenGL 4.1)',
    },
    {
      vendor: 'Apple Inc.',
      renderer: 'Apple GPU',
    },
  ],
  linux: [
    {
      vendor: 'Mesa',
      renderer: 'Mesa Intel(R) HD Graphics 630 (KBL GT2)',
    },
    {
      vendor: 'Mesa',
      renderer: 'Mesa Intel(R) UHD Graphics 630 (CFL GT2)',
    },
    {
      vendor: 'Mesa',
      renderer: 'Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2)',
    },
    {
      vendor: 'Mesa',
      renderer: 'Mesa Intel(R) HD Graphics 530 (SKL GT2)',
    },
    {
      vendor: 'Mesa',
      renderer: 'AMD RAVEN (renoir, LLVM 15.0.7, DRM 3.49, 6.1.0)',
    },
    {
      vendor: 'Mesa',
      renderer: 'Mesa AMD Radeon RX 580 Series (polaris10, LLVM 15.0.7, DRM 3.49, 6.1.0)',
    },
    {
      vendor: 'Mesa',
      renderer: 'NVIDIA GeForce GTX 1060/PCIe/SSE2',
    },
    {
      vendor: 'Mesa',
      renderer: 'llvmpipe (LLVM 15.0.7, 256 bits)',
    },
  ],
  mobile: [
    {
      vendor: 'Google Inc. (Qualcomm)',
      renderer: 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)',
    },
    {
      vendor: 'Google Inc. (Qualcomm)',
      renderer: 'ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)',
    },
    {
      vendor: 'Google Inc. (ARM)',
      renderer: 'ANGLE (ARM, Mali-G78, OpenGL ES 3.2)',
    },
    {
      vendor: 'Google Inc. (ARM)',
      renderer: 'ANGLE (ARM, Mali-G710, OpenGL ES 3.2)',
    },
    {
      vendor: 'Apple Inc.',
      renderer: 'Apple GPU',
    },
  ],
};

// Firefox gets different WebGL strings
const FIREFOX_WEBGL: Record<string, WebGLConfig> = {
  windows: {
    vendor: 'Mozilla',
    renderer: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
  },
  mac: {
    vendor: 'Mozilla',
    renderer: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
  },
  linux: {
    vendor: 'Mozilla',
    renderer: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
  },
};

// --- Timezone Pools -----------------------------------------------------------

const TIMEZONE_POOLS: Record<PlatformType, string[]> = {
  windows: [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Phoenix', 'America/Detroit', 'America/Indiana/Indianapolis',
    'America/Kentucky/Louisville', 'America/Anchorage', 'Pacific/Honolulu',
    'America/Toronto', 'America/Vancouver', 'America/Winnipeg',
  ],
  mac: [
    'America/Los_Angeles', 'America/New_York', 'America/Chicago', 'America/Denver',
    'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu',
    'America/Toronto', 'America/Vancouver', 'US/Pacific', 'US/Eastern',
  ],
  linux: [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Amsterdam',
    'Asia/Tokyo', 'UTC', 'America/Phoenix', 'Australia/Sydney',
    'Europe/Helsinki', 'Asia/Singapore',
  ],
  mobile: [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Phoenix', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo',
  ],
};

// --- Locale Pools -------------------------------------------------------------

const LOCALE_POOLS: Record<PlatformType, string[]> = {
  windows: [
    'en-US', 'en-US', 'en-US', 'en-US', 'en-US', // Weight en-US heavily
    'en-GB', 'en-CA', 'en-AU', 'en-NZ', 'fr-CA',
    'es-US', 'pt-BR', 'de-DE', 'nl-NL', 'it-IT',
  ],
  mac: [
    'en-US', 'en-US', 'en-US', 'en-US', // Weight en-US
    'en-GB', 'en-CA', 'en-AU', 'fr-FR', 'de-DE', 'ja-JP',
  ],
  linux: [
    'en-US', 'en-US', 'en-US', 'en-GB', 'en-CA',
    'de-DE', 'fr-FR', 'ja-JP', 'nl-NL', 'pt-BR', 'es-ES', 'it-IT',
    'ru-RU', 'zh-CN', 'ko-KR',
  ],
  mobile: [
    'en-US', 'en-US', 'en-US', 'en-GB', 'en-CA',
    'ja-JP', 'ko-KR', 'de-DE', 'fr-FR',
  ],
};

// --- Hardware Options ---------------------------------------------------------

const DEVICE_MEMORY_OPTIONS = [2, 4, 8, 16, 32] as const;
const HARDWARE_CONCURRENCY_OPTIONS = [2, 4, 6, 8, 12, 16] as const;

const HARDWARE_PRESETS: Record<PlatformType, { memory: number[]; concurrency: number[] }> = {
  windows: {
    memory: [4, 8, 8, 8, 16, 16, 32],
    concurrency: [4, 6, 8, 8, 12, 16, 16],
  },
  mac: {
    memory: [8, 16, 16, 16, 32],
    concurrency: [8, 8, 10, 12, 16],
  },
  linux: {
    memory: [4, 8, 8, 16, 16, 32],
    concurrency: [2, 4, 6, 8, 12, 16],
  },
  mobile: {
    memory: [2, 4, 4, 8],
    concurrency: [4, 6, 8, 8],
  },
};

// --- Viewport Generation ------------------------------------------------------

function generateViewport(screen: { width: number; height: number }, isMobile: boolean): { width: number; height: number } {
  if (isMobile) {
    // Mobile viewport is the screen itself minus browser chrome
    return {
      width: screen.width,
      height: screen.height - 100 - Math.floor(Math.random() * 50),
    };
  }
  // Desktop: viewport is slightly smaller than screen (browser chrome, taskbar)
  const widthReduction = Math.random() < 0.7 ? 0 : Math.floor(Math.random() * 40);
  const heightReduction = 80 + Math.floor(Math.random() * 80); // Browser chrome + possible taskbar
  return {
    width: screen.width - widthReduction,
    height: screen.height - heightReduction,
  };
}

// --- Platform Detection from User Agent ---------------------------------------

function detectPlatformTypeFromUA(ua: string): PlatformType {
  if (ua.includes('Android') || ua.includes('Mobile')) return 'mobile';
  if (ua.includes('Macintosh') || ua.includes('Mac OS')) return 'mac';
  if (ua.includes('Linux')) return 'linux';
  return 'windows';
}

function detectPlatformString(platformType: PlatformType, ua: string): string {
  if (platformType === 'windows') return 'Win32';
  if (platformType === 'mac') return 'MacIntel';
  if (platformType === 'linux') return 'Linux x86_64';
  if (platformType === 'mobile') {
    if (ua.includes('Pixel') || ua.includes('SM-')) return 'Linux armv8l';
    return 'MacIntel'; // iOS
  }
  return 'Win32';
}

// --- Profile Hash -------------------------------------------------------------

function hashProfile(profile: Omit<BrowserProfile, 'profileHash'>): string {
  const data = JSON.stringify({
    ua: profile.userAgent,
    vp: profile.viewport,
    sr: profile.screenResolution,
    wv: profile.webglVendor,
    wr: profile.webglRenderer,
    hc: profile.hardwareConcurrency,
    dm: profile.deviceMemory,
    tz: profile.timezone,
    loc: profile.locale,
    cn: profile.canvasNoise,
    an: profile.audioNoise,
  });
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

// --- Profile Generator Class --------------------------------------------------

export class ProfileGenerator {
  private profilePool: BrowserProfile[] = [];
  private readonly POOL_SIZE = 200;
  private initialized = false;

  constructor() {
    this.initializePool();
  }

  /**
   * Initialize the profile pool with pre-generated profiles.
   * Generates 200 unique, internally consistent profiles.
   */
  private initializePool(): void {
    logger.info(`Initializing profile pool with ${this.POOL_SIZE} profiles...`);

    for (let i = 0; i < this.POOL_SIZE; i++) {
      try {
        const profile = this.generateProfile();
        this.profilePool.push(profile);
      } catch (err) {
        logger.warn({ err, index: i }, 'Failed to generate profile, skipping');
      }
    }

    this.initialized = true;
    logger.info(`Profile pool initialized with ${this.profilePool.length} profiles`);
  }

  /**
   * Get a random profile from the pre-generated pool.
   */
  getRandomProfile(): BrowserProfile {
    if (this.profilePool.length === 0) {
      logger.warn('Profile pool is empty, generating profile on-the-fly');
      return this.generateProfile();
    }
    return this.profilePool[Math.floor(Math.random() * this.profilePool.length)];
  }

  /**
   * Get a specific profile by index from the pool.
   * Wraps around if index exceeds pool size.
   */
  getProfile(index: number): BrowserProfile {
    if (this.profilePool.length === 0) {
      logger.warn('Profile pool is empty, generating profile on-the-fly');
      return this.generateProfile();
    }
    return this.profilePool[index % this.profilePool.length];
  }

  /**
   * Generate a single new browser profile with internally consistent values.
   * Each generated profile follows consistency rules:
   * - Windows profiles → Intel/NVIDIA/AMD WebGL, Win32 platform, Windows timezones
   * - Mac profiles → Apple WebGL, MacIntel platform, US Pacific/Eastern timezones
   * - Linux profiles → Mesa/Intel WebGL, Linux x86_64 platform, various timezones
   * - Mobile profiles → mobile GPUs, touch support, smaller screens
   */
  generateProfile(): BrowserProfile {
    // 1. Pick a platform type with realistic distribution
    const platformType = this.pickPlatformType();

    // 2. Pick a user agent for this platform
    const builders = USER_AGENT_BUILDERS[platformType];
    const uaBuilder = builders[Math.floor(Math.random() * builders.length)];
    const userAgent = uaBuilder();

    // 3. Determine browser type for WebGL selection
    const isFirefox = userAgent.includes('Firefox');
    const isSafari = userAgent.includes('Safari') && !userAgent.includes('Chrome');

    // 4. Pick WebGL vendor/renderer consistent with platform
    let webglConfig: WebGLConfig;
    if (isFirefox) {
      // Firefox has its own generic WebGL strings
      const platformKey = platformType === 'mobile' ? 'linux' : platformType as keyof typeof FIREFOX_WEBGL;
      webglConfig = FIREFOX_WEBGL[platformKey] || FIREFOX_WEBGL.windows;
    } else if (isSafari) {
      // Safari always reports Apple GPU
      webglConfig = { vendor: 'Apple Inc.', renderer: 'Apple GPU' };
    } else {
      // Chrome: pick from platform-appropriate configs
      const configs = WEBGL_CONFIGS[platformType];
      webglConfig = configs[Math.floor(Math.random() * configs.length)];
    }

    // 5. Pick screen resolution consistent with platform
    const screenOptions = SCREEN_RESOLUTIONS[platformType];
    const screenResolution = screenOptions[Math.floor(Math.random() * screenOptions.length)];

    // 6. Generate viewport from screen resolution
    const isMobile = platformType === 'mobile';
    const viewport = generateViewport(screenResolution, isMobile);

    // 7. Pick locale consistent with platform/timezone
    const localeOptions = LOCALE_POOLS[platformType];
    const locale = localeOptions[Math.floor(Math.random() * localeOptions.length)];

    // 8. Pick timezone consistent with platform
    const timezoneOptions = TIMEZONE_POOLS[platformType];
    const timezone = timezoneOptions[Math.floor(Math.random() * timezoneOptions.length)];

    // 9. Pick fonts consistent with platform
    const fontOptions = FONT_POOLS[platformType];
    const fonts = [...fontOptions[Math.floor(Math.random() * fontOptions.length)]];

    // 10. Pick hardware consistent with platform
    const presets = HARDWARE_PRESETS[platformType];
    const deviceMemory = presets.memory[Math.floor(Math.random() * presets.memory.length)];
    const hardwareConcurrency = presets.concurrency[Math.floor(Math.random() * presets.concurrency.length)];

    // 11. Touch support
    const touchSupport = isMobile;

    // 12. Generate noise values for canvas and audio fingerprint evasion
    // Canvas noise: small integer offset (1-3) to shift pixel values
    const canvasNoise = Math.floor(Math.random() * 3) + 1;
    // Audio noise: small float multiplier (0.0001-0.001) for frequency data perturbation
    const audioNoise = parseFloat((Math.random() * 0.0009 + 0.0001).toFixed(6));

    // 13. Determine platform string
    const platform = detectPlatformString(platformType, userAgent);

    // Build the profile
    const profile: Omit<BrowserProfile, 'profileHash'> = {
      userAgent,
      platform,
      viewport,
      locale,
      timezone,
      webglVendor: webglConfig.vendor,
      webglRenderer: webglConfig.renderer,
      colorDepth: 24,
      deviceMemory,
      hardwareConcurrency,
      screenResolution,
      touchSupport,
      fonts,
      canvasNoise,
      audioNoise,
    };

    // Compute and attach hash
    const profileHash = hashProfile(profile);

    return { ...profile, profileHash };
  }

  /**
   * Pick a platform type with realistic market-share-weighted distribution.
   * Windows ~60%, Mac ~20%, Linux ~5%, Mobile ~15%
   */
  private pickPlatformType(): PlatformType {
    const roll = Math.random();
    if (roll < 0.60) return 'windows';
    if (roll < 0.80) return 'mac';
    if (roll < 0.85) return 'linux';
    return 'mobile';
  }

  /**
   * Get the current pool size.
   */
  getPoolSize(): number {
    return this.profilePool.length;
  }

  /**
   * Regenerate the profile pool (e.g., for periodic rotation).
   */
  regeneratePool(): void {
    logger.info('Regenerating profile pool...');
    this.profilePool = [];
    this.initializePool();
  }

  /**
   * Get all unique profile hashes in the pool (for deduplication checks).
   */
  getPoolHashes(): Set<string> {
    return new Set(this.profilePool.map(p => p.profileHash).filter((h): h is string => !!h));
  }
}

// --- Singleton Export ---------------------------------------------------------

export const profileGenerator = new ProfileGenerator();
