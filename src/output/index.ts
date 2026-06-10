/**
 * Multi-Format Output Pipeline -- Transform scraped HTML into multiple output formats.
 *
 * Inspired by Bright Data's output pipeline: users specify an output format
 * (or let auto-detection choose one) instead of receiving raw HTML every time.
 * Each format is optimized for a different consumer use-case:
 *
 *   raw      -- Original HTML as-is (default, no processing)
 *   markdown -- Clean Markdown with headers, links, images, lists, tables, code
 *   cleaned  -- HTML with noise removed (scripts, ads, nav, cookie banners)
 *   text     -- Plain text with normalized whitespace
 *   parsed   -- Structured JSON with title, OG tags, headings, links, images, main content
 *
 * Key design decisions
 * --------------------
 *  • Regex-based parsing only -- no cheerio dependency for the core pipeline.
 *    Regex is faster and more reliable at scale for production HTML processing.
 *  • Simplified CSS selector support: 'main', 'article', '#id', '.class'
 *  • Proper error handling -- every format degrades gracefully on malformed HTML
 *  • Processing metrics -- every result includes size, compression ratio, and timing
 *
 * Usage
 * -----
 *   import { outputPipeline, detectBestFormat } from './output';
 *
 *   const result = outputPipeline.process(html, url, { format: 'markdown' });
 *   // result.content -- Markdown string
 *   // result.compressionRatio -- 0.35 (65% size reduction)
 *
 *   const best = detectBestFormat(html);
 *   // best === 'parsed' for mostly-boilerplate pages
 */

import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('output-pipeline');

// --- Public Types --------------------------------------------------------------

/** Supported output formats for the pipeline. */
export type OutputFormat = 'raw' | 'markdown' | 'cleaned' | 'text' | 'parsed';

/** Options controlling how the output pipeline transforms HTML. */
export interface OutputOptions {
  /** Desired output format. Default: 'raw'. */
  format: OutputFormat;
  /** Include metadata (title, description, OG tags) in output. Default: true for 'parsed', false otherwise. */
  includeMetadata?: boolean;
  /** Truncate output to this length (in characters). Default: no limit. */
  maxLength?: number;
  /** Extract content from a specific CSS-like selector. Simplified: 'main', 'article', '#id', '.class'. */
  selector?: string;
}

/** Structured output returned by the 'parsed' format. */
export interface ParsedOutput {
  title: string;
  description: string;
  canonicalUrl: string;
  ogTags: Record<string, string>;
  author: string;
  publishedDate: string;
  headings: Array<{ level: number; text: string }>;
  links: Array<{ text: string; href: string }>;
  images: Array<{ alt: string; src: string }>;
  mainContent: string;
  wordCount: number;
}

/** Result of processing HTML through the output pipeline. */
export interface OutputResult {
  /** The format that was applied. */
  format: OutputFormat;
  /** The transformed content (string for raw/markdown/cleaned/text, ParsedOutput for parsed). */
  content: string | ParsedOutput;
  /** Size of the original HTML in bytes. */
  originalSizeBytes: number;
  /** Size of the output in bytes. */
  outputSizeBytes: number;
  /** Ratio of outputSize / originalSize (< 1 means compression). */
  compressionRatio: number;
  /** Processing time in milliseconds. */
  processingMs: number;
}

// --- Internal Helpers ----------------------------------------------------------

/**
 * Decode common HTML entities to their character equivalents.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Strip all HTML tags from a string and normalize whitespace.
 */
function stripAllTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the content of a simplified CSS selector from HTML.
 * Supports: 'main', 'article', '#id', '.class', and tag selectors.
 * Returns the original HTML if the selector doesn't match.
 */
function extractBySelector(html: string, selector: string): string {
  if (!selector) return html;

  const trimmed = selector.trim();

  // ID selector: #my-id
  if (trimmed.startsWith('#')) {
    const id = trimmed.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)(?:<\\/\\w+>\\s*)?(?=<[^>]+id=["']|<\\/body|$)`, 'i');
    const match = html.match(re);
    if (match) {
      // Try to get a balanced closing tag
      const balanced = extractBalancedElement(html, 'id', id);
      if (balanced) return balanced;
      return match[1];
    }
    return html;
  }

  // Class selector: .my-class
  if (trimmed.startsWith('.')) {
    const cls = trimmed.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const balanced = extractBalancedElement(html, 'class', cls);
    if (balanced) return balanced;
    return html;
  }

  // Tag selector: main, article, section, div.content, etc.
  const tagOnly = trimmed.match(/^(\w+)$/);
  if (tagOnly) {
    const tag = tagOnly[1].toLowerCase();
    const balanced = extractBalancedTag(html, tag);
    if (balanced) return balanced;
    return html;
  }

  // Tag with class: div.my-class
  const tagClass = trimmed.match(/^(\w+)\.([\w-]+)$/);
  if (tagClass) {
    const tag = tagClass[1].toLowerCase();
    const cls = tagClass[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const balanced = extractBalancedElement(html, 'class', cls, tag);
    if (balanced) return balanced;
    return html;
  }

  // Tag with id: div#my-id
  const tagId = trimmed.match(/^(\w+)#([\w-]+)$/);
  if (tagId) {
    const tag = tagId[1].toLowerCase();
    const id = tagId[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const balanced = extractBalancedElement(html, 'id', id, tag);
    if (balanced) return balanced;
    return html;
  }

  return html;
}

/**
 * Extract balanced HTML element content by attribute name and value.
 * Uses a simple stack-based approach to handle nesting.
 */
function extractBalancedElement(
  html: string,
  attrName: string,
  attrValue: string,
  tagName?: string,
): string | null {
  const tagPattern = tagName
    ? `<${tagName}`
    : '<\\w+';
  const attrPattern = new RegExp(
    `${tagPattern}[^>]*${attrName}=["']${attrValue}["'][^>]*>`,
    'i',
  );
  const openMatch = html.match(attrPattern);
  if (!openMatch) return null;

  const startIdx = openMatch.index!;
  // Determine the actual tag name from the matched opening tag
  const tagMatch = openMatch[0].match(/^<(\w+)/);
  if (!tagMatch) return null;
  const tag = tagMatch[1].toLowerCase();

  return extractBalancedContentFromIndex(html, tag, startIdx);
}

/**
 * Extract balanced content for a given tag starting from an opening tag at a position.
 */
function extractBalancedTag(html: string, tag: string): string | null {
  const openRe = new RegExp(`<${tag}[\\s>]`, 'i');
  const match = html.match(openRe);
  if (!match || match.index === undefined) return null;

  return extractBalancedContentFromIndex(html, tag, match.index);
}

/**
 * Given the position of an opening tag, extract its balanced content.
 * Uses a depth counter to handle nesting.
 */
function extractBalancedContentFromIndex(html: string, tag: string, startIdx: number): string | null {
  let depth = 0;
  let pos = startIdx;

  // Regex patterns for opening and closing tags
  const openRe = new RegExp(`<${tag}[\\s>/]`, 'gi');
  const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');

  // Find where the opening tag ends
  const afterOpen = html.indexOf('>', startIdx);
  if (afterOpen === -1) return null;
  const contentStart = afterOpen + 1;

  pos = contentStart;
  depth = 1;

  while (depth > 0 && pos < html.length) {
    // Find next opening or closing tag
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;

    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);

    let openPos = nextOpen ? nextOpen.index : Infinity;
    let closePos = nextClose ? nextClose.index : Infinity;

    if (openPos === Infinity && closePos === Infinity) break;

    if (closePos <= openPos) {
      depth--;
      if (depth === 0) {
        return html.substring(contentStart, closePos);
      }
      pos = closePos + nextClose![0].length;
    } else {
      depth++;
      pos = nextOpen!.index + nextOpen![0].length;
    }
  }

  // Fallback: return everything from contentStart to a reasonable boundary
  return html.substring(contentStart, Math.min(contentStart + 100000, html.length));
}

// --- Noise Patterns ------------------------------------------------------------

/** Elements to remove entirely (with their content) for cleaned/text/markdown formats. */
const NOISE_ELEMENTS_RE = /<(script|style|noscript|iframe|svg|path|nav|footer|header|aside|form|button|input|textarea|select|label|fieldset|legend)[\s>][^>]*>[\s\S]*?<\/\1>/gi;

/** Self-closing noise elements. */
const NOISE_SELF_CLOSING_RE = /<(script|style|noscript|iframe|svg|nav|footer|header|aside|form|button|input|textarea|select|meta|link)\b[^>]*\/?>/gi;

/** Common ad / popup / cookie banner class and id patterns. */
const AD_NOISE_CLASS_IDS = [
  // Ad-related
  'ad[s-_]?banner', 'ad[s-_]?container', 'ad[s-_]?wrapper', 'ad[s-_]?slot',
  'ad[s-_]?unit', 'ad[s-_]?placement', 'google[_-]?ad', 'adsense',
  'advertisement', 'sponsored',
  // Cookie / consent
  'cookie[_-]?banner', 'cookie[_-]?consent', 'cookie[_-]?notice',
  'cookie[_-]?policy', 'cookie[_-]?bar', 'gdpr', 'ccpa',
  'consent[_-]?banner', 'consent[_-]?popup', 'privacy[_-]?banner',
  // Popups / overlays
  'popup', 'modal[_-]?overlay', 'overlay', 'interstitial',
  'newsletter[_-]?popup', 'subscribe[_-]?popup', 'paywall',
  'registration[_-]?wall', 'login[_-]?wall',
  // Social / sharing
  'social[_-]?share', 'share[_-]?buttons?', 'social[_-]?bar',
  // Sticky / floating
  'sticky[_-]?bar', 'floating[_-]?bar', 'toolbar',
];

const AD_NOISE_PATTERN = new RegExp(
  `<div[^>]*(?:class|id)=["'][^"']*\\b(?:${AD_NOISE_CLASS_IDS.join('|')})\\b[^"']*["'][^>]*>[\\s\\S]*?<\\/div>`,
  'gi',
);

/** HTML comments. */
const HTML_COMMENTS_RE = /<!--[\s\S]*?-->/g;

/** Data attributes. */
const DATA_ATTRS_RE = /\s+data-[a-zA-Z0-9_-]+=(?:"[^"]*"|'[^']*'|[^\s>]+)/g;

/**
 * Remove noise from HTML (ads, cookie banners, popups, comments, data attributes).
 */
function removeNoise(html: string): string {
  let cleaned = html;

  // Remove HTML comments
  cleaned = cleaned.replace(HTML_COMMENTS_RE, '');

  // Remove ad/cookie/popup divs
  cleaned = cleaned.replace(AD_NOISE_PATTERN, '');

  // Remove noise elements with their content
  cleaned = cleaned.replace(NOISE_ELEMENTS_RE, '');

  // Remove self-closing noise elements
  cleaned = cleaned.replace(NOISE_SELF_CLOSING_RE, '');

  // Remove data attributes
  cleaned = cleaned.replace(DATA_ATTRS_RE, '');

  return cleaned;
}

/**
 * Normalize whitespace in text: collapse multiple spaces, trim lines, remove excessive blank lines.
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\t/g, '  ')
    .replace(/[ \t]+$/gm, '')      // Trim trailing whitespace on lines
    .replace(/\n{3,}/g, '\n\n')    // Max 2 consecutive newlines
    .trim();
}

// --- Format: raw ---------------------------------------------------------------

/**
 * Return the HTML as-is (with optional selector extraction and length truncation).
 */
function processRaw(html: string, options: OutputOptions): string {
  let content = html;
  if (options.selector) {
    content = extractBySelector(content, options.selector);
  }
  if (options.maxLength && content.length > options.maxLength) {
    content = content.substring(0, options.maxLength);
  }
  return content;
}

// --- Format: markdown ----------------------------------------------------------

/**
 * Convert HTML to clean Markdown.
 *
 * Handles: headers (h1-h6), paragraphs, bold, italic, links, images,
 * ordered/unordered lists, code blocks, inline code, tables, blockquotes,
 * horizontal rules, line breaks.
 *
 * Strips: script, style, nav, footer, header, aside elements.
 * Preserves meaningful content only.
 */
function processMarkdown(html: string, options: OutputOptions): string {
  try {
    let content = html;

    // Apply selector if provided
    if (options.selector) {
      content = extractBySelector(content, options.selector);
    }

    // -- Remove noise elements ---------------------------------------------
    content = content.replace(NOISE_ELEMENTS_RE, '');
    content = content.replace(NOISE_SELF_CLOSING_RE, '');
    content = content.replace(HTML_COMMENTS_RE, '');
    content = content.replace(AD_NOISE_PATTERN, '');

    // -- Pre-process: preserve content we want to convert ------------------

    // Tables -- convert before other processing to avoid mangling
    content = convertTablesToMarkdown(content);

    // Code blocks -- preserve them early
    content = content.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_match, code: string) => {
      const lang = '';
      const cleaned = decodeEntities(code.replace(/<[^>]+>/g, '').trim());
      return `\n\n\`\`\`${lang}\n${cleaned}\n\`\`\`\n\n`;
    });

    // Inline code
    content = content.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_match, code: string) => {
      const cleaned = decodeEntities(code.replace(/<[^>]+>/g, '').trim());
      if (cleaned.includes('\n')) {
        return `\n\n\`\`\`\n${cleaned}\n\`\`\`\n\n`;
      }
      return `\`${cleaned}\``;
    });

    // -- Headings ----------------------------------------------------------
    for (let i = 1; i <= 6; i++) {
      const hashes = '#'.repeat(i);
      const re = new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi');
      content = content.replace(re, (_match, text: string) => {
        const cleaned = cleanMarkdownInline(text).trim();
        return `\n\n${hashes} ${cleaned}\n\n`;
      });
    }

    // -- Paragraphs --------------------------------------------------------
    content = content.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_match, text: string) => {
      const cleaned = cleanMarkdownInline(text).trim();
      if (!cleaned) return '';
      return `\n\n${cleaned}\n\n`;
    });

    // -- Bold --------------------------------------------------------------
    content = content.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag: string, text: string) => {
      const cleaned = text.trim();
      if (!cleaned) return '';
      return `**${cleaned}**`;
    });

    // -- Italic ------------------------------------------------------------
    content = content.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag: string, text: string) => {
      const cleaned = text.trim();
      if (!cleaned) '';
      return `*${cleaned}*`;
    });

    // -- Bold + Italic -----------------------------------------------------
    content = content.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
    content = content.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');

    // -- Strikethrough -----------------------------------------------------
    content = content.replace(/<(del|s|strike)[^>]*>([\s\S]*?)<\/\1>/gi, '~~$2~~');

    // -- Links -------------------------------------------------------------
    content = content.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, text: string) => {
      const cleaned = cleanMarkdownInline(text).trim();
      if (!cleaned) return '';
      // Skip anchor links and javascript:
      if (href.startsWith('#') || href.startsWith('javascript:')) return cleaned;
      return `[${cleaned}](${href})`;
    });

    // -- Images ------------------------------------------------------------
    content = content.replace(/<img[^>]*src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, '![$2]($1)');
    content = content.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*\/?>/gi, '![$1]($2)');
    content = content.replace(/<img[^>]*src=["']([^"']*)["'][^>]*\/?>/gi, '![]($1)');

    // -- Unordered Lists ---------------------------------------------------
    content = content.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_match, items: string) => {
      return convertListItems(items, false);
    });

    // -- Ordered Lists -----------------------------------------------------
    content = content.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_match, items: string) => {
      return convertListItems(items, true);
    });

    // -- Blockquotes -------------------------------------------------------
    content = content.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, text: string) => {
      const cleaned = cleanMarkdownInline(text).trim();
      const lines = cleaned.split('\n').map((l: string) => `> ${l}`).join('\n');
      return `\n\n${lines}\n\n`;
    });

    // -- Horizontal Rules --------------------------------------------------
    content = content.replace(/<hr[^>]*\/?>/gi, '\n\n---\n\n');

    // -- Line breaks -------------------------------------------------------
    content = content.replace(/<br[^>]*\/?>/gi, '  \n');

    // -- Definition lists --------------------------------------------------
    content = content.replace(/<dt[^>]*>([\s\S]*?)<\/dt>/gi, (_match, text: string) => {
      return `\n**${cleanMarkdownInline(text).trim()}**\n`;
    });
    content = content.replace(/<dd[^>]*>([\s\S]*?)<\/dd>/gi, (_match, text: string) => {
      return `: ${cleanMarkdownInline(text).trim()}\n`;
    });

    // -- Remove remaining tags ---------------------------------------------
    content = content.replace(/<[^>]+>/g, '');

    // -- Decode entities ---------------------------------------------------
    content = decodeEntities(content);

    // -- Clean up whitespace -----------------------------------------------
    content = normalizeWhitespace(content);

    // Remove excessive empty lines
    content = content.replace(/\n{3,}/g, '\n\n');

    // -- Truncate if needed ------------------------------------------------
    if (options.maxLength && content.length > options.maxLength) {
      content = content.substring(0, options.maxLength);
    }

    return content.trim();
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Markdown conversion failed');
    return html;
  }
}

/**
 * Clean inline HTML elements within a Markdown context.
 * Handles nested bold/italic/links etc. before falling through to tag stripping.
 */
function cleanMarkdownInline(text: string): string {
  let result = text;

  // Bold
  result = result.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  // Italic
  result = result.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  // Strikethrough
  result = result.replace(/<(del|s|strike)[^>]*>([\s\S]*?)<\/\1>/gi, '~~$2~~');
  // Links
  result = result.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  // Images
  result = result.replace(/<img[^>]*src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, '![$2]($1)');
  result = result.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*\/?>/gi, '![$1]($2)');
  result = result.replace(/<img[^>]*src=["']([^"']*)["'][^>]*\/?>/gi, '![]($1)');
  // Inline code
  result = result.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  // Line breaks
  result = result.replace(/<br[^>]*\/?>/gi, '  \n');

  // Remove remaining tags
  result = result.replace(/<[^>]+>/g, '');

  return decodeEntities(result);
}

/**
 * Convert <li> items within a list to Markdown list items.
 */
function convertListItems(itemsHtml: string, ordered: boolean): string {
  const items: string[] = [];
  const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  let idx = 1;

  while ((m = liPattern.exec(itemsHtml)) !== null) {
    const text = cleanMarkdownInline(m[1]).trim();
    if (!text) continue;

    // Handle nested lists within <li> -- extract them separately
    const nestedUl = m[1].match(/<ul[^>]*>([\s\S]*?)<\/ul>/gi);
    const nestedOl = m[1].match(/<ol[^>]*>([\s\S]*?)<\/ol>/gi);

    const prefix = ordered ? `${idx}. ` : '- ';
    let item = `${prefix}${text}`;

    // Add nested list items with indentation
    if (nestedUl) {
      for (const nested of nestedUl) {
        const nestedItems = nested.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
        for (const ni of nestedItems) {
          const niText = cleanMarkdownInline(ni.replace(/<\/?li[^>]*>/gi, '')).trim();
          item += `\n  - ${niText}`;
        }
      }
    }
    if (nestedOl) {
      for (const nested of nestedOl) {
        const nestedItems = nested.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
        let nIdx = 1;
        for (const ni of nestedItems) {
          const niText = cleanMarkdownInline(ni.replace(/<\/?li[^>]*>/gi, '')).trim();
          item += `\n  ${nIdx}. ${niText}`;
          nIdx++;
        }
      }
    }

    items.push(item);
    idx++;
  }

  return '\n\n' + items.join('\n') + '\n\n';
}

/**
 * Convert HTML tables to Markdown table format.
 */
function convertTablesToMarkdown(html: string): string {
  const tablePattern = /<table[^>]*>([\s\S]*?)<\/table>/gi;

  return html.replace(tablePattern, (_match, tableContent: string) => {
    const rows: string[][] = [];

    // Extract rows
    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowPattern.exec(tableContent)) !== null) {
      const cells: string[] = [];

      // Simple cell extraction: find all <th> and <td> content
      const allCells = rowMatch[1].match(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi) || [];
      for (const cell of allCells) {
        const text = cell.replace(/<\/?(th|td)[^>]*>/gi, '').trim();
        const cleaned = cleanMarkdownInline(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
        cells.push(cleaned);
      }

      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    if (rows.length === 0) return '';

    // Build markdown table
    const maxCols = Math.max(...rows.map(r => r.length));
    let md = '\n\n';

    // Header row (first row)
    const header = rows[0];
    md += '| ' + header.join(' | ') + ' |\n';
    md += '| ' + header.map(() => '---').join(' | ') + ' |\n';

    // Data rows
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      // Pad rows with fewer columns
      while (row.length < maxCols) row.push('');
      md += '| ' + row.join(' | ') + ' |\n';
    }

    md += '\n';
    return md;
  });
}

// --- Format: cleaned -----------------------------------------------------------

/**
 * Clean HTML: remove noise elements, ads, popups, cookie banners, comments,
 * data attributes. Keep structural elements. Normalize whitespace.
 */
function processCleaned(html: string, options: OutputOptions): string {
  try {
    let content = html;

    // Apply selector if provided
    if (options.selector) {
      content = extractBySelector(content, options.selector);
    }

    // Remove HTML comments
    content = content.replace(HTML_COMMENTS_RE, '');

    // Remove ad / cookie / popup divs
    content = content.replace(AD_NOISE_PATTERN, '');

    // Remove noise elements with their content
    content = content.replace(NOISE_ELEMENTS_RE, '');

    // Remove self-closing noise elements
    content = content.replace(NOISE_SELF_CLOSING_RE, '');

    // Remove data attributes
    content = content.replace(DATA_ATTRS_RE, '');

    // Remove aria attributes (accessibility attributes, not content)
    content = content.replace(/\s+aria-[a-zA-Z0-9_-]+=(?:"[^"]*"|'[^']*'|[^\s>]+)/g, '');

    // Remove role attributes
    content = content.replace(/\s+role=(?:"[^"]*"|'[^']*'|[^\s>]+)/g, '');

    // Remove event handler attributes
    content = content.replace(/\s+on\w+=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

    // Remove class and style attributes (we keep structural elements but strip styling)
    content = content.replace(/\s+class=(?:"[^"]*"|'[^']*'|[^\s>]+)/g, '');
    content = content.replace(/\s+style=(?:"[^"]*"|'[^']*'|[^\s>]+)/g, '');

    // Remove empty elements (tags with no content between them)
    content = content.replace(/<(div|span|p|section|article|aside|header|footer|main)\s*><\/\1>/gi, '');

    // Normalize whitespace within tags
    content = content.replace(/\s{2,}/g, ' ');

    // Normalize line breaks
    content = content.replace(/\n{3,}/g, '\n\n');

    // Trim
    content = content.trim();

    // Truncate if needed
    if (options.maxLength && content.length > options.maxLength) {
      content = content.substring(0, options.maxLength);
    }

    return content;
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Cleaned HTML processing failed');
    return html;
  }
}

// --- Format: text --------------------------------------------------------------

/**
 * Extract plain text from HTML.
 * Strip ALL HTML tags, normalize whitespace and line breaks,
 * remove excessive blank lines, preserve paragraph structure with double newlines.
 */
function processText(html: string, options: OutputOptions): string {
  try {
    let content = html;

    // Apply selector if provided
    if (options.selector) {
      content = extractBySelector(content, options.selector);
    }

    // Remove noise elements first
    content = content.replace(NOISE_ELEMENTS_RE, '');
    content = content.replace(NOISE_SELF_CLOSING_RE, '');
    content = content.replace(AD_NOISE_PATTERN, '');
    content = content.replace(HTML_COMMENTS_RE, '');

    // Preserve paragraph structure -- add double newlines for block elements
    const blockElements = [
      'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'li', 'tr', 'br', 'hr', 'blockquote', 'pre',
      'section', 'article', 'main', 'aside', 'header', 'footer',
    ];

    for (const tag of blockElements) {
      // Closing tags → double newline for block elements
      if (tag === 'br') {
        content = content.replace(/<br[^>]*\/?>/gi, '\n');
      } else if (tag === 'hr') {
        content = content.replace(/<hr[^>]*\/?>/gi, '\n---\n');
      } else {
        const closeRe = new RegExp(`</${tag}[^>]*>`, 'gi');
        content = content.replace(closeRe, '\n\n');
      }
    }

    // Strip all remaining HTML tags
    content = content.replace(/<[^>]+>/g, '');

    // Decode HTML entities
    content = decodeEntities(content);

    // Normalize whitespace
    content = normalizeWhitespace(content);

    // Remove excessive blank lines but preserve paragraph breaks
    content = content.replace(/\n{3,}/g, '\n\n');

    // Truncate if needed
    if (options.maxLength && content.length > options.maxLength) {
      content = content.substring(0, options.maxLength);
    }

    return content.trim();
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Text extraction failed');
    return html.replace(/<[^>]+>/g, '').trim();
  }
}

// --- Format: parsed ------------------------------------------------------------

/**
 * Intelligently parse HTML to extract structured data:
 *   title, description, canonical URL, OG tags, author, published date,
 *   headings, links, images, main content, word count.
 */
function processParsed(html: string, url: string, options: OutputOptions): ParsedOutput {
  try {
    let content = html;

    // Apply selector if provided
    if (options.selector) {
      content = extractBySelector(content, options.selector);
    }

    // -- Title -------------------------------------------------------------
    let title = extractMetaContent(content, 'og:title')
      || extractFirstMatch(content, /<title[^>]*>([\s\S]*?)<\/title>/i)
      || extractMetaContent(content, 'twitter:title')
      || '';
    title = decodeEntities(stripAllTags(title).trim());

    // -- Description -------------------------------------------------------
    let description = extractMetaName(content, 'description')
      || extractMetaContent(content, 'og:description')
      || extractMetaContent(content, 'twitter:description')
      || '';
    description = decodeEntities(stripAllTags(description).trim());

    // -- Canonical URL -----------------------------------------------------
    let canonicalUrl = extractFirstMatch(content, /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i)
      || extractFirstMatch(content, /<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i)
      || extractMetaContent(content, 'og:url')
      || url;

    // -- OG Tags -----------------------------------------------------------
    const ogTags: Record<string, string> = {};
    const ogPattern = /<meta[^>]*property=["']og:([a-zA-Z0-9_:.-]+)["'][^>]*content=["']([^"']*)["']/gi;
    let ogMatch: RegExpExecArray | null;
    while ((ogMatch = ogPattern.exec(content)) !== null) {
      ogTags[ogMatch[1]] = decodeEntities(ogMatch[2]);
    }
    // Alternate format: content before property
    const ogAltPattern = /<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:([a-zA-Z0-9_:.-]+)["']/gi;
    while ((ogMatch = ogAltPattern.exec(content)) !== null) {
      if (!ogTags[ogMatch[2]]) {
        ogTags[ogMatch[2]] = decodeEntities(ogMatch[1]);
      }
    }

    // -- Author ------------------------------------------------------------
    let author = extractMetaName(content, 'author')
      || extractMetaContent(content, 'article:author')
      || extractFirstMatch(content, /<meta[^>]*property=["']author["'][^>]*content=["']([^"']*)["']/i)
      || extractFirstMatch(content, /<meta[^>]*name=["']byl[^"']*["'][^>]*content=["']([^"']*)["']/i)
      || extractFirstMatch(content, /class=["'][^"']*(?:author|byline)[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|a|div|p)>/i)
      || '';
    author = decodeEntities(stripAllTags(author).trim());

    // -- Published Date ----------------------------------------------------
    let publishedDate = extractMetaProperty(content, 'article:published_time')
      || extractMetaName(content, 'date')
      || extractMetaName(content, 'datepublished')
      || extractMetaName(content, 'pubdate')
      || extractFirstMatch(content, /<time[^>]*datetime=["']([^"']*)["']/i)
      || extractMetaContent(content, 'og:article:published_time')
      || '';
    publishedDate = publishedDate.trim();

    // -- Headings ----------------------------------------------------------
    const headings: Array<{ level: number; text: string }> = [];
    for (let i = 1; i <= 6; i++) {
      const re = new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi');
      let hMatch: RegExpExecArray | null;
      while ((hMatch = re.exec(content)) !== null) {
        const text = decodeEntities(stripAllTags(hMatch[1])).trim();
        if (text) {
          headings.push({ level: i, text });
        }
      }
    }

    // -- Links -------------------------------------------------------------
    const links: Array<{ text: string; href: string }> = [];
    const linkPattern = /<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkPattern.exec(content)) !== null) {
      const href = linkMatch[1].trim();
      const text = decodeEntities(stripAllTags(linkMatch[2])).trim();
      // Skip empty, anchor-only, javascript: links
      if (!text || href.startsWith('#') || href.startsWith('javascript:') || href === '') continue;
      // Deduplicate by href+text combo
      if (links.some(l => l.href === href && l.text === text)) continue;
      links.push({ text, href });
    }
    // Limit to a reasonable number
    if (links.length > 500) {
      links.length = 500;
    }

    // -- Images ------------------------------------------------------------
    const images: Array<{ alt: string; src: string }> = [];
    const imgPattern = /<img[^>]*>/gi;
    let imgMatch: RegExpExecArray | null;
    while ((imgMatch = imgPattern.exec(content)) !== null) {
      const imgTag = imgMatch[0];
      const src = extractAttr(imgTag, 'src') || extractAttr(imgTag, 'data-src') || '';
      const alt = extractAttr(imgTag, 'alt') || '';
      if (src && !src.startsWith('data:')) {
        images.push({ alt: decodeEntities(alt), src });
      }
    }
    // Limit to a reasonable number
    if (images.length > 200) {
      images.length = 200;
    }

    // -- Main Content ------------------------------------------------------
    const mainContent = extractMainContent(content);

    // -- Word Count --------------------------------------------------------
    const wordCount = mainContent.split(/\s+/).filter(w => w.length > 0).length;

    const result: ParsedOutput = {
      title,
      description,
      canonicalUrl,
      ogTags,
      author,
      publishedDate,
      headings,
      links,
      images,
      mainContent,
      wordCount,
    };

    return result;
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Parsed extraction failed');
    return {
      title: '',
      description: '',
      canonicalUrl: url,
      ogTags: {},
      author: '',
      publishedDate: '',
      headings: [],
      links: [],
      images: [],
      mainContent: '',
      wordCount: 0,
    };
  }
}

/**
 * Extract a meta tag content by name attribute.
 */
function extractMetaName(html: string, name: string): string {
  const pattern1 = new RegExp(`<meta[^>]*name=["']${escapeRegex(name)}["'][^>]*content=["']([^"']*)["']`, 'i');
  const pattern2 = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${escapeRegex(name)}["']`, 'i');
  return extractFirstMatch(html, pattern1) || extractFirstMatch(html, pattern2);
}

/**
 * Extract a meta tag content by property attribute.
 */
function extractMetaProperty(html: string, property: string): string {
  const pattern1 = new RegExp(`<meta[^>]*property=["']${escapeRegex(property)}["'][^>]*content=["']([^"']*)["']`, 'i');
  const pattern2 = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']${escapeRegex(property)}["']`, 'i');
  return extractFirstMatch(html, pattern1) || extractFirstMatch(html, pattern2);
}

/**
 * Extract meta tag content -- tries both property and name variants.
 */
function extractMetaContent(html: string, key: string): string {
  return extractMetaProperty(html, key) || extractMetaName(html, key);
}

/**
 * Extract the first capture group from a regex, with a fallback.
 */
function extractFirstMatch(html: string, pattern: RegExp, fallback: string = ''): string {
  try {
    const m = html.match(pattern);
    return m && m[1] !== undefined ? m[1].trim() : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Extract an attribute value from an HTML tag string.
 */
function extractAttr(tag: string, attr: string): string {
  const pattern = new RegExp(`${attr}=["']([^"']*)["']`, 'i');
  const m = tag.match(pattern);
  return m ? m[1] : '';
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract the main content from an HTML document.
 * Strategy:
 *   1. Look for <main>, <article>, or [role="main"] elements
 *   2. Fall back to the largest text block in <body>
 *   3. As a last resort, strip all tags and normalize
 */
function extractMainContent(html: string): string {
  // Strategy 1: <main> or <article>
  const mainContent = extractBalancedTag(html, 'main')
    || extractBalancedTag(html, 'article')
    || '';

  if (mainContent && mainContent.length > 200) {
    // Remove noise from the extracted content
    let cleaned = mainContent;
    cleaned = cleaned.replace(NOISE_ELEMENTS_RE, '');
    cleaned = cleaned.replace(NOISE_SELF_CLOSING_RE, '');
    cleaned = cleaned.replace(AD_NOISE_PATTERN, '');
    cleaned = cleaned.replace(HTML_COMMENTS_RE, '');
    const text = decodeEntities(stripAllTags(cleaned)).trim();
    if (text.length > 100) return normalizeWhitespace(text);
  }

  // Strategy 2: Find <body> and extract the largest text block
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyContent = bodyMatch ? bodyMatch[1] : html;

  // Split into block-level chunks and find the largest one
  const chunks: Array<{ text: string; length: number }> = [];
  const blockPattern = /<(div|section|article|main|p)[^>]*>([\s\S]*?)<\/\1>/gi;
  let bMatch: RegExpExecArray | null;

  while ((bMatch = blockPattern.exec(bodyContent)) !== null) {
    let chunk = bMatch[2];
    // Remove nested noise
    chunk = chunk.replace(NOISE_ELEMENTS_RE, '');
    chunk = chunk.replace(NOISE_SELF_CLOSING_RE, '');
    chunk = chunk.replace(AD_NOISE_PATTERN, '');
    const text = decodeEntities(stripAllTags(chunk)).trim();
    if (text.length > 50) {
      chunks.push({ text, length: text.length });
    }
  }

  // Sort by length descending
  chunks.sort((a, b) => b.length - a.length);

  // Take the top chunks up to a reasonable limit
  if (chunks.length > 0) {
    const topChunks = chunks.slice(0, Math.min(5, chunks.length));
    const combined = topChunks.map(c => c.text).join('\n\n');
    return normalizeWhitespace(combined);
  }

  // Strategy 3: Just strip tags from body
  const text = decodeEntities(stripAllTags(bodyContent)).trim();
  return normalizeWhitespace(text);
}

// --- Auto-detection ------------------------------------------------------------

/**
 * Auto-detect the best output format based on HTML content characteristics.
 *
 * Heuristics:
 *  - If the HTML is very short or appears to be an error page → 'text'
 *  - If it has rich semantic structure (article, main, many headings) → 'markdown'
 *  - If it's mostly boilerplate with some useful meta tags → 'parsed'
 *  - If it has a lot of script/style noise relative to content → 'cleaned'
 *  - Otherwise → 'markdown' (good default for most content)
 */
export function detectBestFormat(html: string): OutputFormat {
  if (!html || html.length < 50) return 'text';

  try {
    const htmlLength = html.length;

    // -- Check for error pages ---------------------------------------------
    const lowerHtml = html.toLowerCase();
    const isErrorPage = lowerHtml.includes('<title>404</title>')
      || lowerHtml.includes('<title>403</title>')
      || lowerHtml.includes('<title>500</title>')
      || lowerHtml.includes('<title>error</title>')
      || lowerHtml.includes('page not found')
      || lowerHtml.includes('access denied');
    if (isErrorPage) return 'text';

    // -- Measure noise vs. content -----------------------------------------
    const scriptSize = (html.match(/<script[\s>][\s\S]*?<\/script>/gi) || []).join('').length;
    const styleSize = (html.match(/<style[\s>][\s\S]*?<\/style>/gi) || []).join('').length;
    const navSize = (html.match(/<nav[\s>][\s\S]*?<\/nav>/gi) || []).join('').length;
    const noiseSize = scriptSize + styleSize + navSize;

    const noiseRatio = noiseSize / htmlLength;

    // -- Check for rich semantic structure ---------------------------------
    const hasArticle = /<article[\s>]/i.test(html);
    const hasMain = /<main[\s>]/i.test(html);
    const headingCount = (html.match(/<h[1-6][\s>]/gi) || []).length;
    const paragraphCount = (html.match(/<p[\s>]/gi) || []).length;
    const linkCount = (html.match(/<a[\s>]/gi) || []).length;

    // -- Check for useful meta tags ----------------------------------------
    const hasOgTags = /property=["']og:/i.test(html);
    const hasMetaDescription = /name=["']description["']/i.test(html);
    const hasJsonLd = /type=["']application\/ld\+json["']/i.test(html);

    // -- Score each format -------------------------------------------------
    let parsedScore = 0;
    let markdownScore = 0;
    let cleanedScore = 0;
    let textScore = 0;

    // Parsed format is best when there's rich metadata
    if (hasOgTags) parsedScore += 3;
    if (hasMetaDescription) parsedScore += 2;
    if (hasJsonLd) parsedScore += 3;
    if (hasArticle) parsedScore += 2;
    if (headingCount >= 3) parsedScore += 2;
    if (linkCount > 20) parsedScore += 1;

    // Markdown format is best for readable content
    if (hasArticle) markdownScore += 3;
    if (hasMain) markdownScore += 2;
    if (headingCount >= 2) markdownScore += 2;
    if (paragraphCount >= 5) markdownScore += 2;
    if (noiseRatio < 0.3) markdownScore += 2;
    if (paragraphCount >= 10) markdownScore += 1;

    // Cleaned format is best when there's a lot of noise
    if (noiseRatio > 0.5) cleanedScore += 4;
    if (noiseRatio > 0.3) cleanedScore += 2;
    if (navSize > htmlLength * 0.1) cleanedScore += 2;

    // Text format is best for simple / short content
    if (htmlLength < 5000) textScore += 2;
    if (paragraphCount < 3 && headingCount < 2) textScore += 2;
    if (noiseRatio > 0.7) textScore += 3;

    // -- Pick the highest scorer -------------------------------------------
    const scores: Array<{ format: OutputFormat; score: number }> = [
      { format: 'parsed', score: parsedScore },
      { format: 'markdown', score: markdownScore },
      { format: 'cleaned', score: cleanedScore },
      { format: 'text', score: textScore },
    ];

    scores.sort((a, b) => b.score - a.score);

    // If markdown and parsed are tied, prefer markdown (more versatile)
    if (scores[0].score === 0) return 'markdown';

    logger.debug({
      scores: scores.map(s => `${s.format}=${s.score}`).join(', '),
      htmlLength,
      noiseRatio: noiseRatio.toFixed(2),
      headingCount,
      paragraphCount,
    }, 'Auto-detected best format');

    return scores[0].format;
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'Auto-detection failed, defaulting to markdown');
    return 'markdown';
  }
}

// --- OutputPipeline Class ------------------------------------------------------

/**
 * Multi-Format Output Pipeline.
 *
 * Transforms raw HTML into the requested output format with processing metrics.
 *
 * @example
 *   const pipeline = new OutputPipeline();
 *   const result = pipeline.process(html, url, { format: 'markdown' });
 *   console.log(result.compressionRatio); // 0.35
 *   console.log(result.processingMs);     // 12
 */
export class OutputPipeline {
  /**
   * Transform HTML to the requested output format.
   *
   * @param html    - The raw HTML string to process.
   * @param url     - The URL of the page (used for canonical URL resolution in 'parsed' format).
   * @param options - Output options controlling format, selector, truncation, etc.
   * @returns An OutputResult with the transformed content and processing metrics.
   */
  process(html: string, url: string, options: OutputOptions): OutputResult {
    const startTime = Date.now();
    const originalSizeBytes = Buffer.byteLength(html, 'utf-8');

    try {
      if (!html || typeof html !== 'string') {
        logger.warn('process() called with empty or non-string HTML');
        return {
          format: options.format || 'raw',
          content: html || '',
          originalSizeBytes,
          outputSizeBytes: originalSizeBytes,
          compressionRatio: 1,
          processingMs: Date.now() - startTime,
        };
      }

      const format = options.format || 'raw';
      let content: string | ParsedOutput;

      switch (format) {
        case 'raw':
          content = processRaw(html, options);
          break;
        case 'markdown':
          content = processMarkdown(html, options);
          break;
        case 'cleaned':
          content = processCleaned(html, options);
          break;
        case 'text':
          content = processText(html, options);
          break;
        case 'parsed':
          content = processParsed(html, url, options);
          // Apply maxLength to mainContent if specified
          if (options.maxLength && content.mainContent.length > options.maxLength) {
            content = {
              ...content,
              mainContent: content.mainContent.substring(0, options.maxLength),
              wordCount: content.mainContent.substring(0, options.maxLength).split(/\s+/).filter(w => w.length > 0).length,
            };
          }
          break;
        default:
          logger.warn({ format }, 'Unknown output format, falling back to raw');
          content = processRaw(html, options);
      }

      const outputSizeBytes = typeof content === 'string'
        ? Buffer.byteLength(content, 'utf-8')
        : Buffer.byteLength(JSON.stringify(content), 'utf-8');

      const compressionRatio = originalSizeBytes > 0 ? outputSizeBytes / originalSizeBytes : 0;
      const processingMs = Date.now() - startTime;

      logger.debug({
        format,
        originalSizeBytes,
        outputSizeBytes,
        compressionRatio: compressionRatio.toFixed(3),
        processingMs,
        selector: options.selector || 'none',
      }, 'Output pipeline processed');

      return {
        format,
        content,
        originalSizeBytes,
        outputSizeBytes,
        compressionRatio,
        processingMs,
      };
    } catch (err) {
      const processingMs = Date.now() - startTime;
      logger.error({ err: (err as Error).message, format: options.format }, 'Output pipeline processing failed');

      return {
        format: options.format || 'raw',
        content: html,
        originalSizeBytes,
        outputSizeBytes: originalSizeBytes,
        compressionRatio: 1,
        processingMs,
      };
    }
  }
}

// --- Singleton Export ----------------------------------------------------------

/** Singleton OutputPipeline instance for shared use across the application. */
export const outputPipeline = new OutputPipeline();
