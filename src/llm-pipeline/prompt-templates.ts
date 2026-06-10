/**
 * Prompt Template Manager -- ScrapeSuite Engine
 *
 * Manages reusable prompt templates for LLM extraction tasks.
 * Provides pre-built templates for common scraping scenarios and
 * supports variable substitution with {{variable}} syntax.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { v4 as uuid } from 'uuid';
import { ExtractionSchema, PromptTemplate } from './types';

const logger = createChildLogger('llm-pipeline:prompt-templates');

const TEMPLATE_CACHE_PREFIX = 'llm:template:';
const TEMPLATE_LIST_KEY = 'llm:templates:list';

// ---------- Pre-built schemas -------------------------------------------------

const PRODUCT_SCHEMA: ExtractionSchema = {
  name: 'product',
  description: 'E-commerce product data',
  fields: [
    { name: 'title', type: 'string', description: 'Product name/title', required: true },
    { name: 'price', type: 'number', description: 'Current price', required: true },
    { name: 'currency', type: 'string', description: 'Currency code (USD, EUR, etc.)', required: false, enum_values: ['USD', 'EUR', 'GBP', 'JPY', 'CNY'] },
    { name: 'description', type: 'string', description: 'Product description', required: false },
    { name: 'availability', type: 'string', description: 'Stock status', required: false, enum_values: ['in_stock', 'out_of_stock', 'pre_order', 'limited'] },
    { name: 'rating', type: 'number', description: 'Average rating (0-5)', required: false },
    { name: 'review_count', type: 'number', description: 'Number of reviews', required: false },
    { name: 'brand', type: 'string', description: 'Brand name', required: false },
    { name: 'sku', type: 'string', description: 'SKU or product ID', required: false },
    { name: 'image_urls', type: 'array', description: 'Product image URLs', required: false },
  ],
};

const ARTICLE_SCHEMA: ExtractionSchema = {
  name: 'article',
  description: 'News article or blog post metadata',
  fields: [
    { name: 'title', type: 'string', description: 'Article headline', required: true },
    { name: 'author', type: 'string', description: 'Author name', required: false },
    { name: 'published_date', type: 'date', description: 'Publication date', required: false },
    { name: 'summary', type: 'string', description: 'Article summary/excerpt', required: false },
    { name: 'category', type: 'string', description: 'Article category/section', required: false },
    { name: 'tags', type: 'array', description: 'Tags or keywords', required: false },
    { name: 'word_count', type: 'number', description: 'Approximate word count', required: false },
    { name: 'sentiment', type: 'string', description: 'Overall sentiment', required: false, enum_values: ['positive', 'negative', 'neutral'] },
  ],
};

const CONTACT_SCHEMA: ExtractionSchema = {
  name: 'contact',
  description: 'Contact information from a page',
  fields: [
    { name: 'name', type: 'string', description: 'Contact person or company name', required: true },
    { name: 'email', type: 'string', description: 'Email address', required: false },
    { name: 'phone', type: 'string', description: 'Phone number', required: false },
    { name: 'address', type: 'string', description: 'Physical address', required: false },
    { name: 'website', type: 'string', description: 'Website URL', required: false },
    { name: 'social_profiles', type: 'array', description: 'Social media profile URLs', required: false },
    { name: 'job_title', type: 'string', description: 'Job title', required: false },
  ],
};

const PRICING_SCHEMA: ExtractionSchema = {
  name: 'pricing',
  description: 'Pricing plan information',
  fields: [
    { name: 'plan_name', type: 'string', description: 'Name of the pricing plan', required: true },
    { name: 'price', type: 'number', description: 'Price amount', required: true },
    { name: 'currency', type: 'string', description: 'Currency', required: false },
    { name: 'billing_period', type: 'string', description: 'Billing frequency', required: false, enum_values: ['monthly', 'yearly', 'weekly', 'one_time'] },
    { name: 'features', type: 'array', description: 'Included features list', required: false },
    { name: 'limitations', type: 'array', description: 'Plan limitations', required: false },
    { name: 'trial_available', type: 'boolean', description: 'Free trial available', required: false },
  ],
};

const REVIEW_SCHEMA: ExtractionSchema = {
  name: 'review',
  description: 'Product or service review',
  fields: [
    { name: 'reviewer', type: 'string', description: 'Reviewer name/username', required: true },
    { name: 'rating', type: 'number', description: 'Rating given (0-5)', required: true },
    { name: 'title', type: 'string', description: 'Review title', required: false },
    { name: 'body', type: 'string', description: 'Review text', required: false },
    { name: 'date', type: 'date', description: 'Review date', required: false },
    { name: 'verified', type: 'boolean', description: 'Verified purchase', required: false },
    { name: 'helpful_count', type: 'number', description: 'Number of helpful votes', required: false },
  ],
};

const JOB_SCHEMA: ExtractionSchema = {
  name: 'job_listing',
  description: 'Job posting data',
  fields: [
    { name: 'title', type: 'string', description: 'Job title', required: true },
    { name: 'company', type: 'string', description: 'Company name', required: true },
    { name: 'location', type: 'string', description: 'Job location', required: false },
    { name: 'salary_min', type: 'number', description: 'Minimum salary', required: false },
    { name: 'salary_max', type: 'number', description: 'Maximum salary', required: false },
    { name: 'employment_type', type: 'string', description: 'Employment type', required: false, enum_values: ['full_time', 'part_time', 'contract', 'remote', 'hybrid'] },
    { name: 'description', type: 'string', description: 'Job description', required: false },
    { name: 'requirements', type: 'array', description: 'Required qualifications', required: false },
    { name: 'posted_date', type: 'date', description: 'Date posted', required: false },
  ],
};

// ---------- Pre-built templates -----------------------------------------------

function builtInTemplates(): PromptTemplate[] {
  return [
    {
      id: 'tpl-product',
      name: 'product_extraction',
      template_text: 'Extract product details from this e-commerce page. Focus on the main product being sold. {{hint}}',
      variables: ['hint'],
      extraction_schema: PRODUCT_SCHEMA,
      created_at: Date.now(),
    },
    {
      id: 'tpl-article',
      name: 'article_extraction',
      template_text: 'Extract article metadata from this news/blog page. Pay attention to publication dates and author info. {{hint}}',
      variables: ['hint'],
      extraction_schema: ARTICLE_SCHEMA,
      created_at: Date.now(),
    },
    {
      id: 'tpl-contact',
      name: 'contact_extraction',
      template_text: 'Extract all contact information from this page including emails, phones, addresses, and social profiles. {{hint}}',
      variables: ['hint'],
      extraction_schema: CONTACT_SCHEMA,
      created_at: Date.now(),
    },
    {
      id: 'tpl-pricing',
      name: 'pricing_extraction',
      template_text: 'Extract all pricing plans and tiers from this page. Include features and limitations for each plan. {{hint}}',
      variables: ['hint'],
      extraction_schema: PRICING_SCHEMA,
      created_at: Date.now(),
    },
    {
      id: 'tpl-review',
      name: 'review_extraction',
      template_text: 'Extract individual reviews from this page. Capture each review as a separate data item with rating and text. {{hint}}',
      variables: ['hint'],
      extraction_schema: REVIEW_SCHEMA,
      created_at: Date.now(),
    },
    {
      id: 'tpl-job',
      name: 'job_extraction',
      template_text: 'Extract job listing details from this careers page. Include salary range if available. {{hint}}',
      variables: ['hint'],
      extraction_schema: JOB_SCHEMA,
      created_at: Date.now(),
    },
  ];
}

// ---------- Template Manager class -------------------------------------------

export class PromptTemplateManager {
  private templates: Map<string, PromptTemplate> = new Map();
  private initialized = false;

  /** Initialize by loading built-in templates and any cached custom ones. */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load built-in templates
    for (const tpl of builtInTemplates()) {
      this.templates.set(tpl.id, tpl);
    }

    // Load custom templates from Redis
    try {
      const customIds = await cacheGet<string[]>(TEMPLATE_LIST_KEY);
      if (customIds?.length) {
        for (const id of customIds) {
          const tpl = await cacheGet<PromptTemplate>(`${TEMPLATE_CACHE_PREFIX}${id}`);
          if (tpl) this.templates.set(tpl.id, tpl);
        }
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to load custom templates from Redis');
    }

    this.initialized = true;
    logger.info({ count: this.templates.size }, 'Template manager initialized');
  }

  /** Render a template by substituting {{variable}} placeholders. */
  renderTemplate(template: PromptTemplate, variables: Record<string, string>): string {
    let text = template.template_text;
    for (const [key, value] of Object.entries(variables)) {
      text = text.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }
    return text;
  }

  /** Register a new custom template. */
  async registerTemplate(template: Omit<PromptTemplate, 'id' | 'created_at'>): Promise<PromptTemplate> {
    await this.initialize();
    const tpl: PromptTemplate = {
      ...template,
      id: `tpl-custom-${uuid().slice(0, 8)}`,
      created_at: Date.now(),
    };
    this.templates.set(tpl.id, tpl);

    // Persist to Redis
    await cacheSet(`${TEMPLATE_CACHE_PREFIX}${tpl.id}`, tpl, 86400 * 30);
    const customIds = [...this.templates.values()]
      .filter(t => t.id.startsWith('tpl-custom-'))
      .map(t => t.id);
    await cacheSet(TEMPLATE_LIST_KEY, customIds, 86400 * 30);

    logger.info({ id: tpl.id, name: tpl.name }, 'Registered custom template');
    return tpl;
  }

  /** Get a template by ID or name. */
  async getTemplate(idOrName: string): Promise<PromptTemplate | null> {
    await this.initialize();
    // Try by ID first
    if (this.templates.has(idOrName)) return this.templates.get(idOrName)!;
    // Try by name
    for (const tpl of this.templates.values()) {
      if (tpl.name === idOrName) return tpl;
    }
    return null;
  }

  /** List all available templates. */
  async listTemplates(): Promise<PromptTemplate[]> {
    await this.initialize();
    return [...this.templates.values()];
  }

  /** Delete a custom template. */
  async deleteTemplate(id: string): Promise<boolean> {
    await this.initialize();
    if (!this.templates.has(id)) return false;
    this.templates.delete(id);
    const customIds = [...this.templates.values()]
      .filter(t => t.id.startsWith('tpl-custom-'))
      .map(t => t.id);
    await cacheSet(TEMPLATE_LIST_KEY, customIds, 86400 * 30);
    return true;
  }
}
