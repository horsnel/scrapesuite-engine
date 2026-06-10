/**
 * Quantum-Resistant TLS -- ScrapeSuite Engine
 *
 * Provides quantum-resistant TLS fingerprinting, profile rotation,
 * and connection management. Includes pre-built browser profiles,
 * JA3/JA4 computation, and quantum readiness assessment.
 */

export { ProfileManager } from './profiles';
export { ProfileRotator } from './rotator';
export { HandshakeManager } from './handshake';
export { QuantumTLSManager, quantumTLSManager } from './manager';
export { TLSFingerprintSpoofer, tlsSpoofer } from './tls-spoofer';
export type { SpoofedConnection, CurlImpersonateResult } from './tls-spoofer';
export * from './types';
