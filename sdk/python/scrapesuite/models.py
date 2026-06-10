"""
ScrapeSuite Python SDK — Pydantic Models
=========================================

Request and response models for the ScrapeSuite API. All models use
Pydantic v2 for validation, serialization, and IDE auto-completion.

Every request model follows the pattern:

    <Action>Request  — payload sent TO the API
    <Action>Response — payload received FROM the API

Additional shared models (``ScrapeOptions``, ``Session``, ``Monitor``,
etc.) represent reusable domain objects.
"""

from __future__ import annotations

import base64
from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator


# =====================================================================
# SHARED / REUSABLE MODELS
# =====================================================================


class ScrapeOptions(BaseModel):
    """Options that control how a scrape request is executed.

    All fields are optional — the server applies sensible defaults when
    a value is not provided.
    """

    strategy: Optional[str] = Field(
        default=None,
        description=(
            "Scraping strategy: 'auto', 'static', 'dynamic', or 'stealth'."
        ),
    )
    proxy_tier: Optional[str] = Field(
        default=None,
        description="Proxy tier: 'datacenter', 'residential', or 'mobile'.",
    )
    proxy_country: Optional[str] = Field(
        default=None,
        description="ISO 3166-1 alpha-2 country code for geo-targeted proxy.",
    )
    render_js: Optional[bool] = Field(
        default=None,
        description="Whether to render JavaScript on the page.",
    )
    solve_captcha: Optional[bool] = Field(
        default=None,
        description="Whether to automatically solve CAPTCHAs.",
    )
    output_format: Optional[str] = Field(
        default=None,
        description="Output format: 'markdown', 'html', 'text', or 'raw'.",
    )
    wait_for_selector: Optional[str] = Field(
        default=None,
        description="CSS selector to wait for before returning content.",
    )
    timeout: Optional[float] = Field(
        default=None,
        gt=0,
        description="Per-request timeout in seconds.",
    )
    extract: Optional[str] = Field(
        default=None,
        description="Natural-language extraction instruction.",
    )
    template_id: Optional[str] = Field(
        default=None,
        description="ID of a pre-defined extraction template.",
    )
    session_id: Optional[str] = Field(
        default=None,
        description="Sticky session ID for consistent proxy IP.",
    )


class ScreenshotOptions(BaseModel):
    """Options for screenshot requests."""

    full_page: Optional[bool] = Field(
        default=None,
        description="Capture the full scrollable page (default: False).",
    )
    width: Optional[int] = Field(
        default=None,
        ge=320,
        le=3840,
        description="Viewport width in pixels.",
    )
    height: Optional[int] = Field(
        default=None,
        ge=240,
        le=2160,
        description="Viewport height in pixels.",
    )
    format: Optional[str] = Field(
        default=None,
        description="Image format: 'png' or 'jpeg'.",
    )
    quality: Optional[int] = Field(
        default=None,
        ge=1,
        le=100,
        description="JPEG quality (1-100). Only applies when format is 'jpeg'.",
    )
    selector: Optional[str] = Field(
        default=None,
        description="CSS selector of the element to screenshot.",
    )
    proxy_country: Optional[str] = Field(
        default=None,
        description="ISO country code for geo-targeted proxy.",
    )
    wait_for_selector: Optional[str] = Field(
        default=None,
        description="CSS selector to wait for before capturing.",
    )
    timeout: Optional[float] = Field(
        default=None,
        gt=0,
        description="Request timeout in seconds.",
    )


class CrawlOptions(BaseModel):
    """Options for website crawling requests."""

    max_depth: Optional[int] = Field(
        default=None,
        ge=1,
        le=10,
        description="Maximum crawl depth (default: 2).",
    )
    max_pages: Optional[int] = Field(
        default=None,
        ge=1,
        le=10000,
        description="Maximum pages to crawl (default: 100).",
    )
    include_patterns: Optional[List[str]] = Field(
        default=None,
        description="URL glob patterns to include.",
    )
    exclude_patterns: Optional[List[str]] = Field(
        default=None,
        description="URL glob patterns to exclude.",
    )
    strategy: Optional[str] = Field(
        default=None,
        description="Scraping strategy for each page.",
    )
    proxy_tier: Optional[str] = Field(
        default=None,
        description="Proxy tier for each page.",
    )
    proxy_country: Optional[str] = Field(
        default=None,
        description="Country for geo-targeted proxy.",
    )
    render_js: Optional[bool] = Field(
        default=None,
        description="Whether to render JavaScript.",
    )
    output_format: Optional[str] = Field(
        default=None,
        description="Output format for each page.",
    )
    timeout: Optional[float] = Field(
        default=None,
        gt=0,
        description="Total crawl timeout in seconds.",
    )


# =====================================================================
# SESSION MODELS
# =====================================================================


class Session(BaseModel):
    """A sticky proxy session that maintains the same IP across requests."""

    session_id: str = Field(description="Unique session identifier.")
    proxy_ip: Optional[str] = Field(default=None, description="Current proxy IP address.")
    proxy_tier: Optional[str] = Field(default=None, description="Proxy tier.")
    proxy_country: Optional[str] = Field(default=None, description="Proxy country code.")
    created_at: Optional[datetime] = Field(default=None, description="Session creation time.")
    expires_at: Optional[datetime] = Field(default=None, description="Session expiration time.")
    ttl: Optional[int] = Field(default=None, description="Time-to-live in seconds.")
    requests_made: Optional[int] = Field(default=None, description="Number of requests made in this session.")
    max_requests: Optional[int] = Field(default=None, description="Max requests before rotation.")
    status: Optional[str] = Field(default=None, description="Session status: 'active', 'expired', or 'revoked'.")


class SessionListResponse(BaseModel):
    """Paginated list of active sessions."""

    sessions: List[Session] = Field(default_factory=list)
    total: int = Field(default=0, description="Total number of active sessions.")
    limit: int = Field(default=50)
    offset: int = Field(default=0)


class CreateSessionRequest(BaseModel):
    """Request payload for creating a sticky proxy session."""

    proxy_tier: Optional[str] = Field(
        default=None,
        description="Proxy tier: 'datacenter', 'residential', or 'mobile'.",
    )
    proxy_country: Optional[str] = Field(
        default=None,
        description="ISO country code for the proxy location.",
    )
    ttl: Optional[int] = Field(
        default=None,
        ge=60,
        le=86400,
        description="Session time-to-live in seconds (60-86400).",
    )
    max_requests: Optional[int] = Field(
        default=None,
        ge=1,
        description="Maximum requests before session rotates.",
    )


# =====================================================================
# SCRAPE REQUEST / RESPONSE
# =====================================================================


class ScrapeRequest(BaseModel):
    """Request payload for a single-URL scrape."""

    url: str = Field(description="The URL to scrape.")
    options: Optional[ScrapeOptions] = Field(
        default=None,
        description="Scraping options.",
    )


class ScrapeData(BaseModel):
    """Scraped content and metadata."""

    url: str = Field(description="The scraped URL.")
    markdown: Optional[str] = Field(default=None, description="Page content as Markdown.")
    html: Optional[str] = Field(default=None, description="Page content as HTML.")
    text: Optional[str] = Field(default=None, description="Page content as plain text.")
    raw: Optional[str] = Field(default=None, description="Raw response body.")
    status_code: Optional[int] = Field(default=None, description="HTTP status code from the target.")
    title: Optional[str] = Field(default=None, description="Page title.")
    description: Optional[str] = Field(default=None, description="Meta description.")
    links: Optional[List[str]] = Field(default=None, description="Links found on the page.")
    images: Optional[List[str]] = Field(default=None, description="Image URLs found on the page.")
    metadata: Optional[Dict[str, Any]] = Field(default=None, description="Additional page metadata.")


class ScrapeResponse(BaseModel):
    """Response from a single-URL scrape request."""

    success: bool = Field(description="Whether the scrape was successful.")
    url: str = Field(description="The URL that was scraped.")
    status: Optional[str] = Field(default=None, description="Scrape status: 'success', 'error', or 'timeout'.")
    data: Optional[ScrapeData] = Field(default=None, description="Scraped content.")
    extraction: Optional[Dict[str, Any]] = Field(
        default=None,
        description="AI-extracted data (only present when 'extract' option is used).",
    )
    error: Optional[str] = Field(default=None, description="Error message if the scrape failed.")
    credits_used: Optional[float] = Field(default=None, description="Credits consumed by this request.")
    proxy_ip: Optional[str] = Field(default=None, description="Proxy IP used for the request.")
    latency_ms: Optional[float] = Field(default=None, description="Request latency in milliseconds.")
    timestamp: Optional[datetime] = Field(default=None, description="Response timestamp.")


# =====================================================================
# BATCH SCRAPE
# =====================================================================


class BatchScrapeRequest(BaseModel):
    """Request payload for batch scraping."""

    urls: List[str] = Field(
        min_length=1,
        max_length=100,
        description="List of URLs to scrape (1-100).",
    )
    options: Optional[ScrapeOptions] = Field(default=None, description="Shared scraping options.")
    concurrency: Optional[int] = Field(
        default=None,
        ge=1,
        le=20,
        description="Maximum parallel scraping tasks on the server (1-20).",
    )


class BatchScrapeResponse(BaseModel):
    """Response from a batch scrape request."""

    success: bool = Field(description="Whether the batch completed (individual results may still have errors).")
    results: List[ScrapeResponse] = Field(
        default_factory=list,
        description="Individual scrape results for each URL.",
    )
    total: int = Field(default=0, description="Total URLs in the batch.")
    completed: int = Field(default=0, description="Number of successfully scraped URLs.")
    failed: int = Field(default=0, description="Number of failed scrapes.")
    credits_used: Optional[float] = Field(default=None, description="Total credits consumed.")
    latency_ms: Optional[float] = Field(default=None, description="Total batch latency in milliseconds.")


# =====================================================================
# SCREENSHOT
# =====================================================================


class ScreenshotResponse(BaseModel):
    """Response from a screenshot request."""

    success: bool = Field(description="Whether the screenshot was captured.")
    url: str = Field(description="The URL that was screenshotted.")
    image: Optional[str] = Field(
        default=None,
        description="Base64-encoded screenshot image data.",
    )
    format: Optional[str] = Field(default=None, description="Image format ('png' or 'jpeg').")
    width: Optional[int] = Field(default=None, description="Viewport width in pixels.")
    height: Optional[int] = Field(default=None, description="Viewport height in pixels.")
    size_bytes: Optional[int] = Field(default=None, description="Image size in bytes.")
    credits_used: Optional[float] = Field(default=None, description="Credits consumed.")
    proxy_ip: Optional[str] = Field(default=None, description="Proxy IP used.")
    latency_ms: Optional[float] = Field(default=None, description="Request latency in milliseconds.")
    error: Optional[str] = Field(default=None, description="Error message if capture failed.")

    @property
    def image_bytes(self) -> Optional[bytes]:
        """Decode the base64 image data into raw bytes.

        Returns
        -------
        bytes | None
            The decoded image bytes, or ``None`` if no image data.
        """
        if self.image is None:
            return None
        return base64.b64decode(self.image)


# =====================================================================
# CRAWL
# =====================================================================


class CrawlPage(BaseModel):
    """A single page discovered during a crawl."""

    url: str = Field(description="Page URL.")
    depth: int = Field(default=0, description="Crawl depth (0 = starting page).")
    status: Optional[str] = Field(default=None, description="Scrape status.")
    title: Optional[str] = Field(default=None, description="Page title.")
    markdown: Optional[str] = Field(default=None, description="Page content as Markdown.")
    html: Optional[str] = Field(default=None, description="Page content as HTML.")
    status_code: Optional[int] = Field(default=None, description="HTTP status code.")
    links: Optional[List[str]] = Field(default=None, description="Outgoing links found on the page.")
    error: Optional[str] = Field(default=None, description="Error message if scraping this page failed.")


class CrawlResponse(BaseModel):
    """Response from a website crawl request."""

    success: bool = Field(description="Whether the crawl completed.")
    url: str = Field(description="Starting URL.")
    pages: List[CrawlPage] = Field(
        default_factory=list,
        description="All crawled pages.",
    )
    total_pages: int = Field(default=0, description="Total pages crawled.")
    max_depth_reached: Optional[int] = Field(default=None, description="Maximum depth reached.")
    credits_used: Optional[float] = Field(default=None, description="Credits consumed.")
    latency_ms: Optional[float] = Field(default=None, description="Total crawl latency in milliseconds.")
    error: Optional[str] = Field(default=None, description="Error message if the crawl failed.")


# =====================================================================
# EXTRACT / PARSE
# =====================================================================


class ExtractRequest(BaseModel):
    """Request payload for AI-powered data extraction."""

    html: str = Field(description="Raw HTML content to extract from.")
    instruction: str = Field(description="Natural-language extraction instruction.")
    url: Optional[str] = Field(
        default=None,
        description="Source URL for context.",
    )


class ExtractResponse(BaseModel):
    """Response from AI-powered extraction."""

    success: bool = Field(description="Whether extraction succeeded.")
    data: Optional[Dict[str, Any]] = Field(default=None, description="Extracted structured data.")
    raw_response: Optional[str] = Field(default=None, description="Raw AI response text.")
    credits_used: Optional[float] = Field(default=None, description="Credits consumed.")
    latency_ms: Optional[float] = Field(default=None, description="Extraction latency in milliseconds.")
    error: Optional[str] = Field(default=None, description="Error message if extraction failed.")


class ParseStructuredRequest(BaseModel):
    """Request payload for structured data parsing."""

    html: str = Field(description="Raw HTML content to parse.")
    parser: str = Field(
        default="auto",
        description="Parser: 'auto', 'article', 'product', 'recipe', 'job', 'event', or 'custom'.",
    )
    url: Optional[str] = Field(default=None, description="Source URL for context.")


class ParseStructuredResponse(BaseModel):
    """Response from structured data parsing."""

    success: bool = Field(description="Whether parsing succeeded.")
    parser: Optional[str] = Field(default=None, description="Parser that was used (may differ from request).")
    data: Optional[Dict[str, Any]] = Field(default=None, description="Parsed structured data.")
    schema_type: Optional[str] = Field(default=None, description="Detected or applied schema type.")
    credits_used: Optional[float] = Field(default=None, description="Credits consumed.")
    latency_ms: Optional[float] = Field(default=None, description="Parsing latency in milliseconds.")
    error: Optional[str] = Field(default=None, description="Error message if parsing failed.")


# =====================================================================
# SERP
# =====================================================================


class SerpRequest(BaseModel):
    """Request payload for search engine results."""

    query: str = Field(description="Search query string.")
    engine: str = Field(
        default="google",
        description="Search engine: 'google', 'bing', or 'duckduckgo'.",
    )
    num: Optional[int] = Field(default=None, ge=1, le=100, description="Number of results (1-100).")
    start: Optional[int] = Field(default=None, ge=0, description="Pagination offset (0-based).")
    geo: Optional[str] = Field(default=None, description="Geographic location for results.")
    language: Optional[str] = Field(default=None, description="Language code for results.")
    safe: Optional[bool] = Field(default=None, description="Enable safe search.")
    period: Optional[str] = Field(
        default=None,
        description="Time period filter: 'day', 'week', 'month', 'year', or None.",
    )
    proxy_country: Optional[str] = Field(default=None, description="Country for geo-targeted proxy.")


class OrganicResult(BaseModel):
    """A single organic search result."""

    position: int = Field(description="Result position (1-based).")
    title: str = Field(description="Result title.")
    url: str = Field(description="Result URL.")
    snippet: Optional[str] = Field(default=None, description="Result snippet / description.")
    date: Optional[str] = Field(default=None, description="Published date, if available.")
    sitelinks: Optional[List[Dict[str, str]]] = Field(default=None, description="Sitelinks.")


class FeaturedSnippet(BaseModel):
    """A featured snippet / direct answer from the search engine."""

    title: Optional[str] = Field(default=None)
    snippet: Optional[str] = Field(default=None)
    url: Optional[str] = Field(default=None)


class SerpResponse(BaseModel):
    """Response from a SERP API request."""

    success: bool = Field(description="Whether the search was successful.")
    query: str = Field(description="The search query that was executed.")
    engine: str = Field(default="google", description="Search engine used.")
    organic: List[OrganicResult] = Field(
        default_factory=list,
        description="Organic search results.",
    )
    featured_snippet: Optional[FeaturedSnippet] = Field(
        default=None,
        description="Featured snippet (if present).",
    )
    ads: Optional[List[Dict[str, Any]]] = Field(
        default=None,
        description="Paid ad results.",
    )
    related_searches: Optional[List[str]] = Field(
        default=None,
        description="Related search queries.",
    )
    total_results: Optional[int] = Field(
        default=None,
        description="Estimated total number of results.",
    )
    credits_used: Optional[float] = Field(default=None, description="Credits consumed.")
    proxy_ip: Optional[str] = Field(default=None, description="Proxy IP used.")
    latency_ms: Optional[float] = Field(default=None, description="Request latency in milliseconds.")


# =====================================================================
# MONITOR
# =====================================================================


class Monitor(BaseModel):
    """A web page monitor that tracks changes over time."""

    monitor_id: str = Field(description="Unique monitor identifier.")
    name: Optional[str] = Field(default=None, description="Human-readable monitor name.")
    url: str = Field(description="Monitored URL.")
    fields: List[str] = Field(default_factory=list, description="Fields being tracked.")
    schedule: Optional[str] = Field(default=None, description="Cron schedule or interval string.")
    status: Optional[str] = Field(default=None, description="Monitor status: 'active', 'paused', or 'error'.")
    proxy_tier: Optional[str] = Field(default=None, description="Proxy tier used for checks.")
    proxy_country: Optional[str] = Field(default=None, description="Country for geo-targeted proxy.")
    webhook_id: Optional[str] = Field(default=None, description="Webhook triggered on changes.")
    alert_email: Optional[str] = Field(default=None, description="Email for change alerts.")
    last_check: Optional[datetime] = Field(default=None, description="Last check timestamp.")
    last_change: Optional[datetime] = Field(default=None, description="Last detected change timestamp.")
    created_at: Optional[datetime] = Field(default=None, description="Monitor creation time.")
    credits_per_check: Optional[float] = Field(default=None, description="Credits consumed per check.")
    check_count: Optional[int] = Field(default=None, description="Total checks performed.")


class MonitorListResponse(BaseModel):
    """Paginated list of monitors."""

    monitors: List[Monitor] = Field(default_factory=list)
    total: int = Field(default=0, description="Total number of monitors.")
    limit: int = Field(default=50)
    offset: int = Field(default=0)


class CreateMonitorRequest(BaseModel):
    """Request payload for creating a monitor."""

    url: str = Field(description="URL to monitor.")
    fields: List[str] = Field(min_length=1, description="Field names or CSS selectors to track.")
    schedule: str = Field(description="Cron schedule or simple interval (e.g. '5m', '1h', '1d').")
    name: Optional[str] = Field(default=None, description="Human-readable monitor name.")
    proxy_tier: Optional[str] = Field(default=None, description="Proxy tier.")
    proxy_country: Optional[str] = Field(default=None, description="Country for geo-targeted proxy.")
    webhook_id: Optional[str] = Field(default=None, description="Webhook ID for change notifications.")
    alert_email: Optional[str] = Field(default=None, description="Email for alerts.")
    css_selector: Optional[str] = Field(default=None, description="CSS selector to scope monitoring.")
    render_js: Optional[bool] = Field(default=None, description="Whether to render JavaScript.")
    timeout: Optional[float] = Field(default=None, gt=0, description="Per-check timeout in seconds.")


class MonitorTestResponse(BaseModel):
    """Response from testing a monitor check."""

    success: bool = Field(description="Whether the test check succeeded.")
    monitor_id: str = Field(description="Monitor ID that was tested.")
    values: Optional[Dict[str, Any]] = Field(default=None, description="Current field values.")
    error: Optional[str] = Field(default=None, description="Error message if the test failed.")


# =====================================================================
# WEBHOOK
# =====================================================================


class Webhook(BaseModel):
    """A webhook endpoint for receiving event notifications."""

    webhook_id: str = Field(description="Unique webhook identifier.")
    name: Optional[str] = Field(default=None, description="Human-readable webhook name.")
    url: str = Field(description="Webhook endpoint URL.")
    events: List[str] = Field(default_factory=list, description="Subscribed event types.")
    secret: Optional[str] = Field(default=None, description="Signing secret for verifying payloads.")
    headers: Optional[Dict[str, str]] = Field(default=None, description="Custom HTTP headers.")
    active: Optional[bool] = Field(default=None, description="Whether the webhook is active.")
    created_at: Optional[datetime] = Field(default=None, description="Webhook creation time.")
    last_delivery: Optional[datetime] = Field(default=None, description="Last successful delivery time.")
    delivery_count: Optional[int] = Field(default=None, description="Total deliveries attempted.")
    failure_count: Optional[int] = Field(default=None, description="Total failed deliveries.")


class WebhookListResponse(BaseModel):
    """Paginated list of webhooks."""

    webhooks: List[Webhook] = Field(default_factory=list)
    total: int = Field(default=0, description="Total number of webhooks.")
    limit: int = Field(default=50)
    offset: int = Field(default=0)


class CreateWebhookRequest(BaseModel):
    """Request payload for creating a webhook."""

    url: str = Field(description="Webhook endpoint URL.")
    events: List[str] = Field(
        min_length=1,
        description="Event types to subscribe to.",
    )
    name: Optional[str] = Field(default=None, description="Human-readable name.")
    secret: Optional[str] = Field(default=None, description="Signing secret for verification.")
    headers: Optional[Dict[str, str]] = Field(default=None, description="Custom HTTP headers.")
    active: Optional[bool] = Field(default=None, description="Whether the webhook is active.")


class WebhookTestResponse(BaseModel):
    """Response from testing a webhook delivery."""

    success: bool = Field(description="Whether the test delivery was successful.")
    webhook_id: str = Field(description="Webhook ID that was tested.")
    status_code: Optional[int] = Field(default=None, description="HTTP status code from the endpoint.")
    response_time_ms: Optional[float] = Field(default=None, description="Response time in milliseconds.")
    error: Optional[str] = Field(default=None, description="Error message if delivery failed.")


# =====================================================================
# PROXY STATS
# =====================================================================


class GeoDistribution(BaseModel):
    """Proxy count by geographic region."""

    country: str = Field(description="ISO country code.")
    count: int = Field(default=0, description="Number of proxies in this country.")


class ProxyStats(BaseModel):
    """Statistics about the ScrapeSuite proxy pool."""

    total_ips: int = Field(default=0, description="Total effective IP addresses across all sources.")
    active_proxies: int = Field(default=0, description="Currently active/healthy proxies.")
    datacenter_count: int = Field(default=0, description="Datacenter proxy count.")
    residential_count: int = Field(default=0, description="Residential proxy count.")
    mobile_count: int = Field(default=0, description="Mobile proxy count.")
    tor_count: int = Field(default=0, description="TOR exit node count.")
    geo_distribution: List[GeoDistribution] = Field(
        default_factory=list,
        description="Proxy count by country.",
    )
    avg_latency_ms: Optional[float] = Field(default=None, description="Average proxy latency.")
    success_rate: Optional[float] = Field(default=None, description="Overall proxy success rate (0-1).")
    uptime_24h: Optional[float] = Field(default=None, description="24-hour uptime percentage (0-100).")


# =====================================================================
# COST ESTIMATION
# =====================================================================


class CostEstimateRequest(BaseModel):
    """Request payload for cost estimation."""

    url: str = Field(description="The URL to estimate.")
    strategy: Optional[str] = Field(default=None, description="Scraping strategy.")
    proxy_tier: Optional[str] = Field(default=None, description="Proxy tier.")
    render_js: Optional[bool] = Field(default=None, description="Whether JS rendering is needed.")
    solve_captcha: Optional[bool] = Field(default=None, description="Whether CAPTCHA solving is needed.")
    output_format: Optional[str] = Field(default=None, description="Desired output format.")


class CostBreakdown(BaseModel):
    """Detailed cost breakdown for a request."""

    base: float = Field(default=0.0, description="Base scraping cost.")
    proxy: float = Field(default=0.0, description="Proxy cost (varies by tier).")
    js_rendering: float = Field(default=0.0, description="JavaScript rendering cost.")
    captcha: float = Field(default=0.0, description="CAPTCHA solving cost.")
    extraction: float = Field(default=0.0, description="AI extraction cost.")
    total: float = Field(default=0.0, description="Total estimated credits.")


class CostEstimate(BaseModel):
    """Estimated cost for a scrape request."""

    url: str = Field(description="Estimated URL.")
    credits: CostBreakdown = Field(default_factory=CostBreakdown, description="Credit breakdown.")
    total_credits: float = Field(default=0.0, description="Total estimated credits.")
    estimated_latency_ms: Optional[float] = Field(
        default=None,
        description="Estimated request latency in milliseconds.",
    )
    note: Optional[str] = Field(
        default=None,
        description="Additional notes about the estimate.",
    )
