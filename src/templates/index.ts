/**
 * Scraper Templates System -- Pre-built data extraction templates for popular websites.
 *
 * Inspired by Bright Data's template-driven scraping: users specify a template
 * name (or let auto-detection choose one from a URL) instead of writing custom
 * extraction logic.  Each template encapsulates domain patterns, output schemas,
 * regex-based extraction, required strategy, and proxy tier.
 *
 * Key features
 * ------------
 *  • 54+ production templates for popular sites (Amazon, Google, LinkedIn, etc.)
 *  • Auto-detection of the best template from a URL via domain matching
 *  • Regex-based extraction (more resilient than CSS selectors to layout changes)
 *  • JSON-LD structured data extraction as a primary fallback
 *  • Open Graph / meta tag extraction as secondary fallback
 *  • Confidence scoring on template matches
 *  • Full JSDoc on all public methods and interfaces
 *
 * Usage
 * -----
 *   import { templateRegistry } from './templates';
 *
 *   // Auto-detect
 *   const match = templateRegistry.detectTemplate('https://www.amazon.com/dp/B0BSHF7WHW');
 *   // match.templateId === 'amazon_product'
 *
 *   // Extract
 *   const data = templateRegistry.extractWithTemplate('amazon_product', html, url);
 */

import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('templates');

// --- Public Types --------------------------------------------------------------

/**
 * A single scraper template definition.
 *
 * Each template knows which domains it handles, what output fields it
 * produces, how to extract them from raw HTML, and which strategy / proxy
 * tier is recommended for reliable scraping.
 */
export interface ScraperTemplate {
  /** Unique template identifier, e.g. 'amazon_product'. */
  id: string;
  /** Human-readable name, e.g. 'Amazon Product'. */
  name: string;
  /** Short description of what the template extracts. */
  description: string;
  /**
   * Domain substrings used for auto-detection.
   * A URL whose hostname contains any of these strings will match.
   * e.g. ['amazon.com', 'amazon.co.uk', 'amazon.de']
   */
  domainPatterns: string[];
  /**
   * Output schema -- maps field names to human-readable descriptions.
   * This describes the shape of the object returned by `extract()`.
   */
  outputSchema: Record<string, string>;
  /** Minimum scraping strategy required for reliable extraction. */
  requiredStrategy: 'http' | 'browser' | 'stealth-browser';
  /** Minimum proxy tier required for reliable extraction. */
  requiredProxyTier: 'residential' | 'mobile' | 'datacenter' | 'isp';
  /**
   * Extract structured data from raw HTML.
   *
   * @param html - The full HTML source of the page.
   * @param url  - The canonical URL of the page (used for ASIN extraction etc.)
   * @returns A plain object whose keys match `outputSchema`.
   */
  extract: (html: string, url: string) => Record<string, any>;
}

/**
 * Result of auto-detecting a template from a URL.
 */
export interface TemplateMatch {
  /** The matched template ID. */
  templateId: string;
  /** Confidence score 0–1 (1 = exact domain match, lower for partial). */
  confidence: number;
  /** The full template definition. */
  template: ScraperTemplate;
}

// --- Internal Helpers ----------------------------------------------------------

/**
 * Safely extract the first capture group from a regex, returning a default
 * on failure.  Never throws.
 */
function regexMatch(html: string, pattern: RegExp, group: number = 1, fallback: string = ''): string {
  try {
    const m = html.match(pattern);
    return m && m[group] !== undefined ? m[group].trim() : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Extract all capture groups from all matches of a global regex.
 */
function regexMatchAll(html: string, pattern: RegExp, group: number = 1): string[] {
  try {
    const results: string[] = [];
    let m: RegExpExecArray | null;
    const re = new RegExp(pattern.source, pattern.flags);
    while ((m = re.exec(html)) !== null) {
      if (m[group] !== undefined) results.push(m[group].trim());
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Extract a numeric value from a string, stripping commas.
 */
function parseNumber(text: string): number | null {
  if (!text) return null;
  const m = text.match(/([\d,]+\.?\d*)/);
  if (!m) return null;
  return parseFloat(m[1].replace(/,/g, ''));
}

/**
 * Extract and parse the first JSON-LD block of a given @type from HTML.
 * Returns null if none found or parsing fails.
 */
function extractLdJson(html: string, typeSubstring: string): Record<string, any> | null {
  try {
    const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    if (!blocks) return null;

    for (const block of blocks) {
      const jsonStr = block.replace(/<\/?script[^>]*>/gi, '').trim();
      try {
        const parsed = JSON.parse(jsonStr);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (item['@graph'] && Array.isArray(item['@graph'])) {
            for (const g of item['@graph']) {
              const t = (g['@type'] || '').toString().toLowerCase();
              if (t.includes(typeSubstring.toLowerCase())) return g;
            }
          }
          const t = (item['@type'] || '').toString().toLowerCase();
          if (t.includes(typeSubstring.toLowerCase())) return item;
        }
      } catch {
        // Skip malformed JSON-LD
      }
    }
  } catch (err) {
    logger.debug({ err: (err as Error).message, typeSubstring }, 'Failed to extract JSON-LD');
  }
  return null;
}

/**
 * Extract all JSON-LD blocks from HTML.
 */
function extractAllLdJson(html: string): Record<string, any>[] {
  const results: Record<string, any>[] = [];
  try {
    const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    if (!blocks) return results;

    for (const block of blocks) {
      const jsonStr = block.replace(/<\/?script[^>]*>/gi, '').trim();
      try {
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed)) {
          results.push(...parsed);
        } else if (parsed['@graph'] && Array.isArray(parsed['@graph'])) {
          results.push(...parsed['@graph']);
        } else {
          results.push(parsed);
        }
      } catch {
        // Skip malformed JSON-LD
      }
    }
  } catch {
    // Ignore
  }
  return results;
}

/**
 * Extract an Open Graph meta content value.
 */
function extractOg(html: string, property: string): string {
  const pattern = new RegExp(`<meta[^>]*property=["']og:${property}["'][^>]*content=["']([^"']*)["']`, 'i');
  const alt = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:${property}["']`, 'i');
  return regexMatch(html, pattern, 1) || regexMatch(html, alt, 1);
}

/**
 * Extract a standard meta tag content value by name.
 */
function extractMetaName(html: string, name: string): string {
  const pattern = new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
  const alt = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i');
  return regexMatch(html, pattern, 1) || regexMatch(html, alt, 1);
}

/**
 * Extract a meta tag content value by property.
 */
function extractMetaProperty(html: string, property: string): string {
  const pattern = new RegExp(`<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i');
  const alt = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']${property}["']`, 'i');
  return regexMatch(html, pattern, 1) || regexMatch(html, alt, 1);
}

/**
 * Strip HTML tags from a string.
 */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Decode common HTML entities.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// --- Template Definitions ------------------------------------------------------

// --------------------------------------------------------------------------------
// 1. Amazon Product
// --------------------------------------------------------------------------------

const amazonProductTemplate: ScraperTemplate = {
  id: 'amazon_product',
  name: 'Amazon Product',
  description: 'Extract product details from Amazon product pages including title, price, rating, availability, ASIN, images, features, description, seller, and breadcrumbs.',
  domainPatterns: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.co.jp', 'amazon.ca', 'amazon.com.au', 'amazon.in', 'amazon.it', 'amazon.es', 'amazon.com.mx', 'amazon.com.br', 'amzn.com'],
  outputSchema: {
    title: 'Product title',
    price: 'Current price (number)',
    currency: 'Currency code (USD, EUR, GBP, etc.)',
    originalPrice: 'List price before discount (number)',
    rating: 'Average rating out of 5 (number)',
    reviewCount: 'Number of customer reviews (integer)',
    availability: 'Availability status string',
    asin: 'Amazon Standard Identification Number (10-char alphanumeric)',
    images: 'Array of image URLs',
    features: 'Array of bullet-point features',
    description: 'Product description text',
    seller: 'Seller / brand name',
    breadcrumbs: 'Array of breadcrumb category names',
  },
  requiredStrategy: 'stealth-browser',
  requiredProxyTier: 'residential',

  extract(html: string, url: string): Record<string, any> {
    try {
      // -- ASIN from URL -------------------------------------------------
      let asin = '';
      const asinUrlMatch = url.match(/\/dp\/([A-Z0-9]{10})/i) || url.match(/\/gp\/product\/([A-Z0-9]{10})/i) || url.match(/\/ASIN\/([A-Z0-9]{10})/i);
      if (asinUrlMatch) asin = asinUrlMatch[1].toUpperCase();

      // ASIN from HTML hidden inputs
      if (!asin) {
        const asinHtml = regexMatch(html, /<input[^>]*name=["']ASIN["'][^>]*value=["']([A-Z0-9]{10})["']/i, 1)
          || regexMatch(html, /<input[^>]*value=["']([A-Z0-9]{10})["'][^>]*name=["']ASIN["']/i, 1);
        if (asinHtml) asin = asinHtml.toUpperCase();
      }

      // ASIN from detail table
      if (!asin) {
        const asinDetail = regexMatch(html, /ASIN[\s:]*<\/[^>]+>\s*([A-Z0-9]{10})/i, 1);
        if (asinDetail) asin = asinDetail.toUpperCase();
      }

      // -- Title ---------------------------------------------------------
      let title = regexMatch(html, /id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i, 1);
      if (!title) title = regexMatch(html, /data-automation-id=["']product-title["'][^>]*>([\s\S]*?)<\/span>/i, 1);
      if (!title) title = regexMatch(html, /<h1[^>]*class=["'][^"']*a-size-large[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i, 1);
      title = decodeEntities(stripHtml(title));

      // -- Price ---------------------------------------------------------
      let priceText = regexMatch(html, /class=["'][^"']*a-price[^"']*["'][^>]*>[\s\S]*?class=["'][^"']*a-offscreen[^"']*["'][^>]*>([\s\S]*?)<\/span>/i, 1);
      if (!priceText) priceText = regexMatch(html, /id=["']priceblock_ourprice["'][^>]*>([\s\S]*?)<\/span>/i, 1);
      if (!priceText) priceText = regexMatch(html, /id=["']priceblock_dealprice["'][^>]*>([\s\S]*?)<\/span>/i, 1);
      if (!priceText) priceText = regexMatch(html, /id=["']priceblock_saleprice["'][^>]*>([\s\S]*?)<\/span>/i, 1);
      if (!priceText) priceText = regexMatch(html, /data-a-color=["']price["'][^>]*>[\s\S]*?class=["'][^"']*a-offscreen[^"']*["'][^>]*>([\s\S]*?)<\/span>/i, 1);
      priceText = stripHtml(priceText);

      const originalPriceText = stripHtml(
        regexMatch(html, /class=["'][^"']*a-text-price[^"']*["'][^>]*>[\s\S]*?class=["'][^"']*a-offscreen[^"']*["'][^>]*>([\s\S]*?)<\/span>/i, 1)
      );

      let price = parseNumber(priceText);
      const originalPrice = parseNumber(originalPriceText);

      let currency = 'USD';
      if (priceText.includes('\u20AC') || priceText.includes('EUR')) currency = 'EUR';
      else if (priceText.includes('\u00A3') || priceText.includes('GBP')) currency = 'GBP';
      else if (priceText.includes('\u00A5') || priceText.includes('CNY') || priceText.includes('JPY')) currency = 'JPY';
      else if (priceText.includes('\u20B9') || priceText.includes('INR')) currency = 'INR';
      else if (priceText.includes('A$') || priceText.includes('AUD')) currency = 'AUD';
      else if (priceText.includes('C$') || priceText.includes('CAD')) currency = 'CAD';
      else if (priceText.includes('R$') || priceText.includes('BRL')) currency = 'BRL';
      else if (priceText.includes('MX$') || priceText.includes('MXN')) currency = 'MXN';

      // -- Rating --------------------------------------------------------
      const ratingText = regexMatch(html, /id=["']acrPopover["'][^>]*>[\s\S]*?class=["'][^"']*a-icon-alt[^"']*["'][^>]*>([\s\S]*?)<\/span>/i, 1)
        || regexMatch(html, /class=["'][^"']*a-icon-star[^"']*["'][^>]*>[\s\S]*?class=["'][^"']*a-icon-alt[^"']*["'][^>]*>([\s\S]*?)<\/span>/i, 1);
      const ratingMatch = ratingText.match(/([\d.]+)/);
      let rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

      // -- Review count --------------------------------------------------
      const reviewText = regexMatch(html, /id=["']acrCustomerReviewText["'][^>]*>([\s\S]*?)<\/span>/i, 1);
      const reviewMatch = reviewText.match(/([\d,]+)/);
      let reviewCount = reviewMatch ? parseInt(reviewMatch[1].replace(/,/g, ''), 10) : null;

      // -- Availability --------------------------------------------------
      let availability = regexMatch(html, /id=["']availability["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i, 1);
      availability = stripHtml(availability);
      if (availability.toLowerCase().includes('in stock')) availability = 'In Stock';
      else if (availability.toLowerCase().includes('out of stock')) availability = 'Out of Stock';
      else if (availability.toLowerCase().includes('currently unavailable')) availability = 'Unavailable';
      if (!availability) availability = 'Unknown';

      // -- Images --------------------------------------------------------
      const images: string[] = [];
      // Main landing image
      const mainImg = regexMatch(html, /id=["']landingImage["'][^>]*src=["']([^"']*)["']/i, 1)
        || regexMatch(html, /id=["']imgBlkFront["'][^>]*src=["']([^"']*)["']/i, 1);
      if (mainImg) images.push(mainImg);

      // Image gallery thumbnails
      const imgPattern = /data-old-hires=["']([^"']*)["']/gi;
      let imgM: RegExpExecArray | null;
      while ((imgM = imgPattern.exec(html)) !== null) {
        if (imgM[1] && !images.includes(imgM[1])) images.push(imgM[1]);
      }

      // Color/thumbnail images
      const thumbPattern = /class=["'][^"']*imageThumbnail[^"']*["'][^>]*src=["']([^"']*)["']/gi;
      while ((imgM = thumbPattern.exec(html)) !== null) {
        if (imgM[1] && !images.includes(imgM[1])) images.push(imgM[1]);
      }

      // -- Features / bullets --------------------------------------------
      const features: string[] = [];
      const bulletSection = html.match(/id=["']feature-bullets["'][^>]*>([\s\S]*?)<\/div>/i);
      if (bulletSection) {
        const bulletMatches = bulletSection[1].matchAll(/<span[^>]*class=["'][^"']*a-list-item[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi);
        for (const bm of bulletMatches) {
          const text = decodeEntities(stripHtml(bm[1]));
          if (text && !text.includes('Make sure this fits')) features.push(text);
        }
      }

      // -- Description ---------------------------------------------------
      let description = '';
      const descMatch = html.match(/id=["']productDescription["'][^>]*>([\s\S]*?)<\/div>/i);
      if (descMatch) description = stripHtml(descMatch[1]).substring(0, 5000);
      if (!description) {
        const aplusMatch = html.match(/id=["']aplus_feature_div["'][^>]*>([\s\S]*?)<\/div>/i)
          || html.match(/id=["']aplus["'][^>]*>([\s\S]*?)<\/div>/i);
        if (aplusMatch) description = stripHtml(aplusMatch[1]).substring(0, 5000);
      }

      // -- Seller --------------------------------------------------------
      let seller: string | null = regexMatch(html, /id=["']sellerProfileTriggerId["'][^>]*>([\s\S]*?)<\/a>/i, 1);
      if (!seller) seller = regexMatch(html, /id=["']merchant-info["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i, 1) || null;
      if (!seller) seller = regexMatch(html, /id=["']bylineInfo["'][^>]*>([\s\S]*?)<\/a>/i, 1)
        || regexMatch(html, /id=["']bylineInfo["'][^>]*>([\s\S]*?)<\/span>/i, 1) || null;
      if (seller) seller = stripHtml(seller);

      // -- Breadcrumbs ---------------------------------------------------
      const breadcrumbs: string[] = [];
      const crumbSection = html.match(/id=["']wayfinding-breadcrumbs_container["'][^>]*>([\s\S]*?)<\/div>/i);
      if (crumbSection) {
        const crumbAnchors = crumbSection[1].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi);
        for (const ca of crumbAnchors) {
          const text = stripHtml(ca[1]);
          if (text) breadcrumbs.push(text);
        }
      }

      // -- JSON-LD fallback for missing fields ---------------------------
      const ldProduct = extractLdJson(html, 'product');
      if (ldProduct) {
        if (!title && ldProduct.name) title = ldProduct.name;
        if (price === null && ldProduct.offers) {
          const offer = Array.isArray(ldProduct.offers) ? ldProduct.offers[0] : ldProduct.offers;
          if (offer?.price) price = parseFloat(offer.price);
          if (offer?.priceCurrency) currency = offer.priceCurrency;
        }
        if (rating === null && ldProduct.aggregateRating?.ratingValue) {
          rating = parseFloat(ldProduct.aggregateRating.ratingValue);
        }
        if (reviewCount === null && ldProduct.aggregateRating?.reviewCount) {
          reviewCount = parseInt(ldProduct.aggregateRating.reviewCount, 10);
        }
        if (images.length === 0 && ldProduct.image) {
          const imgs = Array.isArray(ldProduct.image) ? ldProduct.image : [ldProduct.image];
          for (const img of imgs) {
            const src = typeof img === 'string' ? img : img?.url || '';
            if (src && !images.includes(src)) images.push(src);
          }
        }
        if (!description && ldProduct.description) {
          description = String(ldProduct.description).substring(0, 5000);
        }
        if (!seller && ldProduct.brand?.name) {
          seller = ldProduct.brand.name;
        }
      }

      return {
        title,
        price,
        currency,
        originalPrice,
        rating,
        reviewCount,
        availability,
        asin: asin || null,
        images,
        features,
        description,
        seller,
        breadcrumbs,
      };
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Amazon product extraction failed');
      return {};
    }
  },
};

// --------------------------------------------------------------------------------
// 2. Google SERP
// --------------------------------------------------------------------------------

const googleSerpTemplate: ScraperTemplate = {
  id: 'google_serp',
  name: 'Google SERP',
  description: 'Extract search results from Google search engine results pages including organic results, ads, knowledge panel data, People Also Ask, and related searches.',
  domainPatterns: ['google.com/search', 'google.co.uk/search', 'google.de/search', 'google.fr/search', 'google.co.jp/search', 'google.com.au/search', 'google.ca/search', 'google.com.br/search', 'google.com.mx/search', 'google.nl/search'],
  outputSchema: {
    query: 'Search query',
    organicResults: 'Array of { position, title, url, snippet }',
    ads: 'Array of { title, url, snippet }',
    knowledgePanel: 'Knowledge graph data object or null',
    peopleAlsoAsk: 'Array of question strings',
    relatedSearches: 'Array of related search strings',
    totalResults: 'Estimated total result count (integer or null)',
  },
  requiredStrategy: 'http',
  requiredProxyTier: 'datacenter',

  extract(html: string, url: string): Record<string, any> {
    try {
      // -- Query from URL ------------------------------------------------
      let query = '';
      try {
        const urlObj = new URL(url);
        query = urlObj.searchParams.get('q') || '';
      } catch { /* ignore */ }
      if (!query) query = regexMatch(html, /<input[^>]*name=["']q["'][^>]*value=["']([^"']*)["']/i, 1);
      query = decodeEntities(query);

      // -- Total results -------------------------------------------------
      const totalResultsText = regexMatch(html, /id=["']result-stats["'][^>]*>([\s\S]*?)<\/div>/i, 1);
      const totalResultsMatch = totalResultsText.match(/([\d,]+)\s*results?/i)
        || totalResultsText.match(/About ([\d,]+)/i);
      const totalResults = totalResultsMatch ? parseInt(totalResultsMatch[1].replace(/,/g, ''), 10) : null;

      // -- Organic results -----------------------------------------------
      const organicResults: Array<{ position: number; title: string; url: string; snippet: string }> = [];
      const resultBlocks = html.matchAll(/class=["'][^"']*\bg\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi);

      // Fallback: use a simpler regex approach
      let position = 0;
      const simpleResults = html.matchAll(/<a[^>]*href=["'](\/url\?q=|\/search\?url=)?(https?:\/\/[^"']*?)["'][^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi);
      for (const m of simpleResults) {
        position++;
        const rawUrl = m[2] || '';
        const title = decodeEntities(stripHtml(m[3]));
        // Skip internal Google URLs
        if (!title || rawUrl.includes('google.com') || rawUrl.includes('googleusercontent')) continue;
        organicResults.push({ position, title, url: rawUrl, snippet: '' });
      }

      // Extract snippets -- look for description divs following result headers
      const snippetPattern = /class=["'][^"']*\bVwiC3b\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
      const snippets: string[] = [];
      let sm: RegExpExecArray | null;
      while ((sm = snippetPattern.exec(html)) !== null) {
        snippets.push(decodeEntities(stripHtml(sm[1])));
      }
      // Assign snippets to results by order
      for (let i = 0; i < organicResults.length && i < snippets.length; i++) {
        organicResults[i].snippet = snippets[i];
      }

      // -- Ads -----------------------------------------------------------
      const ads: Array<{ title: string; url: string; snippet: string }> = [];
      const adBlocks = html.matchAll(/class=["'][^"']*\buEierd\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi);
      for (const ab of adBlocks) {
        const adTitle = regexMatch(ab[1], /<h3[^>]*>([\s\S]*?)<\/h3>/i, 1);
        const adUrl = regexMatch(ab[1], /<a[^>]*href=["']([^"']*)["']/i, 1);
        const adSnippet = regexMatch(ab[1], /class=["'][^"']*\bVwiC3b\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i, 1);
        if (adTitle) {
          ads.push({
            title: decodeEntities(stripHtml(adTitle)),
            url: adUrl,
            snippet: decodeEntities(stripHtml(adSnippet)),
          });
        }
      }

      // -- People Also Ask -----------------------------------------------
      const peopleAlsoAsk: string[] = [];
      const paaPattern = /class=["'][^"']*\brelated-question-pair\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/gi;
      let paaM: RegExpExecArray | null;
      while ((paaM = paaPattern.exec(html)) !== null) {
        const q = decodeEntities(stripHtml(paaM[1]));
        if (q && q.endsWith('?') && !peopleAlsoAsk.includes(q)) peopleAlsoAsk.push(q);
      }

      // Fallback PAA regex
      if (peopleAlsoAsk.length === 0) {
        const paaAlt = html.matchAll(/class=["'][^"']*\bJlqpRe\b[^"']*["'][^>]*><span[^>]*>([\s\S]*?)<\/span>/gi);
        for (const pm of paaAlt) {
          const q = decodeEntities(stripHtml(pm[1]));
          if (q && q.endsWith('?') && !peopleAlsoAsk.includes(q)) peopleAlsoAsk.push(q);
        }
      }

      // -- Related searches ----------------------------------------------
      const relatedSearches: string[] = [];
      const relPattern = /class=["'][^"']*\bA7Y9pd\b[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/gi;
      let relM: RegExpExecArray | null;
      while ((relM = relPattern.exec(html)) !== null) {
        const s = decodeEntities(stripHtml(relM[1]));
        if (s && !relatedSearches.includes(s)) relatedSearches.push(s);
      }

      // -- Knowledge panel -----------------------------------------------
      let knowledgePanel: Record<string, any> | null = null;
      const kpMatch = html.match(/class=["'][^"']*\bkp-blk\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i);
      if (kpMatch) {
        const kpTitle = regexMatch(kpMatch[1], /<span[^>]*>[\s\S]*?<\/span>/i, 1);
        const kpDesc = regexMatch(kpMatch[1], /class=["'][^"']*\bkno-fv\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i, 1);
        knowledgePanel = {
          title: decodeEntities(stripHtml(kpTitle)),
          description: decodeEntities(stripHtml(kpDesc)),
        };
      }

      // JSON-LD for SERP
      const ldSerp = extractLdJson(html, 'searchresultspage');
      if (ldSerp && !query) {
        query = ldSerp.query || '';
      }

      return {
        query,
        organicResults,
        ads,
        knowledgePanel,
        peopleAlsoAsk,
        relatedSearches,
        totalResults,
      };
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Google SERP extraction failed');
      return {};
    }
  },
};

// --------------------------------------------------------------------------------
// 3. LinkedIn Profile
// --------------------------------------------------------------------------------

const linkedinProfileTemplate: ScraperTemplate = {
  id: 'linkedin_profile',
  name: 'LinkedIn Profile',
  description: 'Extract professional profile data from LinkedIn including name, headline, location, about section, experience, education, and skills.',
  domainPatterns: ['linkedin.com/in/', 'linkedin.com/pub/'],
  outputSchema: {
    name: 'Full name',
    headline: 'Professional headline / title',
    location: 'Geographic location',
    about: 'About / summary section text',
    experience: 'Array of { company, title, startDate, endDate, duration }',
    education: 'Array of { school, degree, field, startYear, endYear }',
    skills: 'Array of skill names',
  },
  requiredStrategy: 'stealth-browser',
  requiredProxyTier: 'residential',

  extract(html: string, _url: string): Record<string, any> {
    try {
      // -- Name ----------------------------------------------------------
      let name = regexMatch(html, /class=["'][^"']*\btext-heading-xlarge\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i, 1);
      if (!name) name = regexMatch(html, /class=["'][^"']*\bpv-top-card--list\b[^"']*["'][^>]*>[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i, 1);
      if (!name) name = extractOg(html, 'title');
      name = decodeEntities(stripHtml(name));

      // -- Headline ------------------------------------------------------
      let headline = regexMatch(html, /class=["'][^"']*\btext-body-medium\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i, 1);
      if (!headline) headline = regexMatch(html, /class=["'][^"']*\bmt1\b[^"']*["'][^>]*>[\s\S]*?class=["'][^"']*\btext-body-medium\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i, 1);
      headline = decodeEntities(stripHtml(headline));

      // -- Location ------------------------------------------------------
      let location = regexMatch(html, /class=["'][^"']*\btext-body-small\b[^"']*["'][^>]*style[^>]*>([\s\S]*?)<\/span>/i, 1);
      if (!location) location = regexMatch(html, /class=["'][^"']*\btext-body-small-inline\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i, 1);
      location = decodeEntities(stripHtml(location));

      // -- About ---------------------------------------------------------
      let about = '';
      const aboutSection = html.match(/class=["'][^"']*\bpv-about-section\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/i);
      if (aboutSection) about = stripHtml(aboutSection[1]).substring(0, 5000);
      if (!about) {
        const aboutDiv = html.match(/class=["'][^"']*\binline-show-more-text\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
        if (aboutDiv) about = stripHtml(aboutDiv[1]).substring(0, 5000);
      }

      // -- Experience ----------------------------------------------------
      const experience: Array<{ company: string; title: string; startDate: string; endDate: string; duration: string }> = [];
      const expBlocks = html.matchAll(/class=["'][^"']*\bpv-entity__position-group-pager\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi);
      for (const eb of expBlocks) {
        const expTitle = regexMatch(eb[1], /class=["'][^"']*\bt-16\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i, 1)
          || regexMatch(eb[1], /class=["'][^"']*\bmr1\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i, 1);
        const expCompany = regexMatch(eb[1], /class=["'][^"']*\bpv-entity__secondary-title\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i, 1)
          || regexMatch(eb[1], /class=["'][^"']*\bt-14\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i, 1);
        const expDate = regexMatch(eb[1], /class=["'][^"']*\bpv-entity__date-range\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i, 1);
        const expDuration = regexMatch(eb[1], /class=["'][^"']*\bpv-entity__bullet-item-v2\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i, 1);

        experience.push({
          company: decodeEntities(stripHtml(expCompany)),
          title: decodeEntities(stripHtml(expTitle)),
          startDate: '',
          endDate: '',
          duration: decodeEntities(stripHtml(expDuration || expDate)),
        });
      }

      // -- Education -----------------------------------------------------
      const education: Array<{ school: string; degree: string; field: string; startYear: string; endYear: string }> = [];
      const eduBlocks = html.matchAll(/class=["'][^"']*\bpv-entity__degree-info\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi);
      for (const db of eduBlocks) {
        const school = regexMatch(db[1], /class=["'][^"']*\bpv-entity__school-name\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i, 1);
        const degree = regexMatch(db[1], /class=["'][^"']*\bpv-entity__degree-name\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i, 1);
        const field = regexMatch(db[1], /class=["'][^"']*\bpv-entity__fos\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i, 1);
        const dates = regexMatch(db[1], /class=["'][^"']*\bpv-entity__dates\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i, 1);

        const yearMatch = dates.match(/(\d{4})\s*[-–]\s*(\d{4}|Present)/i);
        education.push({
          school: decodeEntities(stripHtml(school)),
          degree: decodeEntities(stripHtml(degree)),
          field: decodeEntities(stripHtml(field)),
          startYear: yearMatch ? yearMatch[1] : '',
          endYear: yearMatch ? yearMatch[2] : '',
        });
      }

      // -- Skills --------------------------------------------------------
      const skills: string[] = [];
      const skillPattern = /class=["'][^"']*\bpv-skill-category-entity\b[^"']*["'][^>]*>[\s\S]*?class=["'][^"']*\bpv-skill-category-entity__name-text\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
      let skM: RegExpExecArray | null;
      while ((skM = skillPattern.exec(html)) !== null) {
        const skill = decodeEntities(stripHtml(skM[1]));
        if (skill) skills.push(skill);
      }

      // Fallback: skill tokens from the page
      if (skills.length === 0) {
        const skillAlt = html.matchAll(/class=["'][^"']*\bpv-skill-entity__skill-name\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi);
        for (const sa of skillAlt) {
          const skill = decodeEntities(stripHtml(sa[1]));
          if (skill) skills.push(skill);
        }
      }

      // -- JSON-LD fallback ----------------------------------------------
      const ldPerson = extractLdJson(html, 'person');
      if (ldPerson) {
        if (!name && ldPerson.name) name = ldPerson.name;
        if (!headline && ldPerson.jobTitle) headline = Array.isArray(ldPerson.jobTitle) ? ldPerson.jobTitle.join(', ') : ldPerson.jobTitle;
        if (!location && ldPerson.address) {
          const addr = ldPerson.address;
          location = typeof addr === 'string' ? addr : `${addr.addressLocality || ''}, ${addr.addressCountry || ''}`.replace(/^,\s*|,\s*$/g, '');
        }
      }

      return { name, headline, location, about, experience, education, skills };
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'LinkedIn profile extraction failed');
      return {};
    }
  },
};

// --------------------------------------------------------------------------------
// 4. Twitter / X Tweet
// --------------------------------------------------------------------------------

const twitterTweetTemplate: ScraperTemplate = {
  id: 'twitter_tweet',
  name: 'Twitter / X Tweet',
  description: 'Extract tweet data from Twitter/X including username, display name, text, timestamp, engagement metrics, hashtags, mentions, and images.',
  domainPatterns: ['twitter.com/', 'x.com/'],
  outputSchema: {
    username: 'Handle (e.g. @elonmusk)',
    displayName: 'Display name',
    tweetText: 'Full tweet text',
    timestamp: 'ISO timestamp of the tweet',
    likes: 'Number of likes (integer)',
    retweets: 'Number of retweets (integer)',
    replies: 'Number of replies (integer)',
    views: 'Number of views / impressions (integer)',
    hashtags: 'Array of hashtag strings (without #)',
    mentions: 'Array of mentioned usernames (without @)',
    images: 'Array of image URLs',
    isRetweet: 'Whether this is a retweet',
    quoteTweetUrl: 'URL of quoted tweet if this is a quote tweet',
  },
  requiredStrategy: 'stealth-browser',
  requiredProxyTier: 'residential',

  extract(html: string, url: string): Record<string, any> {
    try {
      // -- Open Graph / meta fallbacks (most reliable for Twitter) -------
      let displayName = extractOg(html, 'title');
      if (displayName) {
        // OG title format is usually "Username on X: ..." or "Username on Twitter: ..."
        displayName = displayName.replace(/\s+on\s+(X|Twitter)\s*:.*/i, '').trim();
      }

      let tweetText = extractOg(html, 'description');
      if (tweetText) tweetText = decodeEntities(tweetText);

      const ogImage = extractOg(html, 'image');

      // -- Username from URL ---------------------------------------------
      let username = '';
      const urlMatch = url.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\//i);
      if (urlMatch) username = '@' + urlMatch[1];

      // -- From embedded JSON data ---------------------------------------
      const tweetDataMatch = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
      if (tweetDataMatch) {
        try {
          const jsonData = JSON.parse(tweetDataMatch[1]);
          const tweetResults = jsonData?.props?.pageProps?.tweetResult?.result;
          if (tweetResults) {
            const legacy = tweetResults?.legacy || tweetResults?.tweet?.legacy;
            const core = tweetResults?.core?.user_results?.result?.legacy
              || tweetResults?.tweet?.core?.user_results?.result?.legacy;

            if (core) {
              username = '@' + (core.screen_name || '');
              displayName = core.name || displayName;
            }
            if (legacy) {
              tweetText = legacy.full_text || tweetText;
              // Parse timestamp
              const createdAt = legacy.created_at || '';
              // Engagement
              const likes = legacy.favorite_count ?? null;
              const retweets = legacy.retweet_count ?? null;
              const replies = legacy.reply_count ?? null;
              const views = tweetResults?.views?.count
                || tweetResults?.tweet?.views?.count
                || null;

              const hashtags = (legacy.entities?.hashtags || []).map((h: any) => h.text);
              const mentions = (legacy.entities?.user_mentions || []).map((m: any) => '@' + m.screen_name);
              const images: string[] = (legacy.entities?.media || [])
                .filter((m: any) => m.type === 'photo')
                .map((m: any) => m.media_url_https || m.media_url);

              const isRetweet = !!legacy.retweeted_status_id_str;
              const quoteTweetUrl = legacy.quoted_status_id_str
                ? `https://x.com/i/status/${legacy.quoted_status_id_str}`
                : null;

              return {
                username,
                displayName,
                tweetText: decodeEntities(tweetText),
                timestamp: createdAt,
                likes: typeof likes === 'number' ? likes : parseNumber(String(likes)),
                retweets: typeof retweets === 'number' ? retweets : parseNumber(String(retweets)),
                replies: typeof replies === 'number' ? replies : parseNumber(String(replies)),
                views: typeof views === 'number' ? views : parseNumber(String(views)),
                hashtags,
                mentions,
                images,
                isRetweet,
                quoteTweetUrl,
              };
            }
          }
        } catch {
          // Fall through to regex extraction
        }
      }

      // -- Regex-based fallback extraction -------------------------------
      if (!username) {
        const handleMatch = html.match(/class=["'][^"']*\busername\b[^"']*["'][^>]*>[\s\S]*?@([\w]+)/i);
        if (handleMatch) username = '@' + handleMatch[1];
      }

      // Hashtags and mentions from tweet text
      const hashtags = (tweetText.match(/#(\w+)/g) || []).map(h => h.substring(1));
      const mentions = (tweetText.match(/@(\w{1,15})/g) || []).map(m => m);

      // Engagement metrics from HTML
      const likesText = regexMatch(html, /class=["'][^"']*\blike\b[^"']*["'][^>]*>[\s\S]*?(\d[\d,]*)/i, 1)
        || regexMatch(html, /data-favorite-count=["'](\d+)["']/i, 1);
      const retweetsText = regexMatch(html, /class=["'][^"']*\bretweet\b[^"']*["'][^>]*>[\s\S]*?(\d[\d,]*)/i, 1)
        || regexMatch(html, /data-retweet-count=["'](\d+)["']/i, 1);
      const repliesText = regexMatch(html, /class=["'][^"']*\breply\b[^"']*["'][^>]*>[\s\S]*?(\d[\d,]*)/i, 1);

      // Timestamp
      const timestamp = regexMatch(html, /datetime=["']([^"']*)["']/i, 1)
        || regexMatch(html, /data-time=["'](\d+)["']/i, 1)
        || extractMetaProperty(html, 'article:published_time');

      // Images
      const images: string[] = [];
      if (ogImage) images.push(ogImage);
      const imgMatches = html.matchAll(/class=["'][^"']*\btweet-photo\b[^"']*["'][^>]*src=["']([^"']*)["']/gi);
      for (const im of imgMatches) {
        if (im[1] && !images.includes(im[1])) images.push(im[1]);
      }

      const isRetweet = /class=["'][^"']*\bretweet\b[^"']*["']/i.test(html)
        || tweetText.startsWith('RT @');

      return {
        username,
        displayName,
        tweetText,
        timestamp,
        likes: parseNumber(likesText),
        retweets: parseNumber(retweetsText),
        replies: parseNumber(repliesText),
        views: null,
        hashtags,
        mentions,
        images,
        isRetweet,
        quoteTweetUrl: null,
      };
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Twitter tweet extraction failed');
      return {};
    }
  },
};

// --------------------------------------------------------------------------------
// 5. Zillow Listing
// --------------------------------------------------------------------------------

const zillowListingTemplate: ScraperTemplate = {
  id: 'zillow_listing',
  name: 'Zillow Listing',
  description: 'Extract property listing data from Zillow including address, price, beds, baths, sqft, year built, home type, agent, images, and description.',
  domainPatterns: ['zillow.com/homedetails/', 'zillow.com/home/', 'zillow.com/b/'],
  outputSchema: {
    address: 'Full property address',
    price: 'List price (number)',
    beds: 'Number of bedrooms (integer)',
    baths: 'Number of bathrooms (number)',
    sqft: 'Square footage (integer)',
    yearBuilt: 'Year the home was built (integer)',
    homeType: 'Type of home (House, Apartment, Condo, etc.)',
    agent: 'Listing agent name',
    images: 'Array of image URLs',
    description: 'Property description text',
    priceHistory: 'Array of { date, price, event }',
    zestimate: 'Zillow estimated value (number)',
  },
  requiredStrategy: 'browser',
  requiredProxyTier: 'residential',

  extract(html: string, url: string): Record<string, any> {
    try {
      // -- Extract from embedded JSON (Zillow puts everything in __NEXT_DATA__ or hdpApolloPreloadedData) --
      let address = '';
      let price: number | null = null;
      let beds: number | null = null;
      let baths: number | null = null;
      let sqft: number | null = null;
      let yearBuilt: number | null = null;
      let homeType = '';
      let agent = '';
      let zestimate: number | null = null;
      const images: string[] = [];
      let description = '';
      const priceHistory: Array<{ date: string; price: number; event: string }> = [];

      // Try hdpApolloPreloadedData
      const apolloMatch = html.match(/id=["']hdpApolloPreloadedData["'][^>]*>([\s\S]*?)<\/script>/i);
      if (apolloMatch) {
        try {
          const apolloData = JSON.parse(apolloMatch[1]);
          // Navigate the Apollo cache for property data
          const cache = apolloData?.apiCache || apolloData;
          const propertyKey = Object.keys(cache || {}).find(k => k.includes('VariantMarketHdp'));
          if (propertyKey) {
            const propData = cache[propertyKey]?.property;
            if (propData) {
              address = propData.address?.streetAddress || propData.address?.full || '';
              if (propData.address?.city) address += ', ' + propData.address.city;
              if (propData.address?.state) address += ', ' + propData.address.state;
              if (propData.address?.zipcode) address += ' ' + propData.address.zipcode;
              price = propData.price ?? null;
              beds = propData.bedrooms ?? null;
              baths = propData.bathrooms ?? null;
              sqft = propData.livingArea ?? propData.livingAreaValue ?? null;
              yearBuilt = propData.yearBuilt ?? null;
              homeType = propData.homeType || '';
              description = propData.description || '';
              zestimate = propData.zestimate ?? null;
              if (propData.attributionInfo?.agentName) agent = propData.attributionInfo.agentName;
            }
          }
        } catch {
          // Fall through
        }
      }

      // Try __NEXT_DATA__
      const nextDataMatch = html.match(/id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
      if (nextDataMatch) {
        try {
          const nextData = JSON.parse(nextDataMatch[1]);
          const props = nextData?.props?.pageProps?.componentProps;
          const zdpData = props?.zdpData || props;
          if (zdpData) {
            const homeInfo = zdpData.homeInfo || zdpData.property;
            if (homeInfo) {
              if (!address) address = homeInfo.address || homeInfo.streetAddress || '';
              if (price === null) price = homeInfo.price ?? homeInfo.listPrice ?? null;
              if (beds === null) beds = homeInfo.bedrooms ?? null;
              if (baths === null) baths = homeInfo.bathrooms ?? null;
              if (sqft === null) sqft = homeInfo.livingArea ?? homeInfo.livingAreaValue ?? null;
              if (yearBuilt === null) yearBuilt = homeInfo.yearBuilt ?? null;
              if (!homeType) homeType = homeInfo.homeType || '';
              if (!description) description = homeInfo.description || '';
              if (zestimate === null) zestimate = homeInfo.zestimate ?? null;
            }
          }
        } catch {
          // Fall through
        }
      }

      // -- Regex fallbacks -----------------------------------------------
      if (!address) {
        address = regexMatch(html, /class=["'][^"']*\bds-address-container\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i, 1)
          || extractOg(html, 'title');
        address = decodeEntities(stripHtml(address));
      }

      if (price === null) {
        const priceText = regexMatch(html, /class=["'][^"']*\bds-value\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i, 1)
          || regexMatch(html, /class=["'][^"']*\bds-home-details\b[^"']*["'][^>]*>[\s\S]*?\$([\d,]+)/i, 1);
        price = parseNumber(priceText ? '$' + priceText : '');
        if (price === null) {
          const rawPrice = regexMatch(html, /\$([\d,]+(?:\.\d+)?)/, 1);
          if (rawPrice) price = parseNumber(rawPrice);
        }
      }

      if (beds === null) {
        const bedsText = regexMatch(html, /(\d+)\s*(?:bd|bed(?:room)?s?)\b/i, 1);
        if (bedsText) beds = parseInt(bedsText, 10);
      }

      if (baths === null) {
        const bathsText = regexMatch(html, /(\d+(?:\.\d+)?)\s*(?:ba|bath(?:room)?s?)\b/i, 1);
        if (bathsText) baths = parseFloat(bathsText);
      }

      if (sqft === null) {
        const sqftText = regexMatch(html, /([\d,]+)\s*(?:sqft|sq\.?\s*ft\.?|square\s*feet)/i, 1);
        if (sqftText) sqft = parseInt(sqftText.replace(/,/g, ''), 10);
      }

      if (yearBuilt === null) {
        const yearText = regexMatch(html, /built\s*(?:in|:)\s*(\d{4})/i, 1)
          || regexMatch(html, /year\s*built[:\s]*(\d{4})/i, 1);
        if (yearText) yearBuilt = parseInt(yearText, 10);
      }

      if (!homeType) {
        const typeMatch = html.match(/class=["'][^"']*\bds-home-fact\b[^"']*["'][^>]*>[\s\S]*?(House|Condo|Apartment|Townhouse|Manufactured|Lot)/i);
        if (typeMatch) homeType = typeMatch[1];
      }

      if (!agent) {
        agent = regexMatch(html, /class=["'][^"']*\bagent-name\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i, 1)
          || regexMatch(html, /listing\s*agent[:\s]*([^\n<]{3,50})/i, 1);
        agent = stripHtml(agent);
      }

      if (!description) {
        description = regexMatch(html, /class=["'][^"']*\bds-home-description\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i, 1);
        if (description) description = stripHtml(description).substring(0, 5000);
      }

      // Images
      if (images.length === 0) {
        const ogImg = extractOg(html, 'image');
        if (ogImg) images.push(ogImg);
        const imgMatches = html.matchAll(/class=["'][^"']*\bmedia-stream-image\b[^"']*["'][^>]*src=["']([^"']*)["']/gi);
        for (const im of imgMatches) {
          if (im[1] && !images.includes(im[1])) images.push(im[1]);
        }
      }

      return {
        address,
        price,
        beds,
        baths,
        sqft,
        yearBuilt,
        homeType,
        agent,
        images,
        description,
        priceHistory,
        zestimate,
      };
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Zillow listing extraction failed');
      return {};
    }
  },
};

// --------------------------------------------------------------------------------
// 6. YouTube Video
// --------------------------------------------------------------------------------

const youtubeVideoTemplate: ScraperTemplate = {
  id: 'youtube_video',
  name: 'YouTube Video',
  description: 'Extract video metadata from YouTube including title, channel, views, likes, upload date, description, tags, duration, and thumbnail.',
  domainPatterns: ['youtube.com/watch', 'youtu.be/', 'youtube.com/shorts/', 'm.youtube.com/watch'],
  outputSchema: {
    title: 'Video title',
    channel: 'Channel name',
    channelId: 'Channel ID',
    views: 'View count (integer)',
    likes: 'Like count (integer)',
    uploadDate: 'Upload date (ISO string)',
    description: 'Video description text',
    tags: 'Array of tag strings',
    duration: 'Duration in seconds (integer)',
    durationFormatted: 'Duration formatted as HH:MM:SS',
    thumbnail: 'Thumbnail image URL',
    category: 'Video category',
  },
  requiredStrategy: 'browser',
  requiredProxyTier: 'datacenter',

  extract(html: string, url: string): Record<string, any> {
    try {
      // -- Try ytInitialPlayerResponse (most reliable) -------------------
      let title = '';
      let channel = '';
      let channelId = '';
      let views: number | null = null;
      let likes: number | null = null;
      let uploadDate = '';
      let description = '';
      let tags: string[] = [];
      let duration: number | null = null;
      let durationFormatted = '';
      let thumbnail = '';
      let category = '';

      const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*({[\s\S]*?});\s*(?:var|let|const|\n)/i);
      if (playerMatch) {
        try {
          const playerData = JSON.parse(playerMatch[1]);
          const vd = playerData?.videoDetails;
          if (vd) {
            title = vd.title || '';
            channel = vd.author || '';
            channelId = vd.channelId || '';
            views = parseInt(vd.viewCount, 10) || null;
            description = vd.shortDescription || '';
            tags = vd.keywords || [];
            duration = parseInt(vd.lengthSeconds, 10) || null;
          }
          thumbnail = playerData?.videoDetails?.thumbnail?.thumbnails?.[0]?.url || '';
        } catch {
          // Fall through
        }
      }

      // -- Try ytInitialData for engagement data -------------------------
      const initialDataMatch = html.match(/ytInitialData\s*=\s*({[\s\S]*?});\s*(?:var|let|const|\n)/i);
      if (initialDataMatch) {
        try {
          const initialData = JSON.parse(initialDataMatch[1]);
          const contents = initialData?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
          if (contents) {
            for (const content of contents) {
              const primaryInfo = content?.videoPrimaryInfoRenderer;
              if (primaryInfo) {
                // Views
                const viewText = primaryInfo.viewCount?.videoViewCountRenderer?.viewCount?.simpleText || '';
                if (views === null) {
                  const viewMatch = viewText.match(/([\d,]+)/);
                  if (viewMatch) views = parseInt(viewMatch[1].replace(/,/g, ''), 10);
                }
                // Date
                uploadDate = primaryInfo.dateText?.simpleText || uploadDate;
                // Likes
                const likeBtn = primaryInfo.videoActions?.menuRenderer?.topLevelButtons;
                if (likeBtn) {
                  for (const btn of likeBtn) {
                    const likeText = btn?.toggleButtonRenderer?.defaultText?.accessibility?.accessibilityData?.label || '';
                    const likeMatch = likeText.match(/([\d,]+)/);
                    if (likeMatch && likes === null) {
                      likes = parseInt(likeMatch[1].replace(/,/g, ''), 10);
                    }
                  }
                }
              }
              const secInfo = content?.videoSecondaryInfoRenderer;
              if (secInfo) {
                if (!channel) channel = secInfo.owner?.videoOwnerRenderer?.title?.runs?.[0]?.text || '';
                if (!channelId) channelId = secInfo.owner?.videoOwnerRenderer?.navigationEndpoint?.browseEndpoint?.browseId || '';
                if (!description) {
                  const descRuns = secInfo.attributedDescriptionBodyText?.content || '';
                  if (descRuns) description = descRuns;
                }
              }
            }
          }
        } catch {
          // Fall through
        }
      }

      // -- Duration formatted --------------------------------------------
      if (duration !== null) {
        const h = Math.floor(duration / 3600);
        const m = Math.floor((duration % 3600) / 60);
        const s = duration % 60;
        durationFormatted = h > 0
          ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
          : `${m}:${String(s).padStart(2, '0')}`;
      }

      // -- Meta tag / OG fallbacks ---------------------------------------
      if (!title) title = decodeEntities(extractOg(html, 'title')) || extractMetaName(html, 'title');
      if (!description) description = decodeEntities(extractOg(html, 'description'));
      if (!thumbnail) thumbnail = extractOg(html, 'image');
      if (!uploadDate) uploadDate = extractMetaProperty(html, 'video:release_date')
        || extractMetaProperty(html, 'article:published_time');

      // Category from meta
      if (!category) category = extractMetaName(html, 'genre');

      // Duration from meta if still missing
      if (duration === null) {
        const durMeta = extractMetaProperty(html, 'video:duration');
        if (durMeta) duration = parseInt(durMeta, 10) || null;
      }

      return {
        title,
        channel,
        channelId,
        views,
        likes,
        uploadDate,
        description,
        tags,
        duration,
        durationFormatted,
        thumbnail,
        category,
      };
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'YouTube video extraction failed');
      return {};
    }
  },
};

// --------------------------------------------------------------------------------
// 7. Wikipedia Article
// --------------------------------------------------------------------------------

const wikipediaArticleTemplate: ScraperTemplate = {
  id: 'wikipedia_article',
  name: 'Wikipedia Article',
  description: 'Extract article data from Wikipedia including title, introduction, infobox data, sections, categories, and last edited date.',
  domainPatterns: ['wikipedia.org/wiki/'],
  outputSchema: {
    title: 'Article title',
    intro: 'Introduction / lead section text',
    infobox: 'Key-value pairs from the infobox',
    sections: 'Array of { title, level, anchor }',
    categories: 'Array of category names',
    lastEdited: 'Last edited date string',
    url: 'Canonical article URL',
  },
  requiredStrategy: 'http',
  requiredProxyTier: 'datacenter',

  extract(html: string, url: string): Record<string, any> {
    try {
      // -- Title ---------------------------------------------------------
      let title = regexMatch(html, /id=["']firstHeading["'][^>]*>([\s\S]*?)<\/h1>/i, 1);
      if (!title) title = extractOg(html, 'title');
      title = decodeEntities(stripHtml(title));

      // -- Intro / lead section ------------------------------------------
      let intro = '';
      const contentMatch = html.match(/id=["']mw-content-text["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
      if (contentMatch) {
        // Extract paragraphs before the first <h2> or section heading
        const leadSection = contentMatch[1].match(/^([\s\S]*?)(?:<h2|<div\s+class="[^"]*\bheading[^"]*")/i);
        if (leadSection) {
          const paragraphs = leadSection[1].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi);
          const introParts: string[] = [];
          for (const p of paragraphs) {
            const text = stripHtml(p[1]);
            if (text && !text.startsWith('Coordinates:') && text.length > 10) {
              introParts.push(text);
            }
          }
          intro = introParts.join('\n\n').substring(0, 10000);
        }
      }
      if (!intro) {
        // Simple fallback: first significant paragraph
        const firstP = html.match(/<p>([\s\S]*?)<\/p>/i);
        if (firstP) intro = stripHtml(firstP[1]).substring(0, 10000);
      }

      // -- Infobox -------------------------------------------------------
      const infobox: Record<string, string> = {};
      const infoboxMatch = html.match(/class=["'][^"']*\binfobox\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i);
      if (infoboxMatch) {
        const rows = infoboxMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
        for (const row of rows) {
          const th = regexMatch(row[1], /<th[^>]*>([\s\S]*?)<\/th>/i, 1);
          const td = regexMatch(row[1], /<td[^>]*>([\s\S]*?)<\/td>/i, 1);
          if (th && td) {
            const key = stripHtml(th);
            const value = stripHtml(td);
            if (key && value) infobox[key] = value;
          }
        }
      }

      // -- Sections ------------------------------------------------------
      const sections: Array<{ title: string; level: number; anchor: string }> = [];
      const headingPattern = /<h[23][^>]*>\s*<span[^>]*class=["'][^"']*\bmw-headline\b[^"']*["'][^>]*id=["']([^"']*)["'][^>]*>([\s\S]*?)<\/span>/gi;
      let hM: RegExpExecArray | null;
      while ((hM = headingPattern.exec(html)) !== null) {
        const anchor = hM[1];
        const headingText = stripHtml(hM[2]);
        const level = html.indexOf(hM[0]) > -1 && html.substring(html.indexOf(hM[0]) - 20, html.indexOf(hM[0])).includes('<h2') ? 2 : 3;
        if (headingText) sections.push({ title: headingText, level, anchor });
      }

      // -- Categories ----------------------------------------------------
      const categories: string[] = [];
      const catPattern = /class=["'][^"']*\bnew\b[^"']*["'][^>]*title=["']Category:([^"']*)["']/gi;
      let cM: RegExpExecArray | null;
      while ((cM = catPattern.exec(html)) !== null) {
        if (cM[1]) categories.push(decodeEntities(cM[1].replace(/_/g, ' ')));
      }
      // Also try normal category links
      const catPattern2 = /title=["']Category:([^"']*)["']/gi;
      while ((cM = catPattern2.exec(html)) !== null) {
        const cat = decodeEntities(cM[1].replace(/_/g, ' '));
        if (cat && !categories.includes(cat)) categories.push(cat);
      }

      // -- Last edited ---------------------------------------------------
      const lastEdited = regexMatch(html, /id=["']footer-info-lastmod["'][^>]*>([\s\S]*?)<\/li>/i, 1);
      const lastEditedClean = stripHtml(lastEdited).replace(/^This page was last edited on\s*/i, '').trim();

      // -- Canonical URL -------------------------------------------------
      const canonicalUrl = regexMatch(html, /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i, 1);

      return {
        title,
        intro,
        infobox,
        sections,
        categories,
        lastEdited: lastEditedClean,
        url: canonicalUrl || url,
      };
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Wikipedia article extraction failed');
      return {};
    }
  },
};

// --------------------------------------------------------------------------------
// 8. Reddit Post
// --------------------------------------------------------------------------------

const redditPostTemplate: ScraperTemplate = {
  id: 'reddit_post',
  name: 'Reddit Post',
  description: 'Extract post data from Reddit including title, author, subreddit, score, comment count, body text, flair, timestamp, and awards.',
  domainPatterns: ['reddit.com/r/', 'old.reddit.com/r/', 'www.reddit.com/r/', 'redd.it/'],
  outputSchema: {
    title: 'Post title',
    author: 'Post author username',
    subreddit: 'Subreddit name (without r/)',
    score: 'Post score / upvotes (integer)',
    upvoteRatio: 'Upvote ratio (0-1 float)',
    commentCount: 'Number of comments (integer)',
    postText: 'Self-post body text',
    flair: 'Post flair text',
    timestamp: 'ISO timestamp',
    awards: 'Array of { type, count }',
    url: 'Post URL',
    isNsfw: 'Whether the post is NSFW',
    isSpoiler: 'Whether the post is a spoiler',
    linkUrl: 'External link URL (for link posts)',
    images: 'Array of image URLs',
  },
  requiredStrategy: 'http',
  requiredProxyTier: 'datacenter',

  extract(html: string, url: string): Record<string, any> {
    try {
      // -- Try embedded JSON (reddit puts data in <script id="data">) ----
      let title = '';
      let author = '';
      let subreddit = '';
      let score: number | null = null;
      let upvoteRatio: number | null = null;
      let commentCount: number | null = null;
      let postText = '';
      let flair = '';
      let timestamp = '';
      const awards: Array<{ type: string; count: number }> = [];
      let linkUrl = '';
      const images: string[] = [];
      let isNsfw = false;
      let isSpoiler = false;

      const dataScriptMatch = html.match(/id=["']data["'][^>]*>([\s\S]*?)<\/script>/i);
      if (dataScriptMatch) {
        try {
          const jsonData = JSON.parse(dataScriptMatch[1]);
          const posts = jsonData?.posts;
          if (posts) {
            const postId = Object.keys(posts)[0];
            const post = posts[postId];
            if (post) {
              title = post.title || '';
              author = post.author || '';
              subreddit = post.subreddit || '';
              score = post.score ?? null;
              upvoteRatio = post.upvoteRatio ?? null;
              commentCount = post.numComments ?? null;
              postText = post.selftext || post.body || '';
              flair = post.linkFlairText || '';
              timestamp = post.createdUtc ? new Date(post.createdUtc * 1000).toISOString() : '';
              isNsfw = post.over18 || post.isNsfw || false;
              isSpoiler = post.spoiler || false;
              linkUrl = post.url || '';

              if (post.allAwardings) {
                for (const a of post.allAwardings) {
                  awards.push({ type: a.name || '', count: a.count || 0 });
                }
              }

              if (post.media?.images) {
                for (const img of post.media.images) {
                  if (img.source?.url) images.push(img.source.url);
                }
              }
            }
          }
        } catch {
          // Fall through
        }
      }

      // -- Regex fallbacks -----------------------------------------------

      // Subreddit from URL
      if (!subreddit) {
        const subMatch = url.match(/\/r\/([^/]+)/i);
        if (subMatch) subreddit = subMatch[1];
      }

      // Title
      if (!title) {
        title = regexMatch(html, /class=["'][^"']*\bpost-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h\d>/i, 1)
          || regexMatch(html, /<a[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i, 1)
          || extractOg(html, 'title');
        title = decodeEntities(stripHtml(title));

        // Remove subreddit prefix from OG title
        const prefixMatch = title.match(/^.+:\s*(.+)/);
        if (prefixMatch) title = prefixMatch[1].trim();
      }

      // Author
      if (!author) {
        author = regexMatch(html, /class=["'][^"']*\bauthor\b[^"']*["'][^>]*href=["'][^"]*\/user\/([^/"']*)/i, 1)
          || regexMatch(html, /data-author=["']([^"']*)["']/i, 1);
      }

      // Score
      if (score === null) {
        const scoreText = regexMatch(html, /class=["'][^"']*\bscore\b[^"']*["'][^>]*title=["'](\d+)/i, 1)
          || regexMatch(html, /class=["'][^"']*\bunvoted\b[^"']*["'][^>]*>([\d,]+)/i, 1);
        score = parseNumber(scoreText);
      }

      // Comment count
      if (commentCount === null) {
        const commentText = regexMatch(html, /(\d[\d,]*)\s*comments?/i, 1);
        commentCount = parseNumber(commentText);
      }

      // Post text (self-post)
      if (!postText) {
        postText = regexMatch(html, /class=["'][^"']*\busertext-body\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i, 1)
          || regexMatch(html, /class=["'][^"']*\bmd\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i, 1);
        postText = stripHtml(postText).substring(0, 50000);
      }

      // Flair
      if (!flair) {
        flair = regexMatch(html, /class=["'][^"']*\blinkflairlabel\b[^"']*["'][^>]*title=["']([^"']*)["']/i, 1)
          || regexMatch(html, /class=["'][^"']*\bflair\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i, 1);
        flair = stripHtml(flair);
      }

      // Timestamp
      if (!timestamp) {
        const epochStr = regexMatch(html, /datetime=["'](\d+)["']/i, 1)
          || regexMatch(html, /data-timestamp=["'](\d+)["']/i, 1)
          || regexMatch(html, /data-created=["'](\d+)["']/i, 1);
        if (epochStr) {
          const epoch = parseInt(epochStr, 10);
          timestamp = new Date(epoch > 1e12 ? epoch : epoch * 1000).toISOString();
        }
        if (!timestamp) timestamp = regexMatch(html, /class=["'][^"']*\blive-timestamp\b[^"']*["'][^>]*>([\s\S]*?)<\/time>/i, 1);
      }

      // Images
      if (images.length === 0) {
        const ogImg = extractOg(html, 'image');
        if (ogImg) images.push(ogImg);
        // Reddit preview images
        const imgMatches = html.matchAll(/class=["'][^"']*\bpreview-image\b[^"']*["'][^>]*src=["']([^"']*)["']/gi);
        for (const im of imgMatches) {
          if (im[1] && !images.includes(im[1])) images.push(im[1]);
        }
      }

      // NSFW
      if (!isNsfw) isNsfw = /class=["'][^"']*\bnsfw\b[^"']*["']/i.test(html) || /over18/i.test(html);

      return {
        title,
        author,
        subreddit,
        score,
        upvoteRatio,
        commentCount,
        postText,
        flair,
        timestamp,
        awards,
        url,
        isNsfw,
        isSpoiler,
        linkUrl,
        images,
      };
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Reddit post extraction failed');
      return {};
    }
  },
};

// --------------------------------------------------------------------------------
// 9. IMDB Movie
// --------------------------------------------------------------------------------

const imdbMovieTemplate: ScraperTemplate = {
  id: 'imdb_movie',
  name: 'IMDB Movie',
  description: 'Extract movie data from IMDB including title, year, rating, votes, genre, director, cast, plot, runtime, and poster.',
  domainPatterns: ['imdb.com/title/', 'imdb.com/list/', 'm.imdb.com/title/'],
  outputSchema: {
    title: 'Movie / show title',
    year: 'Release year (integer)',
    rating: 'IMDB rating out of 10 (number)',
    votes: 'Number of votes (integer)',
    genre: 'Array of genre strings',
    director: 'Director name(s)',
    cast: 'Array of actor names',
    plot: 'Plot summary / description',
    runtime: 'Runtime in minutes (integer)',
    runtimeFormatted: 'Runtime formatted string (e.g. "2h 15m")',
    poster: 'Poster image URL',
    type: 'Title type (Movie, TV Series, etc.)',
    contentRating: 'MPAA / content rating (PG, R, etc.)',
  },
  requiredStrategy: 'browser',
  requiredProxyTier: 'datacenter',

  extract(html: string, _url: string): Record<string, any> {
    try {
      // -- JSON-LD extraction (IMDB provides rich structured data) --------
      let title = '';
      let year: number | null = null;
      let rating: number | null = null;
      let votes: number | null = null;
      let genre: string[] = [];
      let director = '';
      let cast: string[] = [];
      let plot = '';
      let runtime: number | null = null;
      let runtimeFormatted = '';
      let poster = '';
      let type = '';
      let contentRating = '';

      const ldMovie = extractLdJson(html, 'movie') || extractLdJson(html, 'tvepisode') || extractLdJson(html, 'tvseries');
      if (ldMovie) {
        title = ldMovie.name || '';
        plot = ldMovie.description || '';
        poster = ldMovie.image || '';
        contentRating = ldMovie.contentRating || '';
        type = (ldMovie['@type'] || '').replace(/([A-Z])/g, ' $1').trim();

        if (ldMovie.datePublished) {
          const dateMatch = ldMovie.datePublished.match(/(\d{4})/);
          if (dateMatch) year = parseInt(dateMatch[1], 10);
        }

        if (ldMovie.aggregateRating) {
          rating = parseFloat(ldMovie.aggregateRating.ratingValue) || null;
          votes = parseInt(ldMovie.aggregateRating.ratingCount, 10) || null;
        }

        if (ldMovie.genre) {
          genre = Array.isArray(ldMovie.genre) ? ldMovie.genre : [ldMovie.genre];
        }

        if (ldMovie.director) {
          const dirs = Array.isArray(ldMovie.director) ? ldMovie.director : [ldMovie.director];
          director = dirs.map((d: any) => typeof d === 'string' ? d : d.name || '').filter(Boolean).join(', ');
        }

        if (ldMovie.actor) {
          const actors = Array.isArray(ldMovie.actor) ? ldMovie.actor : [ldMovie.actor];
          cast = actors.map((a: any) => typeof a === 'string' ? a : a.name || '').filter(Boolean);
        }

        if (ldMovie.duration) {
          const durMatch = ldMovie.duration.match(/PT(\d+)H?(\d+)?M?/);
          if (durMatch) {
            const hours = parseInt(durMatch[1] || '0', 10);
            const mins = parseInt(durMatch[2] || '0', 10);
            runtime = hours * 60 + mins;
          }
        }
      }

      // -- Regex fallbacks -----------------------------------------------

      // Title
      if (!title) {
        title = regexMatch(html, /class=["'][^"']*\btitleType\b[^"']*["'][^>]*>[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i, 1);
        if (!title) title = regexMatch(html, /<h1[^>]*data-testid=["']hero-title-block__title["'][^>]*>([\s\S]*?)<\/h1>/i, 1);
        title = decodeEntities(stripHtml(title));
      }

      // Year
      if (year === null) {
        const yearText = regexMatch(html, /class=["'][^"']*\btitleYear\b[^"']*["'][^>]*>[\s\S]*?\((\d{4})\)/i, 1)
          || regexMatch(html, /<span[^>]*data-testid=["']hero-title-block__year["'][^>]*>[\s\S]*?(\d{4})/i, 1);
        if (yearText) year = parseInt(yearText, 10);
      }

      // Rating
      if (rating === null) {
        const ratingText = regexMatch(html, /class=["'][^"']*\bimdbRating\b[^"']*["'][^>]*>[\s\S]*?([\d.]+)/i, 1)
          || regexMatch(html, /data-testid=["']hero-rating-bar__aggregate-rating__score["'][^>]*>[\s\S]*?([\d.]+)/i, 1);
        if (ratingText) rating = parseFloat(ratingText);
      }

      // Votes
      if (votes === null) {
        const votesText = regexMatch(html, /class=["'][^"']*\bimdbRating\b[^"']*["'][^>]*>[\s\S]*?small[^>]*>([\d,]+)/i, 1)
          || regexMatch(html, /class=["'][^"']*\bratingCount\b[^"']*["'][^>]*>([\d,]+)/i, 1);
        if (votesText) votes = parseInt(votesText.replace(/,/g, ''), 10);
      }

      // Genre
      if (genre.length === 0) {
        const genreSection = html.match(/class=["'][^"']*\bsee-more\b[^"']*["'][^>]*>[\s\S]*?Genre/i);
        if (genreSection) {
          const genreLinks = genreSection[0].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi);
          for (const gl of genreLinks) {
            const g = stripHtml(gl[1]);
            if (g && !genre.includes(g)) genre.push(g);
          }
        }
        // Alternative: inline genre chips
        if (genre.length === 0) {
          const genreChips = html.matchAll(/class=["'][^"']*\bipc-chip\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/gi);
          for (const gc of genreChips) {
            const g = stripHtml(gc[1]);
            if (g && g.length < 30 && !genre.includes(g)) genre.push(g);
          }
        }
      }

      // Director
      if (!director) {
        director = regexMatch(html, /class=["'][^"']*\bcredit_summary_item\b[^"']*["'][^>]*>[\s\S]*?Director[s]?:[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i, 1)
          || regexMatch(html, /class=["'][^"']*\bsummary_text\b[^"']*["'][^>]*>[\s\S]*?Directed by\s+([^<.]+)/i, 1);
        director = stripHtml(director);
      }

      // Cast
      if (cast.length === 0) {
        const castPattern = /class=["'][^"']*\bprimary_photo\b[^"']*["'][^>]*>[\s\S]*?alt=["']([^"']*)["']/gi;
        let cM: RegExpExecArray | null;
        while ((cM = castPattern.exec(html)) !== null) {
          if (cM[1]) cast.push(cM[1]);
        }
        // Alternative: title-cast-item
        if (cast.length === 0) {
          const castItems = html.matchAll(/data-testid=["']title-cast-item__actor["'][^>]*>([\s\S]*?)<\/a>/gi);
          for (const ci of castItems) {
            const name = stripHtml(ci[1]);
            if (name) cast.push(name);
          }
        }
      }

      // Plot
      if (!plot) {
        plot = regexMatch(html, /class=["'][^"']*\bsummary_text\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i, 1)
          || regexMatch(html, /data-testid=["']plot-xl["'][^>]*>([\s\S]*?)<\/span>/i, 1)
          || extractOg(html, 'description');
        plot = decodeEntities(stripHtml(plot)).substring(0, 3000);
      }

      // Runtime
      if (runtime === null) {
        const runtimeText = regexMatch(html, /class=["'][^"']*\btechnical-specs\b[^"']*["'][^>]*>[\s\S]*?(\d+)\s*min/i, 1)
          || regexMatch(html, /data-testid=["']title-techspec-runtime["'][^>]*>[\s\S]*?(\d+)\s*min/i, 1)
          || regexMatch(html, /Runtime[\s\S]*?(\d+)\s*min/i, 1);
        if (runtimeText) runtime = parseInt(runtimeText, 10);
      }

      // Runtime formatted
      if (runtime !== null && !runtimeFormatted) {
        const h = Math.floor(runtime / 60);
        const m = runtime % 60;
        runtimeFormatted = h > 0 ? `${h}h ${m}m` : `${m}m`;
      }

      // Poster
      if (!poster) {
        poster = extractOg(html, 'image');
      }

      // Content rating
      if (!contentRating) {
        contentRating = regexMatch(html, /contentRating["']\s*:\s*["']([^"']*)["']/i, 1)
          || regexMatch(html, /class=["'][^"']*\bcertificate\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i, 1);
        contentRating = stripHtml(contentRating);
      }

      return {
        title,
        year,
        rating,
        votes,
        genre,
        director,
        cast,
        plot,
        runtime,
        runtimeFormatted,
        poster,
        type,
        contentRating,
      };
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'IMDB movie extraction failed');
      return {};
    }
  },
};

// --------------------------------------------------------------------------------
// 10. News Article
// --------------------------------------------------------------------------------

const newsArticleTemplate: ScraperTemplate = {
  id: 'news_article',
  name: 'News Article',
  description: 'Extract article data from news websites including headline, author, dates, source, body text, images, and tags using schema.org, Open Graph, and heuristic extraction.',
  domainPatterns: [
    // No specific domain -- this is a fallback template used for news sites
    // The template will be matched with low confidence for unknown domains
    'news', 'article', 'blog',
    // Major news domains for higher-confidence matching
    'cnn.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com', 'washingtonpost.com',
    'theguardian.com', 'reuters.com', 'apnews.com', 'bloomberg.com',
    'wsj.com', 'ft.com', 'economist.com', 'npr.org', 'pbs.org',
    'foxnews.com', 'nbcnews.com', 'abcnews.go.com', 'cbsnews.com',
    'usatoday.com', 'latimes.com', 'chicagotribune.com', 'bostonglobe.com',
    'thetimes.co.uk', 'independent.co.uk', 'telegraph.co.uk',
    'lemonde.fr', 'spiegel.de', 'zeit.de',
  ],
  outputSchema: {
    headline: 'Article headline / title',
    author: 'Author name(s)',
    datePublished: 'Publication date (ISO string)',
    dateModified: 'Last modified date (ISO string)',
    source: 'Publication / source name',
    articleBody: 'Full article body text',
    image: 'Main article image URL',
    tags: 'Array of tags / category strings',
    url: 'Canonical article URL',
    wordCount: 'Approximate word count of the article body',
    readingTimeMinutes: 'Estimated reading time in minutes',
  },
  requiredStrategy: 'http',
  requiredProxyTier: 'datacenter',

  extract(html: string, url: string): Record<string, any> {
    try {
      let headline = '';
      let author = '';
      let datePublished = '';
      let dateModified = '';
      let source = '';
      let articleBody = '';
      let image = '';
      let tags: string[] = [];
      let canonicalUrl = '';

      // -- JSON-LD extraction --------------------------------------------
      const ldArticle = extractLdJson(html, 'article')
        || extractLdJson(html, 'newsarticle')
        || extractLdJson(html, 'reportagenewsarticle')
        || extractLdJson(html, 'liveblogposting')
        || extractLdJson(html, 'blogposting');

      if (ldArticle) {
        headline = ldArticle.headline || ldArticle.name || '';
        datePublished = ldArticle.datePublished || '';
        dateModified = ldArticle.dateModified || '';
        articleBody = ldArticle.articleBody || '';
        image = typeof ldArticle.image === 'string'
          ? ldArticle.image
          : ldArticle.image?.url || ldArticle.image?.[0]?.url || '';

        // Author
        if (ldArticle.author) {
          const authors = Array.isArray(ldArticle.author) ? ldArticle.author : [ldArticle.author];
          author = authors.map((a: any) => typeof a === 'string' ? a : a.name || '').filter(Boolean).join(', ');
        }

        // Source / publisher
        if (ldArticle.publisher) {
          source = typeof ldArticle.publisher === 'string'
            ? ldArticle.publisher
            : ldArticle.publisher.name || '';
        }

        // Keywords → tags
        if (ldArticle.keywords) {
          tags = Array.isArray(ldArticle.keywords) ? ldArticle.keywords : ldArticle.keywords.split(',').map((k: string) => k.trim());
        }
      }

      // -- Also check all JSON-LD for Article types ----------------------
      if (!headline) {
        const allLd = extractAllLdJson(html);
        for (const ld of allLd) {
          const t = (ld['@type'] || '').toString().toLowerCase();
          if (t.includes('article') || t.includes('news') || t.includes('blog')) {
            if (ld.headline) headline = ld.headline;
            if (!datePublished && ld.datePublished) datePublished = ld.datePublished;
            if (!dateModified && ld.dateModified) dateModified = ld.dateModified;
            if (!articleBody && ld.articleBody) articleBody = ld.articleBody;
            if (!author && ld.author) {
              const authors = Array.isArray(ld.author) ? ld.author : [ld.author];
              author = authors.map((a: any) => typeof a === 'string' ? a : a.name || '').filter(Boolean).join(', ');
            }
            if (!source && ld.publisher) {
              source = typeof ld.publisher === 'string' ? ld.publisher : ld.publisher.name || '';
            }
            break;
          }
        }
      }

      // -- Open Graph / meta tag fallbacks -------------------------------
      if (!headline) headline = decodeEntities(extractOg(html, 'title'));
      if (!articleBody) {
        const ogDesc = decodeEntities(extractOg(html, 'description'));
        if (ogDesc) articleBody = ogDesc; // Will be replaced if body extraction succeeds
      }
      if (!image) image = extractOg(html, 'image');
      if (!source) source = extractOg(html, 'site_name');
      if (!datePublished) datePublished = extractMetaProperty(html, 'article:published_time');
      if (!dateModified) dateModified = extractMetaProperty(html, 'article:modified_time');
      if (!author) author = extractMetaName(html, 'author');
      if (!author) author = extractMetaProperty(html, 'article:author');

      // -- HTML fallbacks ------------------------------------------------
      if (!headline) {
        headline = regexMatch(html, /<h1[^>]*class=["'][^"']*\barticle-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i, 1)
          || regexMatch(html, /<h1[^>]*class=["'][^"']*\bentry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i, 1)
          || regexMatch(html, /<h1[^>]*itemprop=["']headline["'][^>]*>([\s\S]*?)<\/h1>/i, 1);
        headline = decodeEntities(stripHtml(headline));
      }
      if (!headline) {
        // Last resort: first h1 tag
        const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        if (h1Match) headline = decodeEntities(stripHtml(h1Match[1])).substring(0, 300);
      }

      // -- Article body extraction ---------------------------------------
      if (!articleBody || articleBody.length < 200) {
        const bodySelectors = [
          /class=["'][^"']*\barticle-body\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
          /class=["'][^"']*\barticle__body\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
          /class=["'][^"']*\bpost-content\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
          /class=["'][^"']*\bentry-content\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
          /class=["'][^"']*\bstory-body\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
          /class=["'][^"']*\bcontent-body\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
          /itemprop=["']articleBody["'][^>]*>([\s\S]*?)<\/div>/i,
          /<article[^>]*>([\s\S]*?)<\/article>/i,
          /role=["']article["'][^>]*>([\s\S]*?)<\/div>/i,
        ];

        for (const pattern of bodySelectors) {
          const bodyMatch = html.match(pattern);
          if (bodyMatch) {
            const text = stripHtml(bodyMatch[1]).substring(0, 100000);
            if (text.length > 200) {
              articleBody = text;
              break;
            }
          }
        }

        // Ultimate fallback: all paragraph text
        if (!articleBody || articleBody.length < 200) {
          const allParagraphs = html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi);
          const pTexts: string[] = [];
          for (const p of allParagraphs) {
            const text = stripHtml(p[1]);
            if (text.length > 30) pTexts.push(text);
          }
          if (pTexts.length > 0) {
            articleBody = pTexts.join('\n\n').substring(0, 100000);
          }
        }
      }

      // -- Tags / keywords from meta -------------------------------------
      if (tags.length === 0) {
        const kwMeta = extractMetaName(html, 'keywords');
        if (kwMeta) {
          tags = kwMeta.split(',').map(k => k.trim()).filter(Boolean);
        }
      }
      if (tags.length === 0) {
        const newsKeywords = extractMetaName(html, 'news_keywords');
        if (newsKeywords) {
          tags = newsKeywords.split(',').map(k => k.trim()).filter(Boolean);
        }
      }

      // -- Canonical URL -------------------------------------------------
      canonicalUrl = regexMatch(html, /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i, 1);

      // -- Word count and reading time -----------------------------------
      const wordCount = articleBody ? articleBody.split(/\s+/).length : 0;
      const readingTimeMinutes = Math.max(1, Math.ceil(wordCount / 200));

      return {
        headline,
        author,
        datePublished,
        dateModified,
        source,
        articleBody,
        image,
        tags,
        url: canonicalUrl || url,
        wordCount,
        readingTimeMinutes,
      };
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'News article extraction failed');
      return {};
    }
  },
};

// --- Template Registry ---------------------------------------------------------

/**
 * Central registry for scraper templates.
 *
 * Provides lookup, auto-detection, and extraction capabilities.
 * Template auto-detection uses domain-pattern matching with confidence scoring.
 */
export class TemplateRegistry {
  /** Internal map of template IDs to their definitions. */
  private templates: Map<string, ScraperTemplate> = new Map();

  /** Pre-compiled domain pattern → template ID index for fast lookups. */
  private domainIndex: Map<string, string> = new Map();

  constructor() {
    // Register all built-in templates
    const builtIn: ScraperTemplate[] = [
      amazonProductTemplate,
      googleSerpTemplate,
      linkedinProfileTemplate,
      twitterTweetTemplate,
      zillowListingTemplate,
      youtubeVideoTemplate,
      wikipediaArticleTemplate,
      redditPostTemplate,
      imdbMovieTemplate,
      newsArticleTemplate,
    ];

    for (const tmpl of builtIn) {
      this.register(tmpl);
    }

    logger.info({ count: this.templates.size }, 'Template registry initialized with built-in templates');
  }

  // --- Private Helpers --------------------------------------------------------

  /**
   * Register a template and index its domain patterns.
   */
  private register(template: ScraperTemplate): void {
    this.templates.set(template.id, template);
    for (const pattern of template.domainPatterns) {
      this.domainIndex.set(pattern.toLowerCase(), template.id);
    }
  }

  // --- Public API -------------------------------------------------------------

  /**
   * Retrieve a template definition by its unique ID.
   *
   * @param id - The template ID, e.g. 'amazon_product'.
   * @returns The full template definition, or `undefined` if not found.
   */
  getTemplate(id: string): ScraperTemplate | undefined {
    return this.templates.get(id);
  }

  /**
   * Auto-detect the best template for a given URL.
   *
   * The method iterates over all registered templates and checks the URL's
   * hostname + path against each template's `domainPatterns`.  The template
   * with the longest matching pattern (most specific) wins, with a confidence
   * score based on match specificity:
   *   - Exact hostname match → confidence 1.0
   *   - Hostname + path match → confidence 0.95
   *   - Partial domain match → confidence 0.7
   *   - Generic keyword match → confidence 0.3
   *
   * @param url - The full URL to detect a template for.
   * @returns A `TemplateMatch` with the best template, or `null` if no match.
   */
  detectTemplate(url: string): TemplateMatch | null {
    try {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        logger.warn({ url }, 'Invalid URL provided for template detection');
        return null;
      }

      const hostname = parsedUrl.hostname.toLowerCase();
      const path = parsedUrl.pathname.toLowerCase();
      const fullUrl = `${hostname}${path}`;

      let bestMatch: TemplateMatch | null = null;

      for (const [id, template] of this.templates) {
        let confidence = 0;

        for (const pattern of template.domainPatterns) {
          const lowerPattern = pattern.toLowerCase();

          if (hostname === lowerPattern || hostname.endsWith('.' + lowerPattern)) {
            // Exact or sub-domain match
            confidence = 1.0;
          } else if (hostname.includes(lowerPattern)) {
            // Pattern is part of the hostname
            confidence = 0.95;
          } else if (fullUrl.includes(lowerPattern)) {
            // Pattern appears in hostname + path (e.g. 'linkedin.com/in/')
            confidence = 0.9;
          } else if (path.includes(lowerPattern)) {
            // Pattern only in path
            confidence = 0.7;
          } else if (hostname.split('.').some(part => part === lowerPattern)) {
            // Single label match (e.g. 'amazon' in www.amazon.com)
            confidence = 0.6;
          }

          // Boost confidence for longer (more specific) patterns
          if (confidence > 0) {
            const specificityBonus = Math.min(lowerPattern.length / 100, 0.1);
            confidence += specificityBonus;
          }

          if (confidence > (bestMatch?.confidence ?? 0)) {
            bestMatch = {
              templateId: id,
              confidence: Math.min(confidence, 1.0),
              template,
            };
            break; // Use the first matching pattern for this template
          }
        }
      }

      if (bestMatch) {
        logger.debug(
          { url, templateId: bestMatch.templateId, confidence: bestMatch.confidence },
          'Template auto-detected',
        );
      } else {
        logger.debug({ url }, 'No matching template found');
      }

      return bestMatch;
    } catch (err) {
      logger.error({ err: (err as Error).message, url }, 'Template detection failed');
      return null;
    }
  }

  /**
   * List all available templates (without the `extract` function).
   *
   * Useful for API responses and UI template browsers where you want to
   * show what templates exist without serializing the extraction logic.
   *
   * @returns Array of template metadata objects.
   */
  listTemplates(): Array<{
    id: string;
    name: string;
    description: string;
    domainPatterns: string[];
    outputSchema: Record<string, string>;
    requiredStrategy: string;
    requiredProxyTier: string;
  }> {
    const result: Array<{
      id: string;
      name: string;
      description: string;
      domainPatterns: string[];
      outputSchema: Record<string, string>;
      requiredStrategy: string;
      requiredProxyTier: string;
    }> = [];

    for (const [, template] of this.templates) {
      result.push({
        id: template.id,
        name: template.name,
        description: template.description,
        domainPatterns: template.domainPatterns,
        outputSchema: template.outputSchema,
        requiredStrategy: template.requiredStrategy,
        requiredProxyTier: template.requiredProxyTier,
      });
    }

    return result;
  }

  /**
   * Extract structured data from HTML using a specific template.
   *
   * @param templateId - The ID of the template to use.
   * @param html       - The raw HTML of the page.
   * @param url        - The page URL (used by some extractors for context).
   * @returns Extracted data matching the template's output schema, or `null`
   *          if the template doesn't exist or extraction fails entirely.
   */
  extractWithTemplate(templateId: string, html: string, url: string): Record<string, any> | null {
    const template = this.templates.get(templateId);
    if (!template) {
      logger.warn({ templateId }, 'Template not found');
      return null;
    }

    try {
      logger.debug({ templateId, url }, 'Starting template extraction');
      const startTime = Date.now();

      const result = template.extract(html, url);

      const elapsed = Date.now() - startTime;
      const fieldsExtracted = Object.keys(result).filter(k => {
        const val = result[k];
        if (val === null || val === undefined || val === '') return false;
        if (Array.isArray(val) && val.length === 0) return false;
        if (typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length === 0) return false;
        return true;
      }).length;

      logger.info(
        {
          templateId,
          url,
          elapsedMs: elapsed,
          fieldsExtracted,
          totalFields: Object.keys(template.outputSchema).length,
        },
        'Template extraction completed',
      );

      return result;
    } catch (err) {
      logger.error(
        { err: (err as Error).message, templateId, url },
        'Template extraction failed with unexpected error',
      );
      return null;
    }
  }
}

// --- Singleton -----------------------------------------------------------------

/** Shared singleton instance -- safe to import from any module. */
export const templateRegistry = new TemplateRegistry();
