import * as cheerio from 'cheerio';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('structured:amazon');

// --- Types --------------------------------------------------------------------

export interface AmazonProduct {
  title: string;
  price: number | null;
  originalPrice: number | null;
  currency: string;
  availability: string;
  rating: number | null;
  reviewCount: number | null;
  seller: string | null;
  asin: string | null;
  imageUrl: string | null;
  categories: string[];
  features: string[];
  description: string;
  breadcrumbs: string[];
}

// --- Amazon Product Parser ----------------------------------------------------

export class AmazonParser {
  /**
   * Parse an Amazon product page HTML into structured JSON.
   * Works with the standard product detail page layout as of 2025-2026.
   */
  parse(html: string): AmazonProduct {
    const $ = cheerio.load(html);

    const title = this.extractTitle($);
    const { price, originalPrice, currency } = this.extractPrice($);
    const availability = this.extractAvailability($);
    const { rating, reviewCount } = this.extractRating($);
    const seller = this.extractSeller($);
    const asin = this.extractAsin($);
    const imageUrl = this.extractMainImage($);
    const categories = this.extractCategories($);
    const features = this.extractFeatures($);
    const description = this.extractDescription($);
    const breadcrumbs = this.extractBreadcrumbs($);

    return {
      title,
      price,
      originalPrice,
      currency,
      availability,
      rating,
      reviewCount,
      seller,
      asin,
      imageUrl,
      categories,
      features,
      description,
      breadcrumbs,
    };
  }

  private extractTitle($: cheerio.CheerioAPI): string {
    return $('#productTitle').text().trim()
      || $('span[data-automation-id="product-title"]').text().trim()
      || $('h1.a-size-large').text().trim()
      || '';
  }

  private extractPrice($: cheerio.CheerioAPI): { price: number | null; originalPrice: number | null; currency: string } {
    // Current price -- try multiple selectors for different Amazon layouts
    const priceSelectors = [
      '.a-price .a-offscreen',
      '#priceblock_ourprice',
      '#priceblock_dealprice',
      '#priceblock_saleprice',
      '.a-color-price .a-offscreen',
      'span[data-a-color="price"] .a-offscreen',
      '#corePrice_feature_div .a-offscreen',
    ];

    let priceText = '';
    for (const sel of priceSelectors) {
      priceText = $(sel).first().text().trim();
      if (priceText) break;
    }

    // Original price (strikethrough)
    const originalPriceText = $('.a-price.a-text-price .a-offscreen').first().text().trim()
      || $('span.a-text-strike .a-offscreen').first().text().trim();

    const parsePrice = (text: string): number | null => {
      if (!text) return null;
      const match = text.match(/[\d,]+\.?\d*/);
      if (!match) return null;
      return parseFloat(match[0].replace(/,/g, ''));
    };

    const detectCurrency = (text: string): string => {
      if (!text) return 'USD';
      if (text.includes('€') || text.includes('EUR')) return 'EUR';
      if (text.includes('£') || text.includes('GBP')) return 'GBP';
      if (text.includes('¥') || text.includes('CNY')) return 'CNY';
      if (text.includes('₹') || text.includes('INR')) return 'INR';
      if (text.includes('A$') || text.includes('AUD')) return 'AUD';
      if (text.includes('C$') || text.includes('CAD')) return 'CAD';
      return 'USD';
    };

    return {
      price: parsePrice(priceText),
      originalPrice: parsePrice(originalPriceText),
      currency: detectCurrency(priceText),
    };
  }

  private extractAvailability($: cheerio.CheerioAPI): string {
    const text = $('#availability span').text().trim()
      || $('#availability').text().trim();
    if (!text) return 'Unknown';
    if (text.toLowerCase().includes('in stock')) return 'In Stock';
    if (text.toLowerCase().includes('out of stock')) return 'Out of Stock';
    if (text.toLowerCase().includes('currently unavailable')) return 'Unavailable';
    if (text.toLowerCase().includes('only')) return text; // "Only 3 left in stock"
    return text;
  }

  private extractRating($: cheerio.CheerioAPI): { rating: number | null; reviewCount: number | null } {
    const ratingText = $('#acrPopover .a-icon-alt').first().text().trim();
    const ratingMatch = ratingText.match(/([\d.]+)/);
    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

    const reviewText = $('#acrCustomerReviewText').text().trim();
    const reviewMatch = reviewText.match(/([\d,]+)/);
    const reviewCount = reviewMatch ? parseInt(reviewMatch[1].replace(/,/g, ''), 10) : null;

    return { rating, reviewCount };
  }

  private extractSeller($: cheerio.CheerioAPI): string | null {
    return $('#sellerProfileTriggerId').text().trim()
      || $('#merchant-info a').first().text().trim()
      || $('#bylineInfo').text().trim()
      || null;
  }

  private extractAsin($: cheerio.CheerioAPI): string | null {
    // ASIN from URL or hidden input
    const asinInput = $('input[name="ASIN"]').val();
    if (asinInput) return String(asinInput);

    // Try from product details table
    const detailRows = $('#productDetails_techSpec_section_1 tr, #detailBullets_feature_div li');
    for (const row of detailRows) {
      const text = $(row).text();
      const match = text.match(/ASIN[:\s]*([A-Z0-9]{10})/i);
      if (match) return match[1];
    }

    return null;
  }

  private extractMainImage($: cheerio.CheerioAPI): string | null {
    const src = $('#landingImage').attr('src')
      || $('#imgBlkFront').attr('src')
      || $('.a-dynamic-image').first().attr('src');
    return src || null;
  }

  private extractCategories($: cheerio.CheerioAPI): string[] {
    const categories: string[] = [];
    $('#wayfinding-breadcrumbs_container a').each((_i, el) => {
      categories.push($(el).text().trim());
    });
    return categories;
  }

  private extractFeatures($: cheerio.CheerioAPI): string[] {
    const features: string[] = [];
    $('#feature-bullets li span.a-list-item').each((_i, el) => {
      const text = $(el).text().trim();
      if (text && !text.includes('Make sure this fits')) {
        features.push(text);
      }
    });
    return features;
  }

  private extractDescription($: cheerio.CheerioAPI): string {
    return $('#productDescription').text().trim()
      || $('#aplus_feature_div').text().trim().substring(0, 2000)
      || '';
  }

  private extractBreadcrumbs($: cheerio.CheerioAPI): string[] {
    const crumbs: string[] = [];
    $('#wayfinding-breadcrumbs_container li a').each((_i, el) => {
      crumbs.push($(el).text().trim());
    });
    return crumbs;
  }
}

export const amazonParser = new AmazonParser();
