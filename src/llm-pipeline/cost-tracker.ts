/**
 * Cost Tracker -- ScrapeSuite Engine
 *
 * Tracks LLM API costs across providers and models. Enforces daily
 * spend limits, stores cost records in Redis and DB, and provides
 * aggregation and reporting capabilities.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { CostRecord, CostReport, LLMProvider, ModelPricing } from './types';

const logger = createChildLogger('llm-pipeline:cost-tracker');

const COST_DAILY_KEY = (date: string) => `llm:cost:daily:${date}`;
const COST_RECORDS_KEY = (date: string) => `llm:cost:records:${date}`;
const DAILY_LIMIT_KEY = 'llm:cost:daily_limit';

// ---------- Pricing table (same as extractor for consistency) ------------------

const PRICING_TABLE: ModelPricing[] = [
  { provider: LLMProvider.OPENAI, model: 'gpt-4o', price_per_1k_input: 0.0025, price_per_1k_output: 0.01 },
  { provider: LLMProvider.OPENAI, model: 'gpt-4o-mini', price_per_1k_input: 0.00015, price_per_1k_output: 0.0006 },
  { provider: LLMProvider.OPENAI, model: 'gpt-4-turbo', price_per_1k_input: 0.01, price_per_1k_output: 0.03 },
  { provider: LLMProvider.ANTHROPIC, model: 'claude-sonnet-4-20250514', price_per_1k_input: 0.003, price_per_1k_output: 0.015 },
  { provider: LLMProvider.ANTHROPIC, model: 'claude-3-haiku-20240307', price_per_1k_input: 0.00025, price_per_1k_output: 0.00125 },
  { provider: LLMProvider.GOOGLE, model: 'gemini-1.5-pro', price_per_1k_input: 0.00125, price_per_1k_output: 0.005 },
  { provider: LLMProvider.GOOGLE, model: 'gemini-1.5-flash', price_per_1k_input: 0.000075, price_per_1k_output: 0.0003 },
  { provider: LLMProvider.LOCAL_OLLAMA, model: 'llama3', price_per_1k_input: 0, price_per_1k_output: 0 },
  { provider: LLMProvider.LOCAL_LMSTUDIO, model: 'default', price_per_1k_input: 0, price_per_1k_output: 0 },
];

function getPricing(provider: LLMProvider, model: string): ModelPricing {
  return PRICING_TABLE.find(p => p.provider === provider && p.model === model)
    ?? { provider, model, price_per_1k_input: 0.001, price_per_1k_output: 0.005 };
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateStr(date?: Date): string {
  return (date ?? new Date()).toISOString().slice(0, 10);
}

// ---------- Cost Tracker class ------------------------------------------------

export class CostTracker {
  private dailyLimitUsd: number;

  constructor(dailyLimitUsd = 100) {
    this.dailyLimitUsd = dailyLimitUsd;
  }

  /** Record a cost entry from an LLM API call. */
  async recordCost(record: CostRecord): Promise<void> {
    const day = dateStr(new Date(record.timestamp));
    const dailyKey = COST_DAILY_KEY(day);
    const recordsKey = COST_RECORDS_KEY(day);

    try {
      // Increment daily total
      const currentTotal = await cacheGet<number>(dailyKey) ?? 0;
      await cacheSet(dailyKey, currentTotal + record.cost_usd, 86400 * 7);

      // Append to records list
      const records = await cacheGet<CostRecord[]>(recordsKey) ?? [];
      records.push(record);
      await cacheSet(recordsKey, records, 86400 * 7);

      logger.debug({ provider: record.provider, model: record.model, cost: record.cost_usd, daily_total: currentTotal + record.cost_usd }, 'Cost recorded');
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to record cost');
    }
  }

  /** Get total spend for a given day. */
  async getDailySpend(date?: Date): Promise<number> {
    const day = dateStr(date);
    return await cacheGet<number>(COST_DAILY_KEY(day)) ?? 0;
  }

  /** Get cost records filtered by provider. */
  async getCostByProvider(provider: LLMProvider, period?: { start: Date; end: Date }): Promise<CostRecord[]> {
    const records = await this.getRecordsInRange(period);
    return records.filter(r => r.provider === provider);
  }

  /** Get cost records filtered by model. */
  async getCostByModel(model: string, period?: { start: Date; end: Date }): Promise<CostRecord[]> {
    const records = await this.getRecordsInRange(period);
    return records.filter(r => r.model === model);
  }

  /** Check if daily spend limit has been reached. */
  async isDailyLimitReached(): Promise<boolean> {
    const spend = await this.getDailySpend();
    return spend >= this.dailyLimitUsd;
  }

  /** Update the daily spend limit. */
  setDailyLimit(limitUsd: number): void {
    this.dailyLimitUsd = limitUsd;
    logger.info({ limit: limitUsd }, 'Daily spend limit updated');
  }

  /** Get remaining daily budget. */
  async getRemainingBudget(): Promise<number> {
    const spent = await this.getDailySpend();
    return Math.max(0, this.dailyLimitUsd - spent);
  }

  /** Generate a cost report for a time period. */
  async getCostReport(period?: { start: Date; end: Date }): Promise<CostReport> {
    const records = await this.getRecordsInRange(period);
    const totalCost = records.reduce((sum, r) => sum + r.cost_usd, 0);
    const totalTokens = records.reduce(
      (acc, r) => ({ input: acc.input + r.tokens_in, output: acc.output + r.tokens_out }),
      { input: 0, output: 0 },
    );

    const byProvider: Record<string, { cost_usd: number; calls: number }> = {};
    const byModel: Record<string, { cost_usd: number; calls: number }> = {};

    for (const r of records) {
      const pKey = r.provider;
      if (!byProvider[pKey]) byProvider[pKey] = { cost_usd: 0, calls: 0 };
      byProvider[pKey].cost_usd += r.cost_usd;
      byProvider[pKey].calls++;

      const mKey = r.model;
      if (!byModel[mKey]) byModel[mKey] = { cost_usd: 0, calls: 0 };
      byModel[mKey].cost_usd += r.cost_usd;
      byModel[mKey].calls++;
    }

    const todaySpend = await this.getDailySpend();

    return {
      total_cost_usd: Math.round(totalCost * 10000) / 10000,
      total_tokens: totalTokens,
      by_provider: byProvider,
      by_model: byModel,
      period: {
        start: period?.start?.getTime() ?? records[0]?.timestamp ?? Date.now(),
        end: period?.end?.getTime() ?? Date.now(),
      },
      daily_limit_remaining_usd: Math.max(0, this.dailyLimitUsd - todaySpend),
    };
  }

  /** Get pricing for a specific model. */
  getPricing(provider: LLMProvider, model: string): ModelPricing {
    return getPricing(provider, model);
  }

  /** Calculate estimated cost for a given token usage. */
  estimateCost(provider: LLMProvider, model: string, tokensIn: number, tokensOut: number): number {
    const pricing = getPricing(provider, model);
    return (tokensIn / 1000) * pricing.price_per_1k_input + (tokensOut / 1000) * pricing.price_per_1k_output;
  }

  // ---------- Internal helpers ------------------------------------------------

  private async getRecordsInRange(period?: { start: Date; end: Date }): Promise<CostRecord[]> {
    const now = new Date();
    const start = period?.start ?? new Date(now.getTime() - 86400000 * 30);
    const end = period?.end ?? now;

    const allRecords: CostRecord[] = [];
    const current = new Date(start);

    while (current <= end) {
      const day = dateStr(current);
      const records = await cacheGet<CostRecord[]>(COST_RECORDS_KEY(day));
      if (records) {
        allRecords.push(...records.filter(r => r.timestamp >= start.getTime() && r.timestamp <= end.getTime()));
      }
      current.setDate(current.getDate() + 1);
    }

    return allRecords;
  }
}
