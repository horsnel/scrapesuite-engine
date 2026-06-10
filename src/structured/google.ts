import * as cheerio from 'cheerio';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('structured:google');

// --- Types --------------------------------------------------------------------

export interface GoogleSerpResult {
  position: number;
  title: string;
  url: string;
  description: string;
  isAd: boolean;
  sitelinks: { title: string; url: string }[];
  date: string | null;
}

export interface GoogleSerpResponse {
  query: string;
  totalResults: number | null;
  searchTime: number | null;
  results: GoogleSerpResult[];
  relatedSearches: string[];
  peopleAlsoAsk: string[];
}

// --- Google SERP Parser ------------------------------------------------------

export class GoogleSerpParser {
  /**
   * Parse a Google search results page HTML into structured JSON.
   */
  parse(html: string, query?: string): GoogleSerpResponse {
    const $ = cheerio.load(html);

    const results = this.extractResults($);
    const totalResults = this.extractTotalResults($);
    const searchTime = this.extractSearchTime($);
    const relatedSearches = this.extractRelatedSearches($);
    const peopleAlsoAsk = this.extractPeopleAlsoAsk($);

    return {
      query: query || this.extractQuery($),
      totalResults,
      searchTime,
      results,
      relatedSearches,
      peopleAlsoAsk,
    };
  }

  private extractResults($: cheerio.CheerioAPI): GoogleSerpResult[] {
    const results: GoogleSerpResult[] = [];
    let position = 0;

    // Organic results
    $('#search .g, #rso .g').each((_i, el) => {
      position++;
      const titleEl = $(el).find('h3').first();
      const title = titleEl.text().trim();

      const linkEl = $(el).find('a').first();
      const url = linkEl.attr('href') || '';

      const description = $(el).find('.VwiC3b, .st').first().text().trim()
        || $(el).find('[data-sncf]').first().text().trim();

      const dateText = $(el).find('.LEwnzc span').first().text().trim()
        || $(el).find('.f').first().text().trim();

      const sitelinks: { title: string; url: string }[] = [];
      $(el).find('.fglc a, .V8oRA a').each((_j, link) => {
        sitelinks.push({
          title: $(link).text().trim(),
          url: $(link).attr('href') || '',
        });
      });

      if (title && url) {
        results.push({
          position,
          title,
          url,
          description,
          isAd: false,
          sitelinks,
          date: dateText || null,
        });
      }
    });

    // Ad results (top and bottom)
    $('.uEierd, #tads .g, #tadsb .g').each((_i, el) => {
      const title = $(el).find('h3, .v0nnHf').first().text().trim();
      const url = $(el).find('a').first().attr('href') || '';
      const description = $(el).find('.VwiC3b, .st').first().text().trim();

      if (title && url) {
        results.push({
          position: -1, // Ads don't have organic position
          title,
          url,
          description,
          isAd: true,
          sitelinks: [],
          date: null,
        });
      }
    });

    // Sort: ads first, then organic by position
    results.sort((a, b) => {
      if (a.isAd !== b.isAd) return a.isAd ? -1 : 1;
      return a.position - b.position;
    });

    // Re-number positions
    let organicPos = 0;
    results.forEach((r) => {
      if (!r.isAd) {
        organicPos++;
        r.position = organicPos;
      }
    });

    return results;
  }

  private extractTotalResults($: cheerio.CheerioAPI): number | null {
    const text = $('#result-stats').text().trim();
    if (!text) return null;
    const match = text.match(/([\d,]+)/);
    return match ? parseInt(match[1].replace(/,/g, ''), 10) : null;
  }

  private extractSearchTime($: cheerio.CheerioAPI): number | null {
    const text = $('#result-stats').text().trim();
    if (!text) return null;
    const match = text.match(/([\d.]+)\s*(?:seconds?|secs?)/i);
    return match ? parseFloat(match[1]) : null;
  }

  private extractQuery($: cheerio.CheerioAPI): string {
    return $('input[name="q"]').val() as string || '';
  }

  private extractRelatedSearches($: cheerio.CheerioAPI): string[] {
    const searches: string[] = [];
    $('#bres .g a, .A7Y9pd .g a').each((_i, el) => {
      const text = $(el).text().trim();
      if (text) searches.push(text);
    });
    return searches;
  }

  private extractPeopleAlsoAsk($: cheerio.CheerioAPI): string[] {
    const questions: string[] = [];
    $('.related-question-pair, .JlqpRe span').each((_i, el) => {
      const text = $(el).text().trim();
      if (text && text.endsWith('?')) {
        questions.push(text);
      }
    });
    return questions;
  }
}

export const googleSerpParser = new GoogleSerpParser();
