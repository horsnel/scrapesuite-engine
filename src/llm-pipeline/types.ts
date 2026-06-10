/**
 * LLM Extraction Pipeline Types -- ScrapeSuite Engine
 *
 * Type definitions for the LLM-powered data extraction pipeline
 * that integrates multiple LLM providers for intelligent structured
 * data extraction from scraped content.
 */

/** Supported LLM provider backends. */
export enum LLMProvider {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GOOGLE = 'google',
  LOCAL_OLLAMA = 'local_ollama',
  LOCAL_LMSTUDIO = 'local_lmstudio',
}

/** Configuration for a specific LLM model call. */
export interface LLMModelConfig {
  provider: LLMProvider;
  model: string;
  temperature: number;
  max_tokens: number;
  top_p: number;
  timeout_ms: number;
  retries: number;
}

/** A single field in an extraction schema. */
export interface SchemaField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';
  description: string;
  required: boolean;
  enum_values?: string[];
  nested_fields?: SchemaField[];
}

/** Schema that defines the expected extraction output. */
export interface ExtractionSchema {
  name: string;
  description: string;
  fields: SchemaField[];
}

/** A request to extract structured data from content. */
export interface ExtractionRequest {
  content: string;
  schema: ExtractionSchema;
  model_config: LLMModelConfig;
  cache_ttl?: number;
  system_prompt?: string;
  few_shot_examples?: FewShotExample[];
}

/** A single few-shot example for in-context learning. */
export interface FewShotExample {
  input: string;
  output: Record<string, unknown>;
}

/** The result of a successful extraction. */
export interface ExtractionResult {
  extracted_data: Record<string, unknown>;
  confidence_score: number;
  tokens_used: { input: number; output: number };
  cost_usd: number;
  latency_ms: number;
  model_used: string;
  cached: boolean;
  errors?: string[];
}

/** A reusable prompt template for extraction tasks. */
export interface PromptTemplate {
  id: string;
  name: string;
  template_text: string;
  variables: string[];
  extraction_schema: ExtractionSchema;
  created_at: number;
}

/** A request to extract data from multiple items. */
export interface BatchExtractionRequest {
  items: string[];
  schema: ExtractionSchema;
  model_config: LLMModelConfig;
  concurrency: number;
  cache_ttl?: number;
  system_prompt?: string;
  on_progress?: (completed: number, total: number) => void;
}

/** The result of a batch extraction run. */
export interface BatchExtractionResult {
  results: ExtractionResult[];
  total_tokens: { input: number; output: number };
  total_cost_usd: number;
  successes: number;
  failures: number;
  total_latency_ms: number;
}

/** A record of cost for a single LLM API call. */
export interface CostRecord {
  provider: LLMProvider;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  timestamp: number;
  request_id: string;
}

/** Configuration for the LLM pipeline as a whole. */
export interface LLMPipelineConfig {
  default_provider: LLMProvider;
  default_model: string;
  max_concurrency: number;
  cache_ttl: number;
  cost_limit_daily_usd: number;
  retry_attempts: number;
  retry_base_delay_ms: number;
}

/** Pricing tier for a model. */
export interface ModelPricing {
  provider: LLMProvider;
  model: string;
  price_per_1k_input: number;
  price_per_1k_output: number;
}

/** Cost report for a given period. */
export interface CostReport {
  total_cost_usd: number;
  total_tokens: { input: number; output: number };
  by_provider: Record<string, { cost_usd: number; calls: number }>;
  by_model: Record<string, { cost_usd: number; calls: number }>;
  period: { start: number; end: number };
  daily_limit_remaining_usd: number;
}
