/**
 * Reddit Scroll Voter -- ScrapeSuite Engine
 *
 * Simulates realistic Reddit browsing behavior to evade behavioral
 * fingerprinting and detection systems. Generates human-like:
 *
 *   - Scroll patterns with reading pauses and direction changes
 *   - Vote patterns (80% up, 10% down, 10% skip — mimicking real engagement)
 *   - Comment reading with depth-aware timing
 *   - Complete browsing sessions with navigation between sections
 *   - Playwright-compatible interaction sequences
 *
 * Reddit's behavioral detection looks for:
 *   - Consistent scroll speeds (bots scroll uniformly)
 *   - Instant page transitions (humans have think-time)
 *   - No interaction patterns (humans occasionally vote/click)
 *   - Missing reading time correlated with content length
 *   - Perfect linear navigation (humans backtrack, revisit)
 */

import { createChildLogger } from '../../utils/logger';
import { cacheSet } from '../../utils/redis';
import type {
  RedditInteractionConfig,
  RedditScrapeTarget,
  RedditSessionProfile,
  RedditBrowsingSession,
  PlaywrightAction,
  PlaywrightSequence,
} from './types';
import { DEFAULT_REDDIT_CONFIG } from './types';

const logger = createChildLogger('reddit-scroll-voter');

// ===============================================================================
// CONSTANTS
// ===============================================================================

/** Average words per post body (for reading time calculation) */
const AVG_POST_BODY_WORDS = 150;

/** Average words per comment (for reading time calculation) */
const AVG_COMMENT_WORDS = 45;

/** Words per comment title (for reading time calculation) */
const AVG_TITLE_WORDS = 12;

/** Maximum realistic scroll events per second */
const MAX_SCROLLS_PER_SECOND = 4;

/** Minimum realistic reading time for any content (ms) */
const MIN_READING_TIME_MS = 400;

/** Maximum items to track in a single simulation */
const MAX_SIMULATION_ITEMS = 200;

/** Cache key prefix for simulation logs */
const CACHE_KEY_PREFIX = 'reddit:simulation:';

// ===============================================================================
// SCROLL VOTER ENGINE
// ===============================================================================

export class ScrollVoter {
  private config: RedditInteractionConfig;
  private stats = {
    totalSessions: 0,
    totalScrolls: 0,
    totalVotes: 0,
    totalCommentReads: 0,
    totalPlaywrightSequences: 0,
    avgSessionDurationMs: 0,
  };

  constructor(config?: Partial<RedditInteractionConfig>) {
    this.config = { ...DEFAULT_REDDIT_CONFIG.interaction, ...config };
  }

  // ===========================================================================
  // BROWSING SESSION GENERATION
  // ===========================================================================

  /**
   * Generate a complete Reddit browsing session with realistic interactions.
   *
   * A session includes:
   *   - Entry point (usually a subreddit listing or the front page)
   *   - Scrolling through posts with reading pauses
   *   - Clicking into posts to read content/comments
   *   - Voting on some posts and comments
   *   - Navigating between sections (hot → comments → back)
   *   - Optional search behavior
   *   - Break periods for realism
   *
   * @param config - Optional override for interaction config
   * @returns A complete browsing session descriptor
   */
  generateBrowsingSession(config?: Partial<RedditInteractionConfig>): RedditBrowsingSession {
    const effectiveConfig = config
      ? { ...this.config, ...config }
      : this.config;

    const sessionId = this.generateSessionId();
    const now = Date.now();

    // Determine session duration
    const sessionDuration = this.randomBetween(
      effectiveConfig.sessionTiming.minSessionDurationMs,
      effectiveConfig.sessionTiming.maxSessionDurationMs
    );

    // Create a session profile
    const profile = this.generateSessionProfile();

    // Plan which sections to visit
    const sections = this.planSectionVisits(effectiveConfig);

    // Generate the Playwright sequence
    const sequence = this.generatePlaywrightSequenceInternal(
      sections,
      profile,
      effectiveConfig
    );

    // Generate vote actions
    const votes = this.generateSessionVotes(sections, effectiveConfig);

    const session: RedditBrowsingSession = {
      sessionId,
      profile,
      sectionsVisited: sections.map(s => ({
        section: s.target,
        subreddit: s.subreddit,
        durationMs: s.estimatedDurationMs,
        actionsCount: s.actions.length,
      })),
      sequence,
      votes,
      totalDurationMs: sessionDuration,
      isActive: true,
      startedAt: now,
      endedAt: null,
    };

    // Update stats
    this.stats.totalSessions++;
    this.stats.totalScrolls += sequence.actions.filter(a => a.type === 'scroll').length;
    this.stats.totalVotes += votes.length;
    this.stats.avgSessionDurationMs = this.stats.totalSessions > 0
      ? (this.stats.avgSessionDurationMs * (this.stats.totalSessions - 1) + sessionDuration) / this.stats.totalSessions
      : sessionDuration;

    // Cache the session for audit trail
    cacheSet(`${CACHE_KEY_PREFIX}${sessionId}`, session, 3600).catch(() => {});

    logger.info({
      sessionId,
      sectionsCount: sections.length,
      totalVotes: votes.length,
      totalActions: sequence.actions.length,
      durationMs: sessionDuration,
    }, 'Generated Reddit browsing session');

    return session;
  }

  // ===========================================================================
  // SCROLL PATTERN GENERATION
  // ===========================================================================

  /**
   * Generate a scroll pattern for a specific Reddit section.
   *
   * Different sections have different natural scroll behaviors:
   *   - Listing pages: Continuous scroll with periodic pauses
   *   - Comment threads: Scroll-and-expand with depth reading
   *   - Search results: Faster scanning, fewer pauses
   *   - User profiles: Variable based on content type
   *
   * @param section - The Reddit section to generate scroll patterns for
   * @returns Array of scroll actions with timing
   */
  generateScrollPattern(section: RedditScrapeTarget): Array<{
    direction: 'down' | 'up';
    distancePx: number;
    delayAfterMs: number;
    isPause: boolean;
  }> {
    const patterns: Array<{
      direction: 'down' | 'up';
      distancePx: number;
      delayAfterMs: number;
      isPause: boolean;
    }> = [];

    let totalDistance = 0;
    const maxScrollDistance = this.getMaxScrollDistance(section);
    const scrollCount = this.randomBetween(5, Math.min(25, MAX_SIMULATION_ITEMS));

    for (let i = 0; i < scrollCount && totalDistance < maxScrollDistance; i++) {
      // Direction — mostly down, occasional up
      const direction: 'down' | 'up' = Math.random() < this.config.scrollPatterns.scrollBackProbability && i > 2
        ? 'up'
        : 'down';

      // Distance — variable speed
      const distance = this.randomBetween(
        this.config.scrollPatterns.scrollSpeedRange.min,
        this.config.scrollPatterns.scrollSpeedRange.max
      );

      // Delay after scroll
      const baseDelay = this.randomBetween(
        this.config.scrollPatterns.scrollIntervalRange.min,
        this.config.scrollPatterns.scrollIntervalRange.max
      );

      // Reading pause — occurs at natural break points
      const isPause = Math.random() < this.config.scrollPatterns.pauseProbability;
      const pauseExtra = isPause
        ? this.randomBetween(
            this.config.scrollPatterns.pauseDurationRange.min,
            this.config.scrollPatterns.pauseDurationRange.max
          )
        : 0;

      patterns.push({
        direction,
        distancePx: direction === 'down' ? distance : Math.min(distance, totalDistance),
        delayAfterMs: baseDelay + pauseExtra,
        isPause,
      });

      totalDistance += direction === 'down' ? distance : -distance;
      totalDistance = Math.max(0, totalDistance);
    }

    // Section-specific modifications
    if (section === 'comments') {
      // Comment sections have longer pauses (reading)
      for (const pattern of patterns) {
        if (pattern.isPause) {
          pattern.delayAfterMs *= 1.5; // 50% longer pauses for comments
        }
      }
    } else if (section === 'search') {
      // Search results get faster scanning
      for (const pattern of patterns) {
        pattern.delayAfterMs = Math.round(pattern.delayAfterMs * 0.7);
      }
    }

    this.stats.totalScrolls += patterns.length;

    logger.debug({
      section,
      scrollCount: patterns.length,
      pauseCount: patterns.filter(p => p.isPause).length,
      totalDistance,
    }, 'Generated scroll pattern');

    return patterns;
  }

  // ===========================================================================
  // VOTE PATTERN GENERATION
  // ===========================================================================

  /**
   * Generate realistic upvote/downvote patterns for a set of posts.
   *
   * Real Reddit user behavior shows:
   *   - ~80% of votes are upvotes (positive bias)
   *   - ~10% are downvotes (rare but necessary for realism)
   *   - ~10% skip voting entirely
   *   - Vote timing correlates with content reading time
   *   - Occasional vote undos (rare, ~2%)
   *   - Comment votes are less frequent than post votes
   *
   * @param postCount - Number of posts to generate vote decisions for
   * @returns Array of vote decisions
   */
  generateVotePattern(postCount: number): Array<{
    direction: 'up' | 'down' | 'skip' | 'undo';
    delayMs: number;
    isCommentVote: boolean;
  }> {
    const votes: Array<{
      direction: 'up' | 'down' | 'skip' | 'undo';
      delayMs: number;
      isCommentVote: boolean;
    }> = [];

    for (let i = 0; i < Math.min(postCount, MAX_SIMULATION_ITEMS); i++) {
      const rand = Math.random();

      // Determine vote direction based on configured probabilities
      let direction: 'up' | 'down' | 'skip';
      if (rand < this.config.voteBehavior.upvoteProbability) {
        direction = 'up';
      } else if (rand < this.config.voteBehavior.upvoteProbability + this.config.voteBehavior.downvoteProbability) {
        direction = 'down';
      } else {
        direction = 'skip';
      }

      // Reading time before voting (correlated with content length)
      const viewTime = this.randomBetween(
        this.config.voteBehavior.minViewTimeBeforeVote,
        this.config.voteBehavior.maxViewTimeBeforeVote
      );

      // Determine if this is a comment vote (less common)
      const isCommentVote = Math.random() < this.config.voteBehavior.commentVoteProbability;

      votes.push({
        direction,
        delayMs: viewTime,
        isCommentVote,
      });

      // Occasional undo vote
      if (direction !== 'skip' && Math.random() < this.config.voteBehavior.undoVoteProbability) {
        votes.push({
          direction: 'undo',
          delayMs: this.randomBetween(3000, 10000), // Undo after a delay
          isCommentVote,
        });
      }
    }

    this.stats.totalVotes += votes.filter(v => v.direction !== 'skip').length;

    logger.debug({
      postCount,
      upvotes: votes.filter(v => v.direction === 'up').length,
      downvotes: votes.filter(v => v.direction === 'down').length,
      skips: votes.filter(v => v.direction === 'skip').length,
      undos: votes.filter(v => v.direction === 'undo').length,
    }, 'Generated vote pattern');

    return votes;
  }

  // ===========================================================================
  // COMMENT READING PATTERN GENERATION
  // ===========================================================================

  /**
   * Generate comment reading behavior for a Reddit comment thread.
   *
   * Real comment reading behavior:
   *   - Top-level comments get the most attention
   *   - Deeper comments get progressively less reading time
   *   - Some collapsed comments get expanded (curiosity)
   *   - Long reply chains may be partially read
   *   - Reading time correlates with word count
   *
   * @param commentCount - Total number of comments in the thread
   * @returns Array of comment reading actions with timing
   */
  generateCommentReadingPattern(commentCount: number): Array<{
    depth: number;
    readTimeMs: number;
    isExpanded: boolean;
    isSkipped: boolean;
  }> {
    const actions: Array<{
      depth: number;
      readTimeMs: number;
      isExpanded: boolean;
      isSkipped: boolean;
    }> = [];

    const effectiveCommentCount = Math.min(commentCount, MAX_SIMULATION_ITEMS);

    for (let i = 0; i < effectiveCommentCount; i++) {
      // Determine depth — weighted toward top-level comments
      const depth = this.weightedDepth();

      // Skip probability increases with depth
      const skipProbability = Math.min(0.6, depth * 0.12);
      const isSkipped = Math.random() < skipProbability;

      if (isSkipped) {
        actions.push({
          depth,
          readTimeMs: 0,
          isExpanded: false,
          isSkipped: true,
        });
        continue;
      }

      // Reading time based on comment length and depth
      const wordCount = this.randomBetween(
        Math.max(5, AVG_COMMENT_WORDS - 20),
        AVG_COMMENT_WORDS + 40
      );
      const baseReadTimeMs = Math.max(
        MIN_READING_TIME_MS,
        (wordCount / this.config.commentReading.readingSpeedWpm) * 60000
      );
      const depthMultiplier = Math.pow(
        this.config.commentReading.depthTimeMultiplier,
        depth
      );
      const readTimeMs = Math.round(baseReadTimeMs * depthMultiplier);

      // Expand collapsed comments occasionally
      const isExpanded = depth > 1
        ? Math.random() < this.config.commentReading.expandCollapsedProbability
        : false;

      actions.push({
        depth,
        readTimeMs,
        isExpanded,
        isSkipped: false,
      });

      // Simulate reading a reply chain
      if (
        depth === 0 &&
        Math.random() < this.config.commentReading.replyChainReadProbability
      ) {
        // Add 1-3 replies to the chain
        const chainLength = this.randomBetween(1, 3);
        for (let j = 1; j <= chainLength && (i + j) < effectiveCommentCount; j++) {
          const chainWords = this.randomBetween(10, AVG_COMMENT_WORDS + 20);
          const chainReadTime = Math.max(
            MIN_READING_TIME_MS,
            (chainWords / this.config.commentReading.readingSpeedWpm) * 60000
              * Math.pow(this.config.commentReading.depthTimeMultiplier, j)
          );

          actions.push({
            depth: j,
            readTimeMs: Math.round(chainReadTime),
            isExpanded: j > 1 && Math.random() < this.config.commentReading.expandCollapsedProbability,
            isSkipped: false,
          });
        }
      }
    }

    this.stats.totalCommentReads += actions.filter(a => !a.isSkipped).length;

    logger.debug({
      commentCount,
      readComments: actions.filter(a => !a.isSkipped).length,
      skippedComments: actions.filter(a => a.isSkipped).length,
      expandedComments: actions.filter(a => a.isExpanded).length,
      totalReadTimeMs: actions.reduce((sum, a) => sum + a.readTimeMs, 0),
    }, 'Generated comment reading pattern');

    return actions;
  }

  // ===========================================================================
  // PLAYWRIGHT SEQUENCE GENERATION
  // ===========================================================================

  /**
   * Generate a Playwright-compatible interaction sequence for browser automation.
   *
   * Produces a sequence of actions that can be directly executed by
   * Playwright to simulate a realistic Reddit browsing session. Each action
   * includes timing information and optional humanization.
   *
   * @returns A complete Playwright interaction sequence
   */
  generatePlaywrightSequence(): PlaywrightSequence {
    const profile = this.generateSessionProfile();
    const sections = this.planSectionVisits(this.config);
    const sequence = this.generatePlaywrightSequenceInternal(sections, profile, this.config);

    this.stats.totalPlaywrightSequences++;

    return sequence;
  }

  // ===========================================================================
  // STATISTICS
  // ===========================================================================

  /**
   * Get scroll voter statistics.
   */
  getStats(): Record<string, unknown> {
    return { ...this.stats };
  }

  // ===========================================================================
  // PRIVATE HELPERS — SESSION GENERATION
  // ===========================================================================

  /**
   * Generate a unique session ID.
   */
  private generateSessionId(): string {
    return `rdt_sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Generate a realistic session profile.
   */
  private generateSessionProfile(): RedditSessionProfile {
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    ];

    const resolutions = [
      { width: 1920, height: 1080, dpr: 1 },
      { width: 1366, height: 768, dpr: 1 },
      { width: 1536, height: 864, dpr: 1.25 },
      { width: 1440, height: 900, dpr: 2 },
      { width: 2560, height: 1440, dpr: 1 },
    ];

    const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
    const res = resolutions[Math.floor(Math.random() * resolutions.length)];

    const defaultSubreddits = [
      'worldnews', 'technology', 'science', 'gaming', 'pics',
      'AskReddit', 'todayilearned', 'funny', 'movies', 'music',
    ];

    return {
      userAgent: ua,
      screenResolution: res,
      platform: ua.includes('Win') ? 'Win32' : ua.includes('Mac') ? 'MacIntel' : 'Linux x86_64',
      language: 'en-US',
      region: 'US',
      timezoneOffset: new Date().getTimezoneOffset(),
      isLoggedIn: Math.random() > 0.4, // 60% chance of appearing logged in
      redditVariant: Math.random() > 0.8 ? 'old' : 'new',
      useJsonApi: true,
      subscribedSubreddits: this.shuffleArray(defaultSubreddits).slice(0, this.randomBetween(3, 7)),
      cookies: {},
      sessionStart: Date.now(),
      sessionId: this.generateSessionId(),
    };
  }

  /**
   * Plan which sections to visit during a browsing session.
   */
  private planSectionVisits(config: RedditInteractionConfig): Array<{
    target: RedditScrapeTarget;
    subreddit?: string;
    actions: PlaywrightAction[];
    estimatedDurationMs: number;
  }> {
    const sections: Array<{
      target: RedditScrapeTarget;
      subreddit?: string;
      actions: PlaywrightAction[];
      estimatedDurationMs: number;
    }> = [];

    // Always start with a listing (front page or subreddit)
    const defaultSubs = ['popular', 'all', 'worldnews', 'technology', 'AskReddit'];
    const entrySubreddit = defaultSubs[Math.floor(Math.random() * defaultSubs.length)];

    sections.push({
      target: 'listing',
      subreddit: entrySubreddit,
      actions: [],
      estimatedDurationMs: this.randomBetween(30000, 120000),
    });

    // Click into some posts
    if (Math.random() < config.navigation.clickIntoPostProbability) {
      const postCount = this.randomBetween(1, 4);
      for (let i = 0; i < postCount; i++) {
        sections.push({
          target: 'post',
          actions: [],
          estimatedDurationMs: this.randomBetween(20000, 90000),
        });

        // Read comments for some posts
        if (Math.random() < 0.7) {
          sections.push({
            target: 'comments',
            actions: [],
            estimatedDurationMs: this.randomBetween(30000, 180000),
          });
        }
      }
    }

    // Visit another subreddit
    if (Math.random() < config.navigation.visitSubredditProbability) {
      const otherSubs = ['science', 'gaming', 'programming', 'datascience', 'machinelearning'];
      sections.push({
        target: 'subreddit',
        subreddit: otherSubs[Math.floor(Math.random() * otherSubs.length)],
        actions: [],
        estimatedDurationMs: this.randomBetween(20000, 60000),
      });
    }

    // Search
    if (Math.random() < config.navigation.searchProbability) {
      sections.push({
        target: 'search',
        actions: [],
        estimatedDurationMs: this.randomBetween(15000, 45000),
      });
    }

    // User profile visit
    if (Math.random() < config.navigation.visitProfileProbability) {
      sections.push({
        target: 'user',
        actions: [],
        estimatedDurationMs: this.randomBetween(10000, 30000),
      });
    }

    // Wiki page
    if (Math.random() < 0.03) {
      sections.push({
        target: 'wiki',
        actions: [],
        estimatedDurationMs: this.randomBetween(15000, 60000),
      });
    }

    return sections;
  }

  /**
   * Generate votes for a complete session.
   */
  private generateSessionVotes(
    sections: Array<{ target: RedditScrapeTarget; subreddit?: string; actions: PlaywrightAction[]; estimatedDurationMs: number }>,
    config: RedditInteractionConfig
  ): Array<{ direction: 'up' | 'down' | 'undo'; targetId: string; targetType: 'post' | 'comment'; delayMs: number }> {
    const votes: Array<{ direction: 'up' | 'down' | 'undo'; targetId: string; targetType: 'post' | 'comment'; delayMs: number }> = [];

    for (const section of sections) {
      if (section.target === 'listing' || section.target === 'subreddit') {
        // Vote on posts in listings
        const postCount = this.randomBetween(3, 12);
        const votePattern = this.generateVotePattern(postCount);
        for (const vote of votePattern) {
          if (vote.direction === 'skip') continue;
          votes.push({
            direction: vote.direction as 'up' | 'down' | 'undo',
            targetId: `t3_${this.randomAlphaNum(6)}`,
            targetType: vote.isCommentVote ? 'comment' : 'post',
            delayMs: vote.delayMs,
          });
        }
      } else if (section.target === 'comments') {
        // Vote on comments
        const commentCount = this.randomBetween(2, 8);
        const votePattern = this.generateVotePattern(commentCount);
        for (const vote of votePattern) {
          if (vote.direction === 'skip') continue;
          votes.push({
            direction: vote.direction as 'up' | 'down' | 'undo',
            targetId: `t1_${this.randomAlphaNum(6)}`,
            targetType: 'comment',
            delayMs: vote.delayMs,
          });
        }
      }
    }

    return votes;
  }

  // ===========================================================================
  // PRIVATE HELPERS — PLAYWRIGHT SEQUENCE
  // ===========================================================================

  /**
   * Generate a Playwright sequence from planned sections.
   */
  private generatePlaywrightSequenceInternal(
    sections: Array<{
      target: RedditScrapeTarget;
      subreddit?: string;
      actions: PlaywrightAction[];
      estimatedDurationMs: number;
    }>,
    profile: RedditSessionProfile,
    config: RedditInteractionConfig
  ): PlaywrightSequence {
    const actions: PlaywrightAction[] = [];
    let totalDuration = 0;

    // Initial page load
    const loadUrl = profile.redditVariant === 'old'
      ? `https://old.reddit.com/r/${sections[0]?.subreddit || 'popular'}`
      : `https://www.reddit.com/r/${sections[0]?.subreddit || 'popular'}`;

    actions.push({
      type: 'navigate',
      value: loadUrl,
      durationMs: 0,
      label: 'Navigate to entry point',
      humanize: false,
    });

    actions.push({
      type: 'wait',
      durationMs: this.randomBetween(2000, 4000),
      label: 'Page load wait',
      humanize: true,
    });
    totalDuration += 3000;

    for (const section of sections) {
      // Navigate to section if not the first one
      if (section !== sections[0]) {
        const navDelay = this.randomBetween(
          config.navigation.navigationDelayRange.min,
          config.navigation.navigationDelayRange.max
        );

        if (section.target === 'subreddit' && section.subreddit) {
          actions.push({
            type: 'navigate',
            value: `https://${profile.redditVariant === 'old' ? 'old' : 'www'}.reddit.com/r/${section.subreddit}`,
            durationMs: 0,
            label: `Navigate to r/${section.subreddit}`,
            humanize: false,
          });
        } else if (section.target === 'search') {
          actions.push({
            type: 'click',
            selector: '[aria-label="Search"]',
            durationMs: this.randomBetween(200, 500),
            label: 'Open search',
            humanize: true,
          });
          actions.push({
            type: 'type',
            selector: 'input[type="search"]',
            value: this.getRandomSearchQuery(),
            durationMs: this.randomBetween(800, 2000),
            label: 'Type search query',
            humanize: true,
          });
          actions.push({
            type: 'keyPress',
            value: 'Enter',
            durationMs: this.randomBetween(100, 300),
            label: 'Submit search',
            humanize: true,
          });
        }

        actions.push({
          type: 'wait',
          durationMs: navDelay,
          label: `Navigation delay (${section.target})`,
          humanize: true,
        });
        totalDuration += navDelay;
      }

      // Section-specific scroll behavior
      const scrollPattern = this.generateScrollPattern(section.target);

      for (const scroll of scrollPattern) {
        actions.push({
          type: 'scroll',
          value: `${scroll.direction}:${scroll.distancePx}`,
          durationMs: this.randomBetween(50, 200),
          label: scroll.isPause ? 'Scroll + reading pause' : `Scroll ${scroll.direction}`,
          humanize: true,
        });

        actions.push({
          type: 'wait',
          durationMs: scroll.delayAfterMs,
          label: scroll.isPause ? 'Reading pause' : 'Scroll interval',
          humanize: true,
        });

        totalDuration += scroll.delayAfterMs;
      }

      // Click into posts (for listing/subreddit sections)
      if (section.target === 'listing' || section.target === 'subreddit') {
        const postsToClick = this.randomBetween(0, 3);
        for (let i = 0; i < postsToClick; i++) {
          actions.push({
            type: 'click',
            selector: `:nth-child(${i + 1}) > [data-testid="post-container"] a`,
            durationMs: this.randomBetween(100, 400),
            label: `Click into post #${i + 1}`,
            humanize: true,
          });

          actions.push({
            type: 'wait',
            durationMs: this.randomBetween(3000, 10000),
            label: 'Read post content',
            humanize: true,
          });

          // Scroll through comments
          const commentScrolls = this.randomBetween(1, 5);
          for (let j = 0; j < commentScrolls; j++) {
            actions.push({
              type: 'scroll',
              value: 'down:200',
              durationMs: this.randomBetween(50, 150),
              label: 'Scroll through comments',
              humanize: true,
            });
            actions.push({
              type: 'wait',
              durationMs: this.randomBetween(1000, 4000),
              label: 'Read comment',
              humanize: true,
            });
          }

          // Navigate back
          actions.push({
            type: 'keyPress',
            value: 'Alt+ArrowLeft',
            durationMs: this.randomBetween(100, 300),
            label: 'Navigate back',
            humanize: true,
          });
          actions.push({
            type: 'wait',
            durationMs: this.randomBetween(1000, 3000),
            label: 'Back navigation delay',
            humanize: true,
          });
        }
      }

      // Expand collapsed comments (for comment sections)
      if (section.target === 'comments') {
        const expandCount = this.randomBetween(0, 3);
        for (let i = 0; i < expandCount; i++) {
          actions.push({
            type: 'expand',
            selector: `[data-testid="comment"] :nth-child(${i + 1}) [data-click-id="expand"]`,
            durationMs: this.randomBetween(200, 600),
            label: `Expand collapsed comment #${i + 1}`,
            humanize: true,
          });
          actions.push({
            type: 'wait',
            durationMs: this.randomBetween(1500, 5000),
            label: 'Read expanded comment',
            humanize: true,
          });
        }
      }

      // Vote interactions (occasional)
      if (Math.random() < 0.4) {
        const voteDirection = Math.random() < 0.8 ? 'up' : 'down';
        actions.push({
          type: 'vote',
          value: voteDirection,
          selector: voteDirection === 'up'
            ? '[aria-label="upvote"]'
            : '[aria-label="downvote"]',
          durationMs: this.randomBetween(100, 300),
          label: `${voteDirection}vote post`,
          humanize: true,
        });
      }

      // Break period (for long sessions)
      if (Math.random() < config.sessionTiming.breakProbability) {
        const breakDuration = this.randomBetween(
          config.sessionTiming.breakDurationRange.min,
          config.sessionTiming.breakDurationRange.max
        );
        actions.push({
          type: 'wait',
          durationMs: breakDuration,
          label: 'Session break',
          humanize: true,
        });
        totalDuration += breakDuration;
      }
    }

    return {
      sequenceId: `seq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      actions,
      estimatedDurationMs: totalDuration,
      targetSection: sections[0]?.target || 'listing',
      profile,
      generatedAt: Date.now(),
    };
  }

  // ===========================================================================
  // PRIVATE HELPERS — UTILITIES
  // ===========================================================================

  /**
   * Get the maximum realistic scroll distance for a section.
   */
  private getMaxScrollDistance(section: RedditScrapeTarget): number {
    switch (section) {
      case 'listing':
        return 15000;
      case 'comments':
        return 30000;
      case 'search':
        return 8000;
      case 'subreddit':
        return 12000;
      case 'user':
        return 10000;
      case 'post':
        return 5000;
      case 'wiki':
        return 20000;
      default:
        return 10000;
    }
  }

  /**
   * Generate a weighted depth for comment reading.
   * Most comments read are at depth 0-2, deeper comments are rarer.
   */
  private weightedDepth(): number {
    const rand = Math.random();
    if (rand < 0.50) return 0;       // 50% top-level
    if (rand < 0.75) return 1;       // 25% first reply
    if (rand < 0.88) return 2;       // 13% second reply
    if (rand < 0.95) return 3;       // 7% deeper
    if (rand < 0.98) return 4;       // 3% very deep
    return 5;                         // 2% deepest
  }

  /**
   * Get a random search query for simulation.
   */
  private getRandomSearchQuery(): string {
    const queries = [
      'best programming language 2024',
      'reddit api changes',
      'how to learn python',
      'web scraping tips',
      'data science career',
      'machine learning resources',
      'best laptop for coding',
      'home office setup',
      'tech news today',
      'open source projects',
    ];
    return queries[Math.floor(Math.random() * queries.length)];
  }

  /**
   * Generate a random alphanumeric string.
   */
  private randomAlphaNum(length: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
  }

  /**
   * Shuffle an array using Fisher-Yates algorithm.
   */
  private shuffleArray<T>(array: T[]): T[] {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * Generate a random integer between min and max (inclusive).
   */
  private randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const scrollVoter = new ScrollVoter();
