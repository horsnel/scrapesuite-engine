/**
 * Batch Processor -- ScrapeSuite Engine
 *
 * Processes multiple extraction requests with concurrency control,
 * progress tracking, cost accumulation, and failure isolation.
 */

import { createChildLogger } from '../utils/logger';
import { LLMExtractor } from './extractor';
import {
  BatchExtractionRequest,
  BatchExtractionResult,
  CostRecord,
  ExtractionRequest,
  ExtractionResult,
} from './types';

const logger = createChildLogger('llm-pipeline:batch-processor');

// ---------- Simple semaphore for concurrency control --------------------------

class Semaphore {
  private current = 0;
  private queue: (() => void)[] = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>(resolve => this.queue.push(resolve));
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }
}

// ---------- Batch Processor class ---------------------------------------------

export class BatchProcessor {
  private extractor: LLMExtractor;
  private costRecords: CostRecord[] = [];

  constructor(extractor: LLMExtractor) {
    this.extractor = extractor;
  }

  /** Process a batch of extraction requests with concurrency limit. */
  async processBatch(request: BatchExtractionRequest): Promise<BatchExtractionResult> {
    const { items, schema, model_config, concurrency, cache_ttl, system_prompt, on_progress } = request;
    const semaphore = new Semaphore(concurrency);
    const results: ExtractionResult[] = new Array(items.length);
    this.costRecords = [];

    let completed = 0;
    let successes = 0;
    let failures = 0;
    const startTime = Date.now();

    logger.info({ items: items.length, concurrency }, 'Starting batch extraction');

    const tasks = items.map(async (content, index) => {
      await semaphore.acquire();
      try {
        const extractionRequest: ExtractionRequest = {
          content,
          schema,
          model_config,
          cache_ttl,
          system_prompt,
        };
        const result = await this.extractor.extract(extractionRequest);
        results[index] = result;
        if (result.confidence_score >= 0.5 && !result.errors?.length) {
          successes++;
        } else {
          failures++;
        }
      } catch (err: any) {
        logger.warn({ index, error: err.message }, 'Batch item failed');
        results[index] = {
          extracted_data: {},
          confidence_score: 0,
          tokens_used: { input: 0, output: 0 },
          cost_usd: 0,
          latency_ms: 0,
          model_used: model_config.model,
          cached: false,
          errors: [err.message],
        };
        failures++;
      } finally {
        completed++;
        semaphore.release();
        on_progress?.(completed, items.length);
      }
    });

    await Promise.all(tasks);

    // Aggregate totals
    const totalTokens = results.reduce(
      (acc, r) => ({
        input: acc.input + (r.tokens_used?.input ?? 0),
        output: acc.output + (r.tokens_used?.output ?? 0),
      }),
      { input: 0, output: 0 },
    );
    const totalCost = results.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
    const totalLatency = Date.now() - startTime;

    logger.info({ successes, failures, total_cost: totalCost, total_latency_ms: totalLatency }, 'Batch extraction complete');

    return {
      results,
      total_tokens: totalTokens,
      total_cost_usd: totalCost,
      successes,
      failures,
      total_latency_ms: totalLatency,
    };
  }

  /** Get cost records accumulated during the last batch. */
  getCostRecords(): CostRecord[] {
    return [...this.costRecords];
  }
}
