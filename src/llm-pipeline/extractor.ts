/**
 * LLM Extractor -- ScrapeSuite Engine
 *
 * Core extraction logic that calls LLM providers and returns
 * structured data. Supports OpenAI, Anthropic, Google, and local
 * models via HTTP. Handles caching, retries, and cost tracking.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import {
  LLMProvider,
  LLMModelConfig,
  ExtractionRequest,
  ExtractionResult,
  ExtractionSchema,
  FewShotExample,
  CostRecord,
  ModelPricing,
} from './types';

const logger = createChildLogger('llm-pipeline:extractor');

// ---------- Pricing table (USD per 1K tokens) --------------------------------

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

function calculateCost(provider: LLMProvider, model: string, tokensIn: number, tokensOut: number): number {
  const pricing = getPricing(provider, model);
  return (tokensIn / 1000) * pricing.price_per_1k_input + (tokensOut / 1000) * pricing.price_per_1k_output;
}

// ---------- Prompt building ---------------------------------------------------

function buildSchemaPrompt(schema: ExtractionSchema): string {
  const fieldsDesc = schema.fields.map(f => {
    let desc = `  "${f.name}" (${f.type})${f.required ? ' REQUIRED' : ' OPTIONAL'}: ${f.description}`;
    if (f.enum_values?.length) desc += ` — one of: ${f.enum_values.join(', ')}`;
    return desc;
  }).join('\n');

  return (
    `Extract the following fields as a JSON object.\n` +
    `Schema: "${schema.name}" — ${schema.description}\n` +
    `Fields:\n${fieldsDesc}\n` +
    `Return ONLY valid JSON matching this schema. Use null for missing optional fields.`
  );
}

function buildFewShotBlock(examples?: FewShotExample[]): string {
  if (!examples?.length) return '';
  const blocks = examples.map((ex, i) =>
    `Example ${i + 1}:\nInput: ${ex.input}\nOutput: ${JSON.stringify(ex.output)}`
  );
  return `\n\nExamples:\n${blocks.join('\n\n')}`;
}

// ---------- Cache key ---------------------------------------------------------

function cacheKey(content: string, schema: ExtractionSchema, model: string): string {
  const hash = crypto.createHash('sha256')
    .update(content + JSON.stringify(schema) + model)
    .digest('hex');
  return `llm:extract:${hash}`;
}

// ---------- Provider HTTP callers ---------------------------------------------

interface ProviderResponse {
  content: string;
  tokens_in: number;
  tokens_out: number;
}

async function callOpenAI(config: LLMModelConfig, systemPrompt: string, userContent: string): Promise<ProviderResponse> {
  const apiKey = process.env.OPENAI_API_KEY || '';
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

  const body = {
    model: config.model,
    temperature: config.temperature,
    max_tokens: config.max_tokens,
    top_p: config.top_p,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_object' },
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeout_ms),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }

  const data = await res.json() as any;
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    tokens_in: data.usage?.prompt_tokens ?? 0,
    tokens_out: data.usage?.completion_tokens ?? 0,
  };
}

async function callAnthropic(config: LLMModelConfig, systemPrompt: string, userContent: string): Promise<ProviderResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1';

  const body = {
    model: config.model,
    max_tokens: config.max_tokens,
    temperature: config.temperature,
    top_p: config.top_p,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  };

  const res = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeout_ms),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  const data = await res.json() as any;
  const content = (data.content ?? []).map((b: any) => b.text ?? '').join('');
  return {
    content,
    tokens_in: data.usage?.input_tokens ?? 0,
    tokens_out: data.usage?.output_tokens ?? 0,
  };
}

async function callGoogle(config: LLMModelConfig, systemPrompt: string, userContent: string): Promise<ProviderResponse> {
  const apiKey = process.env.GOOGLE_AI_API_KEY || '';
  const baseUrl = process.env.GOOGLE_AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

  const body = {
    contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userContent}` }] }],
    generationConfig: { temperature: config.temperature, maxOutputTokens: config.max_tokens, topP: config.top_p },
  };

  const res = await fetch(`${baseUrl}/models/${config.model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeout_ms),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google AI API error ${res.status}: ${text}`);
  }

  const data = await res.json() as any;
  const content = (data.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
  return {
    content,
    tokens_in: data.usageMetadata?.promptTokenCount ?? 0,
    tokens_out: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

async function callLocal(config: LLMModelConfig, systemPrompt: string, userContent: string): Promise<ProviderResponse> {
  const isOllama = config.provider === LLMProvider.LOCAL_OLLAMA;
  const baseUrl = isOllama
    ? (process.env.OLLAMA_BASE_URL || 'http://localhost:11434')
    : (process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234');

  if (isOllama) {
    const body = {
      model: config.model,
      prompt: `${systemPrompt}\n\n${userContent}`,
      stream: false,
      options: { temperature: config.temperature, top_p: config.top_p, num_predict: config.max_tokens },
    };
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeout_ms),
    });
    if (!res.ok) throw new Error(`Ollama error ${res.status}`);
    const data = await res.json() as any;
    return { content: data.response ?? '', tokens_in: data.prompt_eval_count ?? 0, tokens_out: data.eval_count ?? 0 };
  }

  // LM Studio uses OpenAI-compatible API
  const body = {
    model: config.model,
    temperature: config.temperature,
    max_tokens: config.max_tokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  };
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeout_ms),
  });
  if (!res.ok) throw new Error(`LM Studio error ${res.status}`);
  const data = await res.json() as any;
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    tokens_in: data.usage?.prompt_tokens ?? 0,
    tokens_out: data.usage?.completion_tokens ?? 0,
  };
}

// ---------- Retry helper ------------------------------------------------------

async function withRetry<T>(fn: () => Promise<T>, retries: number, baseDelay: number): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt < retries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 200;
        logger.warn({ attempt, delay_ms: Math.round(delay), error: err.message }, 'Retrying LLM call');
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ---------- Extractor class ---------------------------------------------------

export class LLMExtractor {
  private onCostRecord?: (record: CostRecord) => void;

  constructor(opts?: { onCostRecord?: (record: CostRecord) => void }) {
    this.onCostRecord = opts?.onCostRecord;
  }

  /** Extract structured data from content using an LLM. */
  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const startTime = Date.now();
    const { content, schema, model_config, cache_ttl, system_prompt, few_shot_examples } = request;

    // Check cache first
    const key = cacheKey(content, schema, model_config.model);
    if (cache_ttl !== 0) {
      const cached = await cacheGet<ExtractionResult>(key);
      if (cached) {
        logger.info({ model: model_config.model, cached: true }, 'Cache hit for extraction');
        return { ...cached, cached: true };
      }
    }

    // Build prompts
    const schemaPrompt = buildSchemaPrompt(schema);
    const fewShotBlock = buildFewShotBlock(few_shot_examples);
    const sysPrompt = (system_prompt ?? 'You are a precise data extraction assistant.') + '\n\n' + schemaPrompt + fewShotBlock;
    const userContent = `Extract data from the following content:\n\n${content}`;

    // Call provider with retry
    const providerFn = this.getProviderFunction(model_config.provider);
    const response = await withRetry(
      () => providerFn(model_config, sysPrompt, userContent),
      model_config.retries,
      1000,
    );

    // Parse JSON response
    let extractedData: Record<string, unknown>;
    let parseErrors: string[] = [];
    try {
      const jsonStr = response.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      extractedData = JSON.parse(jsonStr);
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to parse LLM JSON response');
      extractedData = {};
      parseErrors.push(`JSON parse error: ${err.message}`);
    }

    // Validate and compute confidence
    const { validated, confidence, errors } = this.validateAgainstSchema(extractedData, schema);
    parseErrors = [...parseErrors, ...errors];

    // Calculate cost
    const costUsd = calculateCost(model_config.provider, model_config.model, response.tokens_in, response.tokens_out);
    const latencyMs = Date.now() - startTime;

    // Record cost
    const costRecord: CostRecord = {
      provider: model_config.provider,
      model: model_config.model,
      tokens_in: response.tokens_in,
      tokens_out: response.tokens_out,
      cost_usd: costUsd,
      timestamp: Date.now(),
      request_id: uuid(),
    };
    this.onCostRecord?.(costRecord);

    const result: ExtractionResult = {
      extracted_data: validated,
      confidence_score: confidence,
      tokens_used: { input: response.tokens_in, output: response.tokens_out },
      cost_usd: costUsd,
      latency_ms: latencyMs,
      model_used: model_config.model,
      cached: false,
      errors: parseErrors.length ? parseErrors : undefined,
    };

    // Cache the result
    const ttl = cache_ttl ?? 3600;
    if (ttl > 0) {
      await cacheSet(key, result, ttl).catch(err => logger.warn({ err }, 'Failed to cache extraction result'));
    }

    logger.info({ model: model_config.model, tokens: response.tokens_in + response.tokens_out, cost: costUsd, confidence, latency_ms: latencyMs }, 'Extraction complete');
    return result;
  }

  /** Select the correct provider function. */
  private getProviderFunction(provider: LLMProvider): (config: LLMModelConfig, sys: string, user: string) => Promise<ProviderResponse> {
    switch (provider) {
      case LLMProvider.OPENAI: return callOpenAI;
      case LLMProvider.ANTHROPIC: return callAnthropic;
      case LLMProvider.GOOGLE: return callGoogle;
      case LLMProvider.LOCAL_OLLAMA:
      case LLMProvider.LOCAL_LMSTUDIO: return callLocal;
      default: return callOpenAI;
    }
  }

  /** Validate extracted data against schema and compute confidence. */
  private validateAgainstSchema(data: Record<string, unknown>, schema: ExtractionSchema): {
    validated: Record<string, unknown>;
    confidence: number;
    errors: string[];
  } {
    const errors: string[] = [];
    let fieldScore = 0;
    const totalFields = schema.fields.length;
    const validated: Record<string, unknown> = {};

    for (const field of schema.fields) {
      const value = data[field.name];

      // Check required fields
      if (field.required && (value === undefined || value === null)) {
        errors.push(`Missing required field: ${field.name}`);
        validated[field.name] = null;
        continue;
      }

      // Type check for present values
      if (value !== undefined && value !== null) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (actualType !== field.type && !(actualType === 'number' && field.type === 'number')) {
          errors.push(`Field "${field.name}" expected ${field.type}, got ${actualType}`);
        }

        // Enum check
        if (field.enum_values?.length && typeof value === 'string' && !field.enum_values.includes(value)) {
          errors.push(`Field "${field.name}" value "${value}" not in enum: ${field.enum_values.join(', ')}`);
        }

        fieldScore++;
        validated[field.name] = value;
      } else {
        validated[field.name] = value ?? null;
        // Optional field present as null is OK
        if (!field.required) fieldScore += 0.5;
      }
    }

    const confidence = totalFields > 0 ? Math.round((fieldScore / totalFields) * 100) / 100 : 0;
    return { validated, confidence, errors };
  }
}
