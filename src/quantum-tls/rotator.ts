/**
 * TLS Profile Rotator -- ScrapeSuite Engine
 *
 * Manages TLS profile rotation with multiple strategies: round-robin,
 * random, weighted, least-used, popular, and geolocation-based selection.
 * Tracks active connections per profile in Redis.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { ProfileManager } from './profiles';
import { RotationPolicy, RotationStrategy, TLSProfile } from './types';

const logger = createChildLogger('quantum-tls:rotator');

const ACTIVE_CONN_PREFIX = 'tls:active_connections:';
const ROTATION_STATE_KEY = 'tls:rotation:state';

// ---------- Profile Rotator class ---------------------------------------------

export class ProfileRotator {
  private profileManager: ProfileManager;
  private roundRobinIndex = 0;
  private recentProfileIds: string[] = [];

  constructor(profileManager: ProfileManager) {
    this.profileManager = profileManager;
  }

  /** Get the next TLS profile based on the rotation policy. */
  async getNextProfile(
    policy: RotationPolicy,
    context?: { domain?: string; country?: string; previous_profile_id?: string },
  ): Promise<TLSProfile> {
    await this.profileManager.initialize();

    const allProfiles = await this.profileManager.listProfiles();
    if (!allProfiles.length) {
      throw new Error('No TLS profiles available');
    }

    // Filter by quantum preference
    let candidates = policy.prefer_quantum_resistant
      ? allProfiles.filter(p => p.is_quantum_resistant).concat(allProfiles.filter(p => !p.is_quantum_resistant))
      : allProfiles;

    // Apply anti-repetition: remove recently used profiles
    if (policy.avoid_repetition_count > 0 && this.recentProfileIds.length > 0) {
      const recentSet = new Set(this.recentProfileIds.slice(-policy.avoid_repetition_count));
      const filtered = candidates.filter(p => !recentSet.has(p.id));
      if (filtered.length > 0) candidates = filtered;
    }

    let selected: TLSProfile;

    switch (policy.strategy) {
      case 'round_robin':
        selected = this.selectRoundRobin(candidates);
        break;
      case 'random':
        selected = this.selectRandom(candidates);
        break;
      case 'weighted':
        selected = this.selectWeighted(candidates);
        break;
      case 'least_used':
        selected = await this.selectLeastUsed(candidates);
        break;
      case 'popular':
        selected = this.selectPopular(candidates);
        break;
      case 'geolocation':
        selected = this.selectGeolocation(candidates, context?.country);
        break;
      default:
        selected = this.selectRandom(candidates);
    }

    // Track usage
    this.recentProfileIds.push(selected.id);
    if (this.recentProfileIds.length > 100) {
      this.recentProfileIds = this.recentProfileIds.slice(-50);
    }

    // Increment active connections
    await this.incrementActiveConnections(selected.id);

    logger.debug({ profileId: selected.id, strategy: policy.strategy }, 'Profile selected');
    return selected;
  }

  /** Release a profile (decrement active connection count). */
  async releaseProfile(profileId: string): Promise<void> {
    const key = ACTIVE_CONN_PREFIX + profileId;
    const current = await cacheGet<number>(key) ?? 0;
    const newValue = Math.max(0, current - 1);
    await cacheSet(key, newValue, 86400);
  }

  /** Get the number of active connections for a profile. */
  async getActiveConnections(profileId: string): Promise<number> {
    return await cacheGet<number>(ACTIVE_CONN_PREFIX + profileId) ?? 0;
  }

  // ---------- Selection strategies --------------------------------------------

  private selectRoundRobin(candidates: TLSProfile[]): TLSProfile {
    const index = this.roundRobinIndex % candidates.length;
    this.roundRobinIndex++;
    return candidates[index];
  }

  private selectRandom(candidates: TLSProfile[]): TLSProfile {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  private selectWeighted(candidates: TLSProfile[]): TLSProfile {
    // Weighted by popularity score
    const totalWeight = candidates.reduce((sum, p) => sum + p.popularity_score, 0);
    let random = Math.random() * totalWeight;

    for (const profile of candidates) {
      random -= profile.popularity_score;
      if (random <= 0) return profile;
    }

    return candidates[candidates.length - 1];
  }

  private async selectLeastUsed(candidates: TLSProfile[]): Promise<TLSProfile> {
    let minConn = Infinity;
    let selected = candidates[0];

    for (const profile of candidates) {
      const conn = await this.getActiveConnections(profile.id);
      if (conn < minConn) {
        minConn = conn;
        selected = profile;
      }
    }

    return selected;
  }

  private selectPopular(candidates: TLSProfile[]): TLSProfile {
    // Sort by popularity (descending) and pick from top 3 with some randomness
    const sorted = [...candidates].sort((a, b) => b.popularity_score - a.popularity_score);
    const topN = sorted.slice(0, Math.min(3, sorted.length));
    return topN[Math.floor(Math.random() * topN.length)];
  }

  private selectGeolocation(candidates: TLSProfile[], country?: string): TLSProfile {
    if (!country) return this.selectWeighted(candidates);

    // Region-based profile preference
    // China/Russia typically use different browser profiles
    const asianCountries = ['CN', 'JP', 'KR', 'TW', 'HK'];
    if (asianCountries.includes(country.toUpperCase())) {
      // Prefer non-Chrome profiles for Asian regions (more Firefox/Safari usage)
      const firefoxOrSafari = candidates.filter(p =>
        p.name.toLowerCase().includes('firefox') || p.name.toLowerCase().includes('safari'),
      );
      if (firefoxOrSafari.length) return this.selectWeighted(firefoxOrSafari);
    }

    // Default: weighted selection
    return this.selectWeighted(candidates);
  }

  // ---------- Internal helpers ------------------------------------------------

  private async incrementActiveConnections(profileId: string): Promise<void> {
    const key = ACTIVE_CONN_PREFIX + profileId;
    const current = await cacheGet<number>(key) ?? 0;
    await cacheSet(key, current + 1, 86400);
  }
}
