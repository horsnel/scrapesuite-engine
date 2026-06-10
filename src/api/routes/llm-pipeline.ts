/**
 * LLM Pipeline API Routes -- ScrapeSuite Engine
 *
 * REST API endpoints for the LLM extraction pipeline including
 * single/batch extraction, prompt templates, and cost reporting.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { llmPipelineManager } from '../../llm-pipeline';
import { LLMProvider, LLMModelConfig, ExtractionSchema } from '../../llm-pipeline/types';

interface ExtractBody {
  content: string;
  schema: ExtractionSchema;
  provider?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  cache_ttl?: number;
  system_prompt?: string;
}

interface BatchExtractBody {
  items: string[];
  schema: ExtractionSchema;
  provider?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  concurrency?: number;
  cache_ttl?: number;
  system_prompt?: string;
}

interface TemplateExtractBody {
  template_name: string;
  content: string;
  variables?: Record<string, string>;
}

interface RegisterTemplateBody {
  name: string;
  template_text: string;
  variables: string[];
  schema: ExtractionSchema;
}

interface CostReportQuery {
  start_date?: string;
  end_date?: string;
}

export async function llmPipelineRoutes(app: FastifyInstance): Promise<void> {

  // Extract structured data from content
  app.post('/v1/llm/extract', async (req: FastifyRequest<{ Body: ExtractBody }>, reply: FastifyReply) => {
    const { content, schema, provider, model, temperature, max_tokens, cache_ttl, system_prompt } = req.body;

    if (!content || !schema) {
      return reply.status(400).send({ error: 'content and schema are required' });
    }

    const modelConfig: LLMModelConfig = {
      provider: (provider as LLMProvider) || LLMProvider.OPENAI,
      model: model || 'gpt-4o-mini',
      temperature: temperature ?? 0.1,
      max_tokens: max_tokens ?? 4096,
      top_p: 0.9,
      timeout_ms: 30000,
      retries: 2,
    };

    const result = await llmPipelineManager.extract({
      content,
      schema,
      model_config: modelConfig,
      cache_ttl,
      system_prompt,
    });

    return reply.send(result);
  });

  // Batch extract from multiple items
  app.post('/v1/llm/extract/batch', async (req: FastifyRequest<{ Body: BatchExtractBody }>, reply: FastifyReply) => {
    const { items, schema, provider, model, temperature, max_tokens, concurrency, cache_ttl, system_prompt } = req.body;

    if (!items?.length || !schema) {
      return reply.status(400).send({ error: 'items (non-empty array) and schema are required' });
    }

    const modelConfig: LLMModelConfig = {
      provider: (provider as LLMProvider) || LLMProvider.OPENAI,
      model: model || 'gpt-4o-mini',
      temperature: temperature ?? 0.1,
      max_tokens: max_tokens ?? 4096,
      top_p: 0.9,
      timeout_ms: 30000,
      retries: 2,
    };

    const result = await llmPipelineManager.extractBatch({
      items,
      schema,
      model_config: modelConfig,
      concurrency: concurrency ?? 3,
      cache_ttl,
      system_prompt,
    });

    return reply.send(result);
  });

  // Extract using a prompt template
  app.post('/v1/llm/extract/template', async (req: FastifyRequest<{ Body: TemplateExtractBody }>, reply: FastifyReply) => {
    const { template_name, content, variables } = req.body;

    if (!template_name || !content) {
      return reply.status(400).send({ error: 'template_name and content are required' });
    }

    const result = await llmPipelineManager.extractWithTemplate(template_name, content, variables);
    return reply.send(result);
  });

  // List prompt templates
  app.get('/v1/llm/templates', async (_req, reply) => {
    const templates = await llmPipelineManager.listTemplates();
    return reply.send({ templates });
  });

  // Register a custom prompt template
  app.post('/v1/llm/templates', async (req: FastifyRequest<{ Body: RegisterTemplateBody }>, reply: FastifyReply) => {
    const { name, template_text, variables, schema } = req.body;

    if (!name || !template_text || !schema) {
      return reply.status(400).send({ error: 'name, template_text, and schema are required' });
    }

    const template = await llmPipelineManager.registerTemplate({
      name,
      template_text,
      variables: variables ?? [],
      extraction_schema: schema,
    });

    return reply.status(201).send(template);
  });

  // Get cost report
  app.get('/v1/llm/costs', async (req: FastifyRequest<{ Querystring: CostReportQuery }>, reply) => {
    const { start_date, end_date } = req.query;
    const period = start_date && end_date ? {
      start: new Date(start_date),
      end: new Date(end_date),
    } : undefined;

    const report = await llmPipelineManager.getCostReport(period);
    return reply.send(report);
  });

  // Get pipeline configuration
  app.get('/v1/llm/config', async (_req, reply) => {
    return reply.send(llmPipelineManager.getConfig());
  });

  // Update daily spend limit
  app.put('/v1/llm/config/daily-limit', async (req: FastifyRequest<{ Body: { limit_usd: number } }>, reply) => {
    const { limit_usd } = req.body;
    if (typeof limit_usd !== 'number' || limit_usd < 0) {
      return reply.status(400).send({ error: 'limit_usd must be a positive number' });
    }
    llmPipelineManager.setDailyLimit(limit_usd);
    return reply.send({ limit_usd });
  });
}
