// --- ScrapeSuite Compliance Framework -----------------------------------------
// GDPR, CCPA, and ethical scraping controls for enterprise customers.
// Provides PII detection/redaction, data retention, audit logging,
// robots.txt enhanced compliance, legal hold, and consent management.
// ------------------------------------------------------------------------------

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet, redis } from '../utils/redis';
import { db } from '../utils/db';
import { robotsParser } from '../robots/parser';
import * as crypto from 'crypto';

const logger = createChildLogger('compliance');

// --- Enums --------------------------------------------------------------------

export enum RedactionStrategy {
  MASK = 'mask',
  HASH = 'hash',
  REMOVE = 'remove',
  REDACTED = 'redacted',
}

export enum PIICategory {
  EMAIL = 'email',
  PHONE = 'phone',
  SSN = 'ssn',
  CREDIT_CARD = 'credit_card',
  IP_ADDRESS = 'ip_address',
  PASSPORT = 'passport',
  DRIVERS_LICENSE = 'drivers_license',
  CUSTOM = 'custom',
}

export enum DataSubjectRequestType {
  ACCESS = 'access',
  ERASURE = 'erasure',
  PORTABILITY = 'portability',
  RECTIFICATION = 'rectification',
  OBJECTION = 'objection',
}

export enum CCPARequestType {
  KNOW = 'know',
  DELETE = 'delete',
  OPT_OUT_SALE = 'opt_out_sale',
  NON_DISCRIMINATION = 'non_discrimination',
}

export enum AuditEventType {
  SCRAPE_REQUEST = 'scrape_request',
  PII_DETECTED = 'pii_detected',
  PII_REDACTED = 'pii_redacted',
  DATA_SUBJECT_REQUEST = 'data_subject_request',
  CCPA_REQUEST = 'ccpa_request',
  DATA_DELETED = 'data_deleted',
  DATA_EXPORTED = 'data_exported',
  RETENTION_EXPIRED = 'retention_expired',
  LEGAL_HOLD_APPLIED = 'legal_hold_applied',
  LEGAL_HOLD_RELEASED = 'legal_hold_released',
  ROBOTS_OVERRIDE = 'robots_override',
  CONSENT_BANNER_DETECTED = 'consent_banner_detected',
  CRAWL_DELAY_ENFORCED = 'crawl_delay_enforced',
  DATA_MINIMIZATION_APPLIED = 'data_minimization_applied',
}

// --- Interfaces ---------------------------------------------------------------

export interface PIIPattern {
  category: PIICategory;
  pattern: RegExp;
  name: string;
  description: string;
  confidence: number; // 0-1
}

export interface PIIDetectionResult {
  category: PIICategory;
  match: string;
  startIndex: number;
  endIndex: number;
  confidence: number;
  redacted: string;
  strategy: RedactionStrategy;
}

export interface RedactionRule {
  category: PIICategory;
  strategy: RedactionStrategy;
  enabled: boolean;
  maskChar?: string;
  maskKeepPrefix?: number;
  maskKeepSuffix?: number;
  replacementText?: string;
}

export interface RedactionConfig {
  rules: RedactionRule[];
  defaultStrategy: RedactionStrategy;
  customPatterns: PIIPattern[];
  enabledCategories: PIICategory[];
}

export interface DataRetentionPolicy {
  id: string;
  name: string;
  description: string;
  retentionDays: number;
  autoDelete: boolean;
  appliesTo: string[]; // URL patterns or domain patterns
  createdAt: Date;
  updatedAt: Date;
}

export interface ConsentBannerResult {
  detected: boolean;
  bannerType: string | null;
  consentOptions: string[];
  recommendedAction: string;
  url: string;
}

export interface DataSubjectRequest {
  id: string;
  type: DataSubjectRequestType;
  subjectIdentifier: string; // email, user ID, etc.
  requestorEmail: string;
  requestDate: Date;
  deadline: Date;
  status: 'pending' | 'in_progress' | 'completed' | 'denied';
  denialReason?: string;
  completedDate?: Date;
  notes: string[];
  dataCollected: ScrapeDataRecord[];
}

export interface CCPARequest {
  id: string;
  type: CCPARequestType;
  consumerIdentifier: string;
  requestDate: Date;
  deadline: Date; // 45 days from request
  status: 'pending' | 'in_progress' | 'completed' | 'denied';
  doNotSell: boolean;
  categoriesCollected: PIICategory[];
  sources: string[];
  notes: string[];
  completedDate?: Date;
  extensionDays?: number; // up to 45 additional days
}

export interface ConsumerDataCatalogEntry {
  id: string;
  consumerIdentifier: string;
  piiCategory: PIICategory;
  dataPoint: string;
  source: string;
  collectedAt: Date;
  doNotSell: boolean;
  legalHold: boolean;
  retentionPolicyId: string | null;
}

export interface ScrapeDataRecord {
  id: string;
  url: string;
  domain: string;
  scrapedAt: Date;
  scrapedBy: string;
  dataFields: Record<string, any>;
  piiDetected: PIIDetectionResult[];
  piiRedacted: boolean;
  consentBanner: ConsentBannerResult | null;
  retentionPolicyId: string | null;
  legalHoldIds: string[];
  doNotSell: boolean;
  deletedAt: Date | null;
}

export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  eventType: AuditEventType;
  userId: string;
  url?: string;
  domain?: string;
  details: Record<string, any>;
  piiFound: boolean;
  piiRedacted: boolean;
  previousHash: string;
  currentHash: string;
}

export interface AuditLogQuery {
  startDate?: Date;
  endDate?: Date;
  userId?: string;
  domain?: string;
  eventType?: AuditEventType;
  piiFound?: boolean;
  limit?: number;
  offset?: number;
}

export interface RobotsComplianceResult {
  url: string;
  allowed: boolean;
  crawlDelay: number | null;
  sitemaps: string[];
  overrideLogged: boolean;
  disallowedPaths: string[];
}

export interface LegalHold {
  id: string;
  caseId: string;
  requestor: string;
  requestorEmail: string;
  appliedAt: Date;
  releasedAt: Date | null;
  reason: string;
  scope: {
    dataRecordIds?: string[];
    urls?: string[];
    domains?: string[];
    consumerIdentifiers?: string[];
  };
  active: boolean;
  metadata: Record<string, any>;
}

export interface ComplianceConfig {
  redaction: RedactionConfig;
  defaultRetentionDays: number;
  respectRobotsTxt: boolean;
  logRobotsOverrides: boolean;
  enableConsentDetection: boolean;
  gdprEnabled: boolean;
  ccpaEnabled: boolean;
  auditLogEnabled: boolean;
  retentionCheckIntervalMs: number;
}

// --- Default PII Patterns -----------------------------------------------------

const DEFAULT_PII_PATTERNS: PIIPattern[] = [
  {
    category: PIICategory.EMAIL,
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    name: 'Email Address',
    description: 'Standard email address format',
    confidence: 0.95,
  },
  {
    category: PIICategory.PHONE,
    pattern: /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g,
    name: 'US Phone Number',
    description: 'US phone number in various formats',
    confidence: 0.85,
  },
  {
    category: PIICategory.SSN,
    pattern: /\b(?!000|666|9\d{2})\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b/g,
    name: 'Social Security Number',
    description: 'US Social Security Number',
    confidence: 0.9,
  },
  {
    category: PIICategory.CREDIT_CARD,
    pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
    name: 'Credit Card Number',
    description: 'Visa, MasterCard, Amex, Discover card numbers',
    confidence: 0.9,
  },
  {
    category: PIICategory.IP_ADDRESS,
    pattern: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
    name: 'IPv4 Address',
    description: 'IPv4 addresses',
    confidence: 0.8,
  },
  {
    category: PIICategory.PASSPORT,
    pattern: /\b[A-Z]{1,2}[0-9]{6,9}\b/g,
    name: 'Passport Number',
    description: 'Passport number format (US and common international)',
    confidence: 0.7,
  },
  {
    category: PIICategory.DRIVERS_LICENSE,
    pattern: /\b[A-Z]{1,2}[- ]?[0-9]{3,8}[- ]?[0-9]{0,5}\b/g,
    name: "Driver's License Number",
    description: "US Driver's License number patterns",
    confidence: 0.65,
  },
];

const DEFAULT_REDACTION_RULES: RedactionRule[] = [
  { category: PIICategory.EMAIL, strategy: RedactionStrategy.MASK, enabled: true, maskChar: '*', maskKeepPrefix: 2, maskKeepSuffix: 4 },
  { category: PIICategory.PHONE, strategy: RedactionStrategy.REDACTED, enabled: true, replacementText: '[PHONE REDACTED]' },
  { category: PIICategory.SSN, strategy: RedactionStrategy.MASK, enabled: true, maskChar: '*', maskKeepPrefix: 0, maskKeepSuffix: 4 },
  { category: PIICategory.CREDIT_CARD, strategy: RedactionStrategy.MASK, enabled: true, maskChar: '*', maskKeepPrefix: 0, maskKeepSuffix: 4 },
  { category: PIICategory.IP_ADDRESS, strategy: RedactionStrategy.MASK, enabled: true, maskChar: '*', maskKeepPrefix: 0, maskKeepSuffix: 0 },
  { category: PIICategory.PASSPORT, strategy: RedactionStrategy.REDACTED, enabled: true, replacementText: '[PASSPORT REDACTED]' },
  { category: PIICategory.DRIVERS_LICENSE, strategy: RedactionStrategy.REDACTED, enabled: true, replacementText: "[DL REDACTED]" },
];

// --- PII Detection & Redaction Engine -----------------------------------------

export class PIIDetectionEngine {
  private patterns: PIIPattern[] = [];
  private redactionRules: Map<PIICategory, RedactionRule> = new Map();
  private defaultStrategy: RedactionStrategy;
  private enabledCategories: Set<PIICategory>;

  constructor(config: RedactionConfig) {
    this.defaultStrategy = config.defaultStrategy || RedactionStrategy.REDACTED;
    this.enabledCategories = new Set(config.enabledCategories || Object.values(PIICategory));

    // Load built-in patterns
    this.patterns = [...DEFAULT_PII_PATTERNS];

    // Load custom patterns
    if (config.customPatterns?.length) {
      this.patterns.push(...config.customPatterns);
    }

    // Build redaction rule map
    const rules = config.rules?.length ? config.rules : DEFAULT_REDACTION_RULES;
    for (const rule of rules) {
      this.redactionRules.set(rule.category, rule);
    }
  }

  /**
   * Detect all PII in a given text string.
   */
  detectPII(text: string): PIIDetectionResult[] {
    const results: PIIDetectionResult[] = [];

    for (const pattern of this.patterns) {
      if (!this.enabledCategories.has(pattern.category)) continue;

      // Reset regex state for patterns with global flag
      const regex = new RegExp(pattern.pattern.source, pattern.pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        const matchedText = match[0];
        const rule = this.redactionRules.get(pattern.category);
        const strategy = rule?.enabled ? rule.strategy : this.defaultStrategy;

        results.push({
          category: pattern.category,
          match: matchedText,
          startIndex: match.index,
          endIndex: match.index + matchedText.length,
          confidence: pattern.confidence,
          redacted: this.applyRedaction(matchedText, pattern.category, rule),
          strategy,
        });
      }
    }

    // Sort by start index for positional processing
    results.sort((a, b) => a.startIndex - b.startIndex);
    return results;
  }

  /**
   * Redact all PII in a given text string, returning the redacted text.
   */
  redactText(text: string): { redactedText: string; detections: PIIDetectionResult[] } {
    const detections = this.detectPII(text);

    if (detections.length === 0) {
      return { redactedText: text, detections };
    }

    // Process from end to start to preserve indices
    let redactedText = text;
    for (let i = detections.length - 1; i >= 0; i--) {
      const det = detections[i];
      redactedText =
        redactedText.slice(0, det.startIndex) + det.redacted + redactedText.slice(det.endIndex);
    }

    return { redactedText, detections };
  }

  /**
   * Redact PII in a structured data object (deep scan).
   */
  redactObject<T extends Record<string, any>>(obj: T): { data: T; detections: PIIDetectionResult[] } {
    const allDetections: PIIDetectionResult[] = [];
    const result = this.deepRedact(obj, allDetections) as T;
    return { data: result, detections: allDetections };
  }

  /**
   * Add a custom PII pattern at runtime.
   */
  addCustomPattern(pattern: PIIPattern): void {
    this.patterns.push({ ...pattern, category: PIICategory.CUSTOM });
    logger.info({ name: pattern.name }, 'Custom PII pattern added');
  }

  /**
   * Remove a PII category from detection.
   */
  disableCategory(category: PIICategory): void {
    this.enabledCategories.delete(category);
    logger.info({ category }, 'PII category disabled');
  }

  /**
   * Enable a PII category for detection.
   */
  enableCategory(category: PIICategory): void {
    this.enabledCategories.add(category);
    logger.info({ category }, 'PII category enabled');
  }

  /**
   * Update redaction rule for a specific PII category.
   */
  updateRedactionRule(category: PIICategory, rule: Partial<RedactionRule>): void {
    const existing = this.redactionRules.get(category);
    if (existing) {
      this.redactionRules.set(category, { ...existing, ...rule });
    } else {
      this.redactionRules.set(category, {
        category,
        strategy: rule.strategy || this.defaultStrategy,
        enabled: rule.enabled ?? true,
        ...rule,
      });
    }
    logger.info({ category, strategy: rule.strategy }, 'Redaction rule updated');
  }

  /**
   * Get all active patterns.
   */
  getPatterns(): PIIPattern[] {
    return [...this.patterns];
  }

  /**
   * Get all redaction rules.
   */
  getRedactionRules(): RedactionRule[] {
    return Array.from(this.redactionRules.values());
  }

  // --- Private Helpers ------------------------------------------------------

  private applyRedaction(text: string, category: PIICategory, rule?: RedactionRule): string {
    const strategy = rule?.enabled ? rule.strategy : this.defaultStrategy;

    switch (strategy) {
      case RedactionStrategy.MASK: {
        const maskChar = rule?.maskChar || '*';
        const keepPrefix = rule?.maskKeepPrefix ?? 0;
        const keepSuffix = rule?.maskKeepSuffix ?? 0;
        const maskableLength = Math.max(0, text.length - keepPrefix - keepSuffix);
        const masked =
          text.slice(0, keepPrefix) +
          maskChar.repeat(maskableLength) +
          text.slice(text.length - keepSuffix);
        return masked;
      }

      case RedactionStrategy.HASH: {
        return 'SHA256:' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
      }

      case RedactionStrategy.REMOVE: {
        return '';
      }

      case RedactionStrategy.REDACTED: {
        const label = rule?.replacementText || `[${category.toUpperCase()} REDACTED]`;
        return label;
      }

      default:
        return '[REDACTED]';
    }
  }

  private deepRedact(obj: any, detections: PIIDetectionResult[]): any {
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'string') {
      const { redactedText, detections: dets } = this.redactText(obj);
      detections.push(...dets);
      return redactedText;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.deepRedact(item, detections));
    }

    if (typeof obj === 'object') {
      const result: Record<string, any> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.deepRedact(value, detections);
      }
      return result;
    }

    return obj;
  }
}

// --- GDPR Compliance Manager --------------------------------------------------

export class GDPRComplianceManager {
  private piiEngine: PIIDetectionEngine;
  private retentionPolicies: Map<string, DataRetentionPolicy> = new Map();
  private dataSubjectRequests: Map<string, DataSubjectRequest> = new Map();
  private consentBannerPatterns: RegExp[];
  private defaultRetentionDays: number;

  constructor(piiEngine: PIIDetectionEngine, defaultRetentionDays: number = 90) {
    this.piiEngine = piiEngine;
    this.defaultRetentionDays = defaultRetentionDays;

    // Common consent banner detection patterns
    this.consentBannerPatterns = [
      /cookie(?:\s|-)?consent/i,
      /gdpr(?:\s|-)?banner/i,
      /privacy(?:\s|-)?notice/i,
      /consent(?:\s|-)?modal/i,
      /ccpa(?:\s|-)?notice/i,
      /accept(?:\s|-)?cookies/i,
      /cookie(?:\s|-)?policy/i,
      /do(?:\s|-)?not(?:\s|-)?sell/i,
      /we(?:\s)?use(?:\s)?cookies/i,
      /this(?:\s)?site(?:\s)?uses(?:\s)?cookies/i,
    ];

    this.loadRetentionPolicy();
    this.startRetentionEnforcement();
  }

  /**
   * Process a data subject access request (GDPR Article 15).
   * Returns all data associated with the given subject identifier.
   */
  async processDataAccessRequest(
    subjectIdentifier: string,
    requestorEmail: string,
  ): Promise<DataSubjectRequest> {
    const requestId = `dsr-${crypto.randomUUID()}`;
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 30); // GDPR: 30 days

    const request: DataSubjectRequest = {
      id: requestId,
      type: DataSubjectRequestType.ACCESS,
      subjectIdentifier,
      requestorEmail,
      requestDate: new Date(),
      deadline,
      status: 'in_progress',
      notes: [`Access request received from ${requestorEmail}`],
      dataCollected: [],
    };

    try {
      // Search for all data records associated with this subject
      const records = await this.findDataBySubject(subjectIdentifier);
      request.dataCollected = records;

      // Also check Redis cache for any cached PII
      const cachedData = await this.findCachedDataBySubject(subjectIdentifier);
      if (cachedData) {
        request.notes.push(`Found cached data in ${cachedData} cache entries`);
      }

      request.status = 'completed';
      request.completedDate = new Date();
      request.notes.push(`Found ${records.length} data records`);

      logger.info({
        requestId,
        subjectIdentifier,
        recordsFound: records.length,
      }, 'GDPR data access request completed');
    } catch (error: any) {
      request.status = 'pending';
      request.notes.push(`Error processing request: ${error.message}`);
      logger.error({ requestId, error: error.message }, 'Failed to process data access request');
    }

    this.dataSubjectRequests.set(requestId, request);

    // Persist to database
    await this.persistDataSubjectRequest(request);

    return request;
  }

  /**
   * Process a right-to-erasure request (GDPR Article 17).
   * Deletes all data associated with the given subject identifier.
   */
  async processErasureRequest(
    subjectIdentifier: string,
    requestorEmail: string,
  ): Promise<DataSubjectRequest> {
    const requestId = `dsr-${crypto.randomUUID()}`;
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 30);

    const request: DataSubjectRequest = {
      id: requestId,
      type: DataSubjectRequestType.ERASURE,
      subjectIdentifier,
      requestorEmail,
      requestDate: new Date(),
      deadline,
      status: 'in_progress',
      notes: [`Erasure request received from ${requestorEmail}`],
      dataCollected: [],
    };

    try {
      const records = await this.findDataBySubject(subjectIdentifier);
      request.dataCollected = records;

      let deletedCount = 0;
      let heldCount = 0;

      for (const record of records) {
        // Check for legal holds
        if (record.legalHoldIds && record.legalHoldIds.length > 0) {
          heldCount++;
          request.notes.push(
            `Record ${record.id} is under legal hold (${record.legalHoldIds.join(', ')}). Skipped deletion.`,
          );
          continue;
        }

        await this.deleteDataRecord(record);
        deletedCount++;
      }

      // Clear Redis cache entries
      await this.clearCachedDataBySubject(subjectIdentifier);

      request.status = 'completed';
      request.completedDate = new Date();
      request.notes.push(`Deleted ${deletedCount} records, ${heldCount} under legal hold`);

      logger.info({
        requestId,
        subjectIdentifier,
        deletedCount,
        heldCount,
      }, 'GDPR erasure request completed');
    } catch (error: any) {
      request.status = 'pending';
      request.notes.push(`Error processing request: ${error.message}`);
      logger.error({ requestId, error: error.message }, 'Failed to process erasure request');
    }

    this.dataSubjectRequests.set(requestId, request);
    await this.persistDataSubjectRequest(request);

    return request;
  }

  /**
   * Export all data for a subject (GDPR Article 20 - Data Portability).
   */
  async exportSubjectData(subjectIdentifier: string, format: 'json' | 'csv' = 'json'): Promise<string> {
    const records = await this.findDataBySubject(subjectIdentifier);

    if (format === 'csv') {
      return this.recordsToCSV(records);
    }

    return JSON.stringify(records, null, 2);
  }

  /**
   * Apply data minimization: only keep fields that are explicitly requested.
   */
  applyDataMinimization(
    data: Record<string, any>,
    requestedFields: string[],
  ): { minimizedData: Record<string, any>; removedFields: string[] } {
    const minimizedData: Record<string, any> = {};
    const removedFields: string[] = [];

    for (const [key, value] of Object.entries(data)) {
      if (requestedFields.includes(key)) {
        minimizedData[key] = value;
      } else {
        removedFields.push(key);
      }
    }

    logger.debug({
      keptFields: requestedFields.length,
      removedFields: removedFields.length,
    }, 'Data minimization applied');

    return { minimizedData, removedFields };
  }

  /**
   * Detect consent banners in HTML content.
   */
  detectConsentBanner(html: string, url: string): ConsentBannerResult {
    const detected = this.consentBannerPatterns.some((pattern) => pattern.test(html));

    if (!detected) {
      return {
        detected: false,
        bannerType: null,
        consentOptions: [],
        recommendedAction: 'No consent banner detected; proceed with caution',
        url,
      };
    }

    // Determine banner type
    let bannerType = 'unknown';
    if (/gdpr/i.test(html)) bannerType = 'gdpr';
    else if (/ccpa/i.test(html)) bannerType = 'ccpa';
    else if (/cookie/i.test(html)) bannerType = 'cookie';

    // Extract consent options
    const consentOptions: string[] = [];
    if (/accept\s+all/i.test(html)) consentOptions.push('accept_all');
    if (/reject\s+all/i.test(html)) consentOptions.push('reject_all');
    if (/manage\s+(?:preferences|consent)/i.test(html)) consentOptions.push('manage_preferences');
    if (/necessary\s+only/i.test(html)) consentOptions.push('necessary_only');

    return {
      detected: true,
      bannerType,
      consentOptions,
      recommendedAction: 'Respect consent banner; do not auto-accept without user direction',
      url,
    };
  }

  /**
   * Add a data retention policy.
   */
  async addRetentionPolicy(policy: Omit<DataRetentionPolicy, 'id' | 'createdAt' | 'updatedAt'>): Promise<DataRetentionPolicy> {
    const fullPolicy: DataRetentionPolicy = {
      ...policy,
      id: `ret-${crypto.randomUUID()}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.retentionPolicies.set(fullPolicy.id, fullPolicy);
    await this.persistRetentionPolicy(fullPolicy);

    logger.info({
      policyId: fullPolicy.id,
      name: fullPolicy.name,
      retentionDays: fullPolicy.retentionDays,
    }, 'Retention policy added');

    return fullPolicy;
  }

  /**
   * Get applicable retention policy for a given URL/domain.
   */
  getRetentionPolicyForUrl(url: string): DataRetentionPolicy | null {
    let bestMatch: DataRetentionPolicy | null = null;
    let bestSpecificity = -1;

    for (const policy of this.retentionPolicies.values()) {
      for (const pattern of policy.appliesTo) {
        if (this.urlMatchesPattern(url, pattern)) {
          if (pattern.length > bestSpecificity) {
            bestSpecificity = pattern.length;
            bestMatch = policy;
          }
        }
      }
    }

    return bestMatch;
  }

  /**
   * Get the default retention period in days.
   */
  getDefaultRetentionDays(): number {
    return this.defaultRetentionDays;
  }

  /**
   * Get all data subject requests, optionally filtered by status.
   */
  getDataSubjectRequests(status?: DataSubjectRequest['status']): DataSubjectRequest[] {
    const requests = Array.from(this.dataSubjectRequests.values());
    if (status) {
      return requests.filter((r) => r.status === status);
    }
    return requests;
  }

  // --- Private Helpers ------------------------------------------------------

  private async findDataBySubject(subjectIdentifier: string): Promise<ScrapeDataRecord[]> {
    try {
      // Query database for records matching the subject identifier
      const results = await db.scrapedData.findMany({
        where: {
          OR: [
            { dataFields: { path: ['$**'], string_contains: subjectIdentifier } },
            { url: { contains: subjectIdentifier } },
          ],
          deletedAt: null,
        },
        take: 1000,
      });

      return results.map((r: any) => ({
        id: r.id,
        url: r.url,
        domain: new URL(r.url).hostname,
        scrapedAt: r.createdAt,
        scrapedBy: r.userId || 'system',
        dataFields: r.dataFields as Record<string, any>,
        piiDetected: r.piiDetections || [],
        piiRedacted: r.piiRedacted ?? false,
        consentBanner: null,
        retentionPolicyId: r.retentionPolicyId,
        legalHoldIds: r.legalHoldIds || [],
        doNotSell: r.doNotSell ?? false,
        deletedAt: r.deletedAt,
      }));
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to query data by subject; using cache fallback');
      // Fallback: check Redis
      const cacheKey = `compliance:data:${subjectIdentifier}`;
      const cached = await cacheGet<ScrapeDataRecord[]>(cacheKey);
      return cached || [];
    }
  }

  private async findCachedDataBySubject(subjectIdentifier: string): Promise<number> {
    try {
      const keys = await redis.keys(`cache:scrape:*${subjectIdentifier}*`);
      return keys.length;
    } catch {
      return 0;
    }
  }

  private async clearCachedDataBySubject(subjectIdentifier: string): Promise<void> {
    try {
      const keys = await redis.keys(`cache:scrape:*${subjectIdentifier}*`);
      if (keys.length > 0) {
        await redis.del(...keys);
        logger.info({ subjectIdentifier, keysCleared: keys.length }, 'Cached data cleared for subject');
      }
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to clear cached data');
    }
  }

  private async deleteDataRecord(record: ScrapeDataRecord): Promise<void> {
    try {
      await db.scrapedData.update({
        where: { id: record.id },
        data: { deletedAt: new Date() },
      });
    } catch (error: any) {
      logger.warn({ recordId: record.id, error: error.message }, 'Failed to soft-delete record');
    }
  }

  private async persistDataSubjectRequest(request: DataSubjectRequest): Promise<void> {
    try {
      await cacheSet(`compliance:dsr:${request.id}`, request, 86400 * 90); // 90 days
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to persist DSR to cache');
    }
  }

  private async persistRetentionPolicy(policy: DataRetentionPolicy): Promise<void> {
    try {
      await cacheSet(`compliance:retention:${policy.id}`, policy, 86400 * 365);
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to persist retention policy');
    }
  }

  private async loadRetentionPolicy(): Promise<void> {
    try {
      // Load from cache or database
      const keys = await redis.keys('cache:compliance:retention:*');
      for (const key of keys) {
        const policy = await cacheGet<DataRetentionPolicy>(key.replace('cache:', ''));
        if (policy) {
          this.retentionPolicies.set(policy.id, policy);
        }
      }
      logger.info({ count: this.retentionPolicies.size }, 'Retention policies loaded');
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to load retention policies');
    }
  }

  private startRetentionEnforcement(): void {
    const interval = setInterval(async () => {
      await this.enforceRetentionPolicies();
    }, 3600_000); // Check every hour

    // Don't prevent process exit
    if (interval.unref) interval.unref();

    logger.info('Retention policy enforcement started');
  }

  private async enforceRetentionPolicies(): Promise<void> {
    const now = new Date();
    let expiredCount = 0;

    try {
      // Find records past retention period
      for (const policy of this.retentionPolicies.values()) {
        if (!policy.autoDelete) continue;

        const cutoffDate = new Date(now.getTime() - policy.retentionDays * 86400_000);

        for (const pattern of policy.appliesTo) {
          try {
            const expired = await db.scrapedData.findMany({
              where: {
                createdAt: { lt: cutoffDate },
                deletedAt: null,
                url: { contains: pattern },
              },
              take: 100,
            });

            for (const record of expired) {
              // Check legal hold
              if ((record as any).legalHoldIds?.length > 0) {
                continue;
              }

              await db.scrapedData.update({
                where: { id: record.id },
                data: { deletedAt: now },
              });

              expiredCount++;
            }
          } catch (error: any) {
            logger.warn({ pattern, error: error.message }, 'Failed to enforce retention for pattern');
          }
        }
      }

      // Also enforce default retention for records without a specific policy
      const defaultCutoff = new Date(now.getTime() - this.defaultRetentionDays * 86400_000);
      try {
        const defaultExpired = await db.scrapedData.findMany({
          where: {
            createdAt: { lt: defaultCutoff },
            deletedAt: null,
          },
          take: 100,
        });

        for (const record of defaultExpired) {
          if ((record as any).legalHoldIds?.length > 0) continue;
          await db.scrapedData.update({
            where: { id: record.id },
            data: { deletedAt: now },
          });
          expiredCount++;
        }
      } catch (error: any) {
        logger.warn({ error: error.message }, 'Failed to enforce default retention');
      }

      if (expiredCount > 0) {
        logger.info({ expiredCount }, 'Retention policies enforced');
      }
    } catch (error: any) {
      logger.error({ error: error.message }, 'Error during retention enforcement');
    }
  }

  private urlMatchesPattern(url: string, pattern: string): boolean {
    if (pattern.startsWith('*.')) {
      // Domain wildcard
      const domain = pattern.slice(2);
      return url.includes(domain);
    }
    if (pattern.startsWith('/')) {
      // Path pattern
      try {
        const urlPath = new URL(url).pathname;
        return urlPath.startsWith(pattern);
      } catch {
        return false;
      }
    }
    return url.includes(pattern);
  }

  private recordsToCSV(records: ScrapeDataRecord[]): string {
    if (records.length === 0) return '';

    const headers = ['id', 'url', 'domain', 'scrapedAt', 'scrapedBy', 'piiRedacted', 'doNotSell'];
    const rows = records.map((r) =>
      headers.map((h) => {
        const val = (r as any)[h];
        return typeof val === 'string' ? `"${val.replace(/"/g, '""')}"` : val;
      }).join(','),
    );

    return [headers.join(','), ...rows].join('\n');
  }
}

// --- CCPA Compliance Manager --------------------------------------------------

export class CCPAComplianceManager {
  private requests: Map<string, CCPARequest> = new Map();
  private consumerCatalog: Map<string, ConsumerDataCatalogEntry[]> = new Map();
  private doNotSellRegistry: Set<string> = new Set();

  constructor() {
    this.loadState();
  }

  /**
   * Process a CCPA consumer request.
   */
  async processRequest(
    type: CCPARequestType,
    consumerIdentifier: string,
  ): Promise<CCPARequest> {
    const requestId = `ccpa-${crypto.randomUUID()}`;
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 45); // CCPA: 45 days

    const request: CCPARequest = {
      id: requestId,
      type,
      consumerIdentifier,
      requestDate: new Date(),
      deadline,
      status: 'in_progress',
      doNotSell: type === CCPARequestType.OPT_OUT_SALE,
      categoriesCollected: [],
      sources: [],
      notes: [],
    };

    try {
      switch (type) {
        case CCPARequestType.KNOW:
          await this.handleKnowRequest(request);
          break;
        case CCPARequestType.DELETE:
          await this.handleDeleteRequest(request);
          break;
        case CCPARequestType.OPT_OUT_SALE:
          await this.handleOptOutRequest(request);
          break;
        case CCPARequestType.NON_DISCRIMINATION:
          request.notes.push('Consumer exercised non-discrimination right');
          break;
      }

      request.status = 'completed';
      request.completedDate = new Date();

      logger.info({
        requestId,
        type,
        consumerIdentifier,
      }, 'CCPA request completed');
    } catch (error: any) {
      request.status = 'pending';
      logger.error({ requestId, error: error.message }, 'Failed to process CCPA request');
    }

    this.requests.set(requestId, request);
    await this.persistRequest(request);

    return request;
  }

  /**
   * Set "Do Not Sell" flag for a consumer.
   */
  async setDoNotSell(consumerIdentifier: string): Promise<void> {
    this.doNotSellRegistry.add(consumerIdentifier);
    await cacheSet(`compliance:ccpa:dns:${consumerIdentifier}`, true, 86400 * 365);

    // Update existing catalog entries
    const entries = this.consumerCatalog.get(consumerIdentifier) || [];
    for (const entry of entries) {
      entry.doNotSell = true;
    }

    logger.info({ consumerIdentifier }, 'Do Not Sell flag set');
  }

  /**
   * Check if a consumer has the "Do Not Sell" flag.
   */
  async isDoNotSell(consumerIdentifier: string): Promise<boolean> {
    if (this.doNotSellRegistry.has(consumerIdentifier)) {
      return true;
    }
    // Check cache
    const cached = await cacheGet<boolean>(`compliance:ccpa:dns:${consumerIdentifier}`);
    if (cached) {
      this.doNotSellRegistry.add(consumerIdentifier);
      return true;
    }
    return false;
  }

  /**
   * Add an entry to the consumer data catalog.
   */
  async addCatalogEntry(entry: Omit<ConsumerDataCatalogEntry, 'id'>): Promise<ConsumerDataCatalogEntry> {
    const fullEntry: ConsumerDataCatalogEntry = {
      ...entry,
      id: `cat-${crypto.randomUUID()}`,
    };

    const existing = this.consumerCatalog.get(entry.consumerIdentifier) || [];
    existing.push(fullEntry);
    this.consumerCatalog.set(entry.consumerIdentifier, existing);

    // Persist to cache
    await cacheSet(
      `compliance:ccpa:catalog:${entry.consumerIdentifier}`,
      existing,
      86400 * 365,
    );

    logger.debug({
      consumerIdentifier: entry.consumerIdentifier,
      category: entry.piiCategory,
    }, 'Consumer data catalog entry added');

    return fullEntry;
  }

  /**
   * Get the consumer data catalog for a specific consumer.
   */
  async getConsumerCatalog(consumerIdentifier: string): Promise<ConsumerDataCatalogEntry[]> {
    const entries = this.consumerCatalog.get(consumerIdentifier);
    if (entries) return entries;

    // Try loading from cache
    const cached = await cacheGet<ConsumerDataCatalogEntry[]>(
      `compliance:ccpa:catalog:${consumerIdentifier}`,
    );
    if (cached) {
      this.consumerCatalog.set(consumerIdentifier, cached);
      return cached;
    }

    return [];
  }

  /**
   * Get all CCPA requests, optionally filtered by type or status.
   */
  getRequests(filters?: { type?: CCPARequestType; status?: CCPARequest['status'] }): CCPARequest[] {
    let result = Array.from(this.requests.values());
    if (filters?.type) {
      result = result.filter((r) => r.type === filters.type);
    }
    if (filters?.status) {
      result = result.filter((r) => r.status === filters.status);
    }
    return result;
  }

  /**
   * Extend a CCPA request deadline (up to 45 additional days).
   */
  async extendRequestDeadline(requestId: string, extensionDays: number): Promise<CCPARequest | null> {
    const request = this.requests.get(requestId);
    if (!request) return null;

    if (extensionDays > 45) {
      throw new Error('CCPA deadline extension cannot exceed 45 additional days');
    }

    const newDeadline = new Date(request.deadline);
    newDeadline.setDate(newDeadline.getDate() + extensionDays);
    request.deadline = newDeadline;
    request.extensionDays = (request.extensionDays || 0) + extensionDays;

    await this.persistRequest(request);
    logger.info({ requestId, extensionDays }, 'CCPA request deadline extended');
    return request;
  }

  // --- Private Helpers ------------------------------------------------------

  private async handleKnowRequest(request: CCPARequest): Promise<void> {
    const entries = await this.getConsumerCatalog(request.consumerIdentifier);
    request.categoriesCollected = [...new Set(entries.map((e) => e.piiCategory))];
    request.sources = [...new Set(entries.map((e) => e.source))];
  }

  private async handleDeleteRequest(request: CCPARequest): Promise<void> {
    const entries = await this.getConsumerCatalog(request.consumerIdentifier);
    let deletedCount = 0;

    for (const entry of entries) {
      if (entry.legalHold) continue;

      try {
        await db.scrapedData.update({
          where: { id: entry.id },
          data: { deletedAt: new Date() },
        });
        deletedCount++;
      } catch (error: any) {
        logger.warn({ entryId: entry.id, error: error.message }, 'Failed to delete consumer data');
      }
    }

    // Clear catalog
    this.consumerCatalog.delete(request.consumerIdentifier);
    await redis.del(`cache:compliance:ccpa:catalog:${request.consumerIdentifier}`);

    logger.info({
      consumerIdentifier: request.consumerIdentifier,
      deletedCount,
    }, 'CCPA deletion request processed');
  }

  private async handleOptOutRequest(request: CCPARequest): Promise<void> {
    await this.setDoNotSell(request.consumerIdentifier);
    request.doNotSell = true;
  }

  private async persistRequest(request: CCPARequest): Promise<void> {
    try {
      await cacheSet(`compliance:ccpa:req:${request.id}`, request, 86400 * 90);
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to persist CCPA request');
    }
  }

  private async loadState(): Promise<void> {
    try {
      // Load Do Not Sell registry
      const dnsKeys = await redis.keys('cache:compliance:ccpa:dns:*');
      for (const key of dnsKeys) {
        const identifier = key.replace('cache:compliance:ccpa:dns:', '');
        this.doNotSellRegistry.add(identifier);
      }

      logger.info({
        dnsEntries: this.doNotSellRegistry.size,
      }, 'CCPA state loaded');
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to load CCPA state');
    }
  }
}

// --- Audit Logger (Tamper-Proof with Hash Chaining) ---------------------------

export class AuditLogger {
  private lastHash: string = '0'.repeat(64); // Genesis hash
  private logBuffer: AuditLogEntry[] = [];
  private flushInterval: NodeJS.Timer | null = null;
  private readonly BUFFER_SIZE = 100;
  private readonly FLUSH_INTERVAL_MS = 10_000;

  constructor() {
    this.loadLastHash();
    this.startFlushCycle();
  }

  /**
   * Log an audit event with hash-chaining for tamper proofing.
   */
  async log(
    eventType: AuditEventType,
    userId: string,
    details: Record<string, any>,
    options?: {
      url?: string;
      domain?: string;
      piiFound?: boolean;
      piiRedacted?: boolean;
    },
  ): Promise<AuditLogEntry> {
    const entry: AuditLogEntry = {
      id: `audit-${crypto.randomUUID()}`,
      timestamp: new Date(),
      eventType,
      userId,
      url: options?.url,
      domain: options?.domain,
      details,
      piiFound: options?.piiFound ?? false,
      piiRedacted: options?.piiRedacted ?? false,
      previousHash: this.lastHash,
      currentHash: '', // Will be computed
    };

    // Compute hash: SHA-256 of entry data + previous hash
    const hashPayload = JSON.stringify({
      id: entry.id,
      timestamp: entry.timestamp.toISOString(),
      eventType,
      userId,
      url: entry.url,
      domain: entry.domain,
      details,
      piiFound: entry.piiFound,
      piiRedacted: entry.piiRedacted,
      previousHash: entry.previousHash,
    });

    entry.currentHash = crypto.createHash('sha256').update(hashPayload).digest('hex');
    this.lastHash = entry.currentHash;

    // Buffer for batch persist
    this.logBuffer.push(entry);

    // Flush if buffer is full
    if (this.logBuffer.length >= this.BUFFER_SIZE) {
      await this.flush();
    }

    return entry;
  }

  /**
   * Query audit logs with filters.
   */
  async query(filters: AuditLogQuery): Promise<AuditLogEntry[]> {
    const cacheKey = `compliance:audit:query:${crypto
      .createHash('md5')
      .update(JSON.stringify(filters))
      .digest('hex')}`;

    // Try cache first
    const cached = await cacheGet<AuditLogEntry[]>(cacheKey);
    if (cached) return cached;

    try {
      // Build where clause for database query
      const where: Record<string, any> = {};

      if (filters.startDate || filters.endDate) {
        where.timestamp = {};
        if (filters.startDate) where.timestamp.gte = filters.startDate;
        if (filters.endDate) where.timestamp.lte = filters.endDate;
      }
      if (filters.userId) where.userId = filters.userId;
      if (filters.domain) where.domain = filters.domain;
      if (filters.eventType) where.eventType = filters.eventType;
      if (filters.piiFound !== undefined) where.piiFound = filters.piiFound;

      const results = await db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: filters.limit || 100,
        skip: filters.offset || 0,
      });

      const entries = results.map((r: any) => ({
        id: r.id,
        timestamp: r.createdAt,
        eventType: r.eventType as AuditEventType,
        userId: r.userId,
        url: r.url,
        domain: r.domain,
        details: r.details as Record<string, any>,
        piiFound: r.piiFound ?? false,
        piiRedacted: r.piiRedacted ?? false,
        previousHash: r.previousHash || '',
        currentHash: r.currentHash || '',
      }));

      // Cache results briefly
      await cacheSet(cacheKey, entries, 300);

      return entries;
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to query audit logs from DB; searching buffer');
      return this.searchBuffer(filters);
    }
  }

  /**
   * Verify integrity of the audit log chain.
   * Returns true if all hashes link correctly.
   */
  async verifyIntegrity(): Promise<{ valid: boolean; brokenAt: string | null; totalChecked: number }> {
    try {
      const entries = await db.auditLog.findMany({
        orderBy: { createdAt: 'asc' },
        take: 10000,
      });

      let previousHash = '0'.repeat(64);
      let totalChecked = 0;

      for (const entry of entries) {
        totalChecked++;

        if (entry.previousHash !== previousHash) {
          logger.error({ entryId: entry.id }, 'Audit log chain integrity broken');
          return { valid: false, brokenAt: entry.id, totalChecked };
        }

        // Recompute hash
        const hashPayload = JSON.stringify({
          id: entry.id,
          timestamp: entry.createdAt.toISOString(),
          eventType: entry.eventType,
          userId: entry.userId,
          url: entry.url,
          domain: entry.domain,
          details: entry.details,
          piiFound: entry.piiFound,
          piiRedacted: entry.piiRedacted,
          previousHash: entry.previousHash,
        });

        const computedHash = crypto.createHash('sha256').update(hashPayload).digest('hex');
        if (computedHash !== entry.currentHash) {
          logger.error({ entryId: entry.id }, 'Audit log entry hash mismatch');
          return { valid: false, brokenAt: entry.id, totalChecked };
        }

        previousHash = entry.currentHash;
      }

      logger.info({ totalChecked }, 'Audit log integrity verified');
      return { valid: true, brokenAt: null, totalChecked };
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to verify audit log integrity');
      return { valid: false, brokenAt: null, totalChecked: 0 };
    }
  }

  /**
   * Flush buffered audit log entries to persistent storage.
   */
  async flush(): Promise<void> {
    if (this.logBuffer.length === 0) return;

    const entries = [...this.logBuffer];
    this.logBuffer = [];

    try {
      // Batch insert into database
      await db.auditLog.createMany({
        data: entries.map((e) => ({
          id: e.id,
          action: e.eventType,
          resource: 'compliance',
          category: 'compliance',
          eventType: e.eventType,
          url: e.url,
          domain: e.domain,
          details: e.details,
          piiFound: e.piiFound,
          piiRedacted: e.piiRedacted,
          previousHash: e.previousHash,
          currentHash: e.currentHash,
          createdAt: e.timestamp,
        })),
      });

      // Update last hash in cache
      if (entries.length > 0) {
        await cacheSet('compliance:audit:lastHash', this.lastHash, 86400);
      }

      logger.debug({ count: entries.length }, 'Audit log entries flushed');
    } catch (error: any) {
      // Re-add to buffer for retry
      this.logBuffer.unshift(...entries);
      logger.error({ error: error.message, count: entries.length }, 'Failed to flush audit log entries');
    }
  }

  /**
   * Shutdown: flush remaining entries.
   */
  async shutdown(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval as any);
    }
    await this.flush();
    logger.info('Audit logger shut down');
  }

  // --- Private Helpers ------------------------------------------------------

  private async loadLastHash(): Promise<void> {
    try {
      const cached = await cacheGet<string>('compliance:audit:lastHash');
      if (cached) {
        this.lastHash = cached;
      }
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to load last audit hash; using genesis');
    }
  }

  private startFlushCycle(): void {
    this.flushInterval = setInterval(async () => {
      await this.flush();
    }, this.FLUSH_INTERVAL_MS);

    if ((this.flushInterval as any).unref) {
      (this.flushInterval as any).unref();
    }
  }

  private searchBuffer(filters: AuditLogQuery): AuditLogEntry[] {
    let results = [...this.logBuffer];

    if (filters.startDate) {
      results = results.filter((e) => e.timestamp >= filters.startDate!);
    }
    if (filters.endDate) {
      results = results.filter((e) => e.timestamp <= filters.endDate!);
    }
    if (filters.userId) {
      results = results.filter((e) => e.userId === filters.userId);
    }
    if (filters.domain) {
      results = results.filter((e) => e.domain === filters.domain);
    }
    if (filters.eventType) {
      results = results.filter((e) => e.eventType === filters.eventType);
    }
    if (filters.piiFound !== undefined) {
      results = results.filter((e) => e.piiFound === filters.piiFound);
    }

    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    return results.slice(filters.offset || 0, (filters.offset || 0) + (filters.limit || 100));
  }
}

// --- Robots.txt Enhanced Compliance -------------------------------------------

export class RobotsComplianceEnhancer {
  private crawlDelays: Map<string, { delayMs: number; lastAccess: number }> = new Map();
  private overrideLog: Map<string, { url: string; timestamp: Date; userId: string }[]> = new Map();
  private respectRobots: boolean;
  private logOverrides: boolean;

  constructor(respectRobots: boolean = true, logOverrides: boolean = true) {
    this.respectRobots = respectRobots;
    this.logOverrides = logOverrides;
  }

  /**
   * Check if a URL is compliant with robots.txt, including crawl-delay enforcement.
   */
  async checkCompliance(
    url: string,
    userAgent: string = 'ScrapeSuite',
    overrideRobots: boolean = false,
  ): Promise<RobotsComplianceResult> {
    const domain = new URL(url).hostname;

    // Check robots.txt via the existing parser
    const result = await robotsParser.isAllowed(url, userAgent, true);

    // Get sitemaps
    const sitemaps = await robotsParser.getSitemaps(domain);

    // Get disallowed paths for this domain
    const disallowedPaths = await this.getDisallowedPaths(domain, userAgent);

    // Check crawl-delay compliance
    if (result.crawlDelay) {
      const delayCompliant = this.checkCrawlDelay(domain, result.crawlDelay);
      if (!delayCompliant.compliant) {
        logger.warn({
          domain,
          requiredDelay: result.crawlDelay,
          remainingMs: delayCompliant.remainingMs,
        }, 'Crawl-delay not yet satisfied');
      }
    }

    // Handle override
    let overrideLogged = false;
    if (!result.allowed && overrideRobots) {
      overrideLogged = true;
      this.logOverride(url, 'system'); // Will be updated with actual user ID
      logger.warn({ url, domain }, 'Robots.txt override applied');
    }

    return {
      url,
      allowed: overrideRobots || result.allowed,
      crawlDelay: result.crawlDelay,
      sitemaps,
      overrideLogged,
      disallowedPaths,
    };
  }

  /**
   * Check crawl-delay and return remaining wait time.
   */
  checkCrawlDelay(domain: string, requiredDelaySeconds: number): {
    compliant: boolean;
    remainingMs: number;
  } {
    const entry = this.crawlDelays.get(domain);
    if (!entry) {
      return { compliant: true, remainingMs: 0 };
    }

    const elapsed = Date.now() - entry.lastAccess;
    const requiredMs = requiredDelaySeconds * 1000;
    const remainingMs = Math.max(0, requiredMs - elapsed);

    return {
      compliant: elapsed >= requiredMs,
      remainingMs,
    };
  }

  /**
   * Record a crawl access for crawl-delay tracking.
   */
  recordAccess(domain: string, crawlDelaySeconds: number | null): void {
    this.crawlDelays.set(domain, {
      delayMs: (crawlDelaySeconds || 0) * 1000,
      lastAccess: Date.now(),
    });
  }

  /**
   * Wait for crawl-delay if needed, then record the access.
   */
  async waitForCrawlDelay(domain: string, crawlDelaySeconds: number | null): Promise<void> {
    if (!crawlDelaySeconds || crawlDelaySeconds <= 0) return;

    const entry = this.crawlDelays.get(domain);
    if (!entry) {
      this.recordAccess(domain, crawlDelaySeconds);
      return;
    }

    const elapsed = Date.now() - entry.lastAccess;
    const requiredMs = crawlDelaySeconds * 1000;
    const remainingMs = requiredMs - elapsed;

    if (remainingMs > 0) {
      logger.debug({ domain, waitMs: remainingMs }, 'Waiting for crawl-delay');
      await new Promise((resolve) => setTimeout(resolve, remainingMs));
    }

    this.recordAccess(domain, crawlDelaySeconds);
  }

  /**
   * Get disallowed paths for a domain.
   */
  async getDisallowedPaths(domain: string, userAgent: string = '*'): Promise<string[]> {
    try {
      const robotsUrl = `https://${domain}/robots.txt`;
      const parsed = await robotsParser.fetchAndParse(robotsUrl);

      if (!parsed) return [];

      return parsed.rules
        .filter((r) => !r.allow)
        .map((r) => r.path);
    } catch (error: any) {
      logger.warn({ domain, error: error.message }, 'Failed to get disallowed paths');
      return [];
    }
  }

  /**
   * Get override history for a domain.
   */
  getOverrideHistory(domain: string): { url: string; timestamp: Date; userId: string }[] {
    return this.overrideLog.get(domain) || [];
  }

  /**
   * Check if robots.txt compliance is enabled.
   */
  isRespectRobots(): boolean {
    return this.respectRobots;
  }

  /**
   * Update robots.txt compliance setting.
   */
  setRespectRobots(respect: boolean): void {
    this.respectRobots = respect;
    logger.info({ respectRobots: respect }, 'Robots.txt respect setting updated');
  }

  // --- Private Helpers ------------------------------------------------------

  private logOverride(url: string, userId: string): void {
    if (!this.logOverrides) return;

    const domain = new URL(url).hostname;
    const entry = { url, timestamp: new Date(), userId };

    const existing = this.overrideLog.get(domain) || [];
    existing.push(entry);
    this.overrideLog.set(domain, existing);

    // Also persist to cache for durability
    cacheSet(`compliance:robots:override:${domain}`, existing, 86400 * 30).catch(() => {});
  }
}

// --- Legal Hold Manager -------------------------------------------------------

export class LegalHoldManager {
  private holds: Map<string, LegalHold> = new Map();

  constructor() {
    this.loadHolds();
  }

  /**
   * Apply a legal hold to prevent auto-deletion of data.
   */
  async applyHold(params: {
    caseId: string;
    requestor: string;
    requestorEmail: string;
    reason: string;
    scope: LegalHold['scope'];
    metadata?: Record<string, any>;
  }): Promise<LegalHold> {
    const hold: LegalHold = {
      id: `hold-${crypto.randomUUID()}`,
      caseId: params.caseId,
      requestor: params.requestor,
      requestorEmail: params.requestorEmail,
      appliedAt: new Date(),
      releasedAt: null,
      reason: params.reason,
      scope: params.scope,
      active: true,
      metadata: params.metadata || {},
    };

    this.holds.set(hold.id, hold);
    await this.persistHold(hold);

    // Apply hold to affected database records
    await this.applyHoldToRecords(hold);

    logger.info({
      holdId: hold.id,
      caseId: hold.caseId,
      requestor: hold.requestor,
    }, 'Legal hold applied');

    return hold;
  }

  /**
   * Release a legal hold, allowing auto-deletion to resume.
   */
  async releaseHold(holdId: string): Promise<LegalHold | null> {
    const hold = this.holds.get(holdId);
    if (!hold) {
      logger.warn({ holdId }, 'Legal hold not found');
      return null;
    }

    hold.active = false;
    hold.releasedAt = new Date();

    await this.persistHold(hold);

    // Remove hold from affected database records
    await this.removeHoldFromRecords(hold);

    logger.info({
      holdId: hold.id,
      caseId: hold.caseId,
    }, 'Legal hold released');

    return hold;
  }

  /**
   * Check if a specific data record is under legal hold.
   */
  isUnderLegalHold(recordId: string, domain?: string, consumerIdentifier?: string): boolean {
    for (const hold of this.holds.values()) {
      if (!hold.active) continue;

      // Check by record ID
      if (hold.scope.dataRecordIds?.includes(recordId)) return true;

      // Check by domain
      if (domain && hold.scope.domains?.some((d) => domain.includes(d))) return true;

      // Check by consumer identifier
      if (
        consumerIdentifier &&
        hold.scope.consumerIdentifiers?.includes(consumerIdentifier)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get all legal hold IDs applicable to a record.
   */
  getApplicableHoldIds(recordId: string, domain?: string, consumerIdentifier?: string): string[] {
    const holdIds: string[] = [];

    for (const hold of this.holds.values()) {
      if (!hold.active) continue;

      if (hold.scope.dataRecordIds?.includes(recordId)) holdIds.push(hold.id);
      else if (domain && hold.scope.domains?.some((d) => domain.includes(d))) holdIds.push(hold.id);
      else if (
        consumerIdentifier &&
        hold.scope.consumerIdentifiers?.includes(consumerIdentifier)
      ) {
        holdIds.push(hold.id);
      }
    }

    return holdIds;
  }

  /**
   * Get a specific legal hold by ID.
   */
  getHold(holdId: string): LegalHold | null {
    return this.holds.get(holdId) || null;
  }

  /**
   * Get all active legal holds.
   */
  getActiveHolds(): LegalHold[] {
    return Array.from(this.holds.values()).filter((h) => h.active);
  }

  /**
   * Get all legal holds (including released).
   */
  getAllHolds(): LegalHold[] {
    return Array.from(this.holds.values());
  }

  /**
   * Get legal holds for a specific case.
   */
  getHoldsByCase(caseId: string): LegalHold[] {
    return Array.from(this.holds.values()).filter((h) => h.caseId === caseId);
  }

  // --- Private Helpers ------------------------------------------------------

  private async applyHoldToRecords(hold: LegalHold): Promise<void> {
    try {
      // Update records matching the hold scope
      if (hold.scope.dataRecordIds?.length) {
        for (const recordId of hold.scope.dataRecordIds) {
          await db.scrapedData.update({
            where: { id: recordId },
            data: {
              legalHoldIds: { push: hold.id },
            },
          });
        }
      }

      if (hold.scope.domains?.length) {
        for (const domain of hold.scope.domains) {
          const records = await db.scrapedData.findMany({
            where: {
              url: { contains: domain },
              deletedAt: null,
            },
            take: 500,
          });

          for (const record of records) {
            const existingHolds = (record as any).legalHoldIds || [];
            if (!existingHolds.includes(hold.id)) {
              await db.scrapedData.update({
                where: { id: record.id },
                data: { legalHoldIds: { push: hold.id } },
              });
            }
          }
        }
      }
    } catch (error: any) {
      logger.warn({ holdId: hold.id, error: error.message }, 'Failed to apply hold to records');
    }
  }

  private async removeHoldFromRecords(hold: LegalHold): Promise<void> {
    try {
      if (hold.scope.dataRecordIds?.length) {
        for (const recordId of hold.scope.dataRecordIds) {
          const record = await db.scrapedData.findUnique({ where: { id: recordId } });
          if (record) {
            const holds = ((record as any).legalHoldIds || []).filter((id: string) => id !== hold.id);
            await db.scrapedData.update({
              where: { id: recordId },
              data: { legalHoldIds: holds },
            });
          }
        }
      }
    } catch (error: any) {
      logger.warn({ holdId: hold.id, error: error.message }, 'Failed to remove hold from records');
    }
  }

  private async persistHold(hold: LegalHold): Promise<void> {
    try {
      await cacheSet(`compliance:hold:${hold.id}`, hold, 86400 * 365 * 5); // 5 years
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to persist legal hold');
    }
  }

  private async loadHolds(): Promise<void> {
    try {
      const keys = await redis.keys('cache:compliance:hold:*');
      for (const key of keys) {
        const hold = await cacheGet<LegalHold>(key.replace('cache:', ''));
        if (hold) {
          this.holds.set(hold.id, hold);
        }
      }
      logger.info({ count: this.holds.size }, 'Legal holds loaded');
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to load legal holds');
    }
  }
}

// --- Main Compliance Engine ---------------------------------------------------

export class ComplianceEngine {
  private piiEngine: PIIDetectionEngine;
  private gdprManager: GDPRComplianceManager;
  private ccpaManager: CCPAComplianceManager;
  private auditLogger: AuditLogger;
  private robotsCompliance: RobotsComplianceEnhancer;
  private legalHoldManager: LegalHoldManager;
  private config: ComplianceConfig;

  constructor(config?: Partial<ComplianceConfig>) {
    // Build full config with defaults
    this.config = {
      redaction: {
        rules: DEFAULT_REDACTION_RULES,
        defaultStrategy: RedactionStrategy.REDACTED,
        customPatterns: [],
        enabledCategories: Object.values(PIICategory),
        ...config?.redaction,
      },
      defaultRetentionDays: config?.defaultRetentionDays ?? 90,
      respectRobotsTxt: config?.respectRobotsTxt ?? true,
      logRobotsOverrides: config?.logRobotsOverrides ?? true,
      enableConsentDetection: config?.enableConsentDetection ?? true,
      gdprEnabled: config?.gdprEnabled ?? true,
      ccpaEnabled: config?.ccpaEnabled ?? true,
      auditLogEnabled: config?.auditLogEnabled ?? true,
      retentionCheckIntervalMs: config?.retentionCheckIntervalMs ?? 3600_000,
    };

    // Initialize sub-engines
    this.piiEngine = new PIIDetectionEngine(this.config.redaction);
    this.gdprManager = new GDPRComplianceManager(this.piiEngine, this.config.defaultRetentionDays);
    this.ccpaManager = new CCPAComplianceManager();
    this.auditLogger = new AuditLogger();
    this.robotsCompliance = new RobotsComplianceEnhancer(
      this.config.respectRobotsTxt,
      this.config.logRobotsOverrides,
    );
    this.legalHoldManager = new LegalHoldManager();

    logger.info({
      gdprEnabled: this.config.gdprEnabled,
      ccpaEnabled: this.config.ccpaEnabled,
      retentionDays: this.config.defaultRetentionDays,
      respectRobotsTxt: this.config.respectRobotsTxt,
    }, 'Compliance Engine initialized');
  }

  // --- PII Detection & Redaction ------------------------------------------

  /**
   * Detect PII in text.
   */
  detectPII(text: string): PIIDetectionResult[] {
    return this.piiEngine.detectPII(text);
  }

  /**
   * Redact PII in text.
   */
  redactText(text: string): { redactedText: string; detections: PIIDetectionResult[] } {
    return this.piiEngine.redactText(text);
  }

  /**
   * Redact PII in a structured object (deep scan).
   */
  redactObject<T extends Record<string, any>>(obj: T): { data: T; detections: PIIDetectionResult[] } {
    return this.piiEngine.redactObject(obj);
  }

  /**
   * Add a custom PII pattern.
   */
  addCustomPIIPattern(pattern: PIIPattern): void {
    this.piiEngine.addCustomPattern(pattern);
  }

  /**
   * Update a redaction rule.
   */
  updateRedactionRule(category: PIICategory, rule: Partial<RedactionRule>): void {
    this.piiEngine.updateRedactionRule(category, rule);
  }

  /**
   * Enable or disable a PII detection category.
   */
  setPIICategoryEnabled(category: PIICategory, enabled: boolean): void {
    if (enabled) {
      this.piiEngine.enableCategory(category);
    } else {
      this.piiEngine.disableCategory(category);
    }
  }

  // --- GDPR ---------------------------------------------------------------

  /**
   * Submit a GDPR data subject access request.
   */
  async requestDataAccess(subjectIdentifier: string, requestorEmail: string): Promise<DataSubjectRequest> {
    if (!this.config.gdprEnabled) {
      throw new Error('GDPR compliance is not enabled');
    }

    const request = await this.gdprManager.processDataAccessRequest(subjectIdentifier, requestorEmail);

    // Audit log
    if (this.config.auditLogEnabled) {
      await this.auditLogger.log(AuditEventType.DATA_SUBJECT_REQUEST, 'system', {
        requestType: DataSubjectRequestType.ACCESS,
        subjectIdentifier,
        recordsFound: request.dataCollected.length,
      }, { piiFound: request.dataCollected.length > 0 });
    }

    return request;
  }

  /**
   * Submit a GDPR right-to-erasure request.
   */
  async requestErasure(subjectIdentifier: string, requestorEmail: string): Promise<DataSubjectRequest> {
    if (!this.config.gdprEnabled) {
      throw new Error('GDPR compliance is not enabled');
    }

    const request = await this.gdprManager.processErasureRequest(subjectIdentifier, requestorEmail);

    // Audit log
    if (this.config.auditLogEnabled) {
      await this.auditLogger.log(AuditEventType.DATA_DELETED, 'system', {
        requestType: DataSubjectRequestType.ERASURE,
        subjectIdentifier,
        status: request.status,
      }, { piiFound: true, piiRedacted: true });
    }

    return request;
  }

  /**
   * Export all data for a subject (data portability).
   */
  async exportSubjectData(subjectIdentifier: string, format: 'json' | 'csv' = 'json'): Promise<string> {
    if (!this.config.gdprEnabled) {
      throw new Error('GDPR compliance is not enabled');
    }

    const data = await this.gdprManager.exportSubjectData(subjectIdentifier, format);

    // Audit log
    if (this.config.auditLogEnabled) {
      await this.auditLogger.log(AuditEventType.DATA_EXPORTED, 'system', {
        subjectIdentifier,
        format,
      });
    }

    return data;
  }

  /**
   * Apply data minimization to a data object.
   */
  applyDataMinimization(
    data: Record<string, any>,
    requestedFields: string[],
  ): { minimizedData: Record<string, any>; removedFields: string[] } {
    const result = this.gdprManager.applyDataMinimization(data, requestedFields);

    // Audit log
    if (this.config.auditLogEnabled) {
      this.auditLogger.log(AuditEventType.DATA_MINIMIZATION_APPLIED, 'system', {
        keptFields: requestedFields.length,
        removedFields: result.removedFields.length,
      }).catch(() => {});
    }

    return result;
  }

  /**
   * Detect consent banners in HTML.
   */
  detectConsentBanner(html: string, url: string): ConsentBannerResult {
    if (!this.config.enableConsentDetection) {
      return { detected: false, bannerType: null, consentOptions: [], recommendedAction: 'Consent detection disabled', url };
    }

    const result = this.gdprManager.detectConsentBanner(html, url);

    // Audit log
    if (this.config.auditLogEnabled && result.detected) {
      this.auditLogger.log(AuditEventType.CONSENT_BANNER_DETECTED, 'system', {
        url,
        bannerType: result.bannerType,
        consentOptions: result.consentOptions,
      }).catch(() => {});
    }

    return result;
  }

  /**
   * Add a data retention policy.
   */
  async addRetentionPolicy(
    policy: Omit<DataRetentionPolicy, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<DataRetentionPolicy> {
    return this.gdprManager.addRetentionPolicy(policy);
  }

  /**
   * Get applicable retention policy for a URL.
   */
  getRetentionPolicyForUrl(url: string): DataRetentionPolicy | null {
    return this.gdprManager.getRetentionPolicyForUrl(url);
  }

  /**
   * Get data subject requests.
   */
  getDataSubjectRequests(status?: DataSubjectRequest['status']): DataSubjectRequest[] {
    return this.gdprManager.getDataSubjectRequests(status);
  }

  // --- CCPA ---------------------------------------------------------------

  /**
   * Submit a CCPA consumer request.
   */
  async submitCCPARequest(type: CCPARequestType, consumerIdentifier: string): Promise<CCPARequest> {
    if (!this.config.ccpaEnabled) {
      throw new Error('CCPA compliance is not enabled');
    }

    const request = await this.ccpaManager.processRequest(type, consumerIdentifier);

    // Audit log
    if (this.config.auditLogEnabled) {
      await this.auditLogger.log(AuditEventType.CCPA_REQUEST, 'system', {
        requestType: type,
        consumerIdentifier,
      });
    }

    return request;
  }

  /**
   * Set Do Not Sell flag for a consumer.
   */
  async setDoNotSell(consumerIdentifier: string): Promise<void> {
    if (!this.config.ccpaEnabled) {
      throw new Error('CCPA compliance is not enabled');
    }

    await this.ccpaManager.setDoNotSell(consumerIdentifier);
  }

  /**
   * Check if a consumer has Do Not Sell flag.
   */
  async isDoNotSell(consumerIdentifier: string): Promise<boolean> {
    return this.ccpaManager.isDoNotSell(consumerIdentifier);
  }

  /**
   * Add an entry to the consumer data catalog.
   */
  async addConsumerCatalogEntry(
    entry: Omit<ConsumerDataCatalogEntry, 'id'>,
  ): Promise<ConsumerDataCatalogEntry> {
    return this.ccpaManager.addCatalogEntry(entry);
  }

  /**
   * Get the consumer data catalog.
   */
  async getConsumerCatalog(consumerIdentifier: string): Promise<ConsumerDataCatalogEntry[]> {
    return this.ccpaManager.getConsumerCatalog(consumerIdentifier);
  }

  /**
   * Get CCPA requests.
   */
  getCCPARequests(filters?: { type?: CCPARequestType; status?: CCPARequest['status'] }): CCPARequest[] {
    return this.ccpaManager.getRequests(filters);
  }

  /**
   * Extend a CCPA request deadline.
   */
  async extendCCPARequestDeadline(requestId: string, extensionDays: number): Promise<CCPARequest | null> {
    return this.ccpaManager.extendRequestDeadline(requestId, extensionDays);
  }

  // --- Audit Logging ------------------------------------------------------

  /**
   * Log an audit event.
   */
  async audit(
    eventType: AuditEventType,
    userId: string,
    details: Record<string, any>,
    options?: {
      url?: string;
      domain?: string;
      piiFound?: boolean;
      piiRedacted?: boolean;
    },
  ): Promise<AuditLogEntry> {
    if (!this.config.auditLogEnabled) {
      // Return a stub entry
      return {
        id: `audit-disabled-${crypto.randomUUID()}`,
        timestamp: new Date(),
        eventType,
        userId,
        url: options?.url,
        domain: options?.domain,
        details,
        piiFound: options?.piiFound ?? false,
        piiRedacted: options?.piiRedacted ?? false,
        previousHash: '',
        currentHash: '',
      };
    }

    return this.auditLogger.log(eventType, userId, details, options);
  }

  /**
   * Query audit logs.
   */
  async queryAuditLogs(filters: AuditLogQuery): Promise<AuditLogEntry[]> {
    return this.auditLogger.query(filters);
  }

  /**
   * Verify audit log integrity.
   */
  async verifyAuditIntegrity(): Promise<{ valid: boolean; brokenAt: string | null; totalChecked: number }> {
    return this.auditLogger.verifyIntegrity();
  }

  // --- Robots.txt Compliance ----------------------------------------------

  /**
   * Check if a URL is compliant with robots.txt.
   */
  async checkRobotsCompliance(
    url: string,
    userAgent?: string,
    overrideRobots?: boolean,
  ): Promise<RobotsComplianceResult> {
    const result = await this.robotsCompliance.checkCompliance(url, userAgent, overrideRobots);

    // Audit log for overrides
    if (result.overrideLogged && this.config.auditLogEnabled) {
      await this.auditLogger.log(AuditEventType.ROBOTS_OVERRIDE, 'system', {
        url,
        userAgent,
        originallyAllowed: false,
        overrideApplied: true,
      }, { url, domain: new URL(url).hostname });
    }

    // Audit log for crawl-delay
    if (result.crawlDelay && this.config.auditLogEnabled) {
      await this.auditLogger.log(AuditEventType.CRAWL_DELAY_ENFORCED, 'system', {
        url,
        crawlDelay: result.crawlDelay,
      }, { url, domain: new URL(url).hostname });
    }

    return result;
  }

  /**
   * Wait for crawl-delay before accessing a domain.
   */
  async waitForCrawlDelay(domain: string, crawlDelaySeconds: number | null): Promise<void> {
    await this.robotsCompliance.waitForCrawlDelay(domain, crawlDelaySeconds);
  }

  /**
   * Record a crawl access for crawl-delay tracking.
   */
  recordCrawlAccess(domain: string, crawlDelaySeconds: number | null): void {
    this.robotsCompliance.recordAccess(domain, crawlDelaySeconds);
  }

  /**
   * Get disallowed paths for a domain.
   */
  async getDisallowedPaths(domain: string, userAgent?: string): Promise<string[]> {
    return this.robotsCompliance.getDisallowedPaths(domain, userAgent);
  }

  /**
   * Get override history for a domain.
   */
  getRobotsOverrideHistory(domain: string): { url: string; timestamp: Date; userId: string }[] {
    return this.robotsCompliance.getOverrideHistory(domain);
  }

  // --- Legal Hold ---------------------------------------------------------

  /**
   * Apply a legal hold.
   */
  async applyLegalHold(params: {
    caseId: string;
    requestor: string;
    requestorEmail: string;
    reason: string;
    scope: LegalHold['scope'];
    metadata?: Record<string, any>;
  }): Promise<LegalHold> {
    const hold = await this.legalHoldManager.applyHold(params);

    // Audit log
    if (this.config.auditLogEnabled) {
      await this.auditLogger.log(AuditEventType.LEGAL_HOLD_APPLIED, params.requestor, {
        holdId: hold.id,
        caseId: hold.caseId,
        scope: hold.scope,
      });
    }

    return hold;
  }

  /**
   * Release a legal hold.
   */
  async releaseLegalHold(holdId: string): Promise<LegalHold | null> {
    const hold = await this.legalHoldManager.releaseHold(holdId);

    if (hold && this.config.auditLogEnabled) {
      await this.auditLogger.log(AuditEventType.LEGAL_HOLD_RELEASED, 'system', {
        holdId: hold.id,
        caseId: hold.caseId,
      });
    }

    return hold;
  }

  /**
   * Check if a record is under legal hold.
   */
  isUnderLegalHold(recordId: string, domain?: string, consumerIdentifier?: string): boolean {
    return this.legalHoldManager.isUnderLegalHold(recordId, domain, consumerIdentifier);
  }

  /**
   * Get applicable hold IDs for a record.
   */
  getLegalHoldIds(recordId: string, domain?: string, consumerIdentifier?: string): string[] {
    return this.legalHoldManager.getApplicableHoldIds(recordId, domain, consumerIdentifier);
  }

  /**
   * Get a specific legal hold.
   */
  getLegalHold(holdId: string): LegalHold | null {
    return this.legalHoldManager.getHold(holdId);
  }

  /**
   * Get all active legal holds.
   */
  getActiveLegalHolds(): LegalHold[] {
    return this.legalHoldManager.getActiveHolds();
  }

  /**
   * Get legal holds by case ID.
   */
  getLegalHoldsByCase(caseId: string): LegalHold[] {
    return this.legalHoldManager.getHoldsByCase(caseId);
  }

  // --- Full Scrape Compliance Pipeline ------------------------------------

  /**
   * Run the full compliance pipeline on a scrape result.
   * This is the primary entry point for ensuring compliance on all scraped data.
   */
  async processScrapeResult(params: {
    url: string;
    userId: string;
    data: Record<string, any>;
    requestedFields?: string[];
    userAgent?: string;
    overrideRobots?: boolean;
  }): Promise<{
    data: Record<string, any>;
    piiDetections: PIIDetectionResult[];
    robotsCompliance: RobotsComplianceResult;
    consentBanner: ConsentBannerResult | null;
    auditEntry: AuditLogEntry;
    minimized: boolean;
    doNotSell: boolean;
    legalHoldIds: string[];
  }> {
    const { url, userId, data, requestedFields, userAgent, overrideRobots } = params;
    const domain = new URL(url).hostname;

    // Step 1: Check robots.txt compliance
    const robotsResult = await this.checkRobotsCompliance(url, userAgent, overrideRobots);

    // Step 2: Detect and redact PII
    const { data: redactedData, detections: piiDetections } = this.piiEngine.redactObject(data);

    // Step 3: Apply data minimization if requested fields specified
    let finalData = redactedData;
    let minimized = false;
    if (requestedFields && requestedFields.length > 0) {
      const result = this.gdprManager.applyDataMinimization(redactedData, requestedFields);
      finalData = result.minimizedData;
      minimized = true;
    }

    // Step 4: Check Do Not Sell flag
    let doNotSell = false;
    if (this.config.ccpaEnabled) {
      // Extract potential consumer identifiers from data
      const identifiers = this.extractConsumerIdentifiers(data);
      for (const id of identifiers) {
        if (await this.ccpaManager.isDoNotSell(id)) {
          doNotSell = true;
          break;
        }
      }
    }

    // Step 5: Check legal holds
    const legalHoldIds = this.legalHoldManager.getApplicableHoldIds('', domain);

    // Step 6: Detect consent banner (if HTML is present)
    let consentBanner: ConsentBannerResult | null = null;
    if (this.config.enableConsentDetection) {
      const htmlContent = data.html || data.body || data.content || '';
      if (typeof htmlContent === 'string' && htmlContent.length > 0) {
        consentBanner = this.gdprManager.detectConsentBanner(htmlContent, url);
      }
    }

    // Step 7: Record crawl access for crawl-delay tracking
    if (robotsResult.crawlDelay) {
      this.robotsCompliance.recordAccess(domain, robotsResult.crawlDelay);
    }

    // Step 8: Audit log
    const auditEntry = await this.auditLogger.log(
      AuditEventType.SCRAPE_REQUEST,
      userId,
      {
        url,
        domain,
        piiFound: piiDetections.length > 0,
        piiCategories: [...new Set(piiDetections.map((d) => d.category))],
        piiCount: piiDetections.length,
        robotsAllowed: robotsResult.allowed,
        robotsOverride: robotsResult.overrideLogged,
        crawlDelay: robotsResult.crawlDelay,
        minimized,
        doNotSell,
        consentBannerDetected: consentBanner?.detected ?? false,
        legalHolds: legalHoldIds.length,
      },
      {
        url,
        domain,
        piiFound: piiDetections.length > 0,
        piiRedacted: piiDetections.length > 0,
      },
    );

    // Step 9: Add to CCPA consumer catalog if PII was found
    if (this.config.ccpaEnabled && piiDetections.length > 0) {
      const identifiers = this.extractConsumerIdentifiers(data);
      for (const identifier of identifiers) {
        for (const detection of piiDetections) {
          await this.ccpaManager.addCatalogEntry({
            consumerIdentifier: identifier,
            piiCategory: detection.category,
            dataPoint: detection.redacted,
            source: url,
            collectedAt: new Date(),
            doNotSell,
            legalHold: legalHoldIds.length > 0,
            retentionPolicyId: null,
          });
        }
      }
    }

    return {
      data: finalData,
      piiDetections,
      robotsCompliance: robotsResult,
      consentBanner,
      auditEntry,
      minimized,
      doNotSell,
      legalHoldIds,
    };
  }

  // --- Configuration ------------------------------------------------------

  /**
   * Get current compliance configuration.
   */
  getConfig(): Readonly<ComplianceConfig> {
    return Object.freeze({ ...this.config });
  }

  /**
   * Update compliance configuration at runtime.
   */
  updateConfig(updates: Partial<ComplianceConfig>): void {
    Object.assign(this.config, updates);

    if (updates.respectRobotsTxt !== undefined) {
      this.robotsCompliance.setRespectRobots(updates.respectRobotsTxt);
    }

    logger.info({ updates: Object.keys(updates) }, 'Compliance configuration updated');
  }

  /**
   * Get all PII patterns (including custom ones).
   */
  getPIIPatterns(): PIIPattern[] {
    return this.piiEngine.getPatterns();
  }

  /**
   * Get all redaction rules.
   */
  getRedactionRules(): RedactionRule[] {
    return this.piiEngine.getRedactionRules();
  }

  // --- Lifecycle ----------------------------------------------------------

  /**
   * Graceful shutdown: flush audit logs.
   */
  async shutdown(): Promise<void> {
    await this.auditLogger.shutdown();
    logger.info('Compliance Engine shut down');
  }

  // --- Private Helpers ----------------------------------------------------

  private extractConsumerIdentifiers(data: Record<string, any>): string[] {
    const identifiers: string[] = [];

    // Check common identifier fields
    const fieldsToCheck = ['email', 'userEmail', 'username', 'userId', 'phone', 'name'];
    for (const field of fieldsToCheck) {
      if (data[field] && typeof data[field] === 'string') {
        identifiers.push(data[field]);
      }
    }

    // Also use PII detections to find email-based identifiers
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const dataStr = JSON.stringify(data);
    const emailMatch = emailRegex.exec(dataStr);
    if (emailMatch) {
      identifiers.push(emailMatch[0]);
    }

    return [...new Set(identifiers)];
  }
}

// --- Singleton Export ---------------------------------------------------------

export const complianceEngine = new ComplianceEngine();


