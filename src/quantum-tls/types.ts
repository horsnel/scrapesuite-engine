/**
 * Quantum-Resistant TLS Types -- ScrapeSuite Engine
 *
 * Type definitions for quantum-resistant TLS fingerprinting,
 * profile management, and connection configuration.
 */

/** Supported TLS protocol version. */
export type TLSVersion = 'TLS_1_2' | 'TLS_1_3';

/** Cipher suite strength classification. */
export type CipherStrength = 'weak' | 'medium' | 'strong' | 'quantum_resistant';

/** A TLS cipher suite definition. */
export interface CipherSuite {
  name: string;
  code: string;
  strength: CipherStrength;
  is_pfs: boolean;
}

/** A complete TLS profile mimicking a real browser. */
export interface TLSProfile {
  id: string;
  name: string;
  tls_version: TLSVersion;
  cipher_suites: string[];
  extensions: number[];
  ja3_hash: string;
  ja4_hash: string;
  supported_groups: string[];
  signature_algorithms: string[];
  alpn_protocols: string[];
  is_quantum_resistant: boolean;
  popularity_score: number;
  created_at: number;
}

/** JA3 fingerprint components. */
export interface JA3Fingerprint {
  hash: string;
  version: number;
  cipher_suites: number[];
  extensions: number[];
  supported_groups: number[];
  signature_algorithms: number[];
}

/** JA4 fingerprint components. */
export interface JA4Fingerprint {
  hash: string;
  protocol_version: string;
  cipher_suites_count: number;
  extensions_count: number;
  alpn: string;
  cipher_list_hash: string;
  extension_list_hash: string;
}

/** Configuration for a TLS connection. */
export interface ConnectionConfig {
  profile_id: string;
  server_name_indication: string;
  alpn: string[];
  certificate_pin?: string;
  timeout_ms: number;
  verify_cert: boolean;
}

/** Profile rotation strategy. */
export type RotationStrategy = 'round_robin' | 'random' | 'weighted' | 'least_used' | 'popular' | 'geolocation';

/** Policy controlling how TLS profiles are rotated. */
export interface RotationPolicy {
  strategy: RotationStrategy;
  interval_ms: number;
  avoid_repetition_count: number;
  prefer_quantum_resistant: boolean;
}

/** Aggregate TLS statistics. */
export interface TLSStats {
  total_profiles: number;
  active_connections: number;
  connections_by_profile: Record<string, number>;
  quantum_resistant_ratio: number;
  average_handshake_ms: number;
}

/** Quantum readiness assessment. */
export type QuantumReadinessLevel = 'not_ready' | 'partial' | 'ready' | 'advanced';

/** Quantum readiness report. */
export interface QuantumReadiness {
  level: QuantumReadinessLevel;
  score: number;
  recommendations: string[];
  resistant_ciphers_percent: number;
}

/** Node.js TLS connection options. */
export interface NodeTLSOptions {
  minVersion: string;
  maxVersion: string;
  ciphers: string;
  honorCipherOrder: boolean;
  ALPNProtocols: string[];
  servername?: string;
  rejectUnauthorized: boolean;
}

/** Result of a TLS handshake simulation. */
export interface HandshakeResult {
  success: boolean;
  negotiated_cipher: string;
  negotiated_version: string;
  handshake_ms: number;
  ja3_hash: string;
  errors?: string[];
}

/** Analysis of a TLS fingerprint. */
export interface FingerprintAnalysis {
  ja3_hash: string;
  ja4_hash: string;
  matching_browsers: string[];
  suspicious: boolean;
  quantum_safe: boolean;
}
