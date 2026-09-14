/**
 * Unified Facade — ScrapeSuite Engine (platform layer)
 *
 * The one-door API: "give me the comments for this URL." Detects the
 * platform behind the URL, picks the best available surface (preferring
 * ones that work from the current network position), and returns
 * normalized models. Consumers never learn Reddit/YouTube/TikTok dialects.
 *
 * Surface selection honors the engine's own capability findings: Reddit
 * prefers RSS (open from datacenter IPs) unless OAuth credentials exist;
 * YouTube uses the InnerTube client; TikTok signed surfaces are offered
 * with session-farm identity where available.
 */

import { createChildLogger } from '../utils/logger';
import { resolveUrl, type ResolvedContent } from './router';
import type { NormalizedItem } from './types-normalized';
import { outcomeTally, telemetryStats, recordAttempt } from './telemetry';
import { cacheStats } from './response-cache';
import { poolStatus } from '../utils/proxy-pool';
import { farmStatus } from './tiktok/session-farm';

const logger = createChildLogger('unified');

// ===============================================================================
// COMMENTS
// ===============================================================================

export interface UnifiedComment {
  platform: 'youtube' | 'reddit';
  id: string;
  author: string | null;
  text: string;
  likes: number | null;
  publishedAt: string | null;
  /** YouTube thread structure: top-level comment + its replies. */
  replies?: UnifiedComment[];
  url?: string;
}

export interface UnifiedCommentsResult {
  ok: boolean;
  target: string;
  resolved: ResolvedContent;
  comments: UnifiedComment[];
  cursor?: string;
  error?: string;
}

/**
 * Fetch comments for any supported URL.
 *  - YouTube watch/short URLs → InnerTube next comments (normalized)
 *  - Reddit post URLs → the post's comment RSS feed (works from datacenter IPs)
 */
export async function getCommentsForUrl(
  url: string,
  options: { maxComments?: number; paginate?: boolean; cache?: boolean } = {},
): Promise<UnifiedCommentsResult> {
  const resolved = resolveUrl(url);
  const maxComments = options.maxComments ?? 20;

  if (resolved.platform === 'youtube' && (resolved.kind === 'video' || resolved.kind === 'short')) {
    const { getComments } = await import('./youtube/innertube-endpoints');
    const { extractCommentItems } = await import('./youtube/normalize-comments');
    const result = await getComments(resolved.videoId, {
      maxComments,
      paginate: options.paginate,
      ...(options.cache !== undefined ? { cache: options.cache } : {}),
    });
    return {
      ok: result.ok,
      target: url,
      resolved,
      comments: result.ok ? extractCommentItems(result.comments) : [],
      ...(result.continuationToken ? { cursor: result.continuationToken } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  }

  if (resolved.platform === 'reddit' && resolved.kind === 'post') {
    const { rssAdapter } = await import('./reddit/rss-adapter');
    const feedUrl = resolved.subreddit
      ? `https://www.reddit.com/r/${resolved.subreddit}/comments/${resolved.postId}`
      : `https://www.reddit.com/comments/${resolved.postId.replace(/^t3_/, '')}`;
    const result = await rssAdapter.fetchAndParse(feedUrl, { limit: maxComments });
    const comments: UnifiedComment[] = (result.success ? result.entries : [])
      .filter((e) => e.kind === 'comment')
      .map((e) => ({
        platform: 'reddit' as const,
        id: e.commentId ?? e.id ?? '',
        author: e.author,
        text: stripHtml(e.htmlContent ?? e.textExcerpt ?? ''),
        likes: null,
        publishedAt: e.publishedAt ? new Date(e.publishedAt).toISOString() : null,
        ...(e.permalink ? { url: e.permalink } : {}),
      }));
    return {
      ok: comments.length > 0,
      target: url,
      resolved,
      comments,
      ...(comments.length === 0 ? { error: result.errors[0] ?? 'no comments parsed from feed' } : {}),
    };
  }

  return {
    ok: false,
    target: url,
    resolved,
    comments: [],
    error: `comments not supported for ${resolved.platform ?? 'unknown'} ${resolved.kind}`,
  };
}

// ===============================================================================
// SEARCH / FEEDS
// ===============================================================================

/**
 * Search YouTube and return normalized videos.
 */
export async function searchVideos(query: string, options: { cache?: boolean } = {}): Promise<NormalizedItem[]> {
  const { innertubeClient } = await import('./youtube/innertube-client');
  const { extractSearchResults } = await import('./youtube/extractors');
  const response = await innertubeClient.execute({
    endpoint: 'search',
    body: { query },
  });
  if (!response.ok || !response.json) {
    recordAttempt({
      surface: 'youtube.search',
      outcome: 'bot_wall',
      url: `https://youtube.com/results?q=${encodeURIComponent(query)}`,
      response: { status: response.status, marker: response.error },
    });
    return [];
  }
  return extractSearchResults(response.json as Record<string, unknown>);
}

/**
 * Fetch a subreddit's posts via RSS (the datacenter-friendly surface),
 * normalized.
 */
export async function getSubredditPosts(
  subreddit: string,
  options: { sort?: 'hot' | 'new' | 'top' | 'rising'; limit?: number } = {},
): Promise<NormalizedItem[]> {
  const { rssAdapter } = await import('./reddit/rss-adapter');
  const { extractRssPosts } = await import('./reddit/extractors');
  const sort = options.sort ?? 'hot';
  const result = await rssAdapter.fetchAndParse(`https://www.reddit.com/r/${subreddit}/${sort}`, {
    limit: options.limit ?? 25,
  });
  if (!result.success) {
    logger.warn({ subreddit, errors: result.errors }, 'subreddit RSS fetch failed');
    return [];
  }
  return extractRssPosts(result.entries, 'reddit.rss');
}

// ===============================================================================
// STATUS
// ===============================================================================

/** Whole-engine self-report: telemetry, cache, pool, farm. */
export async function engineStatus(): Promise<Record<string, unknown>> {
  const farm = await farmStatus().catch(() => null);
  return {
    telemetry: telemetryStats(),
    outcomes: outcomeTally(),
    cache: cacheStats(),
    proxyPool: poolStatus(),
    sessionFarm: farm,
    timestamp: new Date().toISOString(),
  };
}

// ===============================================================================
// HELPERS
// ===============================================================================

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
