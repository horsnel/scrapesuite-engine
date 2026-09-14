/**
 * Platform Router — ScrapeSuite Engine (platform layer)
 *
 * "Give me the comments for this URL" — the router makes that possible by
 * resolving any supported content URL to (platform, kind, ids). Pure
 * parsing, no network.
 */

// ===============================================================================
// TYPES
// ===============================================================================

export type ResolvedContent =
  | { platform: 'youtube'; kind: 'video'; videoId: string }
  | { platform: 'youtube'; kind: 'short'; videoId: string }
  | { platform: 'youtube'; kind: 'channel'; channelId: string }
  | { platform: 'youtube'; kind: 'playlist'; playlistId: string }
  | { platform: 'youtube'; kind: 'search'; query: string }
  | { platform: 'reddit'; kind: 'post'; subreddit: string; postId: string; titleSlug?: string }
  | { platform: 'reddit'; kind: 'subreddit'; subreddit: string; sort?: string }
  | { platform: 'reddit'; kind: 'user'; username: string }
  | { platform: 'tiktok'; kind: 'video'; username: string; videoId: string }
  | { platform: 'tiktok'; kind: 'user'; username: string }
  | { platform: null; kind: 'unknown' };

// ===============================================================================
// RESOLUTION
// ===============================================================================

/**
 * Resolve a content URL to its platform + ids. Accepts bare ids too:
 * a bare YouTube video id shape returns a youtube video, `t3_xxx` a
 * Reddit post. Never throws.
 */
export function resolveUrl(input: string): ResolvedContent {
  const raw = (input ?? '').trim();
  if (!raw) return { platform: null, kind: 'unknown' };

  // ---- Bare id shortcuts ----
  if (/^t[13]_[\w]{5,10}$/.test(raw)) {
    return { platform: 'reddit', kind: 'post', subreddit: '', postId: raw };
  }
  if (/^PL[\w-]{10,}$/.test(raw)) {
    return { platform: 'youtube', kind: 'playlist', playlistId: raw };
  }
  if (/^UC[\w-]{20,}$/.test(raw)) {
    return { platform: 'youtube', kind: 'channel', channelId: raw };
  }
  if (/^[\w-]{11}$/.test(raw) && !raw.includes('/')) {
    return { platform: 'youtube', kind: 'video', videoId: raw };
  }

  // ---- URL parsing ----
  let url: URL;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return { platform: null, kind: 'unknown' };
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase();

  // ---- YouTube ----
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtu.be') {
    if (host === 'youtu.be') {
      const videoId = url.pathname.split('/')[1] ?? '';
      return videoId
        ? { platform: 'youtube', kind: 'video', videoId }
        : { platform: null, kind: 'unknown' };
    }
    const v = url.searchParams.get('v');
    if (v && /^[\w-]{6,20}$/.test(v)) {
      return { platform: 'youtube', kind: 'video', videoId: v };
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'shorts' && parts[1]) {
      return { platform: 'youtube', kind: 'short', videoId: parts[1] };
    }
    if (parts[0] === 'playlist') {
      const list = url.searchParams.get('list');
      return list
        ? { platform: 'youtube', kind: 'playlist', playlistId: list }
        : { platform: null, kind: 'unknown' };
    }
    if ((parts[0] === 'channel' || parts[0] === 'c' || parts[0] === 'user') && parts[1]) {
      const id = parts[0] === 'channel' ? parts[1] : parts[1];
      return { platform: 'youtube', kind: 'channel', channelId: id };
    }
    if (parts[0] === 'results') {
      const q = url.searchParams.get('search_query') ?? url.searchParams.get('q') ?? '';
      return { platform: 'youtube', kind: 'search', query: q };
    }
    if (parts[0] === '@' || parts[0]?.startsWith('@')) {
      return { platform: 'youtube', kind: 'channel', channelId: parts[0] };
    }
    return { platform: null, kind: 'unknown' };
  }

  // ---- Reddit ----
  if (host === 'reddit.com' || host.endsWith('.reddit.com') || host === 'redd.it') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'r' && parts[1]) {
      const subreddit = parts[1];
      if (parts[2] === 'comments' && parts[3]) {
        return { platform: 'reddit', kind: 'post', subreddit, postId: parts[3], ...(parts[4] ? { titleSlug: parts[4] } : {}) };
      }
      return { platform: 'reddit', kind: 'subreddit', subreddit, ...(parts[2] ? { sort: parts[2] } : {}) };
    }
    if (parts[0] === 'user' && parts[1]) {
      return { platform: 'reddit', kind: 'user', username: parts[1] };
    }
    return { platform: null, kind: 'unknown' };
  }

  // ---- TikTok ----
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    const parts = url.pathname.split('/').filter(Boolean);
    const username = parts[0]?.startsWith('@') ? parts[0].slice(1) : undefined;
    if (username && parts[1] === 'video' && parts[2] && /^\d+$/.test(parts[2])) {
      return { platform: 'tiktok', kind: 'video', username, videoId: parts[2] };
    }
    if (username) {
      return { platform: 'tiktok', kind: 'user', username };
    }
    return { platform: null, kind: 'unknown' };
  }

  return { platform: null, kind: 'unknown' };
}

/** Human-readable description of a resolved URL (for APIs and logs). */
export function describeUrl(input: string): string {
  const r = resolveUrl(input);
  if (!r.platform) return 'unrecognized URL';
  switch (r.kind) {
    case 'video': return `YouTube video ${r.videoId}`;
    case 'short': return `YouTube Short ${r.videoId}`;
    case 'channel': return `YouTube channel ${r.channelId}`;
    case 'playlist': return `YouTube playlist ${r.playlistId}`;
    case 'search': return `YouTube search "${r.query}"`;
    case 'post': return `Reddit post in r/${r.subreddit || '?'}`;
    case 'subreddit': return `Reddit r/${r.subreddit}`;
    case 'user': return r.platform === 'reddit' ? `Reddit u/${r.username}` : `TikTok @${r.username}`;
    default: return 'unrecognized URL';
  }
}
