/**
 * InnerTube High-Level Endpoints — ScrapeSuite Engine
 *
 * Structured accessors built on top of `innertubeClient.execute()`:
 *
 *   - getTranscript(videoId)      → POST /youtubei/v1/get_transcript
 *   - getComments(videoId)        → POST /youtubei/v1/next  (2-step: watch
 *                                   metadata → comment-section continuation,
 *                                   then continuation → parsed comments)
 *   - getMoreComments(token)      → pagination cursor for getComments
 *
 * get_transcript params are a length-prefixed protobuf message:
 *   field 1 (string): videoId
 *   field 2 (string): "asr" when requesting auto-generated captions
 *   field 3 (string): language code (e.g. "en"); empty = server default
 *   field 5 (string): empty (observed in real browser traffic)
 * serialized then base64-encoded — matching what the web client sends.
 *
 * Comments are parsed from both response generations:
 *   - New: frameworkUpdates.entityBatchUpdate.mutations[].payload
 *     .commentEntityPayload referenced by commentThreadRenderer
 *   - Old: commentThreadRenderer.comment.commentRenderer inline
 */

import { createChildLogger } from '../../utils/logger';
import { innertubeClient } from './innertube-client';
import type { InnertubeRequestOptions, InnertubeResponseKind } from './innertube-client';
import { tripwire } from '../fixture-store';
import { cachedFetch } from '../response-cache';
import { encodeProto, bytesToBase64, type ProtoMessage } from './protobuf';

const logger = createChildLogger('youtube-innertube-endpoints');

// ===============================================================================
// TYPES
// ===============================================================================

export interface TranscriptSegment {
  /** Start time in milliseconds */
  startMs: number;
  /** End time in milliseconds */
  endMs: number;
  /** Human-formatted start time as shown in the UI (e.g. "0:07") */
  startText: string;
  /** Caption text for this segment */
  text: string;
}

export interface TranscriptResult {
  ok: boolean;
  videoId: string;
  /** Language requested ("" = server default) */
  lang: string;
  /** Whether the "asr" (auto-generated) flag was sent */
  asr: boolean;
  segments: TranscriptSegment[];
  /** All segment texts joined with spaces */
  fullText: string;
  /** Segment count (0 when no transcript found) */
  segmentCount: number;
  /** Track names offered by the language menu (from the response footer) */
  availableTracks?: string[];
  error?: string;
  status?: number;
  kind?: InnertubeResponseKind;
  latencyMs?: number;
}

export interface Comment {
  id: string;
  text: string;
  author: string;
  authorChannelId?: string;
  authorAvatarUrl?: string;
  /** Relative publication time as shown in the UI (e.g. "2 days ago") */
  publishedTime?: string;
  /** Parsed numeric like count ("1.2K" → 1200); undefined when absent */
  likeCount?: number;
  /** Raw like-count string as served ("1.2K") */
  likeCountText?: string;
  replyCount?: number;
  /** Comment is pinned by the creator */
  pinned?: boolean;
}

export interface CommentsOptions {
  /** Language code for the transcript ("en", "es", …; "" = server default) */
  lang?: string;
  /** Request auto-generated (ASR) captions */
  asr?: boolean;
  /** Stop once this many comments have been collected (default 20 = one page) */
  maxComments?: number;
  /** Follow the next-page cursor automatically up to maxComments (default false) */
  paginate?: boolean;
  /** Serve from the response cache when a fresh copy exists (default true) */
  cache?: boolean;
  /** Underlying request options (proxy, cookies, timeouts) */
  request?: Partial<Pick<
    InnertubeRequestOptions,
    'proxyUrl' | 'cookies' | 'clientName' | 'clientVersion' | 'visitorData' | 'autoBootstrap' | 'bootstrapData' | 'sapisid' | 'maxAttempts' | 'timeoutMs'
  >>;
}

export interface CommentsResult {
  ok: boolean;
  videoId: string;
  comments: Comment[];
  /** Cursor for the next page — pass to getMoreComments() */
  continuationToken?: string;
  /** True when no more pages exist */
  exhausted: boolean;
  error?: string;
  status?: number;
  kind?: InnertubeResponseKind;
  latencyMs?: number;
}

// ===============================================================================
// PROTOBUF ENCODING (get_transcript params — built on the general toolkit)
// ===============================================================================

/**
 * Encode get_transcript params the way the web client does:
 * protobuf { 1: videoId, 2: "asr"?, 3: lang?, 5: "" } → base64.
 * Kept for diagnostics/offline experimentation: live servers require
 * SERVER-ISSUED params (see getTranscript) — client-built ones are rejected.
 */
export function encodeGetTranscriptParams(videoId: string, lang = '', asr = false): string {
  const message: ProtoMessage = { 1: videoId, 5: '' };
  if (asr) message[2] = 'asr';
  if (lang) message[3] = lang;
  return bytesToBase64(encodeProto(message));
}

// ===============================================================================
// JSON WALKING HELPERS
// ===============================================================================

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Depth-first walk yielding every object whose key is `key` (arrays traversed). */
function* walkByKey(node: unknown, key: string, depth = 0): Generator<Json> {
  if (depth > 50) return;
  if (Array.isArray(node)) {
    for (const item of node) yield* walkByKey(item, key, depth + 1);
    return;
  }
  if (!isObj(node)) return;
  for (const [k, v] of Object.entries(node)) {
    if (k === key && isObj(v)) {
      yield v;
      yield* walkByKey(v, key, depth + 1);
    } else {
      yield* walkByKey(v, key, depth + 1);
    }
  }
}

/** Parse YouTube count strings: "1.2K" → 1200, "3,4M" → 3400000, "87" → 87. */
export function parseCount(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/,/g, '.').trim().toUpperCase();
  const match = cleaned.match(/^([\d.]+)\s*([KM])?$/);
  if (!match) return undefined;
  const value = parseFloat(match[1]!);
  if (Number.isNaN(value)) return undefined;
  const mult = match[2] === 'K' ? 1_000 : match[2] === 'M' ? 1_000_000 : 1;
  return Math.round(value * mult);
}

/** Flatten text runs: { runs: [{ text }] } or { simpleText } → string. */
function extractText(node: unknown): string {
  if (!isObj(node)) return '';
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (typeof node.content === 'string') return node.content;
  if (Array.isArray(node.runs)) {
    return node.runs
      .map((r) => (isObj(r) && typeof r.text === 'string' ? r.text : ''))
      .join('');
  }
  return '';
}

// ===============================================================================
// TRANSCRIPT
// ===============================================================================

export function parseTranscriptSegments(json: Json): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const seg of walkByKey(json, 'transcriptSegmentRenderer')) {
    const startMs = parseInt(String(seg.startTimeMs ?? ''), 10);
    const endMs = parseInt(String(seg.endTimeMs ?? ''), 10);
    const text = extractText(seg.snippet);
    if (Number.isNaN(startMs) || !text) continue;
    const startText =
      isObj(seg.startTimeText) && typeof (seg.startTimeText as Json).simpleText === 'string'
        ? ((seg.startTimeText as Json).simpleText as string)
        : formatMs(startMs);
    segments.push({
      startMs,
      endMs: Number.isNaN(endMs) ? startMs : endMs,
      startText,
      text,
    });
  }
  return segments;
}

function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ===============================================================================
// COMMENTS — token extraction + parsing
// ===============================================================================

/** Pull the comment-section continuation token out of a first `next` response. */
function extractCommentsToken(json: Json): string | undefined {
  // Preferred: itemSectionRenderer with sectionIdentifier "comment-item-section"
  for (const section of walkByKey(json, 'itemSectionRenderer')) {
    if (section.sectionIdentifier !== 'comment-item-section') continue;
    for (const cont of walkByKey(section, 'continuationItemRenderer')) {
      const token = readContinuationToken(cont);
      if (token) return token;
    }
  }
  // Fallback: engagement panel for comments
  for (const panel of walkByKey(json, 'engagementPanelSectionListRenderer')) {
    if (panel.panelIdentifier !== 'engagement-panel-comments-section') continue;
    for (const cont of walkByKey(panel, 'continuationItemRenderer')) {
      const token = readContinuationToken(cont);
      if (token) return token;
    }
  }
  // Last resort: any continuation under a sort/comment header
  for (const cont of walkByKey(json, 'continuationItemRenderer')) {
    const token = readContinuationToken(cont);
    if (token) return token;
  }
  return undefined;
}

function readContinuationToken(cont: Json): string | undefined {
  const endpoint =
    (isObj(cont.continuationEndpoint) && cont.continuationEndpoint) ||
    (isObj(cont.button) && isObj((cont.button as Json).buttonRenderer) &&
      isObj(((cont.button as Json).buttonRenderer as Json).command) &&
      ((cont.button as Json).buttonRenderer as Json).command) ||
    undefined;
  if (!endpoint) return undefined;
  const cmd =
    (isObj(endpoint) && isObj((endpoint as Json).continuationCommand) &&
      ((endpoint as Json).continuationCommand as Json)) ||
    undefined;
  if (cmd && typeof cmd.token === 'string') return cmd.token;
  return undefined;
}

/** Page of comment threads + next cursor from a `next` continuation response. */
export function parseCommentThreads(json: Json): { comments: Comment[]; nextToken?: string } {
  // Entity map from mutations (new format)
  const entities = new Map<string, Json>();
  if (isObj(json.frameworkUpdates)) {
    const batch = (json.frameworkUpdates as Json).entityBatchUpdate;
    if (isObj(batch) && Array.isArray(batch.mutations)) {
      for (const m of batch.mutations) {
        if (!isObj(m) || !isObj(m.payload)) continue;
        const payload = m.payload as Json;
        if (isObj(payload.commentEntityPayload)) {
          const cep = payload.commentEntityPayload as Json;
          if (typeof cep.key === 'string') entities.set(cep.key, cep);
        }
      }
    }
  }

  const comments: Comment[] = [];
  let nextToken: string | undefined;

  const items = collectContinuationItems(json);
  for (const item of items) {
    const thread = isObj(item.commentThreadRenderer) ? (item.commentThreadRenderer as Json) : null;
    if (!thread) {
      if (isObj(item.continuationItemRenderer)) {
        nextToken = nextToken || readContinuationToken(item.continuationItemRenderer as Json);
      }
      continue;
    }

    const comment = parseThread(thread, entities);
    if (comment) comments.push(comment);

    // Replies / continuation live alongside the thread
    if (isObj(item.continuationItemRenderer)) {
      nextToken = nextToken || readContinuationToken(item.continuationItemRenderer as Json);
    }
  }

  return { comments, nextToken };
}

function collectContinuationItems(json: Json): Json[] {
  const out: Json[] = [];
  for (const ep of Array.isArray(json.onResponseReceivedEndpoints)
    ? (json.onResponseReceivedEndpoints as unknown[])
    : []) {
    if (!isObj(ep)) continue;
    for (const key of ['appendContinuationItemsAction', 'reloadContinuationItemsCommand']) {
      const action = isObj(ep[key]) ? (ep[key] as Json) : null;
      if (action && Array.isArray(action.continuationItems)) {
        for (const item of action.continuationItems as unknown[]) {
          if (isObj(item)) out.push(item);
        }
      }
    }
  }
  return out;
}

function parseThread(thread: Json, entities: Map<string, Json>): Comment | undefined {
  // Current format: commentThreadRenderer.commentViewModel.commentViewModel
  //   carries commentKey/commentId directly (no payload wrapper).
  // Legacy format: commentViewModel.commentViewModelPayload.commentKey.
  for (const vm of walkByKey(thread, 'commentViewModel')) {
    const keys = [vm.commentKey, vm.commentViewModelPayload && isObj(vm.commentViewModelPayload)
      ? (vm.commentViewModelPayload as Json).commentKey : undefined];
    for (const key of keys) {
      if (typeof key === 'string' && entities.has(key)) {
        const comment = parseCommentEntity(entities.get(key)!);
        if (comment) {
          if (typeof vm.pinnedText === 'string' && vm.pinnedText) {
            comment.pinned = true;
          }
          return comment;
        }
      }
    }
  }

  // Old format: comment.commentRenderer
  const legacy = isObj(thread.comment) && isObj((thread.comment as Json).commentRenderer)
    ? ((thread.comment as Json).commentRenderer as Json)
    : null;
  if (legacy) return parseLegacyComment(legacy);

  return undefined;
}

function parseCommentEntity(cep: Json): Comment | undefined {
  const props = isObj(cep.properties) ? (cep.properties as Json) : {};
  const author = isObj(cep.author) ? (cep.author as Json) : {};
  const toolbar = isObj(cep.toolbar) ? (cep.toolbar as Json) : {};

  const id =
    (typeof props.commentId === 'string' && props.commentId) ||
    (typeof cep.key === 'string' ? cep.key.replace(/^comment-entity-payload-/, '') : '');
  const text = extractText(props.content);
  if (!id || !text) return undefined;

  const likeCountText =
    (typeof toolbar.likeCountNotliked === 'string' && toolbar.likeCountNotliked) ||
    (typeof toolbar.likeCountLiked === 'string' && toolbar.likeCountLiked) ||
    undefined;

  return {
    id,
    text,
    author: typeof author.displayName === 'string' ? author.displayName : '',
    authorChannelId: typeof author.channelId === 'string' ? author.channelId : undefined,
    authorAvatarUrl: typeof author.avatarThumbnailUrl === 'string' ? author.avatarThumbnailUrl : undefined,
    publishedTime: typeof props.publishedTime === 'string' ? props.publishedTime : undefined,
    likeCountText,
    likeCount: parseCount(likeCountText),
    replyCount: parseCount(typeof toolbar.replyCount === 'string' ? toolbar.replyCount : undefined),
  };
}

function parseLegacyComment(r: Json): Comment | undefined {
  const id = typeof r.commentId === 'string' ? r.commentId : undefined;
  const text = extractText(r.contentText);
  if (!id || !text) return undefined;
  const authorEndpoint = isObj(r.authorEndpoint) ? (r.authorEndpoint as Json) : {};
  const browse = isObj(authorEndpoint.browseEndpoint) ? (authorEndpoint.browseEndpoint as Json) : {};
  const likeText =
    (isObj(r.voteCount) && extractText(r.voteCount)) || undefined;
  return {
    id,
    text,
    author: extractText(r.authorText),
    authorChannelId: typeof browse.canonicalBaseUrl === 'string' ? browse.canonicalBaseUrl : undefined,
    publishedTime: extractText(r.publishedTimeText) || undefined,
    likeCountText: likeText,
    likeCount: parseCount(likeText),
    replyCount: undefined,
  };
}

/**
 * Pull the server-issued get_transcript params out of a `next` metadata
 * response. The web client never builds these client-side — the watch
 * metadata's transcript engagement panel carries a getTranscriptEndpoint
 * with a params token bound to the video/session. Client-built protobufs
 * are rejected with "Precondition check failed".
 */
export function extractTranscriptParams(metadata: Json): string | undefined {
  for (const ep of walkByKey(metadata, 'getTranscriptEndpoint')) {
    if (typeof ep.params === 'string' && ep.params.length > 0) return ep.params;
  }
  return undefined;
}

/** Harvest responseContext.visitorData (a real session value) from any response. */
export function extractVisitorData(json: Json): string | undefined {
  const rc = isObj(json.responseContext) ? (json.responseContext as Json) : undefined;
  if (rc && typeof rc.visitorData === 'string') return rc.visitorData;
  return undefined;
}

/** Language-track menu from a get_transcript response footer. */
function parseLanguageMenu(json: Json): Array<{ name: string; params: string }> {
  const tracks: Array<{ name: string; params: string }> = [];
  for (const menu of walkByKey(json, 'menuRenderer')) {
    const items = Array.isArray(menu.items) ? menu.items : [];
    for (const item of items) {
      if (!isObj(item) || !isObj(item.menuServiceItemRenderer)) continue;
      const misr = item.menuServiceItemRenderer as Json;
      const name = extractText(misr.text);
      const tap = isObj(misr.onTap) ? (misr.onTap as Json) : {};
      const ep = walkByKey(tap, 'getTranscriptEndpoint').next();
      const params = ep.done ? undefined : (ep.value as Json).params;
      if (name && typeof params === 'string') tracks.push({ name, params });
    }
  }
  return tracks;
}

// ===============================================================================
// ENDPOINT ACCESSORS
// ===============================================================================

function describe(resp: { status: number; kind: InnertubeResponseKind; latencyMs: number; error?: string }) {
  return { status: resp.status, kind: resp.kind, latencyMs: resp.latencyMs, error: resp.error };
}

/**
 * Fetch a video transcript via the InnerTube `get_transcript` endpoint.
 *
 * Browser-accurate two-step flow:
 *   1. `next` (videoId) → watch metadata → server-issued params from the
 *      transcript engagement panel's getTranscriptEndpoint
 *   2. `get_transcript` with those params (+ session visitorData harvested
 *      from the same metadata response)
 *
 * A client-built params protobuf is NOT accepted by the server
 * ("Precondition check failed"), so `lang`/`asr` can only select among the
 * tracks the server offered: when `lang` is set and the response's language
 * menu contains a matching track, a follow-up get_transcript call fetches it.
 */
export async function getTranscript(
  videoId: string,
  options: Pick<CommentsOptions, 'lang' | 'asr' | 'request' | 'cache'> = {},
): Promise<TranscriptResult> {
  const useCache = options.cache !== false;
  if (!useCache) return getTranscriptUncached(videoId, options);
  const { value } = await cachedFetch<TranscriptResult>({
    surface: 'youtube.transcript',
    key: JSON.stringify({ v: videoId, l: options.lang ?? '', a: options.asr ?? false }),
    producer: () => getTranscriptUncached(videoId, options),
    shouldCache: (r) => r.ok === true,
  });
  return value;
}

async function getTranscriptUncached(
  videoId: string,
  options: Pick<CommentsOptions, 'lang' | 'asr' | 'request'> = {},
): Promise<TranscriptResult> {
  const lang = options.lang ?? '';

  // ---- Step 1: metadata → server params + session visitorData ----------------
  const metadata = await innertubeClient.execute({
    endpoint: 'next',
    body: { videoId },
    ...options.request,
  });

  const base = {
    videoId,
    lang,
    asr: options.asr ?? false,
  };

  if (!metadata.ok || !metadata.json) {
    logger.warn({ videoId, kind: metadata.kind }, 'transcript metadata next failed');
    return {
      ok: false,
      segments: [],
      fullText: '',
      segmentCount: 0,
      ...describe(metadata),
      error: metadata.error || `next metadata ${metadata.kind}`,
      ...base,
    };
  }

  const params = extractTranscriptParams(metadata.json);
  if (!params) {
    return {
      ok: false,
      segments: [],
      fullText: '',
      segmentCount: 0,
      error: 'no getTranscriptEndpoint in watch metadata (video may have no captions)',
      status: metadata.status,
      kind: metadata.kind,
      latencyMs: metadata.latencyMs,
      ...base,
    };
  }

  const visitorData = extractVisitorData(metadata.json) || undefined;
  let latency = metadata.latencyMs;

  // ---- Step 2: get_transcript with server params ------------------------------
  const exec = (p: string) =>
    innertubeClient.execute({
      endpoint: 'get_transcript',
      body: { params: p },
      visitorData,
      ...options.request,
    });

  let resp = await exec(params);
  latency += resp.latencyMs;

  const baseWithMeta = {
    ...base,
    status: resp.status,
    kind: resp.kind as InnertubeResponseKind,
    latencyMs: latency,
  };

  if (!resp.ok || !resp.json) {
    logger.warn({ videoId, kind: resp.kind, status: resp.status }, 'get_transcript failed');
    return { ok: false, segments: [], fullText: '', segmentCount: 0, error: resp.error || `get_transcript ${resp.kind}`, ...baseWithMeta };
  }

  const tracks = parseLanguageMenu(resp.json);

  // ---- Optional step 3: requested track differs → follow the language menu ----
  let segments = parseTranscriptSegments(resp.json);
  if (segments.length === 0 && lang && tracks.length > 0) {
    const match = tracks.find((t) => t.name.toLowerCase().includes(lang.toLowerCase()));
    if (match) {
      resp = await exec(match.params);
      latency += resp.latencyMs;
      if (resp.ok && resp.json) segments = parseTranscriptSegments(resp.json);
    }
  }

  if (segments.length === 0) {
    return {
      ok: false,
      segments: [],
      fullText: '',
      segmentCount: 0,
      availableTracks: tracks.map((t) => t.name),
      error: 'no transcriptSegmentRenderer in response (video may have no captions for this track)',
      ...baseWithMeta,
      latencyMs: latency,
    };
  }

  logger.info({ videoId, segments: segments.length }, 'get_transcript parsed');
  return {
    ok: true,
    segments,
    fullText: segments.map((s) => s.text).join(' '),
    segmentCount: segments.length,
    availableTracks: tracks.length > 0 ? tracks.map((t) => t.name) : undefined,
    ...baseWithMeta,
    latencyMs: latency,
  };
}

/**
 * Fetch the first page(s) of comments via the InnerTube `next` endpoint.
 * Step 1 resolves the comment-section continuation from watch metadata;
 * step 2 exchanges it for parsed comment threads.
 */
export async function getComments(
  videoId: string,
  options: CommentsOptions = {},
): Promise<CommentsResult> {
  const useCache = options.cache !== false;
  if (!useCache) return getCommentsUncached(videoId, options);
  const { value } = await cachedFetch<CommentsResult>({
    surface: 'youtube.comments',
    key: JSON.stringify({ v: videoId, m: options.maxComments ?? 20, p: !!options.paginate, l: options.lang ?? '' }),
    producer: () => getCommentsUncached(videoId, options),
    shouldCache: (r) => r.ok === true,
  });
  return value;
}

async function getCommentsUncached(
  videoId: string,
  options: CommentsOptions = {},
): Promise<CommentsResult> {
  const maxComments = options.maxComments ?? 20;

  // ---- Step 1: watch metadata → comment continuation token -------------------
  const first = await innertubeClient.execute({
    endpoint: 'next',
    body: { videoId },
    ...options.request,
  });

  const base = {
    videoId,
    status: first.status,
    kind: first.kind as InnertubeResponseKind,
    latencyMs: first.latencyMs,
  };

  if (!first.ok || !first.json) {
    logger.warn({ videoId, kind: first.kind }, 'next (metadata) failed');
    return { ok: false, comments: [], exhausted: true, error: first.error || `next metadata ${first.kind}`, ...base };
  }

  const token = extractCommentsToken(first.json);
  if (!token) {
    // Zero-result tripwire: metadata arrived but no comment section found —
    // comments-disabled videos are normal, a SHAPE BREAK is not. Save the
    // payload so the difference is diagnosable offline.
    await tripwire({
      surface: 'youtube.next',
      payload: JSON.stringify(first.json),
      parsed: null,
      isEmpty: () => true,
      url: `youtube:watch/${videoId}#comments-token`,
      meta: { stage: 'token-extraction', videoId },
    });
    return {
      ok: false,
      comments: [],
      exhausted: true,
      error: 'comments disabled or no comment-item-section continuation in next response',
      ...base,
    };
  }

  // ---- Step 2+: exchange token(s) for comment pages ---------------------------
  const comments: Comment[] = [];
  let cursor: string | undefined = token;
  let lastStatus = first.status;
  let lastKind = first.kind;
  let lastLatency = first.latencyMs;
  let exhausted = false;

  for (let page = 0; cursor && comments.length < maxComments && page < 20; page++) {
    const pageResp = await innertubeClient.execute({
      endpoint: 'next',
      body: { continuation: cursor },
      ...options.request,
    });
    lastStatus = pageResp.status;
    lastKind = pageResp.kind;
    lastLatency += pageResp.latencyMs;

    if (!pageResp.ok || !pageResp.json) {
      if (comments.length === 0) {
        return { ok: false, videoId, comments: [], exhausted: true, error: pageResp.error || `next continuation ${pageResp.kind}`, status: lastStatus, kind: lastKind, latencyMs: lastLatency };
      }
      break;
    }

    const { comments: pageComments, nextToken } = parseCommentThreads(pageResp.json);
    if (pageComments.length === 0 && page === 0) {
      // Zero-result tripwire on the first page — the silent-killer guard.
      await tripwire({
        surface: 'youtube.next',
        payload: JSON.stringify(pageResp.json),
        parsed: pageComments,
        isEmpty: (c) => !c || c.length === 0,
        url: `youtube:watch/${videoId}#comments-page-0`,
        meta: { stage: 'thread-parse', videoId },
      });
    }
    comments.push(...pageComments);
    cursor = nextToken;
    if (!nextToken || pageComments.length === 0) {
      exhausted = true;
      break;
    }
    if (!options.paginate) break; // one page unless pagination requested
  }

  logger.info({ videoId, count: comments.length, exhausted }, 'getComments parsed');
  return {
    ok: comments.length > 0,
    videoId,
    comments: comments.slice(0, maxComments),
    continuationToken: exhausted ? undefined : cursor,
    exhausted,
    status: lastStatus,
    kind: lastKind,
    latencyMs: lastLatency,
  };
}

/**
 * Fetch the next page of comments using a cursor from getComments().
 */
export async function getMoreComments(
  continuationToken: string,
  videoId = '',
  options: Pick<CommentsOptions, 'maxComments' | 'request'> = {},
): Promise<CommentsResult> {
  const maxComments = options.maxComments ?? 20;
  const resp = await innertubeClient.execute({
    endpoint: 'next',
    body: { continuation: continuationToken },
    ...options.request,
  });

  const base = {
    videoId,
    status: resp.status,
    kind: resp.kind as InnertubeResponseKind,
    latencyMs: resp.latencyMs,
  };

  if (!resp.ok || !resp.json) {
    return { ok: false, comments: [], exhausted: true, error: resp.error || `next ${resp.kind}`, ...base };
  }

  const { comments, nextToken } = parseCommentThreads(resp.json);
  const exhausted = !nextToken || comments.length === 0;
  return {
    ok: comments.length > 0,
    comments: comments.slice(0, maxComments),
    continuationToken: exhausted ? undefined : nextToken,
    exhausted,
    ...base,
  };
}
