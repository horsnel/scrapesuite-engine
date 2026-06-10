/**
 * Network Capture Types -- ScrapeSuite Engine
 *
 * Type definitions for the XHR/Fetch Response Capture module.
 * Captures background network requests in browser sessions for
 * API interception scraping.
 */

export interface CaptureFilter {
  urlPatterns?: string[];
  methods?: string[];
  contentTypes?: string[];
  minBodySize?: number;
  maxBodySize?: number;
  statusCodes?: Array<number | string>;
  requiredHeaders?: string[];
  excludeUrlPatterns?: string[];
  xhrOnly?: boolean;
  captureRequestBodies?: boolean;
  captureHeaders?: boolean;
  deduplicate?: boolean;
}

export interface CapturedResponse {
  id: string;
  captureSessionId: string;
  url: string;
  method: string;
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  contentType: string;
  body: string | null;
  bodyJson: unknown | null;
  bodyTruncated: boolean;
  bodySizeBytes: number;
  requestHeaders?: Record<string, string>;
  requestBody?: string | null;
  requestBodyJson?: unknown | null;
  resourceType: string;
  requestTimestamp: number;
  responseTimestamp: number;
  durationMs: number;
  bodyHash: string;
  isDuplicate: boolean;
}

export interface StartCaptureOptions {
  userId?: string;
  filters?: CaptureFilter;
  maxCaptures?: number;
  maxDurationMs?: number;
  stopOnPattern?: string;
  stopAfterN?: number;
  persistToRedis?: boolean;
  tags?: string[];
}

export interface CaptureSession {
  id: string;
  userId: string;
  config: StartCaptureOptions;
  status: 'starting' | 'active' | 'paused' | 'stopped' | 'error';
  captures: CapturedResponse[];
  startedAt: number;
  stoppedAt: number | null;
  totalRequests: number;
  totalCaptured: number;
  totalFiltered: number;
  totalDeduplicated: number;
  totalBytes: number;
  error?: string;
  seenHashes: Set<string>;
  detachListener?: () => void;
}

export interface CaptureSessionInfo {
  captureSessionId: string;
  status: string;
  startedAt: string;
  filters: CaptureFilter;
  totalCaptured: number;
  totalFiltered: number;
  totalDeduplicated: number;
  maxCaptures: number;
  maxDurationMs: number;
}

export interface CaptureQueryOptions {
  urlPattern?: string;
  method?: string;
  statusCode?: number;
  contentType?: string;
  jsonOnly?: boolean;
  uniqueOnly?: boolean;
  sortBy?: 'timestamp' | 'size' | 'duration';
  sortOrder?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
}

export interface CaptureStats {
  totalSessions: number;
  activeSessions: number;
  totalCaptures: number;
  totalBytes: number;
  avgCapturesPerSession: number;
}
