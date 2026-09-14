/**
 * Reddit Extractors — ScrapeSuite Engine (platform layer)
 *
 * Projects Reddit responses (RSS entries, JSON listings) into
 * `NormalizedItem`s so downstream consumers never learn Reddit's dialects.
 */

import type { NormalizedItem } from '../types-normalized';
import type { RedditRssEntry } from './types';

/** Project RSS feed entries (posts and comments) into normalized items. */
export function extractRssPosts(entries: RedditRssEntry[], source = 'reddit.rss'): NormalizedItem[] {
  const out: NormalizedItem[] = [];
  for (const e of entries) {
    if (e.kind === 'post') {
      out.push({
        kind: 'post',
        platform: 'reddit',
        id: e.id ?? '',
        title: e.title ?? '',
        ...(e.author ? { author: { name: e.author } } : {}),
        ...(e.permalink ? { url: e.permalink } : {}),
        ...(e.publishedAt ? { publishedText: new Date(e.publishedAt).toISOString() } : {}),
        ...(e.subreddit ? { extra: { subreddit: e.subreddit } } : {}),
        ...(e.externalUrl ? { extra: { externalUrl: e.externalUrl } } : {}),
        source,
      });
    } else if (e.kind === 'comment') {
      out.push({
        kind: 'comment',
        platform: 'reddit',
        id: e.commentId ?? e.id ?? '',
        title: e.title ?? '',
        ...(e.author ? { author: { name: e.author } } : {}),
        ...(e.permalink ? { url: e.permalink } : {}),
        ...(e.publishedAt ? { publishedText: new Date(e.publishedAt).toISOString() } : {}),
        ...(e.parentPostId ? { extra: { parentPostId: e.parentPostId } } : {}),
        source,
      });
    }
  }
  return out;
}

/**
 * Project a Reddit JSON listing (`/new.json`, `/hot.json`, search results,
 * OAuth listings) into normalized posts. Tolerates both `data.children`
 * listings and bare arrays. Never throws on shape surprises.
 */
export function extractJsonPosts(json: unknown, source = 'reddit.json'): NormalizedItem[] {
  const out: NormalizedItem[] = [];
  const children = (() => {
    try {
      if (Array.isArray(json)) return json;
      const data = (json as any)?.data;
      if (Array.isArray(data?.children)) return data.children;
      if (Array.isArray((json as any)?.data?.mergedChildren)) return (json as any).data.mergedChildren;
      return [];
    } catch {
      return [];
    }
  })();

  for (const child of children) {
    try {
      const d = child?.data ?? child;
      if (!d || typeof d !== 'object') continue;
      const id = typeof d.name === 'string' ? d.name : typeof d.id === 'string' ? `t3_${d.id}` : '';
      if (!id) continue;
      out.push({
        kind: 'post',
        platform: 'reddit',
        id,
        title: typeof d.title === 'string' ? d.title : '',
        ...(d.author ? { author: { name: String(d.author) } } : {}),
        ...(d.permalink ? { url: `https://www.reddit.com${d.permalink}` } : {}),
        ...(d.created_utc ? { publishedText: new Date(Number(d.created_utc) * 1000).toISOString() } : {}),
        ...(d.subreddit ? { extra: { subreddit: String(d.subreddit) } } : {}),
        ...(d.selftext ? { description: String(d.selftext).slice(0, 500) } : {}),
        stats: {
          ...(d.ups !== undefined ? { upvotes: Number(d.ups) || 0 } : {}),
          ...(d.num_comments !== undefined ? { comments: Number(d.num_comments) || 0 } : {}),
          ...(d.score !== undefined ? { upvotes: Number(d.score) || 0 } : {}),
        },
        source,
      });
    } catch {
      // skip malformed child
    }
  }
  return out;
}
