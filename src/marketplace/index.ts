/**
 * Dataset & Template Marketplace -- Browse, purchase, publish, and sell
 * scraping templates and pre-built datasets.
 *
 * Key features
 * ------------
 *  • Template Marketplace -- browse public templates, search by category, install, rate/review
 *  • Dataset Marketplace -- browse pre-built datasets, preview sample data, purchase with credits
 *  • Publisher System -- publish templates, set pricing (free or credit-based), revenue share
 *  • Categories -- E-Commerce, Social Media, Jobs, Real Estate, Travel, News, Finance, Tech, Education, Government
 *  • Search & Filter -- search by name, keyword, category, price, rating
 *  • Versioning -- templates have versions, changelogs, backwards compatibility flags
 *  • Quality Scoring -- auto-test templates against known URLs, score accuracy, flag broken ones
 *  • Revenue Tracking -- track downloads, revenue, payouts for publishers
 *  • Featured/Popular -- track most downloaded, highest rated, staff picks
 *  • Redis caching for popular templates/datasets, PostgreSQL for persistence
 *
 * Usage
 * -----
 *   import { marketplaceEngine } from './marketplace';
 *
 *   // Browse templates
 *   const templates = await marketplaceEngine.searchTemplates({ category: 'ecommerce' });
 *
 *   // Purchase a dataset
 *   await marketplaceEngine.purchaseDataset('ds_abc123', 'user_456');
 */

import { createChildLogger } from '../utils/logger';
import { redis, cacheGet, cacheSet, cacheDelete } from '../utils/redis';
import { db } from '../utils/db';
import { templateRegistry } from '../templates';
import crypto from 'crypto';

const logger = createChildLogger('marketplace');

// --- Public Types --------------------------------------------------------------

/** Supported marketplace categories. */
export type MarketplaceCategory =
  | 'ecommerce'
  | 'social-media'
  | 'jobs'
  | 'real-estate'
  | 'travel'
  | 'news'
  | 'finance'
  | 'tech'
  | 'education'
  | 'government';

/** All valid categories as a constant array for validation. */
export const MARKETPLACE_CATEGORIES: MarketplaceCategory[] = [
  'ecommerce',
  'social-media',
  'jobs',
  'real-estate',
  'travel',
  'news',
  'finance',
  'tech',
  'education',
  'government',
];

/** Human-readable labels for categories. */
export const CATEGORY_LABELS: Record<MarketplaceCategory, string> = {
  ecommerce: 'E-Commerce',
  'social-media': 'Social Media',
  jobs: 'Jobs',
  'real-estate': 'Real Estate',
  travel: 'Travel',
  news: 'News',
  finance: 'Finance',
  tech: 'Technology',
  education: 'Education',
  government: 'Government',
};

/** Pricing model for marketplace items. */
export type PricingModel = 'free' | 'credits';

/** Publication status for marketplace items. */
export type PublicationStatus = 'draft' | 'published' | 'deprecated' | 'removed';

/** Quality score breakdown for a template. */
export interface QualityScore {
  /** Overall quality score 0–100. */
  overall: number;
  /** Accuracy score -- how well the template extracts correct data. */
  accuracy: number;
  /** Reliability score -- success rate across test URLs. */
  reliability: number;
  /** Freshness score -- how recently the template was updated / tested. */
  freshness: number;
  /** Documentation score -- quality of description, schema, examples. */
  documentation: number;
  /** Number of test URLs used for scoring. */
  testUrlCount: number;
  /** Number of test URLs that passed. */
  testUrlPassed: number;
  /** Timestamp of the last quality test run. */
  lastTestedAt: string | null;
  /** Whether the template has been flagged as broken. */
  flaggedBroken: boolean;
}

/** A single version entry in a template's version history. */
export interface TemplateVersion {
  /** Semantic version string, e.g. '1.2.0'. */
  version: string;
  /** Human-readable changelog for this version. */
  changelog: string;
  /** Whether this version is backwards-compatible with the previous one. */
  backwardsCompatible: boolean;
  /** ISO timestamp when this version was published. */
  publishedAt: string;
  /** User ID of the publisher. */
  publishedBy: string;
}

/** A marketplace template listing. */
export interface MarketplaceTemplate {
  /** Unique template listing ID. */
  id: string;
  /** Reference to the internal scraper template ID (from templateRegistry). */
  templateId: string;
  /** Human-readable display name. */
  name: string;
  /** Short description for the marketplace listing. */
  description: string;
  /** Detailed long description (markdown supported). */
  longDescription: string;
  /** Category tag. */
  category: MarketplaceCategory;
  /** Tags / keywords for search. */
  tags: string[];
  /** Pricing model. */
  pricingModel: PricingModel;
  /** Cost in credits (only applicable when pricingModel is 'credits'). */
  creditCost: number;
  /** Publisher user ID. */
  publisherId: string;
  /** Publisher display name. */
  publisherName: string;
  /** Current version string. */
  currentVersion: string;
  /** Full version history. */
  versions: TemplateVersion[];
  /** Quality score. */
  qualityScore: QualityScore;
  /** Publication status. */
  status: PublicationStatus;
  /** Whether this is a staff pick. */
  staffPick: boolean;
  /** Total number of installs / downloads. */
  installCount: number;
  /** Average rating (0–5, one decimal). */
  avgRating: number;
  /** Total number of ratings. */
  ratingCount: number;
  /** Sample output schema. */
  outputSchema: Record<string, string>;
  /** Known domain patterns this template handles. */
  domainPatterns: string[];
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
}

/** A marketplace dataset listing. */
export interface MarketplaceDataset {
  /** Unique dataset ID. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Short description. */
  description: string;
  /** Detailed long description. */
  longDescription: string;
  /** Category tag. */
  category: MarketplaceCategory;
  /** Tags / keywords for search. */
  tags: string[];
  /** Pricing model. */
  pricingModel: PricingModel;
  /** Cost in credits. */
  creditCost: number;
  /** Publisher user ID. */
  publisherId: string;
  /** Publisher display name. */
  publisherName: string;
  /** Total number of rows in the dataset. */
  rowCount: number;
  /** Number of columns / fields. */
  columnCount: number;
  /** Column definitions with types. */
  columns: Array<{ name: string; type: string; description: string }>;
  /** Sample data (first 5 rows). */
  sampleData: Record<string, any>[];
  /** Full storage key (S3 / GCS) for the dataset file. */
  storageKey: string;
  /** File format: json, csv, parquet. */
  format: 'json' | 'csv' | 'parquet';
  /** File size in bytes. */
  fileSizeBytes: number;
  /** Quality score. */
  qualityScore: QualityScore;
  /** Publication status. */
  status: PublicationStatus;
  /** Whether this is a staff pick. */
  staffPick: boolean;
  /** Total number of purchases. */
  purchaseCount: number;
  /** Average rating. */
  avgRating: number;
  /** Total number of ratings. */
  ratingCount: number;
  /** ISO timestamp of data freshness. */
  dataAsOf: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
}

/** A user review / rating for a marketplace item. */
export interface MarketplaceReview {
  /** Unique review ID. */
  id: string;
  /** The item being reviewed (template or dataset ID). */
  itemId: string;
  /** Item type. */
  itemType: 'template' | 'dataset';
  /** User ID of the reviewer. */
  userId: string;
  /** User display name. */
  userName: string;
  /** Rating from 1 to 5. */
  rating: number;
  /** Written review text. */
  reviewText: string;
  /** ISO timestamp. */
  createdAt: string;
}

/** Revenue record for a publisher. */
export interface PublisherRevenue {
  /** Publisher user ID. */
  publisherId: string;
  /** Total revenue in credits. */
  totalRevenue: number;
  /** Revenue pending payout. */
  pendingPayout: number;
  /** Revenue already paid out. */
  paidOut: number;
  /** Total number of sales. */
  totalSales: number;
  /** Revenue breakdown by item. */
  items: Array<{
    itemId: string;
    itemType: 'template' | 'dataset';
    name: string;
    sales: number;
    revenue: number;
  }>;
  /** Revenue breakdown by month. */
  monthly: Array<{
    month: string; // 'YYYY-MM'
    revenue: number;
    sales: number;
  }>;
}

/** Search / filter parameters for marketplace queries. */
export interface MarketplaceSearchParams {
  /** Free-text search query (matches name, description, tags). */
  query?: string;
  /** Filter by category. */
  category?: MarketplaceCategory;
  /** Filter by pricing model. */
  pricingModel?: PricingModel;
  /** Minimum average rating. */
  minRating?: number;
  /** Maximum credit cost. */
  maxPrice?: number;
  /** Only staff picks. */
  staffPicksOnly?: boolean;
  /** Only items from a specific publisher. */
  publisherId?: string;
  /** Sort order. */
  sort?: 'popular' | 'newest' | 'rating' | 'price-asc' | 'price-desc';
  /** Pagination offset. */
  offset?: number;
  /** Pagination limit. */
  limit?: number;
}

/** Paginated result set. */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

/** Options for publishing a new template to the marketplace. */
export interface PublishTemplateOptions {
  /** The internal template ID to base this listing on. */
  templateId: string;
  /** Display name. */
  name: string;
  /** Short description. */
  description: string;
  /** Long description (markdown). */
  longDescription?: string;
  /** Category. */
  category: MarketplaceCategory;
  /** Tags. */
  tags?: string[];
  /** Pricing model. */
  pricingModel: PricingModel;
  /** Credit cost (required when pricingModel is 'credits'). */
  creditCost?: number;
  /** Publisher user ID. */
  publisherId: string;
  /** Publisher display name. */
  publisherName: string;
  /** Initial version string. */
  version?: string;
  /** Changelog for the initial version. */
  changelog?: string;
}

/** Options for publishing a new dataset to the marketplace. */
export interface PublishDatasetOptions {
  name: string;
  description: string;
  longDescription?: string;
  category: MarketplaceCategory;
  tags?: string[];
  pricingModel: PricingModel;
  creditCost?: number;
  publisherId: string;
  publisherName: string;
  columns: Array<{ name: string; type: string; description: string }>;
  sampleData: Record<string, any>[];
  storageKey: string;
  format: 'json' | 'csv' | 'parquet';
  fileSizeBytes: number;
  rowCount: number;
  dataAsOf: string;
}

/** Options for updating a template version. */
export interface UpdateTemplateVersionOptions {
  /** Marketplace template ID. */
  templateListingId: string;
  /** New version string (must be greater than current). */
  version: string;
  /** Changelog for the new version. */
  changelog: string;
  /** Whether this version is backwards-compatible. */
  backwardsCompatible: boolean;
  /** Publisher user ID (must match original publisher). */
  publisherId: string;
}

/** Result of a purchase operation. */
export interface PurchaseResult {
  success: boolean;
  itemId: string;
  itemType: 'template' | 'dataset';
  creditsCharged: number;
  downloadUrl?: string;
  error?: string;
}

// --- Constants -----------------------------------------------------------------

/** Revenue share percentage for publishers (70%). */
const PUBLISHER_REVENUE_SHARE = 0.70;

/** Platform commission percentage (30%). */
const PLATFORM_COMMISSION = 0.30;

/** Cache TTL for popular templates (5 minutes). */
const POPULAR_CACHE_TTL = 300;

/** Cache TTL for individual template/dataset lookups (2 minutes). */
const ITEM_CACHE_TTL = 120;

/** Cache TTL for search results (1 minute). */
const SEARCH_CACHE_TTL = 60;

/** Maximum review text length. */
const MAX_REVIEW_LENGTH = 2000;

/** Minimum rating value. */
const MIN_RATING = 1;

/** Maximum rating value. */
const MAX_RATING = 5;

/** Default search result limit. */
const DEFAULT_SEARCH_LIMIT = 20;

/** Maximum search result limit. */
const MAX_SEARCH_LIMIT = 100;

/** Minimum credit cost for paid items. */
const MIN_CREDIT_COST = 1;

/** Maximum credit cost for any single item. */
const MAX_CREDIT_COST = 10000;

// --- Marketplace Engine --------------------------------------------------------

export class MarketplaceEngine {
  // --- Template Marketplace --------------------------------------------------

  /**
   * Search and filter templates in the marketplace.
   *
   * Results are cached in Redis for fast repeated queries. Popular sort
   * uses install count as the primary ranking signal.
   */
  async searchTemplates(params: MarketplaceSearchParams = {}): Promise<PaginatedResult<MarketplaceTemplate>> {
    const {
      query,
      category,
      pricingModel,
      minRating,
      maxPrice,
      staffPicksOnly,
      publisherId,
      sort = 'popular',
      offset = 0,
      limit = DEFAULT_SEARCH_LIMIT,
    } = params;

    const effectiveLimit = Math.min(limit, MAX_SEARCH_LIMIT);

    // Check cache for identical search queries
    const cacheKey = `marketplace:templates:search:${crypto
      .createHash('sha256')
      .update(JSON.stringify(params))
      .digest('hex')
      .substring(0, 16)}`;

    try {
      const cached = await cacheGet<PaginatedResult<MarketplaceTemplate>>(cacheKey);
      if (cached) return cached;
    } catch {
      // Cache miss -- continue to DB query
    }

    try {
      // Build where clause for Prisma query
      const where: any = {
        status: 'published',
        itemType: 'template',
      };

      if (category) where.category = category;
      if (pricingModel) where.pricingModel = pricingModel;
      if (staffPicksOnly) where.staffPick = true;
      if (publisherId) where.publisherId = publisherId;
      if (minRating) where.avgRating = { gte: minRating };
      if (maxPrice !== undefined) where.creditCost = { lte: maxPrice };

      if (query) {
        where.OR = [
          { name: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
          { tags: { has: query } },
        ];
      }

      // Determine sort order
      let orderBy: any;
      switch (sort) {
        case 'popular':
          orderBy = { installCount: 'desc' };
          break;
        case 'newest':
          orderBy = { createdAt: 'desc' };
          break;
        case 'rating':
          orderBy = { avgRating: 'desc' };
          break;
        case 'price-asc':
          orderBy = { creditCost: 'asc' };
          break;
        case 'price-desc':
          orderBy = { creditCost: 'desc' };
          break;
        default:
          orderBy = { installCount: 'desc' };
      }

      const [items, total] = await Promise.all([
        db.marketplaceItem.findMany({
          where,
          orderBy,
          skip: offset,
          take: effectiveLimit,
        }),
        db.marketplaceItem.count({ where }),
      ]);

      const templates = items.map((item: any) => this.dbItemToTemplate(item));

      const result: PaginatedResult<MarketplaceTemplate> = {
        items: templates,
        total,
        offset,
        limit: effectiveLimit,
      };

      // Cache the result
      await cacheSet(cacheKey, result, SEARCH_CACHE_TTL).catch(() => {});

      return result;
    } catch (err: any) {
      logger.error({ err: err.message, params }, 'Template search failed');
      return { items: [], total: 0, offset, limit: effectiveLimit };
    }
  }

  /**
   * Get a single template by its marketplace ID.
   * Checks Redis cache first, falls back to DB.
   */
  async getTemplate(templateListingId: string): Promise<MarketplaceTemplate | null> {
    // Check cache
    const cacheKey = `marketplace:template:${templateListingId}`;
    try {
      const cached = await cacheGet<MarketplaceTemplate>(cacheKey);
      if (cached) return cached;
    } catch {
      // Cache miss
    }

    try {
      const item = await db.marketplaceItem.findUnique({
        where: { id: templateListingId, itemType: 'template' },
      });

      if (!item) return null;

      const template = this.dbItemToTemplate(item);

      // Cache the result
      await cacheSet(cacheKey, template, ITEM_CACHE_TTL).catch(() => {});

      return template;
    } catch (err: any) {
      logger.error({ err: err.message, templateListingId }, 'Get template failed');
      return null;
    }
  }

  /**
   * Get featured / staff-pick templates.
   * Results are cached for 5 minutes.
   */
  async getFeaturedTemplates(limit: number = 10): Promise<MarketplaceTemplate[]> {
    const cacheKey = `marketplace:templates:featured:${limit}`;
    try {
      const cached = await cacheGet<MarketplaceTemplate[]>(cacheKey);
      if (cached) return cached;
    } catch {
      // Cache miss
    }

    try {
      const items = await db.marketplaceItem.findMany({
        where: { itemType: 'template', status: 'published', staffPick: true },
        orderBy: [{ avgRating: 'desc' }, { installCount: 'desc' }],
        take: limit,
      });

      const templates = items.map((item: any) => this.dbItemToTemplate(item));
      await cacheSet(cacheKey, templates, POPULAR_CACHE_TTL).catch(() => {});
      return templates;
    } catch (err: any) {
      logger.error({ err: err.message }, 'Get featured templates failed');
      return [];
    }
  }

  /**
   * Get the most popular templates by install count.
   * Results are cached for 5 minutes.
   */
  async getPopularTemplates(limit: number = 20): Promise<MarketplaceTemplate[]> {
    const cacheKey = `marketplace:templates:popular:${limit}`;
    try {
      const cached = await cacheGet<MarketplaceTemplate[]>(cacheKey);
      if (cached) return cached;
    } catch {
      // Cache miss
    }

    try {
      const items = await db.marketplaceItem.findMany({
        where: { itemType: 'template', status: 'published' },
        orderBy: { installCount: 'desc' },
        take: limit,
      });

      const templates = items.map((item: any) => this.dbItemToTemplate(item));
      await cacheSet(cacheKey, templates, POPULAR_CACHE_TTL).catch(() => {});
      return templates;
    } catch (err: any) {
      logger.error({ err: err.message }, 'Get popular templates failed');
      return [];
    }
  }

  /**
   * Get the highest-rated templates.
   */
  async getTopRatedTemplates(limit: number = 20): Promise<MarketplaceTemplate[]> {
    const cacheKey = `marketplace:templates:top-rated:${limit}`;
    try {
      const cached = await cacheGet<MarketplaceTemplate[]>(cacheKey);
      if (cached) return cached;
    } catch {
      // Cache miss
    }

    try {
      const items = await db.marketplaceItem.findMany({
        where: { itemType: 'template', status: 'published', ratingCount: { gte: 3 } },
        orderBy: { avgRating: 'desc' },
        take: limit,
      });

      const templates = items.map((item: any) => this.dbItemToTemplate(item));
      await cacheSet(cacheKey, templates, POPULAR_CACHE_TTL).catch(() => {});
      return templates;
    } catch (err: any) {
      logger.error({ err: err.message }, 'Get top rated templates failed');
      return [];
    }
  }

  /**
   * Install a template to a user's account. Free templates are installed
   * immediately; paid templates require a credit purchase first.
   */
  async installTemplate(
    templateListingId: string,
    userId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const template = await this.getTemplate(templateListingId);
      if (!template) {
        return { success: false, error: 'Template not found' };
      }

      if (template.status !== 'published') {
        return { success: false, error: 'Template is not available for installation' };
      }

      // Check if already installed
      const existing = await db.userInstalledTemplate.findUnique({
        where: {
          userId_itemId: { userId, itemId: templateListingId },
        },
      });

      if (existing) {
        return { success: false, error: 'Template already installed' };
      }

      // If it's a paid template, require a prior purchase
      if (template.pricingModel === 'credits' && template.creditCost > 0) {
        const purchase = await db.marketplacePurchase.findFirst({
          where: {
            userId,
            itemId: templateListingId,
            itemType: 'template',
            status: 'completed',
          },
        });

        if (!purchase) {
          return { success: false, error: 'Template must be purchased before installation' };
        }
      }

      // Install the template
      await db.userInstalledTemplate.create({
        data: {
          id: crypto.randomUUID(),
          userId,
          templateListingId,
          itemId: templateListingId,
          version: template.currentVersion,
          installedAt: new Date(),
        },
      });

      // Increment install count
      await db.marketplaceItem.update({
        where: { id: templateListingId },
        data: { installCount: { increment: 1 } },
      });

      // Invalidate caches
      await this.invalidateTemplateCaches(templateListingId);

      logger.info({ templateListingId, userId }, 'Template installed');
      return { success: true };
    } catch (err: any) {
      logger.error({ err: err.message, templateListingId, userId }, 'Template install failed');
      return { success: false, error: err.message };
    }
  }

  /**
   * Get all templates installed by a user.
   */
  async getUserInstalledTemplates(userId: string): Promise<Array<{
    templateListingId: string;
    templateId: string;
    version: string;
    installedAt: string;
  }>> {
    try {
      const installed = await db.userInstalledTemplate.findMany({
        where: { userId },
        orderBy: { installedAt: 'desc' },
      });

      return installed.map((i: any) => ({
        templateListingId: i.templateListingId,
        templateId: i.templateId,
        version: i.version,
        installedAt: i.installedAt?.toISOString() ?? '',
      }));
    } catch (err: any) {
      logger.error({ err: err.message, userId }, 'Get user installed templates failed');
      return [];
    }
  }

  /**
   * Uninstall a template from a user's account.
   */
  async uninstallTemplate(
    templateListingId: string,
    userId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const existing = await db.userInstalledTemplate.findUnique({
        where: {
          userId_itemId: { userId, itemId: templateListingId },
        },
      });

      if (!existing) {
        return { success: false, error: 'Template not installed' };
      }

      await db.userInstalledTemplate.delete({
        where: {
          userId_itemId: { userId, itemId: templateListingId },
        },
      });

      // Decrement install count
      await db.marketplaceItem.update({
        where: { id: templateListingId },
        data: { installCount: { decrement: 1 } },
      });

      await this.invalidateTemplateCaches(templateListingId);

      logger.info({ templateListingId, userId }, 'Template uninstalled');
      return { success: true };
    } catch (err: any) {
      logger.error({ err: err.message, templateListingId, userId }, 'Template uninstall failed');
      return { success: false, error: err.message };
    }
  }

  // --- Dataset Marketplace ---------------------------------------------------

  /**
   * Search and filter datasets in the marketplace.
   */
  async searchDatasets(params: MarketplaceSearchParams = {}): Promise<PaginatedResult<MarketplaceDataset>> {
    const {
      query,
      category,
      pricingModel,
      minRating,
      maxPrice,
      staffPicksOnly,
      publisherId,
      sort = 'popular',
      offset = 0,
      limit = DEFAULT_SEARCH_LIMIT,
    } = params;

    const effectiveLimit = Math.min(limit, MAX_SEARCH_LIMIT);

    const cacheKey = `marketplace:datasets:search:${crypto
      .createHash('sha256')
      .update(JSON.stringify(params))
      .digest('hex')
      .substring(0, 16)}`;

    try {
      const cached = await cacheGet<PaginatedResult<MarketplaceDataset>>(cacheKey);
      if (cached) return cached;
    } catch {
      // Cache miss
    }

    try {
      const where: any = {
        status: 'published',
        itemType: 'dataset',
      };

      if (category) where.category = category;
      if (pricingModel) where.pricingModel = pricingModel;
      if (staffPicksOnly) where.staffPick = true;
      if (publisherId) where.publisherId = publisherId;
      if (minRating) where.avgRating = { gte: minRating };
      if (maxPrice !== undefined) where.creditCost = { lte: maxPrice };

      if (query) {
        where.OR = [
          { name: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
          { tags: { has: query } },
        ];
      }

      let orderBy: any;
      switch (sort) {
        case 'popular':
          orderBy = { purchaseCount: 'desc' };
          break;
        case 'newest':
          orderBy = { createdAt: 'desc' };
          break;
        case 'rating':
          orderBy = { avgRating: 'desc' };
          break;
        case 'price-asc':
          orderBy = { creditCost: 'asc' };
          break;
        case 'price-desc':
          orderBy = { creditCost: 'desc' };
          break;
        default:
          orderBy = { purchaseCount: 'desc' };
      }

      const [items, total] = await Promise.all([
        db.marketplaceItem.findMany({
          where,
          orderBy,
          skip: offset,
          take: effectiveLimit,
        }),
        db.marketplaceItem.count({ where }),
      ]);

      const datasets = items.map((item: any) => this.dbItemToDataset(item));

      const result: PaginatedResult<MarketplaceDataset> = {
        items: datasets,
        total,
        offset,
        limit: effectiveLimit,
      };

      await cacheSet(cacheKey, result, SEARCH_CACHE_TTL).catch(() => {});
      return result;
    } catch (err: any) {
      logger.error({ err: err.message, params }, 'Dataset search failed');
      return { items: [], total: 0, offset, limit: effectiveLimit };
    }
  }

  /**
   * Get a single dataset by its marketplace ID.
   */
  async getDataset(datasetId: string): Promise<MarketplaceDataset | null> {
    const cacheKey = `marketplace:dataset:${datasetId}`;
    try {
      const cached = await cacheGet<MarketplaceDataset>(cacheKey);
      if (cached) return cached;
    } catch {
      // Cache miss
    }

    try {
      const item = await db.marketplaceItem.findUnique({
        where: { id: datasetId, itemType: 'dataset' },
      });

      if (!item) return null;

      const dataset = this.dbItemToDataset(item);
      await cacheSet(cacheKey, dataset, ITEM_CACHE_TTL).catch(() => {});
      return dataset;
    } catch (err: any) {
      logger.error({ err: err.message, datasetId }, 'Get dataset failed');
      return null;
    }
  }

  /**
   * Preview sample data for a dataset. Returns the first 5 rows only.
   */
  async previewDataset(datasetId: string): Promise<Record<string, any>[] | null> {
    try {
      const dataset = await this.getDataset(datasetId);
      if (!dataset) return null;

      // Return sample data from the dataset record
      return dataset.sampleData || [];
    } catch (err: any) {
      logger.error({ err: err.message, datasetId }, 'Dataset preview failed');
      return null;
    }
  }

  /**
   * Purchase a dataset with credits. Deducts credits from the user's balance
   * and records the transaction. Returns a download URL on success.
   */
  async purchaseDataset(datasetId: string, userId: string): Promise<PurchaseResult> {
    return this.purchaseItem(datasetId, 'dataset', userId);
  }

  /**
   * Get featured datasets.
   */
  async getFeaturedDatasets(limit: number = 10): Promise<MarketplaceDataset[]> {
    const cacheKey = `marketplace:datasets:featured:${limit}`;
    try {
      const cached = await cacheGet<MarketplaceDataset[]>(cacheKey);
      if (cached) return cached;
    } catch {
      // Cache miss
    }

    try {
      const items = await db.marketplaceItem.findMany({
        where: { itemType: 'dataset', status: 'published', staffPick: true },
        orderBy: [{ avgRating: 'desc' }, { purchaseCount: 'desc' }],
        take: limit,
      });

      const datasets = items.map((item: any) => this.dbItemToDataset(item));
      await cacheSet(cacheKey, datasets, POPULAR_CACHE_TTL).catch(() => {});
      return datasets;
    } catch (err: any) {
      logger.error({ err: err.message }, 'Get featured datasets failed');
      return [];
    }
  }

  /**
   * Get the most popular datasets by purchase count.
   */
  async getPopularDatasets(limit: number = 20): Promise<MarketplaceDataset[]> {
    const cacheKey = `marketplace:datasets:popular:${limit}`;
    try {
      const cached = await cacheGet<MarketplaceDataset[]>(cacheKey);
      if (cached) return cached;
    } catch {
      // Cache miss
    }

    try {
      const items = await db.marketplaceItem.findMany({
        where: { itemType: 'dataset', status: 'published' },
        orderBy: { purchaseCount: 'desc' },
        take: limit,
      });

      const datasets = items.map((item: any) => this.dbItemToDataset(item));
      await cacheSet(cacheKey, datasets, POPULAR_CACHE_TTL).catch(() => {});
      return datasets;
    } catch (err: any) {
      logger.error({ err: err.message }, 'Get popular datasets failed');
      return [];
    }
  }

  // --- Publisher System -------------------------------------------------------

  /**
   * Publish a new template to the marketplace.
   *
   * Validates that the referenced templateId exists in the template registry,
   * enforces pricing rules, and creates the marketplace listing in draft status
   * before auto-publishing (if validation passes).
   */
  async publishTemplate(options: PublishTemplateOptions): Promise<{ success: boolean; templateListingId?: string; error?: string }> {
    try {
      // Validate template exists in the registry
      const registryTemplate = templateRegistry.getTemplate(options.templateId);
      if (!registryTemplate) {
        return { success: false, error: `Template '${options.templateId}' not found in template registry` };
      }

      // Validate pricing
      if (options.pricingModel === 'credits') {
        if (!options.creditCost || options.creditCost < MIN_CREDIT_COST) {
          return { success: false, error: `Credit cost must be at least ${MIN_CREDIT_COST}` };
        }
        if (options.creditCost > MAX_CREDIT_COST) {
          return { success: false, error: `Credit cost cannot exceed ${MAX_CREDIT_COST}` };
        }
      }

      // Validate category
      if (!MARKETPLACE_CATEGORIES.includes(options.category)) {
        return { success: false, error: `Invalid category: ${options.category}` };
      }

      // Check for duplicate listing by same publisher for same template
      const existing = await db.marketplaceItem.findFirst({
        where: {
          templateId: options.templateId,
          publisherId: options.publisherId,
          itemType: 'template',
          status: { notIn: ['removed'] },
        },
      });

      if (existing) {
        return { success: false, error: 'You have already published this template' };
      }

      const version = options.version || '1.0.0';
      const id = crypto.randomUUID();

      // Build quality score (initial -- will be updated by auto-test)
      const initialQualityScore: QualityScore = {
        overall: 50,
        accuracy: 50,
        reliability: 50,
        freshness: 100,
        documentation: options.longDescription ? 70 : 40,
        testUrlCount: 0,
        testUrlPassed: 0,
        lastTestedAt: null,
        flaggedBroken: false,
      };

      const versions: TemplateVersion[] = [
        {
          version,
          changelog: options.changelog || 'Initial release',
          backwardsCompatible: true,
          publishedAt: new Date().toISOString(),
          publishedBy: options.publisherId,
        },
      ];

      await db.marketplaceItem.create({
        data: {
          id,
          authorId: options.publisherId,
          slug: `${options.category}-${id.substring(0, 8)}`,
          templateId: options.templateId,
          itemType: 'template',
          name: options.name,
          description: options.description,
          longDescription: options.longDescription || '',
          category: options.category,
          tags: options.tags || [],
          pricingModel: options.pricingModel,
          creditCost: options.pricingModel === 'credits' ? (options.creditCost || 0) : 0,
          publisherId: options.publisherId,
          currentVersion: version,
          version: version,
          qualityScore: initialQualityScore as any,
          status: 'published',
          staffPick: false,
          installCount: 0,
          purchaseCount: 0,
          avgRating: 0,
          ratingCount: 0,
          schema: registryTemplate.outputSchema as any,
          domainPatterns: registryTemplate.domainPatterns as any,
        },
      });

      // Invalidate list caches
      await this.invalidateListCaches();

      logger.info({ templateListingId: id, templateId: options.templateId, publisherId: options.publisherId }, 'Template published to marketplace');
      return { success: true, templateListingId: id };
    } catch (err: any) {
      logger.error({ err: err.message, options }, 'Publish template failed');
      return { success: false, error: err.message };
    }
  }

  /**
   * Publish a new dataset to the marketplace.
   */
  async publishDataset(options: PublishDatasetOptions): Promise<{ success: boolean; datasetId?: string; error?: string }> {
    try {
      // Validate pricing
      if (options.pricingModel === 'credits') {
        if (!options.creditCost || options.creditCost < MIN_CREDIT_COST) {
          return { success: false, error: `Credit cost must be at least ${MIN_CREDIT_COST}` };
        }
        if (options.creditCost > MAX_CREDIT_COST) {
          return { success: false, error: `Credit cost cannot exceed ${MAX_CREDIT_COST}` };
        }
      }

      // Validate category
      if (!MARKETPLACE_CATEGORIES.includes(options.category)) {
        return { success: false, error: `Invalid category: ${options.category}` };
      }

      const id = crypto.randomUUID();

      const initialQualityScore: QualityScore = {
        overall: 60,
        accuracy: 70,
        reliability: 70,
        freshness: 100,
        documentation: options.longDescription ? 70 : 40,
        testUrlCount: 0,
        testUrlPassed: 0,
        lastTestedAt: null,
        flaggedBroken: false,
      };

      await db.marketplaceItem.create({
        data: {
          id,
          authorId: options.publisherId,
          slug: `${options.category}-${id.substring(0, 8)}`,
          templateId: '',
          itemType: 'dataset',
          name: options.name,
          description: options.description,
          longDescription: options.longDescription || '',
          category: options.category,
          tags: options.tags || [],
          pricingModel: options.pricingModel,
          creditCost: options.pricingModel === 'credits' ? (options.creditCost || 0) : 0,
          publisherId: options.publisherId,
          currentVersion: '1.0.0',
          version: '1.0.0',
          qualityScore: initialQualityScore as any,
          status: 'published',
          staffPick: false,
          installCount: 0,
          purchaseCount: 0,
          avgRating: 0,
          ratingCount: 0,
          schema: {} as any,
          domainPatterns: [] as any,
          // Dataset-specific fields stored in metadata JSON
          metadata: {
            columns: options.columns,
            sampleData: options.sampleData,
            storageKey: options.storageKey,
            format: options.format,
            fileSizeBytes: options.fileSizeBytes,
            rowCount: options.rowCount,
            columnCount: options.columns.length,
            dataAsOf: options.dataAsOf,
          } as any,
        },
      });

      await this.invalidateListCaches();

      logger.info({ datasetId: id, publisherId: options.publisherId }, 'Dataset published to marketplace');
      return { success: true, datasetId: id };
    } catch (err: any) {
      logger.error({ err: err.message, options }, 'Publish dataset failed');
      return { success: false, error: err.message };
    }
  }

  /**
   * Update a template to a new version. Validates that the new version
   * string is greater than the current version.
   */
  async updateTemplateVersion(
    options: UpdateTemplateVersionOptions,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const item = await db.marketplaceItem.findUnique({
        where: { id: options.templateListingId },
      });

      if (!item) {
        return { success: false, error: 'Template listing not found' };
      }

      if (item.publisherId !== options.publisherId) {
        return { success: false, error: 'Only the original publisher can update this template' };
      }

      // Validate version increment
      if (!this.isVersionGreater(options.version, item.currentVersion)) {
        return { success: false, error: `New version (${options.version}) must be greater than current version (${item.currentVersion})` };
      }

      const existingVersions: TemplateVersion[] = item.version ? [{
        version: item.version,
        changelog: '',
        backwardsCompatible: true,
        publishedAt: item.createdAt?.toISOString?.() ?? new Date().toISOString(),
        publishedBy: item.authorId,
      }] : [];
      const newVersion: TemplateVersion = {
        version: options.version,
        changelog: options.changelog,
        backwardsCompatible: options.backwardsCompatible,
        publishedAt: new Date().toISOString(),
        publishedBy: options.publisherId,
      };

      const updatedVersions = [...existingVersions, newVersion];

      await db.marketplaceItem.update({
        where: { id: options.templateListingId },
        data: {
          currentVersion: options.version,
          version: options.version,
          updatedAt: new Date(),
          status: 'published', // Re-publish on update
        },
      });

      // Invalidate caches
      await this.invalidateTemplateCaches(options.templateListingId);

      logger.info(
        { templateListingId: options.templateListingId, version: options.version, backwardsCompatible: options.backwardsCompatible },
        'Template version updated',
      );

      return { success: true };
    } catch (err: any) {
      logger.error({ err: err.message, options }, 'Update template version failed');
      return { success: false, error: err.message };
    }
  }

  /**
   * Deprecate a marketplace item. It will no longer appear in search results
   * but remains accessible via direct link for existing purchasers.
   */
  async deprecateItem(
    itemId: string,
    publisherId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const item = await db.marketplaceItem.findUnique({ where: { id: itemId } });
      if (!item) return { success: false, error: 'Item not found' };
      if (item.publisherId !== publisherId) return { success: false, error: 'Only the publisher can deprecate this item' };

      await db.marketplaceItem.update({
        where: { id: itemId },
        data: { status: 'deprecated', updatedAt: new Date() },
      });

      await this.invalidateTemplateCaches(itemId);
      await this.invalidateListCaches();

      logger.info({ itemId, publisherId }, 'Marketplace item deprecated');
      return { success: true };
    } catch (err: any) {
      logger.error({ err: err.message, itemId }, 'Deprecate item failed');
      return { success: false, error: err.message };
    }
  }

  /**
   * Remove a marketplace item entirely. Only for policy violations.
   */
  async removeItem(
    itemId: string,
    adminUserId: string,
    reason: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const item = await db.marketplaceItem.findUnique({ where: { id: itemId } });
      if (!item) return { success: false, error: 'Item not found' };

      await db.marketplaceItem.update({
        where: { id: itemId },
        data: {
          status: 'removed',
          updatedAt: new Date(),
          metadata: { ...(item.metadata as any || {}), removalReason: reason, removedBy: adminUserId },
        },
      });

      await this.invalidateTemplateCaches(itemId);
      await this.invalidateListCaches();

      logger.info({ itemId, adminUserId, reason }, 'Marketplace item removed');
      return { success: true };
    } catch (err: any) {
      logger.error({ err: err.message, itemId }, 'Remove item failed');
      return { success: false, error: err.message };
    }
  }

  // --- Rating & Review System ------------------------------------------------

  /**
   * Submit a rating and review for a marketplace item.
   * Updates the item's average rating in real time.
   */
  async submitReview(
    itemId: string,
    itemType: 'template' | 'dataset',
    userId: string,
    userName: string,
    rating: number,
    reviewText: string = '',
  ): Promise<{ success: boolean; reviewId?: string; error?: string }> {
    try {
      // Validate rating range
      if (rating < MIN_RATING || rating > MAX_RATING) {
        return { success: false, error: `Rating must be between ${MIN_RATING} and ${MAX_RATING}` };
      }

      // Validate review text length
      if (reviewText.length > MAX_REVIEW_LENGTH) {
        return { success: false, error: `Review text must be under ${MAX_REVIEW_LENGTH} characters` };
      }

      // Check item exists
      const item = await db.marketplaceItem.findUnique({ where: { id: itemId } });
      if (!item) return { success: false, error: 'Item not found' };

      // Check if user already reviewed this item
      const existingReview = await db.marketplaceReview.findFirst({
        where: { itemId, userId },
      });

      if (existingReview) {
        return { success: false, error: 'You have already reviewed this item' };
      }

      const reviewId = crypto.randomUUID();

      await db.marketplaceReview.create({
        data: {
          id: reviewId,
          itemId,
          itemType,
          userId,
          rating,
          body: reviewText,
        },
      });

      // Recalculate average rating
      await this.recalculateItemRating(itemId);

      // Invalidate caches
      await this.invalidateTemplateCaches(itemId);

      logger.info({ reviewId, itemId, userId, rating }, 'Review submitted');
      return { success: true, reviewId };
    } catch (err: any) {
      logger.error({ err: err.message, itemId, userId }, 'Submit review failed');
      return { success: false, error: err.message };
    }
  }

  /**
   * Get reviews for a marketplace item.
   */
  async getItemReviews(
    itemId: string,
    offset: number = 0,
    limit: number = 20,
  ): Promise<PaginatedResult<MarketplaceReview>> {
    try {
      const effectiveLimit = Math.min(limit, MAX_SEARCH_LIMIT);

      const [reviews, total] = await Promise.all([
        db.marketplaceReview.findMany({
          where: { itemId },
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: effectiveLimit,
        }),
        db.marketplaceReview.count({ where: { itemId } }),
      ]);

      const mapped: MarketplaceReview[] = reviews.map((r: any) => ({
        id: r.id,
        itemId: r.itemId,
        itemType: r.itemType as 'template' | 'dataset',
        userId: r.userId,
        userName: r.userName,
        rating: r.rating,
        reviewText: r.reviewText,
        createdAt: r.createdAt?.toISOString() ?? '',
      }));

      return { items: mapped, total, offset, limit: effectiveLimit };
    } catch (err: any) {
      logger.error({ err: err.message, itemId }, 'Get item reviews failed');
      return { items: [], total: 0, offset, limit };
    }
  }

  // --- Quality Scoring System ------------------------------------------------

  /**
   * Run quality tests on a template by testing it against known URLs.
   * Updates the template's quality score based on the results.
   *
   * This method fetches each test URL through the scraping pipeline,
   * runs the template's extract function, and scores the output.
   */
  async runQualityTest(
    templateListingId: string,
    testUrls: Array<{ url: string; expectedFields: string[] }>,
  ): Promise<QualityScore> {
    try {
      const template = await this.getTemplate(templateListingId);
      if (!template) {
        throw new Error(`Template ${templateListingId} not found`);
      }

      // Get the internal template from the registry
      const registryTemplate = templateRegistry.getTemplate(template.templateId);
      if (!registryTemplate) {
        throw new Error(`Internal template ${template.templateId} not found in registry`);
      }

      let testUrlCount = testUrls.length;
      let testUrlPassed = 0;
      let totalAccuracy = 0;

      for (const testCase of testUrls) {
        try {
          // Attempt to scrape the test URL (simplified -- uses HTTP strategy for speed)
          const scrapeResult = await this.scrapeTestUrl(testCase.url);
          if (!scrapeResult.success || !scrapeResult.html) {
            continue;
          }

          // Run the template's extract function
          const extracted = registryTemplate.extract(scrapeResult.html, testCase.url);

          // Check if expected fields are present and non-empty
          let fieldsPresent = 0;
          let fieldsNonEmpty = 0;
          for (const field of testCase.expectedFields) {
            if (field in extracted) {
              fieldsPresent++;
              const value = extracted[field];
              if (value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)) {
                fieldsNonEmpty++;
              }
            }
          }

          const fieldAccuracy = testCase.expectedFields.length > 0
            ? fieldsNonEmpty / testCase.expectedFields.length
            : 0;

          // A test passes if at least 50% of expected fields have non-empty values
          if (fieldAccuracy >= 0.5) {
            testUrlPassed++;
          }

          totalAccuracy += fieldAccuracy;
        } catch (err: any) {
          logger.debug({ url: testCase.url, error: err.message }, 'Quality test URL failed');
        }
      }

      const avgAccuracy = testUrlCount > 0 ? totalAccuracy / testUrlCount : 0;
      const reliability = testUrlCount > 0 ? testUrlPassed / testUrlCount : 0;
      const freshness = 100; // Just tested

      // Calculate documentation score based on existing data
      const hasLongDesc = template.longDescription && template.longDescription.length > 100;
      const hasSchema = Object.keys(template.outputSchema).length > 0;
      const hasTags = template.tags.length > 0;
      const docScore = (hasLongDesc ? 30 : 10) + (hasSchema ? 40 : 10) + (hasTags ? 30 : 10);

      const overall = Math.round(
        avgAccuracy * 40 + // 40% weight on accuracy
        reliability * 30 + // 30% weight on reliability
        (freshness / 100) * 10 + // 10% weight on freshness
        (docScore / 100) * 20, // 20% weight on documentation
      );

      const qualityScore: QualityScore = {
        overall: Math.min(100, Math.max(0, overall)),
        accuracy: Math.round(avgAccuracy * 100),
        reliability: Math.round(reliability * 100),
        freshness,
        documentation: docScore,
        testUrlCount,
        testUrlPassed,
        lastTestedAt: new Date().toISOString(),
        flaggedBroken: testUrlCount > 0 && testUrlPassed === 0,
      };

      // Update the item in the database
      await db.marketplaceItem.update({
        where: { id: templateListingId },
        data: {
          qualityScore: qualityScore as any,
          status: qualityScore.flaggedBroken ? 'deprecated' : undefined,
          updatedAt: new Date(),
        },
      });

      // Invalidate caches
      await this.invalidateTemplateCaches(templateListingId);

      logger.info(
        { templateListingId, overall: qualityScore.overall, accuracy: qualityScore.accuracy, reliability: qualityScore.reliability, flaggedBroken: qualityScore.flaggedBroken },
        'Quality test completed',
      );

      return qualityScore;
    } catch (err: any) {
      logger.error({ err: err.message, templateListingId }, 'Quality test failed');
      return {
        overall: 0,
        accuracy: 0,
        reliability: 0,
        freshness: 0,
        documentation: 0,
        testUrlCount: 0,
        testUrlPassed: 0,
        lastTestedAt: null,
        flaggedBroken: true,
      };
    }
  }

  /**
   * Schedule quality tests for all published templates.
   * Uses cached test URLs from the template's domain patterns.
   */
  async runAllQualityTests(): Promise<{ tested: number; flagged: number }> {
    try {
      const templates = await db.marketplaceItem.findMany({
        where: { itemType: 'template', status: 'published' },
        select: { id: true, templateId: true, domainPatterns: true },
      });

      let tested = 0;
      let flagged = 0;

      for (const tpl of templates) {
        const registryTemplate = templateRegistry.getTemplate(tpl.templateId ?? '');
        if (!registryTemplate) continue;

        // Generate test URLs from domain patterns
        const domainPatterns: string[] = Array.isArray(tpl.domainPatterns) ? tpl.domainPatterns as any : [];
        const testUrls = domainPatterns.slice(0, 3).map((domain: string) => ({
          url: `https://www.${domain}/test-quality-check`,
          expectedFields: Object.keys(registryTemplate.outputSchema),
        }));

        if (testUrls.length === 0) continue;

        const score = await this.runQualityTest(tpl.id, testUrls);
        tested++;

        if (score.flaggedBroken) {
          flagged++;
          logger.warn({ templateListingId: tpl.id }, 'Template flagged as broken during quality test');
        }
      }

      logger.info({ tested, flagged }, 'All quality tests completed');
      return { tested, flagged };
    } catch (err: any) {
      logger.error({ err: err.message }, 'Run all quality tests failed');
      return { tested: 0, flagged: 0 };
    }
  }

  // --- Revenue Tracking ------------------------------------------------------

  /**
   * Get revenue data for a publisher. Includes total revenue, pending payout,
   * paid out, and breakdowns by item and by month.
   */
  async getPublisherRevenue(publisherId: string): Promise<PublisherRevenue> {
    try {
      // Aggregate revenue from completed purchases
      const purchases = await db.marketplacePurchase.findMany({
        where: { publisherId, status: 'completed' },
      });

      let totalRevenue = 0;
      const itemMap = new Map<string, { itemId: string; itemType: 'template' | 'dataset'; name: string; sales: number; revenue: number }>();
      const monthMap = new Map<string, { revenue: number; sales: number }>();

      for (const purchase of purchases) {
        const publisherShare = Math.floor(purchase.creditCost * PUBLISHER_REVENUE_SHARE);
        totalRevenue += publisherShare;

        // Item breakdown
        const existingItem = itemMap.get(purchase.itemId);
        if (existingItem) {
          existingItem.sales++;
          existingItem.revenue += publisherShare;
        } else {
          itemMap.set(purchase.itemId, {
            itemId: purchase.itemId,
            itemType: purchase.itemType as 'template' | 'dataset',
            name: purchase.itemName || purchase.itemId,
            sales: 1,
            revenue: publisherShare,
          });
        }

        // Monthly breakdown
        const month = purchase.createdAt?.toISOString().substring(0, 7) || 'unknown';
        const existingMonth = monthMap.get(month);
        if (existingMonth) {
          existingMonth.revenue += publisherShare;
          existingMonth.sales++;
        } else {
          monthMap.set(month, { revenue: publisherShare, sales: 1 });
        }
      }

      // Get payout data
      const payouts = await db.marketplacePayout.findMany({
        where: { publisherId },
      });

      const paidOut = payouts.reduce((sum: number, p: any) => sum + (p.amount || 0), 0);
      const pendingPayout = Math.max(0, totalRevenue - paidOut);

      return {
        publisherId,
        totalRevenue,
        pendingPayout,
        paidOut,
        totalSales: purchases.length,
        items: Array.from(itemMap.values()).sort((a, b) => b.revenue - a.revenue),
        monthly: Array.from(monthMap.entries())
          .map(([month, data]) => ({ month, ...data }))
          .sort((a, b) => b.month.localeCompare(a.month)),
      };
    } catch (err: any) {
      logger.error({ err: err.message, publisherId }, 'Get publisher revenue failed');
      return {
        publisherId,
        totalRevenue: 0,
        pendingPayout: 0,
        paidOut: 0,
        totalSales: 0,
        items: [],
        monthly: [],
      };
    }
  }

  /**
   * Request a payout for accumulated revenue.
   */
  async requestPayout(
    publisherId: string,
    amount: number,
  ): Promise<{ success: boolean; payoutId?: string; error?: string }> {
    try {
      const revenue = await this.getPublisherRevenue(publisherId);

      if (amount > revenue.pendingPayout) {
        return { success: false, error: `Requested amount (${amount}) exceeds pending payout (${revenue.pendingPayout})` };
      }

      if (amount <= 0) {
        return { success: false, error: 'Payout amount must be positive' };
      }

      const payoutId = crypto.randomUUID();

      await db.marketplacePayout.create({
        data: {
          id: payoutId,
          authorId: publisherId,
          publisherId,
          amount,
          periodStart: new Date(),
          periodEnd: new Date(),
          status: 'pending',
        },
      });

      logger.info({ payoutId, publisherId, amount }, 'Payout requested');
      return { success: true, payoutId };
    } catch (err: any) {
      logger.error({ err: err.message, publisherId, amount }, 'Payout request failed');
      return { success: false, error: err.message };
    }
  }

  /**
   * Get all items published by a specific user.
   */
  async getPublisherItems(
    publisherId: string,
    itemType?: 'template' | 'dataset',
  ): Promise<Array<MarketplaceTemplate | MarketplaceDataset>> {
    try {
      const where: any = { publisherId, status: { notIn: ['removed'] } };
      if (itemType) where.itemType = itemType;

      const items = await db.marketplaceItem.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
      });

      return items.map((item: any) =>
        item.itemType === 'template'
          ? this.dbItemToTemplate(item)
          : this.dbItemToDataset(item),
      );
    } catch (err: any) {
      logger.error({ err: err.message, publisherId }, 'Get publisher items failed');
      return [];
    }
  }

  // --- Purchase Flow ----------------------------------------------------------

  /**
   * Purchase a marketplace item (template or dataset) with credits.
   *
   * This is the core purchase flow:
   * 1. Validate item exists and is published
   * 2. Check for duplicate purchase
   * 3. Deduct credits from user balance
   * 4. Record the purchase
   * 5. Update item purchase count
   * 6. Credit publisher revenue share
   * 7. Return download URL (for datasets) or confirmation (for templates)
   */
  async purchaseItem(
    itemId: string,
    itemType: 'template' | 'dataset',
    userId: string,
  ): Promise<PurchaseResult> {
    try {
      // Get the item
      const item = await db.marketplaceItem.findUnique({
        where: { id: itemId, itemType },
      });

      if (!item) {
        return { success: false, itemId, itemType, creditsCharged: 0, error: 'Item not found' };
      }

      if (item.status !== 'published') {
        return { success: false, itemId, itemType, creditsCharged: 0, error: 'Item is not available for purchase' };
      }

      // Free items -- no purchase needed, just install
      if (item.pricingModel === 'free' || item.creditCost === 0) {
        if (itemType === 'template') {
          const installResult = await this.installTemplate(itemId, userId);
          return {
            success: installResult.success,
            itemId,
            itemType,
            creditsCharged: 0,
            error: installResult.error,
          };
        }

        // Free dataset -- record a zero-credit purchase for tracking
        await db.marketplacePurchase.create({
          data: {
            id: crypto.randomUUID(),
            userId,
            itemId,
            itemType,
            itemName: item.name,
            publisherId: item.publisherId,
            priceCredits: 0,
            creditCost: 0,
            status: 'completed',
          },
        });

        // Increment purchase count
        await db.marketplaceItem.update({
          where: { id: itemId },
          data: { purchaseCount: { increment: 1 } },
        });

        return { success: true, itemId, itemType, creditsCharged: 0 };
      }

      // Check for duplicate purchase
      const existingPurchase = await db.marketplacePurchase.findFirst({
        where: { userId, itemId, itemType, status: 'completed' },
      });

      if (existingPurchase) {
        return { success: false, itemId, itemType, creditsCharged: 0, error: 'You have already purchased this item' };
      }

      // Deduct credits from user balance
      const creditCost = item.creditCost;
      const publisherShare = Math.floor(creditCost * PUBLISHER_REVENUE_SHARE);
      const platformShare = creditCost - publisherShare;

      // Check user credit balance
      const userCredits = await this.getUserCreditBalance(userId);
      if (userCredits < creditCost) {
        return {
          success: false,
          itemId,
          itemType,
          creditsCharged: 0,
          error: `Insufficient credits. You have ${userCredits}, but this item costs ${creditCost}`,
        };
      }

      // Deduct credits
      const deducted = await this.deductUserCredits(userId, creditCost);
      if (!deducted) {
        return { success: false, itemId, itemType, creditsCharged: 0, error: 'Failed to deduct credits' };
      }

      // Record the purchase
      const purchaseId = crypto.randomUUID();
      await db.marketplacePurchase.create({
        data: {
          id: purchaseId,
          userId,
          itemId,
          itemType,
          itemName: item.name,
          publisherId: item.publisherId,
          priceCredits: creditCost,
          creditCost,
          status: 'completed',
        },
      });

      // Increment purchase count
      await db.marketplaceItem.update({
        where: { id: itemId },
        data: { purchaseCount: { increment: 1 } },
      });

      // Invalidate caches
      await this.invalidateTemplateCaches(itemId);

      // For datasets, generate a download URL
      let downloadUrl: string | undefined;
      if (itemType === 'dataset') {
        const metadata = item.metadata as any;
        if (metadata?.storageKey) {
          downloadUrl = await this.generateDownloadUrl(metadata.storageKey);
        }
      }

      logger.info(
        { purchaseId, itemId, itemType, userId, creditCost, publisherShare, platformShare },
        'Item purchased',
      );

      return {
        success: true,
        itemId,
        itemType,
        creditsCharged: creditCost,
        downloadUrl,
      };
    } catch (err: any) {
      logger.error({ err: err.message, itemId, itemType, userId }, 'Purchase failed');
      return { success: false, itemId, itemType, creditsCharged: 0, error: err.message };
    }
  }

  /**
   * Purchase a template with credits.
   */
  async purchaseTemplate(
    templateListingId: string,
    userId: string,
  ): Promise<PurchaseResult> {
    return this.purchaseItem(templateListingId, 'template', userId);
  }

  // --- Staff Picks Management ------------------------------------------------

  /**
   * Set or unset a marketplace item as a staff pick. Admin-only operation.
   */
  async setStaffPick(
    itemId: string,
    isStaffPick: boolean,
    adminUserId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const item = await db.marketplaceItem.findUnique({ where: { id: itemId } });
      if (!item) return { success: false, error: 'Item not found' };

      await db.marketplaceItem.update({
        where: { id: itemId },
        data: { staffPick: isStaffPick, updatedAt: new Date() },
      });

      await this.invalidateTemplateCaches(itemId);
      await this.invalidateListCaches();

      logger.info({ itemId, isStaffPick, adminUserId }, 'Staff pick updated');
      return { success: true };
    } catch (err: any) {
      logger.error({ err: err.message, itemId }, 'Set staff pick failed');
      return { success: false, error: err.message };
    }
  }

  // --- Category Listing ------------------------------------------------------

  /**
   * Get all categories with their item counts.
   */
  async getCategories(): Promise<Array<{
    id: MarketplaceCategory;
    label: string;
    templateCount: number;
    datasetCount: number;
  }>> {
    const cacheKey = 'marketplace:categories';
    try {
      const cached = await cacheGet<Array<{
        id: MarketplaceCategory;
        label: string;
        templateCount: number;
        datasetCount: number;
      }>>(cacheKey);
      if (cached) return cached;
    } catch {
      // Cache miss
    }

    try {
      const results: Array<{
        id: MarketplaceCategory;
        label: string;
        templateCount: number;
        datasetCount: number;
      }> = [];

      for (const cat of MARKETPLACE_CATEGORIES) {
        const [templateCount, datasetCount] = await Promise.all([
          db.marketplaceItem.count({
            where: { category: cat, itemType: 'template', status: 'published' },
          }),
          db.marketplaceItem.count({
            where: { category: cat, itemType: 'dataset', status: 'published' },
          }),
        ]);

        results.push({
          id: cat,
          label: CATEGORY_LABELS[cat],
          templateCount,
          datasetCount,
        });
      }

      await cacheSet(cacheKey, results, POPULAR_CACHE_TTL).catch(() => {});
      return results;
    } catch (err: any) {
      logger.error({ err: err.message }, 'Get categories failed');
      return MARKETPLACE_CATEGORIES.map((cat) => ({
        id: cat,
        label: CATEGORY_LABELS[cat],
        templateCount: 0,
        datasetCount: 0,
      }));
    }
  }

  // --- Private Helpers -------------------------------------------------------

  /**
   * Convert a database marketplace item record to a MarketplaceTemplate.
   */
  private dbItemToTemplate(item: any): MarketplaceTemplate {
    const qualityScore: QualityScore = item.qualityScore
      ? (typeof item.qualityScore === 'string' ? JSON.parse(item.qualityScore) : item.qualityScore)
      : {
          overall: 0,
          accuracy: 0,
          reliability: 0,
          freshness: 0,
          documentation: 0,
          testUrlCount: 0,
          testUrlPassed: 0,
          lastTestedAt: null,
          flaggedBroken: false,
        };

    const versions: TemplateVersion[] = Array.isArray(item.versions)
      ? item.versions as any
      : [];

    return {
      id: item.id,
      templateId: item.templateId || '',
      name: item.name,
      description: item.description,
      longDescription: item.longDescription || '',
      category: item.category as MarketplaceCategory,
      tags: Array.isArray(item.tags) ? item.tags : [],
      pricingModel: item.pricingModel as PricingModel,
      creditCost: item.creditCost || 0,
      publisherId: item.publisherId,
      publisherName: item.publisherName || '',
      currentVersion: item.currentVersion || '1.0.0',
      versions,
      qualityScore,
      status: item.status as PublicationStatus,
      staffPick: item.staffPick || false,
      installCount: item.installCount || 0,
      avgRating: item.avgRating || 0,
      ratingCount: item.ratingCount || 0,
      outputSchema: item.outputSchema || {},
      domainPatterns: Array.isArray(item.domainPatterns) ? item.domainPatterns : [],
      createdAt: item.createdAt?.toISOString?.() ?? String(item.createdAt ?? ''),
      updatedAt: item.updatedAt?.toISOString?.() ?? String(item.updatedAt ?? ''),
    };
  }

  /**
   * Convert a database marketplace item record to a MarketplaceDataset.
   */
  private dbItemToDataset(item: any): MarketplaceDataset {
    const metadata = item.metadata || {};
    const qualityScore: QualityScore = item.qualityScore
      ? (typeof item.qualityScore === 'string' ? JSON.parse(item.qualityScore) : item.qualityScore)
      : {
          overall: 0,
          accuracy: 0,
          reliability: 0,
          freshness: 0,
          documentation: 0,
          testUrlCount: 0,
          testUrlPassed: 0,
          lastTestedAt: null,
          flaggedBroken: false,
        };

    return {
      id: item.id,
      name: item.name,
      description: item.description,
      longDescription: item.longDescription || '',
      category: item.category as MarketplaceCategory,
      tags: Array.isArray(item.tags) ? item.tags : [],
      pricingModel: item.pricingModel as PricingModel,
      creditCost: item.creditCost || 0,
      publisherId: item.publisherId,
      publisherName: item.publisherName || '',
      rowCount: metadata.rowCount || 0,
      columnCount: metadata.columnCount || 0,
      columns: metadata.columns || [],
      sampleData: metadata.sampleData || [],
      storageKey: metadata.storageKey || '',
      format: metadata.format || 'json',
      fileSizeBytes: metadata.fileSizeBytes || 0,
      qualityScore,
      status: item.status as PublicationStatus,
      staffPick: item.staffPick || false,
      purchaseCount: item.purchaseCount || 0,
      avgRating: item.avgRating || 0,
      ratingCount: item.ratingCount || 0,
      dataAsOf: metadata.dataAsOf || '',
      createdAt: item.createdAt?.toISOString?.() ?? String(item.createdAt ?? ''),
      updatedAt: item.updatedAt?.toISOString?.() ?? String(item.updatedAt ?? ''),
    };
  }

  /**
   * Recalculate the average rating for a marketplace item.
   */
  private async recalculateItemRating(itemId: string): Promise<void> {
    try {
      const reviews = await db.marketplaceReview.findMany({
        where: { itemId },
        select: { rating: true },
      });

      if (reviews.length === 0) return;

      const avgRating = reviews.reduce((sum: number, r: any) => sum + r.rating, 0) / reviews.length;
      const roundedRating = Math.round(avgRating * 10) / 10; // One decimal place

      await db.marketplaceItem.update({
        where: { id: itemId },
        data: {
          avgRating: roundedRating,
          ratingCount: reviews.length,
        },
      });
    } catch (err: any) {
      logger.error({ err: err.message, itemId }, 'Recalculate item rating failed');
    }
  }

  /**
   * Scrape a test URL for quality testing. Uses a lightweight HTTP fetch.
   */
  private async scrapeTestUrl(
    url: string,
  ): Promise<{ success: boolean; html?: string; statusCode?: number }> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'ScrapeSuite-QualityTest/1.0',
          Accept: 'text/html',
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const html = await response.text();
      return {
        success: response.status >= 200 && response.status < 400,
        html,
        statusCode: response.status,
      };
    } catch (err: any) {
      return { success: false };
    }
  }

  /**
   * Compare two semantic version strings. Returns true if v1 > v2.
   */
  private isVersionGreater(v1: string, v2: string): boolean {
    const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
    const parts1 = parse(v1);
    const parts2 = parse(v2);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 > p2) return true;
      if (p1 < p2) return false;
    }

    return false; // Equal versions
  }

  /**
   * Get a user's credit balance.
   */
  private async getUserCreditBalance(userId: string): Promise<number> {
    try {
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { creditsRemaining: true },
      });
      return user?.creditsRemaining ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Deduct credits from a user's balance. Returns true on success.
   */
  private async deductUserCredits(userId: string, amount: number): Promise<boolean> {
    try {
      const result = await db.user.updateMany({
        where: { id: userId, creditsRemaining: { gte: amount } },
        data: { creditsRemaining: { decrement: amount } },
      });
      return result.count > 0;
    } catch {
      return false;
    }
  }

  /**
   * Generate a time-limited download URL for a dataset file.
   * In production this would use S3 presigned URLs or similar.
   */
  private async generateDownloadUrl(storageKey: string): Promise<string> {
    // Generate a signed download token stored in Redis with 1-hour TTL
    const token = crypto.randomUUID();
    await cacheSet(`marketplace:download:${token}`, { storageKey }, 3600);

    const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';
    return `${baseUrl}/api/marketplace/download?token=${token}`;
  }

  /**
   * Validate a download token and return the storage key.
   */
  async validateDownloadToken(token: string): Promise<string | null> {
    try {
      const data = await cacheGet<{ storageKey: string }>(`marketplace:download:${token}`);
      if (!data) return null;

      // Delete the token after use (one-time download)
      await cacheDelete(`marketplace:download:${token}`);

      return data.storageKey;
    } catch {
      return null;
    }
  }

  /**
   * Invalidate all caches related to a specific item.
   */
  private async invalidateTemplateCaches(itemId: string): Promise<void> {
    const keys = [
      `marketplace:template:${itemId}`,
      `marketplace:dataset:${itemId}`,
    ];

    for (const key of keys) {
      await cacheDelete(key).catch(() => {});
    }
  }

  /**
   * Invalidate list-level caches (search results, featured, popular, etc.)
   */
  private async invalidateListCaches(): Promise<void> {
    try {
      const r = redis;
      const pattern = 'cache:marketplace:*';
      const keys = await r.keys(pattern);
      if (keys.length > 0) {
        await r.del(...keys);
      }
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Failed to invalidate list caches');
    }
  }
}

// --- Singleton -----------------------------------------------------------------

export const marketplaceEngine = new MarketplaceEngine();
