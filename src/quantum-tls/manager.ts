/**
 * Quantum TLS Manager -- ScrapeSuite Engine
 *
 * Main orchestrator for quantum-resistant TLS management.
 * Wires together profile management, rotation, and handshake analysis.
 */

import { createChildLogger } from '../utils/logger';
import { ProfileManager } from './profiles';
import { ProfileRotator } from './rotator';
import { HandshakeManager } from './handshake';
import {
  ConnectionConfig,
  NodeTLSOptions,
  QuantumReadiness,
  RotationPolicy,
  TLSProfile,
  TLSStats,
  TLSVersion,
} from './types';

const logger = createChildLogger('quantum-tls:manager');

const DEFAULT_ROTATION_POLICY: RotationPolicy = {
  strategy: 'weighted',
  interval_ms: 0,
  avoid_repetition_count: 3,
  prefer_quantum_resistant: false,
};

// ---------- Quantum TLS Manager class -----------------------------------------

export class QuantumTLSManager {
  private profileManager: ProfileManager;
  private rotator: ProfileRotator;
  private handshakeManager: HandshakeManager;
  private initialized = false;

  constructor() {
    this.profileManager = new ProfileManager();
    this.rotator = new ProfileRotator(this.profileManager);
    this.handshakeManager = new HandshakeManager();
  }

  /** Initialize the manager and load profiles. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.profileManager.initialize();
    this.initialized = true;
    logger.info('Quantum TLS Manager initialized');
  }

  /** Get a connection configuration for a domain, including profile selection. */
  async getConnectionConfig(domain: string, country?: string): Promise<ConnectionConfig> {
    await this.initialize();

    const profile = await this.rotator.getNextProfile(DEFAULT_ROTATION_POLICY, {
      domain,
      country,
    });

    return {
      profile_id: profile.id,
      server_name_indication: domain,
      alpn: profile.alpn_protocols,
      timeout_ms: 30000,
      verify_cert: true,
    };
  }

  /** Get Node.js TLS options for a connection. */
  async getConnectionOptions(domain: string, country?: string): Promise<NodeTLSOptions> {
    await this.initialize();

    const profile = await this.rotator.getNextProfile(DEFAULT_ROTATION_POLICY, {
      domain,
      country,
    });

    return this.handshakeManager.generateConnectionOptions(profile, domain);
  }

  /** Release a profile after connection ends. */
  async releaseConnection(profileId: string): Promise<void> {
    await this.rotator.releaseProfile(profileId);
  }

  /** Get a profile by ID. */
  async getProfile(id: string): Promise<TLSProfile | null> {
    return this.profileManager.getProfile(id);
  }

  /** List all profiles. */
  async listProfiles(filter?: { quantum_resistant?: boolean; tls_version?: TLSVersion }): Promise<TLSProfile[]> {
    return this.profileManager.listProfiles(filter);
  }

  /** Create a custom TLS profile. */
  async createProfile(profile: Omit<TLSProfile, 'id' | 'created_at' | 'ja3_hash' | 'ja4_hash'>): Promise<TLSProfile> {
    return this.profileManager.createProfile(profile);
  }

  /** Get aggregate TLS statistics. */
  async getStats(): Promise<TLSStats> {
    await this.initialize();
    const profiles = await this.profileManager.listProfiles();

    const connectionsByProfile: Record<string, number> = {};
    for (const profile of profiles) {
      connectionsByProfile[profile.id] = await this.rotator.getActiveConnections(profile.id);
    }

    const totalActive = Object.values(connectionsByProfile).reduce((s, c) => s + c, 0);
    const quantumProfiles = profiles.filter(p => p.is_quantum_resistant);
    const quantumRatio = profiles.length > 0 ? quantumProfiles.length / profiles.length : 0;

    return {
      total_profiles: profiles.length,
      active_connections: totalActive,
      connections_by_profile: connectionsByProfile,
      quantum_resistant_ratio: Math.round(quantumRatio * 100) / 100,
      average_handshake_ms: 0, // Would need real metrics aggregation
    };
  }

  /** Get quantum readiness assessment. */
  async getQuantumReadiness(): Promise<QuantumReadiness> {
    await this.initialize();
    const profiles = await this.profileManager.listProfiles();
    return this.handshakeManager.getQuantumReadiness(profiles);
  }

  /** Rotate to a new profile using the given policy. */
  async rotateProfile(policy?: Partial<RotationPolicy>): Promise<TLSProfile> {
    await this.initialize();
    const fullPolicy: RotationPolicy = { ...DEFAULT_ROTATION_POLICY, ...policy };
    return this.rotator.getNextProfile(fullPolicy);
  }

  /** Get the handshake manager for direct access. */
  getHandshakeManager(): HandshakeManager {
    return this.handshakeManager;
  }
}

// ---------- Singleton export --------------------------------------------------

export const quantumTLSManager = new QuantumTLSManager();
