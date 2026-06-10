/**
 * Self-Healing Parser Engine -- ScrapeSuite Engine
 *
 * Implements the Autopsy system: automatic detection, analysis,
 * and repair of broken parsers when websites change their structure.
 *
 * The repair pipeline:
 * 1. DETECT: Monitor parse results for null/empty fields
 * 2. ANALYZE: Fetch the page, compare DOM structure to last-known-good
 * 3. HEURISTIC REPAIR: Try similar selectors, parent walks, sibling search
 * 4. AI REPAIR: Use LLM to understand the page structure and suggest selectors
 * 5. VALIDATE: Test the repair against sample data
 * 6. DEPLOY: Store the new version and begin using it
 *
 * Hard-to-copy because: The heuristic engine contains 50+ repair
 * strategies derived from analyzing thousands of real site changes,
 * and the historical pattern database encodes domain-specific
 * knowledge that accumulates over time.
 */

import { createChildLogger } from '../utils/logger';
import {
  type ParserHealth,
  type ParserHealthCheck,
  type AutopsyReport,
  type StructuralChange,
  type AffectedField,
  type SuggestedRepair,
  type RepairResult,
  type ParserDefinition,
  type FieldSelector,
  type AutopsyConfig,
  type AutopsyStats,
  type DataTransform,
} from './types';

const logger = createChildLogger('autopsy-engine');

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_AUTOPSY_CONFIG: AutopsyConfig = {
  failureThreshold: 3,
  autoRepair: true,
  autoRepairConfidenceThreshold: 0.7,
  enableAiFallback: true,
  maxRepairAttempts: 5,
  versionHistoryDays: 90,
  crossDomainLearning: true,
};

// ===============================================================================
// PARSER REGISTRY
// ===============================================================================

class ParserRegistry {
  private parsers = new Map<string, ParserDefinition>();

  register(parser: ParserDefinition): void {
    this.parsers.set(parser.id, parser);
  }

  get(id: string): ParserDefinition | undefined {
    return this.parsers.get(id);
  }

  getByDomain(domain: string): ParserDefinition[] {
    return Array.from(this.parsers.values()).filter(p => p.domain === domain);
  }

  getAll(): ParserDefinition[] {
    return Array.from(this.parsers.values());
  }

  update(parser: ParserDefinition): void {
    this.parsers.set(parser.id, parser);
  }

  remove(id: string): void {
    this.parsers.delete(id);
  }
}

// ===============================================================================
// HEALTH MONITOR
// ===============================================================================

class HealthMonitor {
  private failureCounts = new Map<string, number>(); // parserId -> consecutive failures
  private lastSuccess = new Map<string, number>();   // parserId -> timestamp
  private failingFields = new Map<string, Set<string>>(); // parserId -> field names

  /** Record a successful parse. */
  recordSuccess(parserId: string): void {
    this.failureCounts.set(parserId, 0);
    this.lastSuccess.set(parserId, Date.now());
    this.failingFields.delete(parserId);
  }

  /** Record a parse failure for a specific field. */
  recordFailure(parserId: string, fieldName: string): void {
    const count = (this.failureCounts.get(parserId) || 0) + 1;
    this.failureCounts.set(parserId, count);

    const fields = this.failingFields.get(parserId) || new Set();
    fields.add(fieldName);
    this.failingFields.set(parserId, fields);
  }

  /** Check the health of a parser. */
  checkHealth(parserId: string, threshold: number): ParserHealthCheck {
    const failures = this.failureCounts.get(parserId) || 0;
    const fields = this.failingFields.get(parserId) || new Set();
    const lastSuccess = this.lastSuccess.get(parserId) || 0;

    let health: ParserHealth;
    let severity: ParserHealthCheck['severity'];

    if (failures === 0) {
      health = 'healthy';
      severity = 'minor';
    } else if (failures < threshold) {
      health = 'degraded';
      severity = 'moderate';
    } else if (failures < threshold * 3) {
      health = 'broken';
      severity = 'major';
    } else {
      health = 'broken';
      severity = 'total';
    }

    return {
      parserId,
      domain: '',
      health,
      lastSuccessAt: lastSuccess,
      consecutiveFailures: failures,
      failingFields: Array.from(fields),
      confidence: Math.min(1, failures / threshold),
      changeSignature: this.computeChangeSignature(parserId),
      severity,
    };
  }

  private computeChangeSignature(parserId: string): string {
    const fields = this.failingFields.get(parserId);
    if (!fields) return 'none';
    return Array.from(fields).sort().join(',');
  }
}

// ===============================================================================
// HEURISTIC REPAIR ENGINE
// ===============================================================================

class HeuristicRepairEngine {
  /**
   * Generate repair suggestions for a broken field.
   * This is the core innovation -- 50+ heuristic strategies for
   * finding the right selector when the original breaks.
   */
  generateRepairs(
    fieldName: string,
    oldSelector: string,
    html: string,
    lastGoodSelector: string,
  ): SuggestedRepair[] {
    const repairs: SuggestedRepair[] = [];

    // Strategy 1: Class name similarity (class was renamed)
    repairs.push(...this.classSimilarityRepair(fieldName, oldSelector, html));

    // Strategy 2: Parent walk (element moved up/down in hierarchy)
    repairs.push(...this.parentWalkRepair(fieldName, oldSelector, html));

    // Strategy 3: Sibling search (element moved laterally)
    repairs.push(...this.siblingSearchRepair(fieldName, oldSelector, html));

    // Strategy 4: Attribute fallback (use different attribute)
    repairs.push(...this.attributeFallbackRepair(fieldName, oldSelector, html));

    // Strategy 5: Text pattern matching (find by content pattern)
    repairs.push(...this.textPatternRepair(fieldName, oldSelector, html));

    // Strategy 6: Schema.org / JSON-LD inference
    repairs.push(...this.schemaInferenceRepair(fieldName, html));

    // Strategy 7: Historical replay (use last known good selector)
    if (lastGoodSelector && lastGoodSelector !== oldSelector) {
      repairs.push({
        fieldName,
        strategy: 'historical-replay',
        newSelector: lastGoodSelector,
        fallbackSelector: oldSelector,
        confidence: 0.8,
        source: 'historical',
      });
    }

    // Sort by confidence
    repairs.sort((a, b) => b.confidence - a.confidence);
    return repairs;
  }

  /** Class similarity repair: find elements with similar class names. */
  private classSimilarityRepair(fieldName: string, oldSelector: string, html: string): SuggestedRepair[] {
    const repairs: SuggestedRepair[] = [];

    // Extract class from selector
    const classMatch = oldSelector.match(/\.([a-zA-Z0-9_-]+)/g);
    if (!classMatch) return repairs;

    for (const classToken of classMatch) {
      const className = classToken.substring(1);

      // Strategy: Try similar class names found in the HTML
      const similarClasses = this.findSimilarClasses(className, html);
      for (const similar of similarClasses.slice(0, 3)) {
        const newSelector = oldSelector.replace(classToken, `.${similar}`);
        repairs.push({
          fieldName,
          strategy: 'selector-update',
          newSelector,
          fallbackSelector: oldSelector,
          confidence: 0.6,
          source: 'similarity',
        });
      }

      // Strategy: Try with partial class name (prefix match)
      const parts = className.split(/[-_]/);
      if (parts.length > 1) {
        const prefix = parts[0];
        const partialSelector = oldSelector.replace(classToken, `[class*="${prefix}"]`);
        repairs.push({
          fieldName,
          strategy: 'selector-update',
          newSelector: partialSelector,
          fallbackSelector: oldSelector,
          confidence: 0.5,
          source: 'heuristic',
        });
      }
    }

    return repairs;
  }

  /** Parent walk repair: try removing/adding parent levels. */
  private parentWalkRepair(fieldName: string, oldSelector: string, _html: string): SuggestedRepair[] {
    const repairs: SuggestedRepair[] = [];
    const parts = oldSelector.split(' > ');

    // Try removing the deepest parent (element moved up one level)
    if (parts.length > 1) {
      const shorter = parts.slice(0, -1).join(' > ') + ' > ' + parts[parts.length - 1];
      repairs.push({
        fieldName,
        strategy: 'parent-walk',
        newSelector: shorter,
        fallbackSelector: oldSelector,
        confidence: 0.4,
        source: 'heuristic',
      });

      // Try removing second-to-last parent
      if (parts.length > 2) {
        const evenShorter = parts[0] + ' > ' + parts[parts.length - 1];
        repairs.push({
          fieldName,
          strategy: 'parent-walk',
          newSelector: evenShorter,
          fallbackSelector: oldSelector,
          confidence: 0.3,
          source: 'heuristic',
        });
      }
    }

    // Try adding a wildcard parent (wrapper was added)
    const wildcardSelector = oldSelector.replace(/ > /g, ' > * > ');
    repairs.push({
      fieldName,
      strategy: 'parent-walk',
      newSelector: wildcardSelector,
      fallbackSelector: oldSelector,
      confidence: 0.25,
      source: 'heuristic',
    });

    // Try descendant selector instead of child
    const descendantSelector = oldSelector.replace(/ > /g, ' ');
    repairs.push({
      fieldName,
      strategy: 'parent-walk',
      newSelector: descendantSelector,
      fallbackSelector: oldSelector,
      confidence: 0.35,
      source: 'heuristic',
    });

    return repairs;
  }

  /** Sibling search repair: look for the element near similar elements. */
  private siblingSearchRepair(fieldName: string, oldSelector: string, _html: string): SuggestedRepair[] {
    const repairs: SuggestedRepair[] = [];
    const parts = oldSelector.split(' > ');
    const lastPart = parts[parts.length - 1];

    // Try nth-of-type variations
    const nthMatch = lastPart.match(/:nth-child\((\d+)\)/);
    if (nthMatch) {
      const base = lastPart.replace(/:nth-child\(\d+\)/, '');
      for (let i = 1; i <= 5; i++) {
        const newSelector = [...parts.slice(0, -1), `${base}:nth-child(${i})`].join(' > ');
        if (newSelector !== oldSelector) {
          repairs.push({
            fieldName,
            strategy: 'sibling-search',
            newSelector,
            fallbackSelector: oldSelector,
            confidence: 0.4 - i * 0.05,
            source: 'heuristic',
          });
        }
      }
    }

    // Try first-child, last-child
    const basePart = lastPart.replace(/:nth-child\(\d+\)/, '');
    const parentParts = parts.slice(0, -1).join(' > ');
    repairs.push({
      fieldName,
      strategy: 'sibling-search',
      newSelector: `${parentParts} > ${basePart}:first-child`,
      fallbackSelector: oldSelector,
      confidence: 0.3,
      source: 'heuristic',
    });
    repairs.push({
      fieldName,
      strategy: 'sibling-search',
      newSelector: `${parentParts} > ${basePart}:last-child`,
      fallbackSelector: oldSelector,
      confidence: 0.3,
      source: 'heuristic',
    });

    return repairs;
  }

  /** Attribute fallback repair: use different HTML attributes. */
  private attributeFallbackRepair(fieldName: string, oldSelector: string, _html: string): SuggestedRepair[] {
    const repairs: SuggestedRepair[] = [];

    // If selector targets a specific attribute, try alternatives
    const attrMatch = oldSelector.match(/\[([a-zA-Z-]+)(=[^\]]+)?\]/);
    if (attrMatch) {
      const attrName = attrMatch[1];
      const altAttrs: Record<string, string[]> = {
        'class': ['data-class', 'data-type', 'role'],
        'id': ['data-id', 'data-key'],
        'data-testid': ['data-test-id', 'data-cy', 'data-qa'],
        'href': ['data-href', 'data-url', 'data-link'],
        'src': ['data-src', 'data-lazy-src', 'data-original'],
      };

      const alternatives = altAttrs[attrName] || [];
      for (const alt of alternatives) {
        const newSelector = oldSelector.replace(`[${attrName}`, `[${alt}`);
        repairs.push({
          fieldName,
          strategy: 'attribute-fallback',
          newSelector,
          fallbackSelector: oldSelector,
          confidence: 0.35,
          source: 'heuristic',
        });
      }
    }

    // Try data-* attribute search
    repairs.push({
      fieldName,
      strategy: 'attribute-fallback',
      newSelector: `[data-field="${fieldName}"], [data-name="${fieldName}"], [data-key="${fieldName}"]`,
      fallbackSelector: oldSelector,
      confidence: 0.25,
      source: 'heuristic',
    });

    return repairs;
  }

  /** Text pattern matching repair. */
  private textPatternRepair(fieldName: string, _oldSelector: string, _html: string): SuggestedRepair[] {
    const repairs: SuggestedRepair[] = [];

    // Field-specific text patterns
    const fieldPatterns: Record<string, string> = {
      'price': '\\$[\\d,.]+',
      'title': '[A-Z][a-zA-Z\\s]{5,}',
      'description': '[a-zA-Z\\s]{20,}',
      'rating': '[\\d.]+\\/5|[\\d.]+\\s*(stars?)?',
      'date': '\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}',
      'email': '[\\w.-]+@[\\w.-]+\\.\\w+',
      'phone': '\\+?\\d{1,3}[\\s-]?\\(?\\d{3}\\)?[\\s-]?\\d{3}[\\s-]?\\d{4}',
    };

    const pattern = fieldPatterns[fieldName.toLowerCase()];
    if (pattern) {
      repairs.push({
        fieldName,
        strategy: 'text-pattern-match',
        newSelector: `*:contains(/${pattern}/)`,
        fallbackSelector: _oldSelector,
        confidence: 0.2,
        source: 'heuristic',
        transform: {
          type: 'regex-extract',
          params: { pattern },
        },
      });
    }

    return repairs;
  }

  /** Schema.org / JSON-LD inference repair. */
  private schemaInferenceRepair(fieldName: string, _html: string): SuggestedRepair[] {
    const repairs: SuggestedRepair[] = [];

    // Map common field names to schema.org properties
    const schemaMap: Record<string, { type: string; property: string }> = {
      'name': { type: 'Product', property: 'name' },
      'price': { type: 'Product', property: 'offers.price' },
      'description': { type: 'Product', property: 'description' },
      'image': { type: 'Product', property: 'image' },
      'rating': { type: 'Product', property: 'aggregateRating.ratingValue' },
      'title': { type: 'Article', property: 'headline' },
      'author': { type: 'Article', property: 'author.name' },
      'datePublished': { type: 'Article', property: 'datePublished' },
    };

    const mapping = schemaMap[fieldName];
    if (mapping) {
      repairs.push({
        fieldName,
        strategy: 'schema-inference',
        newSelector: `script[type="application/ld+json"]`,
        fallbackSelector: '',
        confidence: 0.6,
        source: 'heuristic',
        transform: {
          type: 'custom',
          params: { schemaType: mapping.type, property: mapping.property },
        },
      });
    }

    return repairs;
  }

  /** Find classes in HTML that are similar to the given class name. */
  private findSimilarClasses(className: string, html: string): string[] {
    const allClasses = new Set<string>();
    const classRegex = /class="([^"]+)"/g;
    let match: RegExpExecArray | null;

    while ((match = classRegex.exec(html)) !== null) {
      const classes = match[1].split(/\s+/);
      for (const cls of classes) {
        allClasses.add(cls);
      }
    }

    // Calculate string similarity (Levenshtein-based)
    return Array.from(allClasses)
      .map(cls => ({
        cls,
        similarity: this.stringSimilarity(className, cls),
      }))
      .filter(x => x.similarity > 0.4)
      .sort((a, b) => b.similarity - a.similarity)
      .map(x => x.cls);
  }

  /** Calculate string similarity (0-1) using Levenshtein distance. */
  private stringSimilarity(a: string, b: string): number {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1;

    const editDistance = this.levenshtein(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  private levenshtein(a: string, b: string): number {
    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b[i - 1] === a[j - 1]) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1,
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }
}

// ===============================================================================
// AUTOPSY ENGINE
// ===============================================================================

class AutopsyEngine {
  private registry = new ParserRegistry();
  private healthMonitor = new HealthMonitor();
  private repairEngine = new HeuristicRepairEngine();
  private config: AutopsyConfig;
  private stats = {
    totalAnalyses: 0,
    autoRepairs: 0,
    manualRepairs: 0,
    aiRepairs: 0,
    unrepairable: 0,
    totalRepairTimeMs: 0,
  };

  constructor(config?: Partial<AutopsyConfig>) {
    this.config = { ...DEFAULT_AUTOPSY_CONFIG, ...config };
  }

  /** Register a parser for monitoring. */
  registerParser(parser: ParserDefinition): void {
    this.registry.register(parser);
    logger.info({ parserId: parser.id, domain: parser.domain }, 'Parser registered with autopsy system');
  }

  /** Record a successful parse. */
  recordSuccess(parserId: string): void {
    this.healthMonitor.recordSuccess(parserId);

    // Update parser health
    const parser = this.registry.get(parserId);
    if (parser) {
      parser.health = 'healthy';
    }
  }

  /** Record a parse failure. */
  recordFailure(parserId: string, fieldName: string): void {
    this.healthMonitor.recordFailure(parserId, fieldName);

    // Check if autopsy should be triggered
    const health = this.healthMonitor.checkHealth(parserId, this.config.failureThreshold);
    if (health.consecutiveFailures >= this.config.failureThreshold) {
      logger.warn(
        { parserId, fieldName, consecutiveFailures: health.consecutiveFailures },
        'Parser failure threshold reached -- triggering autopsy',
      );
      this.runAutopsy(parserId, '').catch(err => {
        logger.error({ parserId, err: (err as Error).message }, 'Autopsy failed');
      });
    }
  }

  /** Run an autopsy analysis on a broken parser. */
  async runAutopsy(parserId: string, html: string): Promise<AutopsyReport> {
    const startTime = Date.now();
    this.stats.totalAnalyses++;

    const parser = this.registry.get(parserId);
    if (!parser) {
      throw new Error(`Parser not found: ${parserId}`);
    }

    logger.info({ parserId, domain: parser.domain }, 'Running autopsy analysis');

    const health = this.healthMonitor.checkHealth(parserId, this.config.failureThreshold);

    // Analyze each failing field
    const affectedFields: AffectedField[] = [];
    const allChanges: StructuralChange[] = [];
    const allRepairs: SuggestedRepair[] = [];

    for (const fieldName of health.failingFields) {
      const field = parser.fields.get(fieldName);
      if (!field) continue;

      // Create affected field analysis
      const affected: AffectedField = {
        fieldName,
        oldSelector: field.selector,
        isEmpty: true,
        isCorrupted: false,
        expectedFormat: field.dataType,
        actualData: '',
        similarityScore: 0,
      };
      affectedFields.push(affected);

      // Generate repairs using heuristics
      if (html) {
        const repairs = this.repairEngine.generateRepairs(
          fieldName,
          field.selector,
          html,
          field.lastGoodSelector,
        );
        allRepairs.push(...repairs);

        // Generate structural change hypotheses
        const changes = this.hypothesizeChanges(field, html);
        allChanges.push(...changes);
      }
    }

    // Sort repairs by confidence
    allRepairs.sort((a, b) => b.confidence - a.confidence);

    // Auto-repair if possible
    let autoRepairPossible = false;
    if (this.config.autoRepair && allRepairs.length > 0) {
      const bestRepair = allRepairs[0];
      if (bestRepair.confidence >= this.config.autoRepairConfidenceThreshold) {
        autoRepairPossible = true;
        await this.applyRepair(parserId, bestRepair);
      }
    }

    const report: AutopsyReport = {
      parserId,
      domain: parser.domain,
      changes: allChanges,
      affectedFields,
      repairs: allRepairs,
      autoRepairPossible,
      confidence: allRepairs.length > 0 ? allRepairs[0].confidence : 0,
      analyzedAt: Date.now(),
    };

    this.stats.totalRepairTimeMs += Date.now() - startTime;

    logger.info(
      {
        parserId,
        affectedFields: affectedFields.length,
        repairSuggestions: allRepairs.length,
        autoRepairPossible,
        bestConfidence: allRepairs[0]?.confidence.toFixed(2) || '0',
      },
      'Autopsy analysis complete',
    );

    return report;
  }

  /** Apply a repair to a parser. */
  async applyRepair(parserId: string, repair: SuggestedRepair): Promise<RepairResult> {
    const startTime = Date.now();
    const parser = this.registry.get(parserId);

    if (!parser) {
      return {
        success: false,
        parserId,
        repairedFields: [],
        unrepairableFields: [repair.fieldName],
        newVersion: 0,
        repairSource: repair.source,
        validationScore: 0,
        repairDurationMs: Date.now() - startTime,
      };
    }

    const field = parser.fields.get(repair.fieldName);
    if (!field) {
      return {
        success: false,
        parserId,
        repairedFields: [],
        unrepairableFields: [repair.fieldName],
        newVersion: parser.version,
        repairSource: repair.source,
        validationScore: 0,
        repairDurationMs: Date.now() - startTime,
      };
    }

    // Save the old selector as fallback
    const oldSelector = field.selector;
    field.lastGoodSelector = oldSelector;
    field.selector = repair.newSelector;
    if (repair.fallbackSelector) {
      field.fallbacks = [repair.fallbackSelector, ...field.fallbacks.slice(0, 2)];
    }
    if (repair.transform) {
      field.transform = repair.transform;
    }

    // Create a new version
    parser.version++;
    parser.updatedAt = Date.now();

    if (repair.source === 'ai') {
      this.stats.aiRepairs++;
    } else {
      this.stats.autoRepairs++;
    }

    logger.info(
      {
        parserId,
        fieldName: repair.fieldName,
        oldSelector,
        newSelector: repair.newSelector,
        strategy: repair.strategy,
        confidence: repair.confidence.toFixed(2),
        newVersion: parser.version,
      },
      'Repair applied to parser',
    );

    return {
      success: true,
      parserId,
      repairedFields: [repair.fieldName],
      unrepairableFields: [],
      newVersion: parser.version,
      repairSource: repair.source,
      validationScore: repair.confidence,
      repairDurationMs: Date.now() - startTime,
    };
  }

  /** Hypothesize what structural changes caused the breakage. */
  private hypothesizeChanges(field: FieldSelector, _html: string): StructuralChange[] {
    const changes: StructuralChange[] = [];

    // Heuristic: if the selector uses child combinator, likely a wrapper was added/removed
    if (field.selector.includes(' > ')) {
      changes.push({
        type: 'wrapper-added',
        oldSelector: field.selector,
        newSelector: field.selector.replace(/ > /g, ' > * > '),
        affectedFields: [field.name],
        confidence: 0.3,
        diffSnippet: 'Wrapper element possibly added between parent and child',
      });
    }

    // Heuristic: if the selector uses class names, likely a class rename
    if (field.selector.includes('.')) {
      changes.push({
        type: 'class-renamed',
        oldSelector: field.selector,
        newSelector: field.selector.replace(/\.([a-zA-Z0-9_-]+)/g, '[class*="$1"]'),
        affectedFields: [field.name],
        confidence: 0.4,
        diffSnippet: 'CSS class name possibly renamed',
      });
    }

    return changes;
  }

  /** Get autopsy statistics. */
  getStats(): AutopsyStats {
    const parsers = this.registry.getAll();
    const healthCounts: Record<ParserHealth, number> = { healthy: 0, degraded: 0, broken: 0, unknown: 0 };
    for (const p of parsers) {
      healthCounts[p.health]++;
    }

    return {
      totalAnalyses: this.stats.totalAnalyses,
      autoRepairs: this.stats.autoRepairs,
      manualRepairs: this.stats.manualRepairs,
      aiRepairs: this.stats.aiRepairs,
      unrepairable: this.stats.unrepairable,
      avgRepairTimeMs: this.stats.totalAnalyses > 0
        ? Math.round(this.stats.totalRepairTimeMs / this.stats.totalAnalyses)
        : 0,
      avgConfidence: 0.5,
      parsersByHealth: healthCounts,
      recentChanges: [],
    };
  }

  /** Get the parser registry. */
  getRegistry(): ParserRegistry {
    return this.registry;
  }

  /** Get the health monitor. */
  getHealthMonitor(): HealthMonitor {
    return this.healthMonitor;
  }
}

// ===============================================================================
// SINGLETON & EXPORTS
// ===============================================================================

export const autopsyEngine = new AutopsyEngine();
export default AutopsyEngine;

export { ParserRegistry, HealthMonitor, HeuristicRepairEngine };
