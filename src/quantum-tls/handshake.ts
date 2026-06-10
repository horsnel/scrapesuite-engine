/**
 * TLS Handshake Manager -- ScrapeSuite Engine
 *
 * Handles TLS handshake simulation, fingerprint analysis,
 * quantum readiness assessment, and Node.js TLS option generation.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import {
  TLSProfile,
  HandshakeResult,
  FingerprintAnalysis,
  QuantumReadiness,
  QuantumReadinessLevel,
  NodeTLSOptions,
} from './types';

const logger = createChildLogger('quantum-tls:handshake');

const HANDSHAKE_METRICS_KEY = 'tls:handshake:metrics';

// ---------- Quantum-resistant cipher indicators --------------------------------

const QUANTUM_CIPHER_INDICATORS = [
  'KYBER', 'MLKEM', 'NTRU', 'SABER', 'DILITHIUM', 'FALCON', 'SPHINCS',
  'x25519_kyber768', 'x25519_mlkem768', 'SecP256r1MLKEM768',
];

// ---------- Handshake Manager class -------------------------------------------

export class HandshakeManager {

  /** Simulate a TLS handshake and return the result. */
  async simulateHandshake(profile: TLSProfile, hostname: string): Promise<HandshakeResult> {
    const startTime = Date.now();

    try {
      // Validate profile has necessary components
      if (!profile.cipher_suites?.length) {
        return {
          success: false,
          negotiated_cipher: '',
          negotiated_version: '',
          handshake_ms: Date.now() - startTime,
          ja3_hash: profile.ja3_hash,
          errors: ['No cipher suites configured'],
        };
      }

      // Simulate cipher negotiation (pick first supported cipher)
      const negotiatedCipher = profile.cipher_suites[0];
      const negotiatedVersion = profile.tls_version === 'TLS_1_3' ? '1.3' : '1.2';

      const handshakeMs = Date.now() - startTime;

      // Record metrics
      await this.recordHandshakeMetric(handshakeMs);

      return {
        success: true,
        negotiated_cipher: negotiatedCipher,
        negotiated_version: negotiatedVersion,
        handshake_ms: handshakeMs,
        ja3_hash: profile.ja3_hash,
      };
    } catch (err: any) {
      return {
        success: false,
        negotiated_cipher: '',
        negotiated_version: '',
        handshake_ms: Date.now() - startTime,
        ja3_hash: profile.ja3_hash,
        errors: [err.message],
      };
    }
  }

  /** Analyze a TLS fingerprint for suspicious patterns. */
  analyzeFingerprint(profile: TLSProfile): FingerprintAnalysis {
    // Check if fingerprint matches known browser patterns
    const matchingBrowsers: string[] = [];

    if (profile.name.includes('Chrome')) matchingBrowsers.push('Chrome');
    if (profile.name.includes('Firefox')) matchingBrowsers.push('Firefox');
    if (profile.name.includes('Safari')) matchingBrowsers.push('Safari');
    if (profile.name.includes('Edge')) matchingBrowsers.push('Edge');

    // Detect suspicious patterns
    let suspicious = false;

    // Very few cipher suites is suspicious
    if (profile.cipher_suites.length < 3) suspicious = true;

    // Missing common extensions
    if (!profile.extensions.includes(0)) suspicious = true; // SNI

    // No ALPN is unusual for modern browsers
    if (!profile.alpn_protocols?.length) suspicious = true;

    // Check quantum safety
    const quantumSafe = this.isProfileQuantumSafe(profile);

    return {
      ja3_hash: profile.ja3_hash,
      ja4_hash: profile.ja4_hash,
      matching_browsers: matchingBrowsers,
      suspicious,
      quantum_safe: quantumSafe,
    };
  }

  /** Assess quantum readiness across all profiles. */
  async getQuantumReadiness(profiles: TLSProfile[]): Promise<QuantumReadiness> {
    if (!profiles.length) {
      return {
        level: 'not_ready',
        score: 0,
        recommendations: ['No TLS profiles configured. Add browser-mimicking profiles.'],
        resistant_ciphers_percent: 0,
      };
    }

    const quantumReady = profiles.filter(p => this.isProfileQuantumSafe(p));
    const resistantPercent = (quantumReady.length / profiles.length) * 100;

    const score = this.scoreQuantumReadiness(profiles);
    const recommendations = this.generateQuantumRecommendations(profiles, resistantPercent);

    let level: QuantumReadinessLevel;
    if (score >= 80) level = 'advanced';
    else if (score >= 60) level = 'ready';
    else if (score >= 30) level = 'partial';
    else level = 'not_ready';

    return {
      level,
      score,
      recommendations,
      resistant_ciphers_percent: Math.round(resistantPercent * 100) / 100,
    };
  }

  /** Generate Node.js TLS connection options from a profile. */
  generateConnectionOptions(profile: TLSProfile, hostname?: string): NodeTLSOptions {
    return {
      minVersion: profile.tls_version === 'TLS_1_3' ? 'TLSv1.3' : 'TLSv1.2',
      maxVersion: 'TLSv1.3',
      ciphers: profile.cipher_suites.join(':'),
      honorCipherOrder: true,
      ALPNProtocols: profile.alpn_protocols,
      servername: hostname,
      rejectUnauthorized: true,
    };
  }

  // ---------- Internal helpers ------------------------------------------------

  private isProfileQuantumSafe(profile: TLSProfile): boolean {
    if (profile.is_quantum_resistant) return true;

    // Check cipher suites for quantum-resistant indicators
    const hasQuantumCipher = profile.cipher_suites.some(cipher =>
      QUANTUM_CIPHER_INDICATORS.some(indicator => cipher.toUpperCase().includes(indicator)),
    );

    // Check supported groups for hybrid key exchange
    const hasHybridGroup = profile.supported_groups.some(group =>
      group.toLowerCase().includes('kyber') || group.toLowerCase().includes('mlkem'),
    );

    return hasQuantumCipher || hasHybridGroup;
  }

  scoreQuantumReadiness(profiles: TLSProfile[]): number {
    let score = 0;
    const total = profiles.length;

    // Points for having TLS 1.3 profiles
    const tls13Count = profiles.filter(p => p.tls_version === 'TLS_1_3').length;
    score += (tls13Count / total) * 30;

    // Points for PFS (forward secrecy) via ECDHE ciphers
    const pfsCount = profiles.filter(p =>
      p.cipher_suites.some(c => c.includes('ECDHE') || c.includes('CHACHA20')),
    ).length;
    score += (pfsCount / total) * 20;

    // Points for quantum-resistant profiles
    const qrCount = profiles.filter(p => this.isProfileQuantumSafe(p)).length;
    score += (qrCount / total) * 40;

    // Points for profile diversity
    const uniqueGroups = new Set(profiles.flatMap(p => p.supported_groups));
    score += Math.min(10, uniqueGroups.size * 2);

    return Math.round(Math.min(100, score) * 100) / 100;
  }

  private generateQuantumRecommendations(profiles: TLSProfile[], resistantPercent: number): string[] {
    const recommendations: string[] = [];

    if (resistantPercent < 20) {
      recommendations.push('Add quantum-resistant TLS profiles with hybrid key exchange (e.g., X25519+Kyber768)');
    }

    const tls12Profiles = profiles.filter(p => p.tls_version === 'TLS_1_2');
    if (tls12Profiles.length > 0) {
      recommendations.push(`Migrate ${tls12Profiles.length} TLS 1.2 profiles to TLS 1.3 for better security`);
    }

    const noPfs = profiles.filter(p => !p.cipher_suites.some(c => c.includes('ECDHE')));
    if (noPfs.length > 0) {
      recommendations.push(`${noPfs.length} profiles lack Perfect Forward Secrecy — add ECDHE cipher suites`);
    }

    if (profiles.length < 5) {
      recommendations.push('Increase profile diversity — at least 5 different browser profiles recommended');
    }

    if (resistantPercent >= 50) {
      recommendations.push('Good quantum readiness — continue monitoring NIST post-quantum standards');
    }

    return recommendations;
  }

  private async recordHandshakeMetric(handshakeMs: number): Promise<void> {
    const metrics = await cacheGet<number[]>(HANDSHAKE_METRICS_KEY) ?? [];
    metrics.push(handshakeMs);
    await cacheSet(HANDSHAKE_METRICS_KEY, metrics.slice(-1000), 86400);
  }
}
