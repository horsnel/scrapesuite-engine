/**
 * Comment Normalizer — ScrapeSuite Engine (platform layer)
 *
 * Maps the InnerTube `Comment` model onto the unified comment shape used
 * by the unified facade. Kept separate so the InnerTube endpoints file
 * stays free of cross-platform types.
 */

import type { Comment } from './innertube-endpoints';

export interface UnifiedComment {
  platform: 'youtube' | 'reddit';
  id: string;
  author: string | null;
  text: string;
  likes: number | null;
  publishedAt: string | null;
  pinned?: boolean;
  url?: string;
}

/** Project InnerTube comments into the unified model (order preserved). */
export function extractCommentItems(comments: Comment[]): UnifiedComment[] {
  return comments.map((c) => ({
    platform: 'youtube' as const,
    id: c.id,
    author: c.author || null,
    text: c.text,
    likes: typeof c.likeCount === 'number' ? c.likeCount : null,
    publishedAt: c.publishedTime ?? null,
    ...(c.pinned ? { pinned: true } : {}),
    url: `https://www.youtube.com/watch?v=${c.id.split('.').pop() ?? ''}&lc=${c.id}`,
  }));
}
