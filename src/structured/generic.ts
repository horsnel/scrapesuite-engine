import * as cheerio from 'cheerio';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('structured:generic');

// --- Types --------------------------------------------------------------------

export interface GenericArticle {
  title: string;
  description: string;
  author: string | null;
  datePublished: string | null;
  dateModified: string | null;
  content: string;
  imageUrl: string | null;
  siteName: string | null;
  language: string | null;
  wordCount: number;
  readingTimeMinutes: number;
}

export interface GenericProduct {
  name: string;
  price: number | null;
  currency: string;
  description: string;
  imageUrl: string | null;
  availability: string;
  rating: number | null;
  ratingCount: number | null;
  brand: string | null;
  sku: string | null;
  offers: { price: number; seller: string; currency: string }[];
}

export interface StructuredDataResult {
  type: 'article' | 'product' | 'unknown';
  article?: GenericArticle;
  product?: GenericProduct;
  rawLdJson: Record<string, any>[];
  meta: Record<string, string>;
  links: { text: string; href: string }[];
}

// --- Generic Structured Data Parser ------------------------------------------

export class GenericParser {
  /**
   * Parse any web page into structured data using schema.org, Open Graph,
   * and HTML meta tags. Falls back to heuristic extraction.
   */
  parse(html: string, url?: string): StructuredDataResult {
    const $ = cheerio.load(html);

    // 1. Extract JSON-LD structured data
    const ldJson = this.extractLdJson($);

    // 2. Extract Open Graph and meta tags
    const meta = this.extractMeta($);

    // 3. Determine page type
    const type = this.detectPageType(ldJson, meta);

    // 4. Parse based on type
    let article: GenericArticle | undefined;
    let product: GenericProduct | undefined;

    if (type === 'article') {
      article = this.parseArticle($, ldJson, meta);
    } else if (type === 'product') {
      product = this.parseProduct($, ldJson, meta);
    }

    // 5. Extract links
    const links = this.extractLinks($, url);

    return {
      type,
      article,
      product,
      rawLdJson: ldJson,
      meta,
      links,
    };
  }

  // --- JSON-LD Extraction ----------------------------------------------------

  private extractLdJson($: cheerio.CheerioAPI): Record<string, any>[] {
    const results: Record<string, any>[] = [];

    $('script[type="application/ld+json"]').each((_i, el) => {
      try {
        const text = $(el).text().trim();
        const parsed = JSON.parse(text);
        // Handle @graph arrays
        if (parsed['@graph'] && Array.isArray(parsed['@graph'])) {
          results.push(...parsed['@graph']);
        } else if (Array.isArray(parsed)) {
          results.push(...parsed);
        } else {
          results.push(parsed);
        }
      } catch {
        // Skip malformed JSON-LD
      }
    });

    return results;
  }

  // --- Meta Tag Extraction ---------------------------------------------------

  private extractMeta($: cheerio.CheerioAPI): Record<string, string> {
    const meta: Record<string, string> = {};

    // Open Graph
    $('meta[property^="og:"]').each((_i, el) => {
      const property = $(el).attr('property')?.replace('og:', '') || '';
      const content = $(el).attr('content') || '';
      if (property && content) meta[`og:${property}`] = content;
    });

    // Twitter Card
    $('meta[name^="twitter:"]').each((_i, el) => {
      const name = $(el).attr('name')?.replace('twitter:', '') || '';
      const content = $(el).attr('content') || '';
      if (name && content) meta[`twitter:${name}`] = content;
    });

    // Standard meta tags
    $('meta[name]').each((_i, el) => {
      const name = $(el).attr('name')?.toLowerCase() || '';
      const content = $(el).attr('content') || '';
      if (name && content && !name.startsWith('twitter:')) meta[name] = content;
    });

    // Canonical URL
    const canonical = $('link[rel="canonical"]').attr('href');
    if (canonical) meta['canonical'] = canonical;

    return meta;
  }

  // --- Page Type Detection --------------------------------------------------

  private detectPageType(ldJson: Record<string, any>[], meta: Record<string, string>): 'article' | 'product' | 'unknown' {
    // Check JSON-LD types
    for (const ld of ldJson) {
      const type = (ld['@type'] || '').toString().toLowerCase();
      if (type.includes('article') || type.includes('news') || type.includes('blog')) return 'article';
      if (type.includes('product') || type.includes('offer')) return 'product';
    }

    // Check Open Graph type
    const ogType = (meta['og:type'] || '').toLowerCase();
    if (ogType === 'article') return 'article';
    if (ogType === 'product' || ogType === 'product.item') return 'product';

    return 'unknown';
  }

  // --- Article Parsing -------------------------------------------------------

  private parseArticle(
    $: cheerio.CheerioAPI,
    ldJson: Record<string, any>[],
    meta: Record<string, string>,
  ): GenericArticle {
    // Find the article schema
    const articleSchema = ldJson.find((ld) => {
      const type = (ld['@type'] || '').toString().toLowerCase();
      return type.includes('article') || type.includes('news');
    });

    const title = meta['og:title']
      || articleSchema?.headline
      || articleSchema?.name
      || $('h1').first().text().trim()
      || $('title').text().trim();

    const description = meta['og:description']
      || meta['description']
      || articleSchema?.description
      || $('meta[name="description"]').attr('content')
      || '';

    const author = articleSchema?.author?.name
      || (typeof articleSchema?.author === 'string' ? articleSchema.author : null)
      || $('meta[name="author"]').attr('content')
      || null;

    const datePublished = articleSchema?.datePublished
      || meta['article:published_time']
      || $('meta[property="article:published_time"]').attr('content')
      || null;

    const dateModified = articleSchema?.dateModified
      || meta['article:modified_time']
      || $('meta[property="article:modified_time"]').attr('content')
      || null;

    // Extract article body text
    const content = this.extractArticleContent($);

    const imageUrl = meta['og:image']
      || articleSchema?.image
      || null;

    const siteName = meta['og:site_name']
      || articleSchema?.publisher?.name
      || null;

    const language = $('html').attr('lang')
      || meta['og:locale']
      || null;

    const wordCount = content.split(/\s+/).length;
    const readingTimeMinutes = Math.max(1, Math.ceil(wordCount / 200));

    return {
      title,
      description,
      author,
      datePublished,
      dateModified,
      content,
      imageUrl,
      siteName,
      language,
      wordCount,
      readingTimeMinutes,
    };
  }

  // --- Product Parsing -------------------------------------------------------

  private parseProduct(
    $: cheerio.CheerioAPI,
    ldJson: Record<string, any>[],
    meta: Record<string, string>,
  ): GenericProduct {
    const productSchema = ldJson.find((ld) => {
      const type = (ld['@type'] || '').toString().toLowerCase();
      return type.includes('product');
    });

    const name = meta['og:title']
      || productSchema?.name
      || $('h1').first().text().trim()
      || '';

    const description = meta['og:description']
      || productSchema?.description
      || $('meta[name="description"]').attr('content')
      || '';

    const imageUrl = meta['og:image']
      || productSchema?.image
      || null;

    const brand = productSchema?.brand?.name
      || null;

    const sku = productSchema?.sku
      || null;

    // Price extraction from schema
    const offer = productSchema?.offers;
    let price: number | null = null;
    let currency = 'USD';
    let availability = 'Unknown';

    if (offer) {
      if (Array.isArray(offer)) {
        const firstOffer = offer[0];
        price = parseFloat(firstOffer?.price) || null;
        currency = firstOffer?.priceCurrency || 'USD';
        availability = this.parseAvailability(firstOffer?.availability);
      } else {
        price = parseFloat(offer.price) || null;
        currency = offer.priceCurrency || 'USD';
        availability = this.parseAvailability(offer.availability);
      }
    }

    // Rating extraction
    const aggregateRating = productSchema?.aggregateRating;
    const rating = aggregateRating ? parseFloat(aggregateRating.ratingValue) : null;
    const ratingCount = aggregateRating ? parseInt(aggregateRating.reviewCount, 10) : null;

    // Extract offers
    const offers: { price: number; seller: string; currency: string }[] = [];
    if (offer) {
      const offerArray = Array.isArray(offer) ? offer : [offer];
      for (const o of offerArray) {
        if (o.price) {
          offers.push({
            price: parseFloat(o.price),
            seller: o.seller?.name || o.seller || 'Unknown',
            currency: o.priceCurrency || 'USD',
          });
        }
      }
    }

    return {
      name,
      price,
      currency,
      description,
      imageUrl,
      availability,
      rating,
      ratingCount,
      brand,
      sku,
      offers,
    };
  }

  // --- Helpers ----------------------------------------------------------------

  private extractArticleContent($: cheerio.CheerioAPI): string {
    // Try common article content selectors
    const selectors = [
      'article',
      '[role="article"]',
      '.post-content',
      '.article-content',
      '.entry-content',
      '.content-body',
      'main',
    ];

    for (const selector of selectors) {
      const content = $(selector).first().text().trim();
      if (content.length > 200) {
        return content.substring(0, 50000); // Cap at 50k chars
      }
    }

    // Fallback: body text
    return $('body').text().trim().substring(0, 50000);
  }

  private parseAvailability(availability: string | undefined): string {
    if (!availability) return 'Unknown';
    const lower = availability.toLowerCase();
    if (lower.includes('instock') || lower.includes('in_stock')) return 'In Stock';
    if (lower.includes('outofstock') || lower.includes('out_of_stock')) return 'Out of Stock';
    if (lower.includes('preorder') || lower.includes('pre_order')) return 'Pre-Order';
    if (lower.includes('soldout') || lower.includes('sold_out')) return 'Sold Out';
    return availability;
  }

  private extractLinks($: cheerio.CheerioAPI, baseUrl?: string): { text: string; href: string }[] {
    const links: { text: string; href: string }[] = [];
    const seen = new Set<string>();

    $('a[href]').each((_i, el) => {
      const text = $(el).text().trim().substring(0, 200);
      let href = $(el).attr('href') || '';

      if (!text || !href || href.startsWith('#') || href.startsWith('javascript:')) return;

      // Resolve relative URLs
      if (baseUrl && href.startsWith('/')) {
        try {
          const base = new URL(baseUrl);
          href = `${base.origin}${href}`;
        } catch {}
      }

      if (!seen.has(href)) {
        seen.add(href);
        links.push({ text, href });
      }
    });

    return links.slice(0, 500); // Cap at 500 links
  }
}

export const genericParser = new GenericParser();
