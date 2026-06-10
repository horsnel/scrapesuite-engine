export type ScrollStrategy = 'smooth' | 'jump' | 'human-like';
export type TerminationCondition = 'no-new-content' | 'max-scrolls' | 'max-duration' | 'selector-appears' | 'element-count' | 'manual';
export type ExtractionStrategy = 'selector' | 'xpath' | 'custom-function';

export interface ExtractionField { name: string; selector?: string; attribute?: string; extractType: 'text' | 'html' | 'attribute' | 'href' | 'src'; transform?: 'trim' | 'number' | 'url' | 'lowercase' | 'uppercase' | 'regex' | 'none'; regexPattern?: string; defaultValue?: unknown; }

export interface ExtractionConfig { strategy: ExtractionStrategy; selector?: string; xpath?: string; customFunction?: string; fields?: ExtractionField[]; deduplicate?: boolean; deduplicateKey?: string; maxItems?: number; }

export interface ScrollConfig {
  strategy?: ScrollStrategy; scrollAmount?: number; waitBetweenScrolls?: number; maxScrolls?: number; maxDurationMs?: number;
  stabilizationWaitMs?: number; stabilizationThreshold?: number; terminationCondition?: TerminationCondition;
  targetSelector?: string; targetElementCount?: number; scrollContainerSelector?: string;
  behaviorProfile?: 'fast' | 'normal' | 'careful' | 'researcher'; scrollJitterPercent?: number;
  occasionalScrollUp?: boolean; scrollUpProbability?: number; maxUpScrollPixels?: number;
  readingPauses?: boolean; readingPauseProbability?: number; minReadingPauseMs?: number; maxReadingPauseMs?: number;
}

export interface ScrollSession {
  id: string; userId: string; status: 'starting' | 'scrolling' | 'extracting' | 'paused' | 'completed' | 'error';
  config: ScrollConfig; extractionConfig?: ExtractionConfig; startedAt: number; completedAt: number | null;
  scrollCount: number; totalScrollDistance: number; domHeightStart: number; domHeightEnd: number;
  domHeightHistory: number[]; extractedItems: unknown[]; totalExtracted: number; duplicateCount: number;
  terminationReason: string; error?: string; lastKnownHeight: number; stabilizationCount: number;
  seenItemKeys: Set<string>; abortController?: AbortController;
}

export interface ScrollResult {
  sessionId: string; status: string; scrollCount: number; totalScrollDistance: number;
  totalExtracted: number; duplicateCount: number; durationMs: number;
  domHeightChange: { start: number; end: number; change: number; changePercent: number };
  extractedItems: unknown[]; terminationReason: string;
  domHeightHistory: Array<{ scrollNumber: number; height: number }>;
}

export interface ScrollSessionInfo { id: string; status: string; scrollCount: number; totalExtracted: number; startedAt: string; completedAt: string | null; terminationReason: string; }

export interface ScrollHandlerStats { totalSessions: number; activeSessions: number; totalScrolls: number; totalItemsExtracted: number; avgScrollsPerSession: number; avgItemsPerSession: number; }
