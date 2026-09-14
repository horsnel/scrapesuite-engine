/**
 * Normalized Item Model — ScrapeSuite Engine (platform layer)
 *
 * The common shape every platform's extractors project into. One model
 * means downstream code (feeds, LLM pipelines, datasets) never learns
 * three different response dialects.
 */

export type PlatformName = 'youtube' | 'reddit' | 'tiktok';

export type NormalizedKind =
  | 'video'
  | 'short'
  | 'live'
  | 'channel'
  | 'playlist'
  | 'post'
  | 'comment'
  | 'subreddit'
  | 'user';

export interface NormalizedStats {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  subscribers?: number;
  members?: number;
  upvotes?: number;
}

export interface NormalizedItem {
  kind: NormalizedKind;
  platform: PlatformName;
  /** Platform-native id (videoId, t3_xxx, aweme_id, …). */
  id: string;
  title: string;
  author?: {
    id?: string;
    name?: string;
    verified?: boolean;
    url?: string;
  };
  url?: string;
  thumbnail?: string;
  durationText?: string;
  publishedText?: string;
  description?: string;
  stats?: NormalizedStats;
  /** The surface this item was extracted from. */
  source?: string;
  /** Escape hatch for platform-specific extras. */
  extra?: Record<string, unknown>;
}
