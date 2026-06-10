/**
 * Self-Healing Parser System Types -- ScrapeSuite Engine
 *
 * "Autopsy" -- When a parser breaks (because the target site changed
 * its HTML structure), the Autopsy system automatically:
 * 1. Detects the breakage (null/empty data)
 * 2. Analyzes the new page structure
 * 3. Attempts automated repair using CSS/XPath heuristics
 * 4. Falls back to AI-based extraction if heuristics fail
 * 5. Stores the repair as a new parser version
 *
 * Hard-to-copy because: The repair knowledge base grows over time
 * and encodes site-specific structural change patterns that no
 * competitor can replicate without the same repair history.
 */

// ===============================================================================
// PARSER HEALTH TYPES
// ===============================================================================

/** Health status of a parser. */
export type ParserHealth = 'healthy' | 'degraded' | 'broken' | 'unknown';

/** Result of a parser health check. */
export interface ParserHealthCheck {
  /** Parser ID. */
  parserId: string;
  /** Domain this parser targets. */
  domain: string;
  /** Health status. */
  health: ParserHealth;
  /** When the last successful parse was. */
  lastSuccessAt: number;
  /** Number of consecutive failures. */
  consecutiveFailures: number;
  /** What field(s) are failing. */
  failingFields: string[];
  /** Confidence in the health assessment (0-1). */
  confidence: number;
  /** HTML diff signature (what changed). */
  changeSignature: string;
  /** Severity of the breakage. */
  severity: 'minor' | 'moderate' | 'major' | 'total';
}

// ===============================================================================
// AUTOPSY ANALYSIS TYPES
// ===============================================================================

/** Result of analyzing a broken parse. */
export interface AutopsyReport {
  /** Parser that was analyzed. */
  parserId: string;
  /** Domain. */
  domain: string;
  /** What changed on the page. */
  changes: StructuralChange[];
  /** Which fields are affected. */
  affectedFields: AffectedField[];
  /** Suggested repairs. */
  repairs: SuggestedRepair[];
  /** Whether auto-repair is possible. */
  autoRepairPossible: boolean;
  /** Confidence in the analysis (0-1). */
  confidence: number;
  /** Time of analysis. */
  analyzedAt: number;
}

/** A structural change detected on a page. */
export interface StructuralChange {
  /** What changed. */
  type: 'selector-moved' | 'class-renamed' | 'attribute-changed' | 'element-removed' | 'element-added' | 'hierarchy-changed' | 'wrapper-added' | 'wrapper-removed';
  /** The old CSS selector or XPath. */
  oldSelector: string;
  /** The new CSS selector or XPath. */
  newSelector: string;
  /** The field(s) affected by this change. */
  affectedFields: string[];
  /** How confident we are about this change (0-1). */
  confidence: number;
  /** HTML snippet showing the change. */
  diffSnippet: string;
}

/** A field that is affected by a structural change. */
export interface AffectedField {
  /** Field name. */
  fieldName: string;
  /** Old selector. */
  oldSelector: string;
  /** Whether data extraction returns null/empty. */
  isEmpty: boolean;
  /** Whether the data looks wrong (different format, garbage text). */
  isCorrupted: boolean;
  /** Expected data type/format. */
  expectedFormat: string;
  /** Actual data received. */
  actualData: string;
  /** Similarity score between expected and actual (0-1). */
  similarityScore: number;
}

// ===============================================================================
// REPAIR TYPES
// ===============================================================================

/** A suggested repair for a broken parser. */
export interface SuggestedRepair {
  /** The field to repair. */
  fieldName: string;
  /** Repair strategy. */
  strategy: RepairStrategy;
  /** New selector to try. */
  newSelector: string;
  /** Backup selector (if primary fails). */
  fallbackSelector: string;
  /** Confidence in this repair (0-1). */
  confidence: number;
  /** How the repair was derived. */
  source: 'heuristic' | 'similarity' | 'ai' | 'historical' | 'cross-domain';
  /** Transformation to apply to extracted data. */
  transform?: DataTransform;
}

/** Repair strategies. */
export type RepairStrategy =
  | 'selector-update'       // Replace the CSS/XPath selector
  | 'attribute-fallback'    // Use a different HTML attribute
  | 'parent-walk'           // Walk up the DOM tree and re-select
  | 'sibling-search'        // Search nearby elements
  | 'text-pattern-match'    // Match by text content pattern
  | 'schema-inference'      // Infer from schema.org/JSON-LD
  | 'ai-extraction'         // Fall back to AI-based extraction
  | 'historical-replay';    // Use a previous working selector

/** Data transformation to apply after extraction. */
export interface DataTransform {
  /** Type of transformation. */
  type: 'regex-extract' | 'substring' | 'replace' | 'trim' | 'parse-number' | 'parse-date' | 'custom';
  /** Transformation parameters. */
  params: Record<string, string>;
}

/** Result of applying a repair. */
export interface RepairResult {
  /** Whether the repair was successful. */
  success: boolean;
  /** The parser ID that was repaired. */
  parserId: string;
  /** Fields that were repaired. */
  repairedFields: string[];
  /** Fields that could not be repaired. */
  unrepairableFields: string[];
  /** New parser version. */
  newVersion: number;
  /** How the repair was done. */
  repairSource: SuggestedRepair['source'];
  /** Validation score (0-1). */
  validationScore: number;
  /** Time taken to repair (ms). */
  repairDurationMs: number;
}

// ===============================================================================
// PARSER REGISTRY TYPES
// ===============================================================================

/** A parser definition with versioning. */
export interface ParserDefinition {
  /** Parser ID. */
  id: string;
  /** Domain this parser targets. */
  domain: string;
  /** Parser name. */
  name: string;
  /** Current version. */
  version: number;
  /** Field selectors. */
  fields: Map<string, FieldSelector>;
  /** Health status. */
  health: ParserHealth;
  /** Last known good version. */
  lastGoodVersion: number;
  /** Version history. */
  versions: ParserVersion[];
  /** Creation timestamp. */
  createdAt: number;
  /** Last update timestamp. */
  updatedAt: number;
}

/** A field selector in a parser. */
export interface FieldSelector {
  /** Field name. */
  name: string;
  /** Primary CSS selector. */
  selector: string;
  /** Fallback CSS selectors. */
  fallbacks: string[];
  /** XPath selector (alternative to CSS). */
  xpath?: string;
  /** Data type expected. */
  dataType: 'text' | 'number' | 'url' | 'image' | 'date' | 'html' | 'boolean' | 'array';
  /** Attribute to extract (null = textContent). */
  attribute?: string;
  /** Transform to apply. */
  transform?: DataTransform;
  /** Whether this field is required. */
  required: boolean;
  /** Pattern for validation. */
  validationPattern?: string;
  /** Last known good selector. */
  lastGoodSelector: string;
}

/** A version of a parser. */
export interface ParserVersion {
  /** Version number. */
  version: number;
  /** Field selectors for this version. */
  fields: Map<string, FieldSelector>;
  /** When this version was created. */
  createdAt: number;
  /** Why this version was created. */
  reason: 'initial' | 'auto-repair' | 'manual-update' | 'ai-repair' | 'historical-replay';
  /** How successful this version is (0-1). */
  successRate: number;
  /** Total parses with this version. */
  totalParses: number;
  /** Successful parses with this version. */
  successfulParses: number;
}

// ===============================================================================
// HEURISTIC ENGINE TYPES
// ===============================================================================

/** Configuration for the autopsy system. */
export interface AutopsyConfig {
  /** Number of consecutive failures before triggering autopsy. */
  failureThreshold: number;
  /** Whether to auto-repair when possible. */
  autoRepair: boolean;
  /** Minimum confidence to apply auto-repair. */
  autoRepairConfidenceThreshold: number;
  /** Whether to fall back to AI extraction. */
  enableAiFallback: boolean;
  /** Maximum number of repair attempts. */
  maxRepairAttempts: number;
  /** How long to keep parser version history. */
  versionHistoryDays: number;
  /** Whether to learn from cross-domain patterns. */
  crossDomainLearning: boolean;
}

/** Statistics for the autopsy system. */
export interface AutopsyStats {
  totalAnalyses: number;
  autoRepairs: number;
  manualRepairs: number;
  aiRepairs: number;
  unrepairable: number;
  avgRepairTimeMs: number;
  avgConfidence: number;
  parsersByHealth: Record<ParserHealth, number>;
  recentChanges: StructuralChange[];
}
