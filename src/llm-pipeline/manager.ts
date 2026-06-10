/**
 * LLM Pipeline Manager -- ScrapeSuite Engine
 *
 * Main orchestrator that wires together the extractor, batch processor,
 * cost tracker, and prompt template manager into a unified API.
 */

import { createChildLogger } from '../utils/logger';
import { LLMExtractor } from './extractor';
import { BatchProcessor } from './batch-processor';
import { CostTracker } from './cost-tracker';
import { PromptTemplateManager } from './prompt-templates';
import {
  BatchExtractionRequest,
  BatchExtractionResult,
  CostReport,
  ExtractionRequest,
  ExtractionResult,
  LLMPipelineConfig,
  LLMProvider,
  PromptTemplate,
} from './types';

const logger = createChildLogger('llm-pipeline:manager');

// ---------- Default configuration ---------------------------------------------

const DEFAULT_CONFIG: LLMPipelineConfig = {
  default_provider: LLMProvider.OPENAI,
  default_model: 'gpt-4o-mini',
  max_concurrency: 5,
  cache_ttl: 3600,
  cost_limit_daily_usd: 100,
  retry_attempts: 2,
  retry_base_delay_ms: 1000,
};

// ---------- Pipeline Manager class --------------------------------------------

export class LLMPipelineManager {
  private config: LLMPipelineConfig;
  private extractor: LLMExtractor;
  private batchProcessor: BatchProcessor;
  private costTracker: CostTracker;
  private templateManager: PromptTemplateManager;

  constructor(config?: Partial<LLMPipelineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.costTracker = new CostTracker(this.config.cost_limit_daily_usd);
    this.extractor = new LLMExtractor({
      onCostRecord: (record) => this.costTracker.recordCost(record),
    });
    this.batchProcessor = new BatchProcessor(this.extractor);
    this.templateManager = new PromptTemplateManager();

    logger.info({ config: this.config }, 'LLM Pipeline Manager initialized');
  }

  /** Initialize async components (template loading). */
  async initialize(): Promise<void> {
    await this.templateManager.initialize();
  }

  /** Extract structured data from content using an LLM. */
  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    // Check daily spend limit
    const limitReached = await this.costTracker.isDailyLimitReached();
    if (limitReached) {
      throw new Error('Daily LLM spend limit reached. Increase the limit or wait for the next day.');
    }

    return this.extractor.extract(request);
  }

  /** Extract data from multiple items in batch. */
  async extractBatch(request: BatchExtractionRequest): Promise<BatchExtractionResult> {
    const limitReached = await this.costTracker.isDailyLimitReached();
    if (limitReached) {
      throw new Error('Daily LLM spend limit reached. Increase the limit or wait for the next day.');
    }

    const batchRequest: BatchExtractionRequest = {
      ...request,
      concurrency: request.concurrency ?? this.config.max_concurrency,
    };

    return this.batchProcessor.processBatch(batchRequest);
  }

  /** Extract using a named prompt template. */
  async extractWithTemplate(
    templateName: string,
    content: string,
    variables: Record<string, string> = {},
  ): Promise<ExtractionResult> {
    const template = await this.templateManager.getTemplate(templateName);
    if (!template) {
      throw new Error(`Template not found: ${templateName}`);
    }

    const renderedSystemPrompt = this.templateManager.renderTemplate(template, variables);

    const request: ExtractionRequest = {
      content,
      schema: template.extraction_schema,
      model_config: {
        provider: this.config.default_provider,
        model: this.config.default_model,
        temperature: 0.1,
        max_tokens: 4096,
        top_p: 0.9,
        timeout_ms: 30000,
        retries: this.config.retry_attempts,
      },
      cache_ttl: this.config.cache_ttl,
      system_prompt: renderedSystemPrompt,
    };

    return this.extract(request);
  }

  /** Get a cost report for a time period. */
  async getCostReport(period?: { start: Date; end: Date }): Promise<CostReport> {
    return this.costTracker.getCostReport(period);
  }

  /** List all available prompt templates. */
  async listTemplates(): Promise<PromptTemplate[]> {
    return this.templateManager.listTemplates();
  }

  /** Register a custom prompt template. */
  async registerTemplate(template: Omit<PromptTemplate, 'id' | 'created_at'>): Promise<PromptTemplate> {
    return this.templateManager.registerTemplate(template);
  }

  /** Get the cost tracker for direct access. */
  getCostTracker(): CostTracker {
    return this.costTracker;
  }

  /** Update the daily spend limit. */
  setDailyLimit(limitUsd: number): void {
    this.costTracker.setDailyLimit(limitUsd);
    this.config.cost_limit_daily_usd = limitUsd;
  }

  /** Get current pipeline configuration. */
  getConfig(): LLMPipelineConfig {
    return { ...this.config };
  }
}

// ---------- Singleton export --------------------------------------------------

export const llmPipelineManager = new LLMPipelineManager();
