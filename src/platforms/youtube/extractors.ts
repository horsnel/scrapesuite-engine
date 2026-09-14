/**
 * YouTube Extractors — ScrapeSuite Engine (platform layer)
 *
 * Projects raw InnerTube responses into `NormalizedItem`s.
 *
 * The beauty of InnerTube's dialects: `videoRenderer` is the SAME renderer
 * in browse grids, search results, and related lists. One walker covers all
 * of them. `gridVideoRenderer` (home grid) and `compactVideoRenderer`
 * (side lists) carry the same fields under different names.
 *
 * All extractors are pure functions over JSON — trivially testable offline
 * against fixtures.
 */

import type { NormalizedItem, NormalizedStats } from '../types-normalized';

// ===============================================================================
// JSON WALKING
// ===============================================================================

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Depth-first walk yielding every object named by `key` (arrays traversed). */
export function* walkRenderers(node: unknown, key: string, depth = 0): Generator<Json> {
  if (depth > 60 || !node) return;
  if (Array.isArray(node)) {
    for (const item of node) yield* walkRenderers(item, key, depth + 1);
    return;
  }
  if (!isObj(node)) return;
  for (const [k, v] of Object.entries(node)) {
    if (k === key && isObj(v)) {
      yield v;
      yield* walkRenderers(v, key, depth + 1);
    } else {
      yield* walkRenderers(v, key, depth + 1);
    }
  }
}

// ===============================================================================
// FIELD HELPERS
// ===============================================================================

/** YouTube renders runs like `{"simpleText": "1.2M views"}` or labeled runs. */
function simpleText(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (isObj(v) && typeof v.simpleText === 'string') return v.simpleText;
  if (isObj(v) && Array.isArray(v.runs)) {
    const runs = v.runs as Json[];
    return runs.map((r) => (typeof r.text === 'string' ? r.text : '')).join('') || undefined;
  }
  return undefined;
}

/** Parse "1.2M views" → 1200000 (best effort). */
export function parseCompactCount(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const match = text.replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return undefined;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(match[2] ?? '').toLowerCase()] ?? 1;
  return Math.round(n * mult);
}

function ownerOf(renderer: Json): NormalizedItem['author'] {
  const ownerText = isObj(renderer.ownerText) ? renderer.ownerText : isObj(renderer.longBylineText) ? renderer.longBylineText : undefined;
  if (!ownerText || !Array.isArray(ownerText.runs)) return undefined;
  const first = (ownerText.runs as Json[])[0];
  if (!first) return undefined;
  const nav = isObj(first.navigationEndpoint) && isObj((first.navigationEndpoint as Json).commandMetadata)
    ? ((((first.navigationEndpoint as Json).commandMetadata as Json).webCommandMetadata as Json)?.url as string | undefined)
    : undefined;
  return {
    name: typeof first.text === 'string' ? first.text : undefined,
    ...(nav ? { url: nav.startsWith('http') ? nav : `https://www.youtube.com${nav}` } : {}),
  };
}

function thumbnailsOf(renderer: Json): string | undefined {
  const t = renderer.thumbnail ?? (isObj(renderer.thumbnailRenderer) ? (renderer.thumbnailRenderer as Json).thumbnail : undefined);
  if (!isObj(t) || !Array.isArray(t.thumbnails)) return undefined;
  const list = t.thumbnails as Json[];
  const best = list.filter((x) => isObj(x) && typeof x.url === 'string').pop();
  const url = best ? (best.url as string) : undefined;
  return url ? (url.startsWith('//') ? `https:${url}` : url) : undefined;
}

function statsOf(renderer: Json): NormalizedStats {
  const stats: NormalizedStats = {};
  const viewsText = simpleText(renderer.viewCountText) ?? simpleText(renderer.shortViewCountText);
  const views = parseCompactCount(viewsText);
  if (views !== undefined) stats.views = views;
  return stats;
}

function normalizeVideoRenderer(renderer: Json, kind: NormalizedItem['kind'], source: string): NormalizedItem | null {
  const videoId = typeof renderer.videoId === 'string' ? renderer.videoId : undefined;
  if (!videoId) return null;
  const title = simpleText(renderer.title) ?? simpleText(renderer.headline) ?? '';
  const badges = Array.isArray(renderer.badges) ? (renderer.badges as Json[]) : [];
  const isLive = badges.some((b) => isObj(b) && isObj(b.metadataBadgeRenderer) && b.metadataBadgeRenderer.style === 'BADGE_STYLE_TYPE_LIVE_NOW')
    || simpleText(renderer.badges)?.includes('LIVE');

  return {
    kind: isLive ? 'live' : kind,
    platform: 'youtube',
    id: videoId,
    title,
    ...(ownerOf(renderer) ? { author: ownerOf(renderer) } : {}),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    ...(thumbnailsOf(renderer) ? { thumbnail: thumbnailsOf(renderer) } : {}),
    ...(simpleText(renderer.lengthText) ? { durationText: simpleText(renderer.lengthText) } : {}),
    ...(simpleText(renderer.publishedTimeText) ? { publishedText: simpleText(renderer.publishedTimeText) } : {}),
    ...(simpleText(renderer.descriptionSnippet) ? { description: simpleText(renderer.descriptionSnippet) } : {}),
    stats: statsOf(renderer),
    source,
  };
}

// ===============================================================================
// SURFACE EXTRACTORS
// ===============================================================================

/**
 * Extract videos from a `browse` response (home feed, trending, channel
 * tabs). Covers videoRenderer, gridVideoRenderer, and shorts shards.
 */
export function extractBrowseVideos(json: Json): NormalizedItem[] {
  const out: NormalizedItem[] = [];
  const seen = new Set<string>();

  for (const r of walkRenderers(json, 'videoRenderer')) {
    const item = normalizeVideoRenderer(r, 'video', 'youtube.browse');
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  for (const r of walkRenderers(json, 'gridVideoRenderer')) {
    const item = normalizeVideoRenderer(r, 'video', 'youtube.browse');
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  for (const r of walkRenderers(json, 'shortsLockupViewModel')) {
    const entityId = typeof r.entityId === 'string' ? r.entityId : undefined;
    const videoId = (() => {
      try {
        const s = JSON.stringify(r.onTap ?? {});
        const m = s.match(/"videoId":"([\w-]{6,20})"/);
        return m?.[1];
      } catch {
        return undefined;
      }
    })();
    if (videoId && !seen.has(videoId)) {
      seen.add(videoId);
      const overlay = isObj(r.overlayMetadata) ? r.overlayMetadata : {};
      out.push({
        kind: 'short',
        platform: 'youtube',
        id: videoId,
        title: simpleText(overlay.primaryText) ?? simpleText(overlay.secondaryText) ?? '',
        url: `https://www.youtube.com/shorts/${videoId}`,
        ...(isObj(r.thumbnail) && Array.isArray((r.thumbnail as Json).thumbnails) ? { thumbnail: thumbnailsOf({ thumbnail: r.thumbnail }) } : {}),
        source: 'youtube.browse',
        ...(entityId ? { extra: { entityId } } : {}),
      });
    }
  }
  return out;
}

/**
 * Extract results from a `search` response.
 */
export function extractSearchResults(json: Json): NormalizedItem[] {
  const out: NormalizedItem[] = [];
  const seen = new Set<string>();
  for (const r of walkRenderers(json, 'videoRenderer')) {
    const item = normalizeVideoRenderer(r, 'video', 'youtube.search');
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  for (const r of walkRenderers(json, 'channelRenderer')) {
    const channelId = typeof r.channelId === 'string' ? r.channelId : undefined;
    if (!channelId || seen.has(channelId)) continue;
    seen.add(channelId);
    out.push({
      kind: 'channel',
      platform: 'youtube',
      id: channelId,
      title: simpleText(r.title) ?? '',
      ...(simpleText(r.subscriberCountText)
        ? { stats: { subscribers: parseCompactCount(simpleText(r.subscriberCountText)) } }
        : {}),
      url: `https://www.youtube.com/channel/${channelId}`,
      ...(thumbnailsOf(r) ? { thumbnail: thumbnailsOf(r) } : {}),
      source: 'youtube.search',
    });
  }
  for (const r of walkRenderers(json, 'playlistRenderer')) {
    const playlistId = typeof r.playlistId === 'string' ? r.playlistId : undefined;
    if (!playlistId || seen.has(playlistId)) continue;
    seen.add(playlistId);
    out.push({
      kind: 'playlist',
      platform: 'youtube',
      id: playlistId,
      title: simpleText(r.title) ?? '',
      url: `https://www.youtube.com/playlist?list=${playlistId}`,
      source: 'youtube.search',
    });
  }
  return out;
}

/**
 * Extract a single video's details from a `player` response.
 */
export function extractPlayerInfo(json: Json): NormalizedItem | null {
  const details = isObj(json.videoDetails) ? (json.videoDetails as Json) : null;
  if (!details) return null;
  const videoId = typeof details.videoId === 'string' ? details.videoId : '';
  return {
    kind: 'video',
    platform: 'youtube',
    id: videoId,
    title: typeof details.title === 'string' ? details.title : '',
    ...(typeof details.author === 'string' ? { author: { name: details.author } } : {}),
    ...(typeof details.channelId === 'string' ? { author: { id: details.channelId, name: typeof details.author === 'string' ? details.author : undefined } } : {}),
    url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : undefined,
    ...(isObj(details.thumbnail) && Array.isArray((details.thumbnail as Json).thumbnails)
      ? { thumbnail: thumbnailsOf({ thumbnail: details.thumbnail }) }
      : {}),
    ...(typeof details.lengthSeconds === 'string' ? { durationText: `${Math.floor(Number(details.lengthSeconds) / 60)}:${String(Number(details.lengthSeconds) % 60).padStart(2, '0')}` } : {}),
    ...(typeof details.shortDescription === 'string' ? { description: details.shortDescription.slice(0, 500) } : {}),
    stats: {
      ...(typeof details.viewCount === 'string' ? { views: Number(details.viewCount) || undefined } : {}),
    },
    source: 'youtube.player',
    ...(isObj(json.playabilityStatus) ? { extra: { playabilityStatus: (json.playabilityStatus as Json).status } } : {}),
  };
}
