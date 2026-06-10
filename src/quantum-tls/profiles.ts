/**
 * TLS Profile Manager -- ScrapeSuite Engine
 *
 * Manages TLS profiles that mimic real browser configurations.
 * Includes pre-built profiles for Chrome, Firefox, Safari, and Edge,
 * plus custom profile creation and JA3/JA4 computation.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import { TLSProfile, TLSVersion, JA3Fingerprint, JA4Fingerprint } from './types';

const logger = createChildLogger('quantum-tls:profiles');

const PROFILE_PREFIX = 'tls:profile:';
const PROFILE_LIST_KEY = 'tls:profiles:list';

// ---------- Pre-built browser profiles ----------------------------------------

function builtInProfiles(): TLSProfile[] {
  return [
    {
      id: 'chrome-120-tls13',
      name: 'Chrome 120+ (TLS 1.3)',
      tls_version: 'TLS_1_3',
      cipher_suites: [
        'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
        'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256', 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
        'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384', 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
        'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256', 'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
      ],
      extensions: [0, 10, 11, 13, 16, 23, 27, 35, 43, 45, 51, 65281],
      ja3_hash: '',
      ja4_hash: '',
      supported_groups: ['x25519', 'secp256r1', 'secp384r1'],
      signature_algorithms: ['ecdsa_secp256r1_sha256', 'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256', 'rsa_pss_rsae_sha384'],
      alpn_protocols: ['h2', 'http/1.1'],
      is_quantum_resistant: false,
      popularity_score: 95,
      created_at: Date.now(),
    },
    {
      id: 'firefox-120-tls13',
      name: 'Firefox 120+ (TLS 1.3)',
      tls_version: 'TLS_1_3',
      cipher_suites: [
        'TLS_AES_128_GCM_SHA256', 'TLS_CHACHA20_POLY1305_SHA256', 'TLS_AES_256_GCM_SHA384',
        'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256', 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
        'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256', 'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
        'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384', 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
      ],
      extensions: [0, 5, 10, 11, 13, 16, 23, 27, 35, 43, 45, 51, 65281],
      ja3_hash: '',
      ja4_hash: '',
      supported_groups: ['x25519', 'secp256r1', 'secp384r1', 'secp521r1'],
      signature_algorithms: ['ecdsa_secp256r1_sha256', 'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256', 'rsa_pss_rsae_sha384', 'rsa_pkcs1_sha384'],
      alpn_protocols: ['h2', 'http/1.1'],
      is_quantum_resistant: false,
      popularity_score: 80,
      created_at: Date.now(),
    },
    {
      id: 'safari-17-tls13',
      name: 'Safari 17+ (TLS 1.3)',
      tls_version: 'TLS_1_3',
      cipher_suites: [
        'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
        'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256', 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
        'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384', 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
      ],
      extensions: [0, 5, 10, 11, 13, 16, 23, 27, 35, 43, 65281],
      ja3_hash: '',
      ja4_hash: '',
      supported_groups: ['x25519', 'secp256r1', 'secp384r1', 'secp521r1'],
      signature_algorithms: ['ecdsa_secp256r1_sha256', 'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256'],
      alpn_protocols: ['h2', 'http/1.1'],
      is_quantum_resistant: false,
      popularity_score: 65,
      created_at: Date.now(),
    },
    {
      id: 'edge-120-tls13',
      name: 'Edge 120+ (TLS 1.3)',
      tls_version: 'TLS_1_3',
      cipher_suites: [
        'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
        'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256', 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
        'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384', 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
        'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256', 'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
      ],
      extensions: [0, 10, 11, 13, 16, 23, 27, 35, 43, 45, 51, 65281],
      ja3_hash: '',
      ja4_hash: '',
      supported_groups: ['x25519', 'secp256r1', 'secp384r1'],
      signature_algorithms: ['ecdsa_secp256r1_sha256', 'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256'],
      alpn_protocols: ['h2', 'http/1.1'],
      is_quantum_resistant: false,
      popularity_score: 70,
      created_at: Date.now(),
    },
    {
      id: 'quantum-chrome-hybrid',
      name: 'Chrome Quantum-Hybrid (Post-Quantum)',
      tls_version: 'TLS_1_3',
      cipher_suites: [
        'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
        'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256', 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
        'TLS_KYBER_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256', 'TLS_KYBER_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
      ],
      extensions: [0, 10, 11, 13, 16, 23, 27, 35, 43, 45, 51, 65281],
      ja3_hash: '',
      ja4_hash: '',
      supported_groups: ['x25519_kyber768', 'x25519', 'secp256r1'],
      signature_algorithms: ['ecdsa_secp256r1_sha256', 'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256'],
      alpn_protocols: ['h2', 'http/1.1'],
      is_quantum_resistant: true,
      popularity_score: 40,
      created_at: Date.now(),
    },
  ];
}

// ---------- Profile Manager class ---------------------------------------------

export class ProfileManager {
  private profiles: Map<string, TLSProfile> = new Map();
  private initialized = false;

  /** Initialize built-in profiles. */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load built-in profiles
    for (const profile of builtInProfiles()) {
      profile.ja3_hash = this.computeJA3(profile);
      profile.ja4_hash = this.computeJA4(profile);
      this.profiles.set(profile.id, profile);
    }

    // Load custom profiles from Redis
    try {
      const customIds = await cacheGet<string[]>(PROFILE_LIST_KEY) ?? [];
      for (const id of customIds) {
        const profile = await cacheGet<TLSProfile>(PROFILE_PREFIX + id);
        if (profile) this.profiles.set(id, profile);
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to load custom profiles from Redis');
    }

    this.initialized = true;
    logger.info({ count: this.profiles.size }, 'TLS profile manager initialized');
  }

  /** Create a custom TLS profile. */
  async createProfile(profile: Omit<TLSProfile, 'id' | 'created_at' | 'ja3_hash' | 'ja4_hash'>): Promise<TLSProfile> {
    await this.initialize();
    const full: TLSProfile = {
      ...profile,
      id: `custom-${uuid().slice(0, 8)}`,
      ja3_hash: '',
      ja4_hash: '',
      created_at: Date.now(),
    };
    full.ja3_hash = this.computeJA3(full);
    full.ja4_hash = this.computeJA4(full);

    this.profiles.set(full.id, full);
    await cacheSet(PROFILE_PREFIX + full.id, full, 86400 * 30);

    const customIds = [...this.profiles.values()]
      .filter(p => p.id.startsWith('custom-'))
      .map(p => p.id);
    await cacheSet(PROFILE_LIST_KEY, customIds, 86400 * 30);

    logger.info({ id: full.id, name: full.name }, 'Custom TLS profile created');
    return full;
  }

  /** Get a profile by ID. */
  async getProfile(id: string): Promise<TLSProfile | null> {
    await this.initialize();
    return this.profiles.get(id) ?? null;
  }

  /** List all profiles. */
  async listProfiles(filter?: { quantum_resistant?: boolean; tls_version?: TLSVersion }): Promise<TLSProfile[]> {
    await this.initialize();
    let list = [...this.profiles.values()];
    if (filter?.quantum_resistant !== undefined) {
      list = list.filter(p => p.is_quantum_resistant === filter.quantum_resistant);
    }
    if (filter?.tls_version) {
      list = list.filter(p => p.tls_version === filter.tls_version);
    }
    return list;
  }

  /** Get a random profile. */
  async getRandomProfile(): Promise<TLSProfile> {
    await this.initialize();
    const list = [...this.profiles.values()];
    return list[Math.floor(Math.random() * list.length)];
  }

  /** Get only quantum-resistant profiles. */
  async getQuantumResistantProfiles(): Promise<TLSProfile[]> {
    return this.listProfiles({ quantum_resistant: true });
  }

  /** Compute JA3 hash from profile components. */
  computeJA3(profile: TLSProfile): string {
    const version = profile.tls_version === 'TLS_1_3' ? '771' : '771';
    const ciphers = profile.cipher_suites.join(',');
    const extensions = profile.extensions.join(',');
    const groups = profile.supported_groups.join(',');
    const sigAlgs = profile.signature_algorithms.join(',');

    const ja3String = `${version},${ciphers},${extensions},${groups},${sigAlgs}`;
    return crypto.createHash('md5').update(ja3String).digest('hex');
  }

  /** Compute JA4 hash from profile components. */
  computeJA4(profile: TLSProfile): string {
    const protocolVersion = profile.tls_version === 'TLS_1_3' ? 't13' : 't12';
    const cipherCount = String(profile.cipher_suites.length).padStart(2, '0');
    const extCount = String(profile.extensions.length).padStart(2, '0');
    const alpn = profile.alpn_protocols[0] ?? '00';

    const cipherHash = crypto.createHash('sha256')
      .update(profile.cipher_suites.join(',')).digest('hex').slice(0, 12);
    const extHash = crypto.createHash('sha256')
      .update(profile.extensions.join(',')).digest('hex').slice(0, 12);

    return `${protocolVersion}_${cipherCount}${extCount}_${alpn}_${cipherHash}_${extHash}`;
  }

  /** Validate a profile for completeness. */
  validateProfile(profile: TLSProfile): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!profile.name) errors.push('Profile name is required');
    if (!profile.cipher_suites?.length) errors.push('At least one cipher suite is required');
    if (!profile.supported_groups?.length) errors.push('At least one supported group is required');
    return { valid: errors.length === 0, errors };
  }

  /** Import a profile from a JA3 string. */
  async importProfileFromCapture(ja3String: string, name?: string): Promise<TLSProfile> {
    const parts = ja3String.split(',');
    if (parts.length < 5) {
      throw new Error('Invalid JA3 string format');
    }

    const profile: TLSProfile = {
      id: `imported-${uuid().slice(0, 8)}`,
      name: name ?? `Imported JA3 ${ja3String.slice(0, 16)}`,
      tls_version: parseInt(parts[0]) >= 772 ? 'TLS_1_3' : 'TLS_1_2',
      cipher_suites: parts[1] ? parts[1].split('-') : [],
      extensions: parts[2] ? parts[2].split('-').map(Number).filter(n => !isNaN(n)) : [],
      ja3_hash: crypto.createHash('md5').update(ja3String).digest('hex'),
      ja4_hash: '',
      supported_groups: parts[3] ? parts[3].split('-') : [],
      signature_algorithms: parts[4] ? parts[4].split('-') : [],
      alpn_protocols: ['h2', 'http/1.1'],
      is_quantum_resistant: false,
      popularity_score: 30,
      created_at: Date.now(),
    };

    profile.ja4_hash = this.computeJA4(profile);
    this.profiles.set(profile.id, profile);

    logger.info({ id: profile.id, ja3: profile.ja3_hash }, 'Profile imported from JA3 capture');
    return profile;
  }
}
