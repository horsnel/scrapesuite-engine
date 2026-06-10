// --- Schema Definition Types --------------------------------------------------

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'url' | 'array' | 'object';

export interface ValidationRule {
  type: 'regex' | 'range' | 'length' | 'enum' | 'custom';
  value: string | number | string[] | ((v: unknown) => boolean);
  message: string;
}

export interface SchemaField {
  name: string; type: FieldType; selector: string; attribute: 'text' | 'html' | 'href' | 'src' | 'content' | 'data-*' | 'title';
  required: boolean; defaultValue?: unknown; validation?: ValidationRule[];
}

export interface ExtractionSchema {
  name: string; domain: string; fields: SchemaField[]; version: string; lastUpdated: string;
}

// --- Helper -------------------------------------------------------------------

const F = (n: string, t: FieldType, s: string, a: SchemaField['attribute'] = 'text', r = true, d?: unknown, v?: ValidationRule[]): SchemaField =>
  ({ name: n, type: t, selector: s, attribute: a, required: r, defaultValue: d, validation: v });

// --- 50+ Pre-Built Extraction Schemas -----------------------------------------

export const SCHEMAS: ExtractionSchema[] = [
  { name: 'amazon-product', domain: 'amazon\\.(com|co\\.uk|de|fr|co\\.jp|ca|com\\.au|in)', version: '2.1.0', lastUpdated: '2025-06-01', fields: [
    F('title', 'string', '#productTitle'), F('price', 'string', '.a-price .a-offscreen'),
    F('originalPrice', 'string', '.a-text-price .a-offscreen', 'text', false),
    F('rating', 'number', '#acrPopover span.a-icon-alt', 'text', false, 0),
    F('reviewCount', 'number', '#acrCustomerReviewText', 'text', false, 0),
    F('availability', 'string', '#availability span', 'text', false), F('brand', 'string', '#bylineInfo', 'text', false),
    F('asin', 'string', 'input[name="ASIN"]', 'content', false), F('images', 'array', '#imageBlock img', 'src', false, []),
    F('description', 'string', '#productDescription', 'html', false), F('features', 'array', '#feature-bullets li span.a-list-item', 'text', false, []),
    F('breadcrumbs', 'array', '#wayfinding-breadcrumbs_container li a', 'text', false, []),
  ]},
  { name: 'google-serp', domain: 'www\\.google\\.(com|co\\.uk|com\\.au|ca|de|fr)', version: '1.4.0', lastUpdated: '2025-05-20', fields: [
    F('query', 'string', 'input[name="q"]', 'content'), F('results', 'array', '.g', 'html', true, []),
    F('resultTitles', 'array', '.g h3', 'text', false, []), F('resultUrls', 'array', '.g a', 'href', false, []),
    F('resultSnippets', 'array', '.g .VwiC3b', 'text', false, []), F('adsCount', 'number', '.commercial-unit', 'html', false, 0),
    F('peopleAlsoAsk', 'array', '.related-question-pair', 'text', false, []), F('totalResults', 'string', '#result-stats', 'text', false),
  ]},
  { name: 'google-shopping', domain: 'www\\.google\\.(com|co\\.uk|com\\.au|ca|de|fr)/shopping', version: '1.2.0', lastUpdated: '2025-05-15', fields: [
    F('productName', 'string', '.sh-nfp__product-title'), F('price', 'string', '.sh-nfp__price'),
    F('seller', 'string', '.sh-nfp__seller-name', 'text', false), F('rating', 'number', '.sh-nfp__rating span', 'text', false, 0),
    F('reviewCount', 'number', '.sh-nfp__review-count', 'text', false, 0), F('image', 'url', '.sh-nfp__image img', 'src', false),
    F('description', 'string', '.sh-nfp__description', 'text', false),
  ]},
  { name: 'twitter-profile', domain: '(twitter|x)\\.com', version: '1.6.0', lastUpdated: '2025-06-01', fields: [
    F('username', 'string', '[data-testid="UserName"]'), F('displayName', 'string', '[data-testid="UserName"] span', 'text', false),
    F('bio', 'string', '[data-testid="UserDescription"]', 'text', false), F('followers', 'number', 'a[href$="/verified_followers"] span', 'text', false, 0),
    F('following', 'number', 'a[href$="/following"] span', 'text', false, 0), F('tweets', 'number', '[data-testid="primaryColumn"] a[href*="/status/"]', 'html', false, 0),
    F('location', 'string', '[data-testid="UserLocation"]', 'text', false), F('website', 'url', '[data-testid="UserUrl"] a', 'href', false),
    F('joinedDate', 'string', '[data-testid="UserJoinDate"]', 'text', false), F('isVerified', 'boolean', '[data-testid="verificationBadge"]', 'html', false, false),
    F('bannerImage', 'url', '[data-testid="placementTracking"] img', 'src', false), F('profileImage', 'url', '[data-testid="TweetAvatar"] img', 'src', false),
  ]},
  { name: 'twitter-tweet', domain: '(twitter|x)\\.com/.+/status/', version: '1.3.0', lastUpdated: '2025-05-28', fields: [
    F('author', 'string', '[data-testid="User-Name"]'), F('handle', 'string', '[data-testid="User-Name"] span', 'text', false),
    F('content', 'string', '[data-testid="tweetText"]'), F('timestamp', 'string', 'time', 'content', false),
    F('likes', 'number', '[data-testid="like"] span', 'text', false, 0), F('retweets', 'number', '[data-testid="retweet"] span', 'text', false, 0),
    F('replies', 'number', '[data-testid="reply"] span', 'text', false, 0), F('views', 'number', 'a[href*="/analytics"] span', 'text', false, 0),
    F('images', 'array', '[data-testid="tweetPhoto"] img', 'src', false, []), F('videos', 'array', 'video', 'src', false, []),
    F('isRetweet', 'boolean', '[data-testid="socialContext"]', 'html', false, false),
  ]},
  { name: 'linkedin-profile', domain: 'www\\.linkedin\\.com/in/', version: '1.5.0', lastUpdated: '2025-05-20', fields: [
    F('fullName', 'string', 'h1'), F('headline', 'string', '.text-body-medium', 'text', false),
    F('location', 'string', '.text-body-small span', 'text', false), F('connections', 'number', 'a[href*="/connections/"] span', 'text', false, 0),
    F('about', 'string', '#about', 'text', false), F('experience', 'array', '#experience .pvs-entity', 'html', false, []),
    F('education', 'array', '#education .pvs-entity', 'html', false, []), F('skills', 'array', '#skills .pvs-entity span', 'text', false, []),
    F('profileImage', 'url', '.pv-top-card img', 'src', false),
  ]},
  { name: 'indeed-job', domain: '(www\\.)?indeed\\.(com|co\\.uk|ca|com\\.au)', version: '1.4.0', lastUpdated: '2025-05-15', fields: [
    F('title', 'string', '.jobsearch-JobInfoHeader-title'), F('company', 'string', '.jobsearch-CompanyInfoContainer a', 'text', false),
    F('location', 'string', '.jobsearch-JobInfoHeader-subtitle span', 'text', false), F('salary', 'string', '.jobsearch-JobMetadataHeader-item .attribute_snippet', 'text', false),
    F('jobType', 'string', '.jobsearch-JobMetadataHeader-item', 'text', false), F('description', 'string', '#jobDescriptionText', 'html'),
    F('postedDate', 'string', '.jobsearch-JobMetadataFooter', 'text', false), F('remote', 'boolean', '.jobsearch-JobMetadataHeader-item', 'html', false, false),
  ]},
  { name: 'zillow-listing', domain: 'www\\.zillow\\.com', version: '1.3.0', lastUpdated: '2025-05-10', fields: [
    F('address', 'string', 'h1'), F('price', 'string', '[data-testid="price"] span'), F('bedrooms', 'number', '[data-testid="bed-bath-beyond"] span:nth-child(1)', 'text', false, 0),
    F('bathrooms', 'number', '[data-testid="bed-bath-beyond"] span:nth-child(2)', 'text', false, 0), F('sqft', 'number', '[data-testid="bed-bath-beyond"] span:nth-child(3)', 'text', false, 0),
    F('homeType', 'string', '[data-testid="home-type"]', 'text', false), F('yearBuilt', 'number', '.ds-home-facts-list-item span', 'text', false, 0),
    F('description', 'string', '[data-testid="description"]', 'text', false), F('images', 'array', '.gallery-container img', 'src', false, []),
    F('agentName', 'string', '.listing-agent span', 'text', false), F('zestimate', 'string', '[data-testid="zestimate"]', 'text', false),
  ]},
  { name: 'ebay-product', domain: '(www\\.)?ebay\\.(com|co\\.uk|de|com\\.au)', version: '1.3.0', lastUpdated: '2025-05-10', fields: [
    F('title', 'string', '#itemTitle'), F('price', 'string', '.x-price-primary'), F('condition', 'string', '#vi-itm-cond', 'text', false),
    F('seller', 'string', '.d-stores-info-categories__container__info__name a', 'text', false), F('sellerFeedback', 'number', '#si-fb', 'text', false, 0),
    F('shipping', 'string', '#shSummary span', 'text', false), F('images', 'array', '#vi_main_img_fs_slider img', 'src', false, []),
    F('itemNumber', 'string', '#descItemNumber', 'text', false), F('description', 'string', '#desc_ifr', 'html', false),
    F('bids', 'number', '#qty-test', 'text', false, 0), F('watchers', 'number', '#watchers', 'text', false, 0),
  ]},
  { name: 'wikipedia-article', domain: '(\\w+\\.)?wikipedia\\.org', version: '1.2.0', lastUpdated: '2025-04-20', fields: [
    F('title', 'string', '#firstHeading'), F('subtitle', 'string', '#mw-content-subtitle', 'text', false),
    F('content', 'string', '#mw-content-text .mw-parser-output', 'html'), F('infobox', 'object', '.infobox', 'html', false),
    F('categories', 'array', '#catlinks a', 'text', false, []), F('lastEdited', 'string', '#footer-info-lastmod', 'text', false),
    F('toc', 'array', '.toc ul li a', 'text', false, []), F('references', 'number', '.references li', 'html', false, 0),
  ]},
  { name: 'youtube-video', domain: '(www\\.)?youtube\\.com', version: '1.5.0', lastUpdated: '2025-06-01', fields: [
    F('title', 'string', 'h1.yt-watch-metadata-title'), F('channel', 'string', '#channel-name a'), F('channelUrl', 'url', '#channel-name a', 'href', false),
    F('views', 'number', '#info span:first-child', 'text', false, 0), F('likes', 'number', '#top-level-buttons-computed #text', 'text', false, 0),
    F('uploadDate', 'string', '#info span:nth-child(3)', 'text', false), F('description', 'string', '#description-inner', 'text', false),
    F('subscribers', 'string', '#owner-sub-count', 'text', false), F('duration', 'string', '.ytp-time-duration', 'text', false),
    F('tags', 'array', 'meta[name="keywords"]', 'content', false, []),
  ]},
  { name: 'reddit-post', domain: '(www\\.)?reddit\\.com', version: '1.4.0', lastUpdated: '2025-05-20', fields: [
    F('title', 'string', '[data-testid="post-container"] h1'), F('author', 'string', '[data-testid="post-author-link"]', 'text', false),
    F('subreddit', 'string', '[data-testid="post-subreddit"]', 'text', false), F('score', 'number', '[data-testid="post-score"]', 'text', false, 0),
    F('upvoteRatio', 'number', '[data-testid="upvote-ratio"]', 'text', false, 0), F('commentCount', 'number', '[data-testid="comment-count"]', 'text', false, 0),
    F('body', 'string', '[data-testid="post-container"] .md', 'text', false), F('flair', 'string', '[data-testid="post-flair"]', 'text', false),
    F('postedAt', 'string', 'time', 'content', false), F('awards', 'number', '[data-testid="awards"]', 'text', false, 0),
    F('imageUrls', 'array', '[data-testid="post-container"] img', 'src', false, []),
  ]},
  { name: 'instagram-profile', domain: 'www\\.instagram\\.com', version: '1.3.0', lastUpdated: '2025-05-15', fields: [
    F('username', 'string', 'h2'), F('fullName', 'string', 'header section h1', 'text', false),
    F('bio', 'string', 'header section span', 'text', false), F('posts', 'number', 'header section li:nth-child(1) span', 'text', false, 0),
    F('followers', 'number', 'header section li:nth-child(2) span', 'text', false, 0), F('following', 'number', 'header section li:nth-child(3) span', 'text', false, 0),
    F('isVerified', 'boolean', '.verified', 'html', false, false), F('profileImage', 'url', 'header img', 'src', false),
    F('externalUrl', 'url', 'header a[href]', 'href', false),
  ]},
  { name: 'yelp-business', domain: 'www\\.yelp\\.(com|co\\.uk)', version: '1.2.0', lastUpdated: '2025-05-10', fields: [
    F('name', 'string', 'h1'), F('rating', 'number', '.five-stars__09f24__mBKfm', 'text', false, 0),
    F('reviewCount', 'number', 'a[href*="/reviews"] span', 'text', false, 0), F('priceRange', 'string', '.priceCategory span', 'text', false),
    F('category', 'string', '.priceCategory a', 'text', false), F('address', 'string', 'address span', 'text', false),
    F('phone', 'string', 'p:has(a[href^="tel:"])', 'text', false), F('website', 'url', 'a[href^="http"]:not([href*="yelp"])', 'href', false),
    F('hours', 'string', '.hours-table', 'text', false), F('images', 'array', '.photo-slideshow img', 'src', false, []),
  ]},
  { name: 'tripadvisor-listing', domain: 'www\\.tripadvisor\\.(com|co\\.uk)', version: '1.2.0', lastUpdated: '2025-04-25', fields: [
    F('name', 'string', 'h1'), F('rating', 'number', '.ui_bubble_rating', 'content', false, 0),
    F('reviewCount', 'number', 'a[href*="/Reviews"] span', 'text', false, 0), F('address', 'string', '[data-testid="detail-address"]', 'text', false),
    F('phone', 'string', '[data-testid="detail-phone"]', 'text', false), F('website', 'url', '[data-testid="detail-link"] a', 'href', false),
    F('priceRange', 'string', '.ui_column span', 'text', false), F('amenities', 'array', '.amenities-list li', 'text', false, []),
    F('description', 'string', '.description', 'text', false),
  ]},
  { name: 'airbnb-listing', domain: 'www\\.airbnb\\.(com|co\\.uk|com\\.au)', version: '1.3.0', lastUpdated: '2025-05-20', fields: [
    F('title', 'string', 'h1'), F('hostName', 'string', '[data-testid="host-profile"] h2', 'text', false),
    F('price', 'string', '[data-testid="price-accordion"] span'), F('rating', 'number', '[data-testid="review-score"] span', 'text', false, 0),
    F('reviewCount', 'number', 'button[href*="/reviews"] span', 'text', false, 0), F('location', 'string', '[data-testid="location-section"] span', 'text', false),
    F('guests', 'number', 'li span', 'text', false, 0), F('bedrooms', 'number', 'li span', 'text', false, 0),
    F('amenities', 'array', '[data-testid="amenities"] li', 'text', false, []), F('images', 'array', 'picture img', 'src', false, []),
  ]},
  { name: 'producthunt-product', domain: '(www\\.)?producthunt\\.com', version: '1.1.0', lastUpdated: '2025-04-15', fields: [
    F('name', 'string', 'h1'), F('tagline', 'string', '[data-testid="tagline"]', 'text', false),
    F('upvotes', 'number', '[data-testid="vote-button"] span', 'text', false, 0), F('comments', 'number', 'a[href*="/comments"] span', 'text', false, 0),
    F('website', 'url', 'a[data-testid="product-link"]', 'href', false), F('makers', 'array', '.makers a', 'text', false, []),
    F('topics', 'array', '.topic-link', 'text', false, []), F('description', 'string', '[data-testid="product-description"]', 'text', false),
  ]},
  { name: 'hackernews-story', domain: 'news\\.ycombinator\\.com', version: '1.1.0', lastUpdated: '2025-04-10', fields: [
    F('title', 'string', '.titleline a'), F('url', 'url', '.titleline a', 'href', false),
    F('points', 'number', '.score', 'text', false, 0), F('author', 'string', '.hnuser', 'text', false),
    F('commentCount', 'number', 'a[href*="item"]:last-child', 'text', false, 0), F('postedAt', 'string', '.age', 'title', false),
  ]},
  { name: 'github-repo', domain: 'github\\.com', version: '1.5.0', lastUpdated: '2025-06-01', fields: [
    F('name', 'string', 'strong[itemprop="name"] a'), F('description', 'string', 'p[data-testid="about-description"]', 'text', false),
    F('stars', 'number', '#repo-stars-counter-star', 'text', false, 0), F('forks', 'number', '#repo-forks-counter-fork', 'text', false, 0),
    F('watching', 'number', '#repo-watchers-counter-watching', 'text', false, 0), F('language', 'string', '[data-testid="language"] span', 'text', false),
    F('license', 'string', '[data-testid="license"] span', 'text', false), F('lastCommit', 'string', 'relative-time', 'content', false),
    F('topics', 'array', '.topic-tag', 'text', false, []), F('isOpenSource', 'boolean', '[data-testid="license"]', 'html', false, false),
  ]},
  { name: 'imdb-movie', domain: 'www\\.imdb\\.com', version: '1.3.0', lastUpdated: '2025-05-10', fields: [
    F('title', 'string', 'h1 span'), F('year', 'number', 'h1 a', 'text', false, 0),
    F('rating', 'number', '[data-testid="hero-rating-bar__aggregate-rating__score"] span', 'text', false, 0),
    F('voteCount', 'number', '[data-testid="hero-rating-bar__aggregate-rating__score"] div', 'text', false, 0),
    F('director', 'string', '[data-testid="title-pc-wide-screen"] li a', 'text', false), F('genres', 'array', '[data-testid="genres"] a span', 'text', false, []),
    F('runtime', 'string', '[data-testid="title-techspec_runtime"] span', 'text', false), F('plot', 'string', '[data-testid="plot-xl"]', 'text', false),
    F('poster', 'url', '[data-testid="hero-media__poster"] img', 'src', false), F('metacritic', 'number', '.metacritic-score span', 'text', false, 0),
  ]},
  { name: 'stackoverflow-question', domain: 'stackoverflow\\.com', version: '1.2.0', lastUpdated: '2025-04-20', fields: [
    F('title', 'string', '#question-header h1'), F('votes', 'number', '.js-vote-count', 'text', false, 0),
    F('answers', 'number', '#answers-header h2 span', 'text', false, 0), F('body', 'string', '.question .js-post-body', 'html'),
    F('tags', 'array', '.post-tag', 'text', false, []), F('author', 'string', '.question .user-details a', 'text', false),
    F('askedDate', 'string', '.question time', 'title', false), F('acceptedAnswer', 'string', '.accepted-answer .js-post-body', 'html', false),
  ]},
  { name: 'medium-article', domain: '(www\\.)?medium\\.com', version: '1.2.0', lastUpdated: '2025-04-20', fields: [
    F('title', 'string', 'h1'), F('author', 'string', '[data-testid="authorName"]', 'text', false),
    F('authorUrl', 'url', '[data-testid="authorName"] a', 'href', false), F('publishedAt', 'string', 'time', 'content', false),
    F('readTime', 'string', 'span span', 'text', false), F('claps', 'number', 'button span', 'text', false, 0),
    F('content', 'string', 'article', 'html'), F('tags', 'array', 'a[href*="/tag/"]', 'text', false, []),
  ]},
  { name: 'cnn-article', domain: '(www\\.)?cnn\\.com', version: '1.1.0', lastUpdated: '2025-04-10', fields: [
    F('title', 'string', 'h1'), F('byline', 'string', '.byline__name', 'text', false), F('publishedAt', 'string', 'time', 'content', false),
    F('updated', 'string', '.timestamp__date', 'text', false), F('content', 'string', '.article__content', 'html'),
    F('section', 'string', '.breadcrumb span', 'text', false), F('imageUrls', 'array', '.article__content img', 'src', false, []),
  ]},
  { name: 'bbc-article', domain: 'www\\.bbc\\.(co\\.uk|com)', version: '1.1.0', lastUpdated: '2025-04-10', fields: [
    F('title', 'string', 'h1'), F('byline', 'string', '[data-testid="byline-name"]', 'text', false), F('publishedAt', 'string', 'time', 'content', false),
    F('content', 'string', '[data-testid="article-body"]', 'html'), F('section', 'string', '[data-testid="section-label"]', 'text', false),
    F('imageUrls', 'array', '[data-testid="article-body"] img', 'src', false, []),
  ]},
  { name: 'booking-hotel', domain: 'www\\.booking\\.com', version: '1.2.0', lastUpdated: '2025-05-10', fields: [
    F('name', 'string', 'h2#hp_hotel_name'), F('rating', 'number', '.bui-review-score__badge', 'text', false, 0),
    F('reviewCount', 'number', '.bui-review-score__text', 'text', false, 0), F('stars', 'number', '.bui-rating span', 'text', false, 0),
    F('address', 'string', '#showOnMap span', 'text', false), F('price', 'string', '.bui-price-display__value', 'text', false),
    F('amenities', 'array', '.hotel-icons li', 'text', false, []), F('description', 'string', '#property_description_content', 'html', false),
    F('images', 'array', '.hotel-gallery img', 'src', false, []),
  ]},
  { name: 'expedia-flight', domain: 'www\\.expedia\\.(com|co\\.uk)', version: '1.1.0', lastUpdated: '2025-04-20', fields: [
    F('airline', 'string', '.uitk-text.uitk-type-500'), F('departureTime', 'string', '[data-testid="departure-time"]', 'text', false),
    F('arrivalTime', 'string', '[data-testid="arrival-time"]', 'text', false), F('duration', 'string', '[data-testid="duration"]', 'text', false),
    F('stops', 'number', '[data-testid="stops"]', 'text', false, 0), F('price', 'string', '.uitk-lockup-price', 'text', false),
    F('origin', 'string', '[data-testid="origin"]', 'text', false), F('destination', 'string', '[data-testid="destination"]', 'text', false),
  ]},
  { name: 'walmart-product', domain: 'www\\.walmart\\.com', version: '1.2.0', lastUpdated: '2025-05-10', fields: [
    F('title', 'string', 'h1'), F('price', 'string', '[data-testid="price-wrap"] span'), F('rating', 'number', '[data-testid="review-ratings"] span', 'text', false, 0),
    F('reviewCount', 'number', '[data-testid="review-count"]', 'text', false, 0), F('seller', 'string', '[data-testid="seller-name"]', 'text', false),
    F('availability', 'string', '[data-testid="availability"]', 'text', false), F('images', 'array', '[data-testid="product-image"] img', 'src', false, []),
    F('description', 'string', '[data-testid="product-description"]', 'html', false), F('itemId', 'string', '[data-testid="product-id"]', 'text', false),
  ]},
  { name: 'target-product', domain: 'www\\.target\\.com', version: '1.1.0', lastUpdated: '2025-04-20', fields: [
    F('title', 'string', 'h1'), F('price', 'string', '[data-test="product-price"]'), F('rating', 'number', '[data-test="ratings-rating"] span', 'text', false, 0),
    F('reviewCount', 'number', '[data-test="ratings-count"]', 'text', false, 0), F('availability', 'string', '[data-test="fulfillment"]', 'text', false),
    F('images', 'array', '[data-test="product-image"] img', 'src', false, []), F('description', 'string', '[data-test="product-description"]', 'html', false),
    F('tcin', 'string', '[data-test="item-tcin"]', 'text', false),
  ]},
  { name: 'etsy-product', domain: 'www\\.etsy\\.com', version: '1.1.0', lastUpdated: '2025-04-15', fields: [
    F('title', 'string', 'h1'), F('price', 'string', '.wt-text-title-01'), F('seller', 'string', '[data-testid="shop-name"] a', 'text', false),
    F('rating', 'number', '[data-testid="review-stars"] span', 'text', false, 0), F('reviewCount', 'number', '[data-testid="review-count"]', 'text', false, 0),
    F('images', 'array', '.image-carousel img', 'src', false, []), F('description', 'string', '#description-text', 'html', false),
    F('tags', 'array', '.tag a', 'text', false, []),
  ]},
  { name: 'shopify-store', domain: '.*\\.myshopify\\.com', version: '1.0.0', lastUpdated: '2025-03-15', fields: [
    F('storeName', 'string', '.site-header__name'), F('productName', 'string', '.product-single__title'),
    F('price', 'string', '.price__regular .price-item', 'text', false), F('comparePrice', 'string', '.price__sale .price-item', 'text', false),
    F('description', 'string', '.product-single__description', 'html', false), F('images', 'array', '.product-single__photo img', 'src', false, []),
    F('variants', 'array', '.variant-selector option', 'text', false, []),
  ]},
  { name: 'aliexpress-product', domain: '(www\\.)?aliexpress\\.(com|us)', version: '1.1.0', lastUpdated: '2025-04-20', fields: [
    F('title', 'string', 'h1'), F('price', 'string', '.product-price-current'), F('originalPrice', 'string', '.product-price-original', 'text', false),
    F('rating', 'number', '.product-rating span', 'text', false, 0), F('orders', 'number', '.product-orders span', 'text', false, 0),
    F('shipping', 'string', '.product-shipping span', 'text', false), F('storeName', 'string', '.store-name a', 'text', false),
    F('images', 'array', '.product-images img', 'src', false, []), F('description', 'string', '.product-description', 'html', false),
  ]},
  { name: 'crunchbase-company', domain: 'www\\.crunchbase\\.com', version: '1.1.0', lastUpdated: '2025-04-15', fields: [
    F('name', 'string', 'h1'), F('description', 'string', '[data-testid="description"]', 'text', false),
    F('founded', 'string', '[data-testid="founded-date"]', 'text', false), F('headquarters', 'string', '[data-testid="headquarters"]', 'text', false),
    F('totalFunding', 'string', '[data-testid="total-funding"]', 'text', false), F('valuation', 'string', '[data-testid="valuation"]', 'text', false),
    F('employees', 'string', '[data-testid="employees"]', 'text', false), F('category', 'string', '[data-testid="categories"]', 'text', false),
    F('website', 'url', '[data-testid="website"] a', 'href', false), F('founders', 'array', '[data-testid="founders"] a', 'text', false, []),
    F('investors', 'array', '[data-testid="investors"] a', 'text', false, []),
  ]},
  { name: 'glassdoor-review', domain: 'www\\.glassdoor\\.(com|co\\.uk)', version: '1.1.0', lastUpdated: '2025-04-10', fields: [
    F('company', 'string', 'h1'), F('overallRating', 'number', '.rating', 'text', false, 0),
    F('reviewCount', 'number', '.review-count', 'text', false, 0), F('pros', 'string', '.pros', 'text', false),
    F('cons', 'string', '.cons', 'text', false), F('authorRole', 'string', '.author-jobtitle', 'text', false),
    F('date', 'string', '.date', 'text', false), F('title', 'string', '.review-title', 'text', false),
  ]},
  { name: 'zillow-agent', domain: 'www\\.zillow\\.com/.*agent', version: '1.0.0', lastUpdated: '2025-03-20', fields: [
    F('name', 'string', 'h1'), F('brokerage', 'string', '[data-testid="brokerage"]', 'text', false),
    F('rating', 'number', '[data-testid="agent-rating"]', 'text', false, 0), F('reviewCount', 'number', '[data-testid="review-count"]', 'text', false, 0),
    F('salesCount', 'number', '[data-testid="sales-count"]', 'text', false, 0), F('specialties', 'array', '[data-testid="specialties"] li', 'text', false, []),
    F('areas', 'array', '[data-testid="service-areas"] li', 'text', false, []), F('phone', 'string', '[data-testid="phone"]', 'text', false),
    F('photo', 'url', '[data-testid="agent-photo"] img', 'src', false),
  ]},
  { name: 'redfin-listing', domain: 'www\\.redfin\\.com', version: '1.1.0', lastUpdated: '2025-04-20', fields: [
    F('address', 'string', 'h1'), F('price', 'string', '.stats .price'), F('beds', 'number', '.stats .beds', 'text', false, 0),
    F('baths', 'number', '.stats .baths', 'text', false, 0), F('sqft', 'number', '.stats .sqft', 'text', false, 0),
    F('pricePerSqft', 'string', '.stats .price-sqft', 'text', false), F('yearBuilt', 'number', '.key-details li', 'text', false, 0),
    F('propertyType', 'string', '.key-details li', 'text', false), F('mls', 'string', '.mls-number', 'text', false),
    F('description', 'string', '.remarks', 'text', false), F('images', 'array', '.gallery img', 'src', false, []),
  ]},
  { name: 'realtor-listing', domain: 'www\\.realtor\\.com', version: '1.1.0', lastUpdated: '2025-04-15', fields: [
    F('address', 'string', 'h1'), F('price', 'string', '[data-testid="list-price"]'),
    F('beds', 'number', '[data-testid="beds"]', 'text', false, 0), F('baths', 'number', '[data-testid="baths"]', 'text', false, 0),
    F('sqft', 'number', '[data-testid="sqft"]', 'text', false, 0), F('propertyType', 'string', '[data-testid="property-type"]', 'text', false),
    F('listingAgent', 'string', '[data-testid="listing-agent"]', 'text', false), F('description', 'string', '[data-testid="description"]', 'html', false),
    F('images', 'array', '[data-testid="gallery"] img', 'src', false, []),
  ]},
  { name: 'indeed-company', domain: '(www\\.)?indeed\\.(com|co\\.uk|ca)/cmp/', version: '1.0.0', lastUpdated: '2025-03-20', fields: [
    F('name', 'string', 'h1'), F('rating', 'number', '.rating-number', 'text', false, 0),
    F('reviewCount', 'number', '.review-count', 'text', false, 0), F('industry', 'string', '[data-testid="industry"]', 'text', false),
    F('size', 'string', '[data-testid="size"]', 'text', false), F('headquarters', 'string', '[data-testid="headquarters"]', 'text', false),
    F('founded', 'string', '[data-testid="founded"]', 'text', false), F('website', 'url', '[data-testid="company-website"]', 'href', false),
    F('openJobs', 'number', '[data-testid="open-jobs"]', 'text', false, 0),
  ]},
  { name: 'glassdoor-salary', domain: 'www\\.glassdoor\\.(com|co\\.uk)/Salary/', version: '1.0.0', lastUpdated: '2025-03-20', fields: [
    F('jobTitle', 'string', 'h1'), F('company', 'string', '.employer-name', 'text', false),
    F('avgBasePay', 'string', '.avg-base-pay', 'text', false), F('rangeLow', 'string', '.range-low', 'text', false),
    F('rangeHigh', 'string', '.range-high', 'text', false), F('totalComp', 'string', '.total-comp', 'text', false),
    F('location', 'string', '.location', 'text', false),
  ]},
  { name: 'forbes-article', domain: 'www\\.forbes\\.com', version: '1.0.0', lastUpdated: '2025-03-15', fields: [
    F('title', 'string', 'h1'), F('author', 'string', '[data-testid="author-name"]', 'text', false),
    F('publishedAt', 'string', 'time', 'content', false), F('content', 'string', '.article-body', 'html'),
    F('category', 'string', '[data-testid="category"]', 'text', false), F('imageUrls', 'array', '.article-body img', 'src', false, []),
  ]},
  { name: 'techcrunch-article', domain: 'techcrunch\\.com', version: '1.0.0', lastUpdated: '2025-03-15', fields: [
    F('title', 'string', 'h1'), F('author', 'string', '.article__byline a', 'text', false),
    F('publishedAt', 'string', 'time', 'content', false), F('content', 'string', '.article-content', 'html'),
    F('tags', 'array', '.article__tags a', 'text', false, []), F('imageUrls', 'array', '.article-content img', 'src', false, []),
  ]},
  { name: 'nytimes-article', domain: 'www\\.nytimes\\.com', version: '1.1.0', lastUpdated: '2025-04-10', fields: [
    F('title', 'string', 'h1'), F('byline', 'string', '.byline', 'text', false), F('publishedAt', 'string', 'time', 'content', false),
    F('content', 'string', '[data-testid="story-body"]', 'html'), F('section', 'string', '[data-testid="section-label"]', 'text', false),
    F('imageUrls', 'array', '[data-testid="story-body"] img', 'src', false, []),
  ]},
  { name: 'espn-score', domain: 'www\\.espn\\.com', version: '1.0.0', lastUpdated: '2025-03-15', fields: [
    F('homeTeam', 'string', '.home-team .team-name'), F('awayTeam', 'string', '.away-team .team-name'),
    F('homeScore', 'number', '.home-team .score', 'text', false, 0), F('awayScore', 'number', '.away-team .score', 'text', false, 0),
    F('gameStatus', 'string', '.game-status', 'text', false), F('date', 'string', '.game-date', 'text', false), F('venue', 'string', '.venue', 'text', false),
  ]},
  { name: 'weather-data', domain: 'weather\\.com|www\\.accuweather\\.com|www\\.wunderground\\.com', version: '1.0.0', lastUpdated: '2025-03-10', fields: [
    F('location', 'string', 'h1'), F('temperature', 'number', '.temperature span'), F('condition', 'string', '.condition', 'text', false),
    F('humidity', 'number', '.humidity span', 'text', false, 0), F('windSpeed', 'string', '.wind-speed span', 'text', false),
    F('windDirection', 'string', '.wind-direction', 'text', false), F('pressure', 'string', '.pressure span', 'text', false),
    F('visibility', 'string', '.visibility span', 'text', false), F('uvIndex', 'number', '.uv-index span', 'text', false, 0),
    F('feelsLike', 'number', '.feels-like span', 'text', false, 0),
  ]},
  { name: 'crypto-price', domain: 'www\\.coinmarketcap\\.com|www\\.coingecko\\.com', version: '1.1.0', lastUpdated: '2025-04-20', fields: [
    F('name', 'string', 'h1 span'), F('symbol', 'string', '.name-symbol', 'text', false), F('price', 'string', '.priceValue span'),
    F('marketCap', 'string', '[data-testid="market-cap"]', 'text', false), F('volume24h', 'string', '[data-testid="volume-24h"]', 'text', false),
    F('change24h', 'string', '[data-testid="change-24h"]', 'text', false), F('change7d', 'string', '[data-testid="change-7d"]', 'text', false),
    F('rank', 'number', '.rank span', 'text', false, 0), F('circulatingSupply', 'string', '[data-testid="circulating-supply"]', 'text', false),
  ]},
  { name: 'stock-quote', domain: 'finance\\.yahoo\\.com|www\\.nasdaq\\.com|www\\.marketwatch\\.com', version: '1.1.0', lastUpdated: '2025-05-10', fields: [
    F('symbol', 'string', 'h1 span'), F('name', 'string', 'h1', 'text', false), F('price', 'string', '[data-testid="price"] span'),
    F('change', 'string', '[data-testid="change"]', 'text', false), F('changePercent', 'string', '[data-testid="change-percent"]', 'text', false),
    F('open', 'string', '[data-testid="open"]', 'text', false), F('high', 'string', '[data-testid="high"]', 'text', false),
    F('low', 'string', '[data-testid="low"]', 'text', false), F('volume', 'string', '[data-testid="volume"]', 'text', false),
    F('marketCap', 'string', '[data-testid="market-cap"]', 'text', false), F('peRatio', 'number', '[data-testid="pe-ratio"]', 'text', false, 0),
    F('dividend', 'string', '[data-testid="dividend"]', 'text', false),
  ]},
  { name: 'news-rss', domain: '.*', version: '1.0.0', lastUpdated: '2025-03-10', fields: [
    F('title', 'string', 'title'), F('link', 'url', 'link', 'href'), F('description', 'string', 'description', 'text', false),
    F('pubDate', 'date', 'pubDate', 'text', false), F('author', 'string', 'dc\\:creator', 'text', false),
    F('category', 'string', 'category', 'text', false), F('content', 'string', 'content\\:encoded', 'html', false),
    F('enclosureUrl', 'url', 'enclosure', 'src', false),
  ]},
  { name: 'generic-article', domain: '.*', version: '1.2.0', lastUpdated: '2025-05-01', fields: [
    F('title', 'string', 'h1'), F('author', 'string', '[rel="author"], .author, .byline, [data-testid="author"]', 'text', false),
    F('publishedAt', 'string', 'time, [datetime], .date, .published-date', 'content', false),
    F('content', 'string', 'article, .article-body, .post-content, .entry-content, main', 'html'),
    F('description', 'string', 'meta[name="description"]', 'content', false),
    F('image', 'url', 'article img, .article-body img, meta[property="og:image"]', 'src', false),
    F('tags', 'array', '.tags a, .categories a, a[rel="tag"]', 'text', false, []), F('wordCount', 'number', 'article', 'html', false, 0),
  ]},
  { name: 'generic-product', domain: '.*', version: '1.2.0', lastUpdated: '2025-05-01', fields: [
    F('name', 'string', 'h1, [data-testid="product-name"], .product-title'), F('price', 'string', '.price, [data-testid="price"], .product-price', 'text', false),
    F('originalPrice', 'string', '.original-price, .compare-price, .was-price', 'text', false),
    F('description', 'string', '.description, [data-testid="description"]', 'html', false),
    F('image', 'url', '.product-image img, [data-testid="product-image"] img', 'src', false),
    F('rating', 'number', '.rating, [data-testid="rating"]', 'text', false, 0), F('reviewCount', 'number', '.review-count, [data-testid="review-count"]', 'text', false, 0),
    F('availability', 'string', '.availability, .stock-status', 'text', false), F('sku', 'string', '.sku, [data-testid="sku"]', 'text', false),
  ]},
  { name: 'generic-listing', domain: '.*', version: '1.1.0', lastUpdated: '2025-04-15', fields: [
    F('title', 'string', 'h1, .listing-title'), F('price', 'string', '.price, .listing-price', 'text', false),
    F('location', 'string', '.location, .listing-location', 'text', false), F('description', 'string', '.description, .listing-description', 'html', false),
    F('image', 'url', '.listing-image img, .gallery img', 'src', false), F('datePosted', 'string', '.date, .listing-date', 'text', false),
    F('seller', 'string', '.seller, .listing-seller', 'text', false), F('contact', 'string', '.contact, .listing-contact', 'text', false),
  ]},
  { name: 'generic-profile', domain: '.*', version: '1.1.0', lastUpdated: '2025-04-15', fields: [
    F('name', 'string', 'h1, .profile-name'), F('bio', 'string', '.bio, .profile-bio, [data-testid="bio"]', 'text', false),
    F('avatar', 'url', '.profile-avatar img, .avatar img', 'src', false), F('location', 'string', '.location, .profile-location', 'text', false),
    F('website', 'url', '.website a, .profile-website a', 'href', false), F('followers', 'number', '.followers, .profile-followers', 'text', false, 0),
    F('following', 'number', '.following, .profile-following', 'text', false, 0), F('joinDate', 'string', '.join-date, .profile-join-date', 'text', false),
  ]},
  { name: 'patent-doc', domain: 'patents\\.google\\.com|patft\\.uspto\\.gov', version: '1.0.0', lastUpdated: '2025-04-01', fields: [
    F('title', 'string', 'h1, .title'), F('patentNumber', 'string', '.patent-number', 'text', false),
    F('filingDate', 'string', '.filing-date, [itemprop="filingDate"]', 'text', false),
    F('publicationDate', 'string', '.publication-date, [itemprop="publicationDate"]', 'text', false),
    F('inventors', 'array', '[itemprop="inventor"] name, .inventor', 'text', false, []),
    F('assignee', 'string', '[itemprop="assignee"] name, .assignee', 'text', false),
    F('abstract', 'string', '.abstract, [itemprop="abstract"]', 'text', false),
    F('claims', 'number', '.claim', 'html', false, 0),
    F('citations', 'number', '.citation', 'html', false, 0),
  ]},
  { name: 'recipe-page', domain: '.*', version: '1.0.0', lastUpdated: '2025-04-01', fields: [
    F('name', 'string', 'h1, [itemprop="name"]'), F('author', 'string', '[itemprop="author"]', 'text', false),
    F('prepTime', 'string', '[itemprop="prepTime"], .prep-time', 'text', false),
    F('cookTime', 'string', '[itemprop="cookTime"], .cook-time', 'text', false),
    F('totalTime', 'string', '[itemprop="totalTime"], .total-time', 'text', false),
    F('servings', 'number', '[itemprop="recipeYield"], .servings', 'text', false, 0),
    F('calories', 'number', '[itemprop="nutrition"] .calories', 'text', false, 0),
    F('ingredients', 'array', '[itemprop="ingredients"], .ingredient li', 'text', false, []),
    F('instructions', 'array', '[itemprop="recipeInstructions"] li, .instruction li', 'text', false, []),
    F('rating', 'number', '[itemprop="aggregateRating"]', 'text', false, 0),
    F('image', 'url', '[itemprop="image"] img, .recipe-image img', 'src', false),
  ]},
  { name: 'event-page', domain: '.*', version: '1.0.0', lastUpdated: '2025-04-01', fields: [
    F('name', 'string', 'h1, [itemprop="name"]'), F('startDate', 'string', '[itemprop="startDate"]', 'content', false),
    F('endDate', 'string', '[itemprop="endDate"]', 'content', false),
    F('location', 'string', '[itemprop="location"]', 'text', false),
    F('address', 'string', '[itemprop="address"]', 'text', false),
    F('description', 'string', '[itemprop="description"], .event-description', 'html', false),
    F('organizer', 'string', '[itemprop="organizer"]', 'text', false),
    F('price', 'string', '[itemprop="offers"] .price', 'text', false),
    F('availability', 'string', '[itemprop="availability"]', 'content', false),
    F('image', 'url', '[itemprop="image"] img, .event-image img', 'src', false),
  ]},
];

// --- Schema Lookup Utilities --------------------------------------------------

const schemaMap = new Map(SCHEMAS.map((s) => [s.name, s]));

/** Look up a schema by its exact name. */
export function getSchemaByName(name: string): ExtractionSchema | undefined {
  return schemaMap.get(name);
}

/** Find all schemas whose domain regex matches the given URL. */
export function getSchemasForUrl(url: string): ExtractionSchema[] {
  let hostname: string;
  try { hostname = new URL(url).hostname; } catch { return []; }
  const pathname = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
  return SCHEMAS.filter((s) => {
    try { return new RegExp(s.domain, 'i').test(hostname + pathname); } catch { return false; }
  });
}

/** Return the best-matching schema for a URL (first specific match wins). */
export function detectSchemaForUrl(url: string): ExtractionSchema | undefined {
  const matches = getSchemasForUrl(url);
  // Prefer specific schemas over catch-all (domain === '.*') schemas
  const specific = matches.find((s) => s.domain !== '.*');
  return specific ?? matches[0];
}

/** Get all schema names. */
export function getAllSchemaNames(): string[] {
  return SCHEMAS.map((s) => s.name);
}

/** Get schemas grouped by category (product, article, listing, profile, financial, etc.). */
export function getSchemasByCategory(): Record<string, ExtractionSchema[]> {
  const categories: Record<string, string[]> = {
    product: ['amazon-product', 'ebay-product', 'walmart-product', 'target-product', 'etsy-product',
      'shopify-store', 'aliexpress-product', 'generic-product'],
    article: ['wikipedia-article', 'medium-article', 'cnn-article', 'bbc-article', 'forbes-article',
      'techcrunch-article', 'nytimes-article', 'generic-article'],
    social: ['twitter-profile', 'twitter-tweet', 'reddit-post', 'instagram-profile', 'hackernews-story',
      'generic-profile'],
    professional: ['linkedin-profile', 'indeed-job', 'indeed-company', 'glassdoor-review', 'glassdoor-salary',
      'crunchbase-company', 'stackoverflow-question', 'github-repo'],
    realEstate: ['zillow-listing', 'zillow-agent', 'redfin-listing', 'realtor-listing', 'generic-listing'],
    travel: ['booking-hotel', 'airbnb-listing', 'tripadvisor-listing', 'expedia-flight', 'yelp-business'],
    financial: ['crypto-price', 'stock-quote'],
    media: ['youtube-video', 'imdb-movie', 'producthunt-product', 'espn-score'],
    search: ['google-serp', 'google-shopping'],
    data: ['weather-data', 'news-rss', 'patent-doc', 'recipe-page', 'event-page'],
  };
  const result: Record<string, ExtractionSchema[]> = {};
  for (const [cat, names] of Object.entries(categories)) {
    result[cat] = names.map((n) => schemaMap.get(n)).filter((s): s is ExtractionSchema => s !== undefined);
  }
  return result;
}

/** Get the total count of schemas. */
export function getSchemaCount(): number {
  return SCHEMAS.length;
}
