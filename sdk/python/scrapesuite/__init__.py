"""
ScrapeSuite Python SDK
======================

The official Python SDK for the ScrapeSuite API. Scrape the web with just
a few lines of Python -- powered by a 10M+ IP proxy pool, AI extraction,
CAPTCHA solving, and headless browser orchestration.

Quick Start
-----------
>>> from scrapesuite import ScrapeSuiteClient
>>> client = ScrapeSuiteClient(api_key="ss_live_...")
>>>
>>> # Synchronous usage (default)
>>> result = client.scrape("https://example.com")
>>> print(result.data.markdown)
>>>
>>> # Asynchronous usage
>>> import asyncio
>>> async def main():
...     async with ScrapeSuiteClient(api_key="ss_live_...") as client:
...         result = await client.scrape("https://example.com")
...         print(result.data.markdown)
>>> asyncio.run(main())

Features
--------
- Synchronous and asynchronous API via ``httpx``
- Automatic retry with exponential backoff
- Rate-limit awareness (respects ``X-RateLimit-*`` headers)
- Streaming batch results
- Playwright CDP browser integration
- Full type hints and Pydantic models
- Comprehensive error hierarchy

Copyright (c) 2026 ScrapeSuite. All rights reserved.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager, contextmanager
from typing import (
    Any,
    AsyncIterator,
    Dict,
    Generator,
    Iterator,
    List,
    Optional,
    Sequence,
    Tuple,
    Type,
    TypeVar,
    Union,
)

import httpx

from .models import (
    BatchScrapeRequest,
    BatchScrapeResponse,
    CostEstimate,
    CostEstimateRequest,
    CrawlOptions,
    CrawlResponse,
    CreateMonitorRequest,
    CreateSessionRequest,
    CreateWebhookRequest,
    ExtractRequest,
    ExtractResponse,
    Monitor,
    MonitorListResponse,
    MonitorTestResponse,
    ParseStructuredRequest,
    ParseStructuredResponse,
    ProxyStats,
    ScrapeOptions,
    ScrapeRequest,
    ScrapeResponse,
    ScreenshotOptions,
    ScreenshotResponse,
    Session,
    SessionListResponse,
    SerpRequest,
    SerpResponse,
    Webhook,
    WebhookListResponse,
    WebhookTestResponse,
)

__version__ = "1.0.0"
__all__ = [
    # Client
    "ScrapeSuiteClient",
    # Errors
    "ScrapeSuiteError",
    "AuthenticationError",
    "RateLimitError",
    "QuotaExceededError",
    "ScrapingError",
    "ValidationError",
    "ServerError",
    "TimeoutError",
    # Version
    "__version__",
]

logger = logging.getLogger("scrapesuite")

T = TypeVar("T")

# ---------------------------------------------------------------------------
# Default configuration
# ---------------------------------------------------------------------------

_DEFAULT_BASE_URL = "https://api.scrapesuite.dev"
_DEFAULT_TIMEOUT = 120.0
_DEFAULT_MAX_RETRIES = 3
_DEFAULT_BACKOFF_BASE = 0.5  # seconds
_DEFAULT_RETRYABLE_STATUS = {429, 500, 502, 503, 504}
_USER_AGENT = f"scrapesuite-python/{__version__}"


# ---------------------------------------------------------------------------
# Error hierarchy
# ---------------------------------------------------------------------------


class ScrapeSuiteError(Exception):
    """Base exception for all ScrapeSuite SDK errors.

    Attributes
    ----------
    status_code : int | None
        HTTP status code from the API response, if available.
    headers : dict
        Response headers (useful for rate-limit introspection).
    body : Any
        Parsed response body, if available.
    """

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        headers: Optional[Dict[str, str]] = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.headers = headers or {}
        self.body = body

    def __repr__(self) -> str:
        return (
            f"{self.__class__.__name__}(message={self.args[0]!r}, "
            f"status_code={self.status_code})"
        )


class AuthenticationError(ScrapeSuiteError):
    """Raised when the API key is missing, invalid, or revoked (401/403)."""

    pass


class RateLimitError(ScrapeSuiteError):
    """Raised when the API rate limit has been exceeded (429).

    Inspect ``self.headers`` for ``X-RateLimit-Reset`` to know when
    the limit window resets.
    """

    @property
    def retry_after(self) -> Optional[float]:
        """Seconds until the rate-limit window resets (from headers)."""
        val = self.headers.get("retry-after") or self.headers.get("Retry-After")
        if val is not None:
            try:
                return float(val)
            except (ValueError, TypeError):
                pass
        reset = self.headers.get("X-RateLimit-Reset")
        if reset:
            try:
                return max(0.0, float(reset) - time.time())
            except (ValueError, TypeError):
                pass
        return None


class QuotaExceededError(ScrapeSuiteError):
    """Raised when the account credit/quota has been exhausted (402)."""

    pass


class ScrapingError(ScrapeSuiteError):
    """Raised when the scraping engine could not complete the request.

    This typically indicates that the target site returned unexpected
    content, blocked the request, or timed out.
    """

    pass


class ValidationError(ScrapeSuiteError):
    """Raised when request parameters fail validation (400)."""

    pass


class ServerError(ScrapeSuiteError):
    """Raised for 5xx server-side errors that are not retryable."""

    pass


class TimeoutError(ScrapeSuiteError):
    """Raised when a request exceeds the configured timeout."""

    pass


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _raise_for_status(response: httpx.Response) -> None:
    """Translate HTTP error codes into typed ScrapeSuite exceptions."""
    code = response.status_code
    if 200 <= code < 300:
        return

    try:
        body = response.json()
    except Exception:
        body = response.text

    headers = dict(response.headers)

    if code == 401 or code == 403:
        raise AuthenticationError(
            f"Authentication failed (HTTP {code}). Check your API key.",
            status_code=code,
            headers=headers,
            body=body,
        )
    if code == 402:
        raise QuotaExceededError(
            f"Quota exceeded (HTTP {code}). Upgrade your plan or add credits.",
            status_code=code,
            headers=headers,
            body=body,
        )
    if code == 429:
        raise RateLimitError(
            f"Rate limit exceeded (HTTP {code}). Slow down or increase your plan.",
            status_code=code,
            headers=headers,
            body=body,
        )
    if code == 400:
        raise ValidationError(
            f"Validation error (HTTP {code}). {body}",
            status_code=code,
            headers=headers,
            body=body,
        )
    if code == 408:
        raise TimeoutError(
            f"Request timed out (HTTP {code}). Try increasing the timeout parameter.",
            status_code=code,
            headers=headers,
            body=body,
        )
    if 500 <= code < 600:
        raise ServerError(
            f"Server error (HTTP {code}). Please retry later.",
            status_code=code,
            headers=headers,
            body=body,
        )
    # Generic fallback
    raise ScrapeSuiteError(
        f"Unexpected HTTP {code}: {body}",
        status_code=code,
        headers=headers,
        body=body,
    )


def _build_headers(api_key: str, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Build standard request headers."""
    headers: Dict[str, str] = {
        "Authorization": f"Bearer {api_key}",
        "User-Agent": _USER_AGENT,
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if extra:
        headers.update(extra)
    return headers


class _RateLimitState:
    """Track rate-limit headers and pause automatically."""

    def __init__(self) -> None:
        self.remaining: Optional[int] = None
        self.limit: Optional[int] = None
        self.reset_at: Optional[float] = None

    def update(self, headers: Dict[str, str]) -> None:
        """Update state from response headers."""
        if "X-RateLimit-Remaining" in headers:
            try:
                self.remaining = int(headers["X-RateLimit-Remaining"])
            except (ValueError, TypeError):
                pass
        if "X-RateLimit-Limit" in headers:
            try:
                self.limit = int(headers["X-RateLimit-Limit"])
            except (ValueError, TypeError):
                pass
        if "X-RateLimit-Reset" in headers:
            try:
                self.reset_at = float(headers["X-RateLimit-Reset"])
            except (ValueError, TypeError):
                pass

    def maybe_wait(self) -> None:
        """Synchronous sleep if we're approaching the rate limit."""
        if self.remaining is not None and self.remaining <= 1 and self.reset_at:
            wait = max(0.0, self.reset_at - time.time() + 0.5)
            if wait > 0:
                logger.info("Rate limit near; sleeping %.1fs", wait)
                time.sleep(wait)

    async def maybe_wait_async(self) -> None:
        """Asynchronous sleep if we're approaching the rate limit."""
        if self.remaining is not None and self.remaining <= 1 and self.reset_at:
            wait = max(0.0, self.reset_at - time.time() + 0.5)
            if wait > 0:
                logger.info("Rate limit near; sleeping %.1fs", wait)
                await asyncio.sleep(wait)


# ---------------------------------------------------------------------------
# ScrapeSuiteClient
# ---------------------------------------------------------------------------


class ScrapeSuiteClient:
    """Official Python client for the ScrapeSuite API.

    Parameters
    ----------
    api_key : str
        Your ScrapeSuite API key (starts with ``ss_live_`` or ``ss_test_``).
    base_url : str, optional
        API base URL. Defaults to ``https://api.scrapesuite.dev``.
        Override for self-hosted instances.
    timeout : float, optional
        Default request timeout in seconds. Defaults to ``120``.
    max_retries : int, optional
        Maximum number of automatic retries for transient failures.
        Defaults to ``3``.
    backoff_base : float, optional
        Base delay in seconds for exponential backoff. Defaults to ``0.5``.
    async_mode : bool, optional
        If ``True``, the client uses async ``httpx.AsyncClient`` under the
        hood and all methods become coroutines. Defaults to ``False``.

    Examples
    --------
    **Synchronous:**

    >>> client = ScrapeSuiteClient(api_key="ss_live_abc123")
    >>> result = client.scrape("https://news.ycombinator.com")

    **Asynchronous:**

    >>> async with ScrapeSuiteClient(api_key="ss_live_abc123", async_mode=True) as client:
    ...     result = await client.scrape("https://news.ycombinator.com")
    """

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    def __init__(
        self,
        api_key: str,
        base_url: str = _DEFAULT_BASE_URL,
        timeout: float = _DEFAULT_TIMEOUT,
        max_retries: int = _DEFAULT_MAX_RETRIES,
        backoff_base: float = _DEFAULT_BACKOFF_BASE,
        async_mode: bool = False,
    ) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_retries = max_retries
        self._backoff_base = backoff_base
        self._async_mode = async_mode
        self._rate_limit = _RateLimitState()

        # Lazy-initialised HTTP clients
        self._sync_client: Optional[httpx.Client] = None
        self._async_client: Optional[httpx.AsyncClient] = None

    # ------------------------------------------------------------------
    # Context-manager support
    # ------------------------------------------------------------------

    def __enter__(self) -> "ScrapeSuiteClient":
        if self._async_mode:
            raise RuntimeError(
                "Use 'async with' for async-mode clients, not 'with'."
            )
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    async def __aenter__(self) -> "ScrapeSuiteClient":
        if not self._async_mode:
            raise RuntimeError(
                "Use 'with' for sync-mode clients, not 'async with'."
            )
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    # ------------------------------------------------------------------
    # HTTP client lifecycle
    # ------------------------------------------------------------------

    @property
    def sync_client(self) -> httpx.Client:
        """Lazily create the synchronous httpx.Client."""
        if self._sync_client is None:
            self._sync_client = httpx.Client(
                base_url=self._base_url,
                headers=_build_headers(self._api_key),
                timeout=httpx.Timeout(self._timeout, connect=15.0),
                follow_redirects=True,
            )
        return self._sync_client

    @property
    def async_client(self) -> httpx.AsyncClient:
        """Lazily create the asynchronous httpx.AsyncClient."""
        if self._async_client is None:
            self._async_client = httpx.AsyncClient(
                base_url=self._base_url,
                headers=_build_headers(self._api_key),
                timeout=httpx.Timeout(self._timeout, connect=15.0),
                follow_redirects=True,
            )
        return self._async_client

    def close(self) -> None:
        """Close the synchronous HTTP client."""
        if self._sync_client is not None:
            self._sync_client.close()
            self._sync_client = None

    async def aclose(self) -> None:
        """Close the asynchronous HTTP client."""
        if self._async_client is not None:
            await self._async_client.aclose()
            self._async_client = None

    # ------------------------------------------------------------------
    # Internal request methods (retry + rate-limit aware)
    # ------------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> httpx.Response:
        """Synchronous request with automatic retry and rate-limit awareness.

        Parameters
        ----------
        method : str
            HTTP method (GET, POST, PUT, DELETE, PATCH).
        path : str
            API endpoint path (e.g. ``/v1/scrape``).
        json_body : dict, optional
            JSON request body.
        params : dict, optional
            Query-string parameters.
        extra_headers : dict, optional
            Additional headers to merge.

        Returns
        -------
        httpx.Response
            The successful HTTP response.

        Raises
        ------
        ScrapeSuiteError
            On non-retryable API errors.
        RateLimitError
            When retries are exhausted after 429 responses.
        TimeoutError
            When the request exceeds the configured timeout.
        """
        last_exc: Optional[Exception] = None

        for attempt in range(self._max_retries + 1):
            self._rate_limit.maybe_wait()

            try:
                headers = _build_headers(self._api_key, extra_headers)
                resp = self.sync_client.request(
                    method,
                    path,
                    json=json_body,
                    params=params,
                    headers=headers,
                )
                self._rate_limit.update(dict(resp.headers))

                # Retryable status?
                if resp.status_code in _DEFAULT_RETRYABLE_STATUS and attempt < self._max_retries:
                    delay = self._backoff_base * (2 ** attempt)
                    # If server gave Retry-After, honour it
                    retry_after = resp.headers.get("Retry-After")
                    if retry_after:
                        try:
                            delay = float(retry_after)
                        except (ValueError, TypeError):
                            pass
                    logger.warning(
                        "Retrying %s %s (HTTP %d, attempt %d/%d) in %.1fs",
                        method,
                        path,
                        resp.status_code,
                        attempt + 1,
                        self._max_retries,
                        delay,
                    )
                    time.sleep(delay)
                    continue

                _raise_for_status(resp)
                return resp

            except httpx.TimeoutException as exc:
                last_exc = exc
                if attempt < self._max_retries:
                    delay = self._backoff_base * (2 ** attempt)
                    logger.warning(
                        "Timeout on %s %s (attempt %d/%d), retrying in %.1fs",
                        method,
                        path,
                        attempt + 1,
                        self._max_retries,
                        delay,
                    )
                    time.sleep(delay)
                    continue
                raise TimeoutError(
                    f"Request to {path} timed out after {self._timeout}s "
                    f"and {self._max_retries} retries."
                ) from exc

            except httpx.ConnectError as exc:
                last_exc = exc
                if attempt < self._max_retries:
                    delay = self._backoff_base * (2 ** attempt)
                    logger.warning(
                        "Connection error on %s %s (attempt %d/%d), retrying in %.1fs",
                        method,
                        path,
                        attempt + 1,
                        self._max_retries,
                        delay,
                    )
                    time.sleep(delay)
                    continue
                raise ScrapeSuiteError(
                    f"Connection error for {path}: {exc}"
                ) from exc

        # Should not reach here, but just in case
        raise ScrapeSuiteError(f"Failed after {self._max_retries} retries: {last_exc}")

    async def _arequest(
        self,
        method: str,
        path: str,
        *,
        json_body: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> httpx.Response:
        """Asynchronous request with automatic retry and rate-limit awareness.

        Parameters
        ----------
        method : str
            HTTP method (GET, POST, PUT, DELETE, PATCH).
        path : str
            API endpoint path (e.g. ``/v1/scrape``).
        json_body : dict, optional
            JSON request body.
        params : dict, optional
            Query-string parameters.
        extra_headers : dict, optional
            Additional headers to merge.

        Returns
        -------
        httpx.Response
            The successful HTTP response.

        Raises
        ------
        ScrapeSuiteError
            On non-retryable API errors.
        RateLimitError
            When retries are exhausted after 429 responses.
        TimeoutError
            When the request exceeds the configured timeout.
        """
        last_exc: Optional[Exception] = None

        for attempt in range(self._max_retries + 1):
            await self._rate_limit.maybe_wait_async()

            try:
                headers = _build_headers(self._api_key, extra_headers)
                resp = await self.async_client.request(
                    method,
                    path,
                    json=json_body,
                    params=params,
                    headers=headers,
                )
                self._rate_limit.update(dict(resp.headers))

                # Retryable status?
                if resp.status_code in _DEFAULT_RETRYABLE_STATUS and attempt < self._max_retries:
                    delay = self._backoff_base * (2 ** attempt)
                    retry_after = resp.headers.get("Retry-After")
                    if retry_after:
                        try:
                            delay = float(retry_after)
                        except (ValueError, TypeError):
                            pass
                    logger.warning(
                        "Retrying %s %s (HTTP %d, attempt %d/%d) in %.1fs",
                        method,
                        path,
                        resp.status_code,
                        attempt + 1,
                        self._max_retries,
                        delay,
                    )
                    await asyncio.sleep(delay)
                    continue

                _raise_for_status(resp)
                return resp

            except httpx.TimeoutException as exc:
                last_exc = exc
                if attempt < self._max_retries:
                    delay = self._backoff_base * (2 ** attempt)
                    logger.warning(
                        "Timeout on %s %s (attempt %d/%d), retrying in %.1fs",
                        method,
                        path,
                        attempt + 1,
                        self._max_retries,
                        delay,
                    )
                    await asyncio.sleep(delay)
                    continue
                raise TimeoutError(
                    f"Request to {path} timed out after {self._timeout}s "
                    f"and {self._max_retries} retries."
                ) from exc

            except httpx.ConnectError as exc:
                last_exc = exc
                if attempt < self._max_retries:
                    delay = self._backoff_base * (2 ** attempt)
                    logger.warning(
                        "Connection error on %s %s (attempt %d/%d), retrying in %.1fs",
                        method,
                        path,
                        attempt + 1,
                        self._max_retries,
                        delay,
                    )
                    await asyncio.sleep(delay)
                    continue
                raise ScrapeSuiteError(
                    f"Connection error for {path}: {exc}"
                ) from exc

        raise ScrapeSuiteError(f"Failed after {self._max_retries} retries: {last_exc}")

    # ==================================================================
    # SCRAPING METHODS
    # ==================================================================

    def scrape(
        self,
        url: str,
        *,
        strategy: Optional[str] = None,
        proxy_tier: Optional[str] = None,
        proxy_country: Optional[str] = None,
        render_js: Optional[bool] = None,
        solve_captcha: Optional[bool] = None,
        output_format: Optional[str] = None,
        wait_for_selector: Optional[str] = None,
        timeout: Optional[float] = None,
        extract: Optional[str] = None,
        template_id: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> ScrapeResponse:
        """Scrape a single URL and return structured data.

        Parameters
        ----------
        url : str
            The URL to scrape.
        strategy : str, optional
            Scraping strategy: ``"auto"``, ``"static"``, ``"dynamic"``,
            or ``"stealth"``. Default is ``"auto"``.
        proxy_tier : str, optional
            Proxy tier: ``"datacenter"``, ``"residential"``, or
            ``"mobile"``. Default is ``"datacenter"``.
        proxy_country : str, optional
            ISO 3166-1 alpha-2 country code for geo-targeted proxies
            (e.g. ``"us"``, ``"de"``, ``"jp"``).
        render_js : bool, optional
            Whether to render JavaScript. Default is ``True`` for
            ``"dynamic"`` and ``"stealth"`` strategies.
        solve_captcha : bool, optional
            Whether to automatically solve CAPTCHAs. Default is ``False``.
        output_format : str, optional
            Desired output format: ``"markdown"``, ``"html"``,
            ``"text"``, or ``"raw"``. Default is ``"markdown"``.
        wait_for_selector : str, optional
            CSS selector to wait for before returning content.
        timeout : float, optional
            Per-request timeout in seconds (overrides client default).
        extract : str, optional
            Natural-language extraction instruction. When provided, the
            response will include an ``extraction`` field with AI-extracted
            data.
        template_id : str, optional
            ID of a pre-defined extraction template.
        session_id : str, optional
            Sticky session ID for consistent proxy IP across requests.

        Returns
        -------
        ScrapeResponse
            Parsed response containing scraped content, metadata, and
            optional extraction results.

        Raises
        ------
        AuthenticationError
            If the API key is invalid.
        ScrapingError
            If the target site could not be scraped.
        QuotaExceededError
            If the account has insufficient credits.

        Examples
        --------
        >>> result = client.scrape(
        ...     "https://example.com",
        ...     strategy="stealth",
        ...     proxy_country="us",
        ...     render_js=True,
        ... )
        >>> print(result.data.markdown)
        """
        options = ScrapeOptions(
            strategy=strategy,
            proxy_tier=proxy_tier,
            proxy_country=proxy_country,
            render_js=render_js,
            solve_captcha=solve_captcha,
            output_format=output_format,
            wait_for_selector=wait_for_selector,
            timeout=timeout,
            extract=extract,
            template_id=template_id,
            session_id=session_id,
        )
        payload = ScrapeRequest(url=url, options=options)
        body = payload.model_dump(exclude_none=True)

        resp = self._request("POST", "/v1/scrape", json_body=body)
        return ScrapeResponse.model_validate(resp.json())

    async def ascrape(
        self,
        url: str,
        *,
        strategy: Optional[str] = None,
        proxy_tier: Optional[str] = None,
        proxy_country: Optional[str] = None,
        render_js: Optional[bool] = None,
        solve_captcha: Optional[bool] = None,
        output_format: Optional[str] = None,
        wait_for_selector: Optional[str] = None,
        timeout: Optional[float] = None,
        extract: Optional[str] = None,
        template_id: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> ScrapeResponse:
        """Asynchronously scrape a single URL.

        See :meth:`scrape` for parameter documentation.
        """
        options = ScrapeOptions(
            strategy=strategy,
            proxy_tier=proxy_tier,
            proxy_country=proxy_country,
            render_js=render_js,
            solve_captcha=solve_captcha,
            output_format=output_format,
            wait_for_selector=wait_for_selector,
            timeout=timeout,
            extract=extract,
            template_id=template_id,
            session_id=session_id,
        )
        payload = ScrapeRequest(url=url, options=options)
        body = payload.model_dump(exclude_none=True)

        resp = await self._arequest("POST", "/v1/scrape", json_body=body)
        return ScrapeResponse.model_validate(resp.json())

    # ------------------------------------------------------------------
    # Batch scrape
    # ------------------------------------------------------------------

    def scrape_batch(
        self,
        urls: Sequence[str],
        *,
        strategy: Optional[str] = None,
        proxy_tier: Optional[str] = None,
        proxy_country: Optional[str] = None,
        render_js: Optional[bool] = None,
        solve_captcha: Optional[bool] = None,
        output_format: Optional[str] = None,
        timeout: Optional[float] = None,
        concurrency: Optional[int] = None,
    ) -> BatchScrapeResponse:
        """Batch scrape up to 100 URLs in a single request.

        Parameters
        ----------
        urls : Sequence[str]
            List of URLs to scrape (max 100).
        strategy : str, optional
            Scraping strategy applied to all URLs.
        proxy_tier : str, optional
            Proxy tier for all URLs.
        proxy_country : str, optional
            Geo-targeted country for all URLs.
        render_js : bool, optional
            Whether to render JavaScript.
        solve_captcha : bool, optional
            Whether to solve CAPTCHAs.
        output_format : str, optional
            Output format for all URLs.
        timeout : float, optional
            Per-URL timeout.
        concurrency : int, optional
            Maximum parallel scraping tasks on the server (1-20).

        Returns
        -------
        BatchScrapeResponse
            Contains a list of individual :class:`ScrapeResponse` objects.

        Raises
        ------
        ValidationError
            If more than 100 URLs are provided.

        Examples
        --------
        >>> urls = ["https://a.com", "https://b.com", "https://c.com"]
        >>> results = client.scrape_batch(urls, strategy="stealth")
        >>> for r in results.results:
        ...     print(r.url, r.status)
        """
        if len(urls) > 100:
            raise ValidationError("Batch scrape supports a maximum of 100 URLs.")

        options = ScrapeOptions(
            strategy=strategy,
            proxy_tier=proxy_tier,
            proxy_country=proxy_country,
            render_js=render_js,
            solve_captcha=solve_captcha,
            output_format=output_format,
            timeout=timeout,
        )
        payload = BatchScrapeRequest(
            urls=list(urls),
            options=options,
            concurrency=concurrency,
        )
        body = payload.model_dump(exclude_none=True)

        resp = self._request("POST", "/v1/scrape/batch", json_body=body)
        return BatchScrapeResponse.model_validate(resp.json())

    async def ascrape_batch(
        self,
        urls: Sequence[str],
        *,
        strategy: Optional[str] = None,
        proxy_tier: Optional[str] = None,
        proxy_country: Optional[str] = None,
        render_js: Optional[bool] = None,
        solve_captcha: Optional[bool] = None,
        output_format: Optional[str] = None,
        timeout: Optional[float] = None,
        concurrency: Optional[int] = None,
    ) -> BatchScrapeResponse:
        """Asynchronously batch scrape up to 100 URLs.

        See :meth:`scrape_batch` for parameter documentation.
        """
        if len(urls) > 100:
            raise ValidationError("Batch scrape supports a maximum of 100 URLs.")

        options = ScrapeOptions(
            strategy=strategy,
            proxy_tier=proxy_tier,
            proxy_country=proxy_country,
            render_js=render_js,
            solve_captcha=solve_captcha,
            output_format=output_format,
            timeout=timeout,
        )
        payload = BatchScrapeRequest(
            urls=list(urls),
            options=options,
            concurrency=concurrency,
        )
        body = payload.model_dump(exclude_none=True)

        resp = await self._arequest("POST", "/v1/scrape/batch", json_body=body)
        return BatchScrapeResponse.model_validate(resp.json())

    # ------------------------------------------------------------------
    # Screenshot
    # ------------------------------------------------------------------

    def screenshot(
        self,
        url: str,
        *,
        full_page: Optional[bool] = None,
        width: Optional[int] = None,
        height: Optional[int] = None,
        format: Optional[str] = None,
        quality: Optional[int] = None,
        selector: Optional[str] = None,
        proxy_country: Optional[str] = None,
        wait_for_selector: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> ScreenshotResponse:
        """Take a screenshot of a web page.

        Parameters
        ----------
        url : str
            URL to screenshot.
        full_page : bool, optional
            Capture the full scrollable page. Default is ``False``
            (viewport only).
        width : int, optional
            Viewport width in pixels. Default is ``1920``.
        height : int, optional
            Viewport height in pixels. Default is ``1080``.
        format : str, optional
            Image format: ``"png"`` or ``"jpeg"``. Default is ``"png"``.
        quality : int, optional
            JPEG quality (1-100). Only applies when format is ``"jpeg"``.
        selector : str, optional
            CSS selector of the element to screenshot (instead of
            viewport).
        proxy_country : str, optional
            ISO country code for geo-targeted proxy.
        wait_for_selector : str, optional
            CSS selector to wait for before capturing.
        timeout : float, optional
            Request timeout in seconds.

        Returns
        -------
        ScreenshotResponse
            Contains the screenshot as base64-encoded image data,
            plus metadata like URL, dimensions, and format.

        Examples
        --------
        >>> shot = client.screenshot("https://example.com", full_page=True)
        >>> with open("screenshot.png", "wb") as f:
        ...     f.write(shot.image_bytes)
        """
        options = ScreenshotOptions(
            full_page=full_page,
            width=width,
            height=height,
            format=format,
            quality=quality,
            selector=selector,
            proxy_country=proxy_country,
            wait_for_selector=wait_for_selector,
            timeout=timeout,
        )
        body = {"url": url, **options.model_dump(exclude_none=True)}

        resp = self._request("POST", "/v1/screenshot", json_body=body)
        return ScreenshotResponse.model_validate(resp.json())

    async def ascreenshot(
        self,
        url: str,
        *,
        full_page: Optional[bool] = None,
        width: Optional[int] = None,
        height: Optional[int] = None,
        format: Optional[str] = None,
        quality: Optional[int] = None,
        selector: Optional[str] = None,
        proxy_country: Optional[str] = None,
        wait_for_selector: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> ScreenshotResponse:
        """Asynchronously take a screenshot of a web page.

        See :meth:`screenshot` for parameter documentation.
        """
        options = ScreenshotOptions(
            full_page=full_page,
            width=width,
            height=height,
            format=format,
            quality=quality,
            selector=selector,
            proxy_country=proxy_country,
            wait_for_selector=wait_for_selector,
            timeout=timeout,
        )
        body = {"url": url, **options.model_dump(exclude_none=True)}

        resp = await self._arequest("POST", "/v1/screenshot", json_body=body)
        return ScreenshotResponse.model_validate(resp.json())

    # ------------------------------------------------------------------
    # Crawl
    # ------------------------------------------------------------------

    def crawl(
        self,
        url: str,
        *,
        max_depth: Optional[int] = None,
        max_pages: Optional[int] = None,
        include_patterns: Optional[List[str]] = None,
        exclude_patterns: Optional[List[str]] = None,
        strategy: Optional[str] = None,
        proxy_tier: Optional[str] = None,
        proxy_country: Optional[str] = None,
        render_js: Optional[bool] = None,
        output_format: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> CrawlResponse:
        """Crawl a website, following links up to a specified depth.

        Parameters
        ----------
        url : str
            Starting URL to crawl from.
        max_depth : int, optional
            Maximum crawl depth. Default is ``2`` (starting page + 2
            levels of links).
        max_pages : int, optional
            Maximum number of pages to crawl. Default is ``100``.
        include_patterns : list[str], optional
            URL patterns to include (glob-style). Only URLs matching at
            least one pattern will be crawled.
        exclude_patterns : list[str], optional
            URL patterns to exclude (glob-style). URLs matching any
            pattern will be skipped.
        strategy : str, optional
            Scraping strategy for each page.
        proxy_tier : str, optional
            Proxy tier for each page.
        proxy_country : str, optional
            Geo-targeted country for proxy.
        render_js : bool, optional
            Whether to render JavaScript on each page.
        output_format : str, optional
            Output format for each page.
        timeout : float, optional
            Total crawl timeout in seconds.

        Returns
        -------
        CrawlResponse
            Contains all crawled pages, crawl metadata, and status.

        Examples
        --------
        >>> result = client.crawl(
        ...     "https://docs.example.com",
        ...     max_depth=3,
        ...     max_pages=50,
        ...     include_patterns=["/docs/*"],
        ... )
        >>> for page in result.pages:
        ...     print(page.url, page.status)
        """
        options = CrawlOptions(
            max_depth=max_depth,
            max_pages=max_pages,
            include_patterns=include_patterns,
            exclude_patterns=exclude_patterns,
            strategy=strategy,
            proxy_tier=proxy_tier,
            proxy_country=proxy_country,
            render_js=render_js,
            output_format=output_format,
            timeout=timeout,
        )
        body = {"url": url, **options.model_dump(exclude_none=True)}

        resp = self._request("POST", "/v1/crawl", json_body=body)
        return CrawlResponse.model_validate(resp.json())

    async def acrawl(
        self,
        url: str,
        *,
        max_depth: Optional[int] = None,
        max_pages: Optional[int] = None,
        include_patterns: Optional[List[str]] = None,
        exclude_patterns: Optional[List[str]] = None,
        strategy: Optional[str] = None,
        proxy_tier: Optional[str] = None,
        proxy_country: Optional[str] = None,
        render_js: Optional[bool] = None,
        output_format: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> CrawlResponse:
        """Asynchronously crawl a website.

        See :meth:`crawl` for parameter documentation.
        """
        options = CrawlOptions(
            max_depth=max_depth,
            max_pages=max_pages,
            include_patterns=include_patterns,
            exclude_patterns=exclude_patterns,
            strategy=strategy,
            proxy_tier=proxy_tier,
            proxy_country=proxy_country,
            render_js=render_js,
            output_format=output_format,
            timeout=timeout,
        )
        body = {"url": url, **options.model_dump(exclude_none=True)}

        resp = await self._arequest("POST", "/v1/crawl", json_body=body)
        return CrawlResponse.model_validate(resp.json())

    # ==================================================================
    # DATA EXTRACTION METHODS
    # ==================================================================

    def extract(
        self,
        html: str,
        instruction: str,
        *,
        url: Optional[str] = None,
    ) -> ExtractResponse:
        """Extract data from HTML using a natural-language instruction.

        Powered by AI, this method lets you describe the data you want
        in plain English and receive structured results.

        Parameters
        ----------
        html : str
            Raw HTML content to extract from.
        instruction : str
            Natural-language description of what to extract.
            Example: ``"Extract the product name, price, and rating"``
        url : str, optional
            Source URL (improves extraction accuracy by providing
            context about the page structure).

        Returns
        -------
        ExtractResponse
            Contains the extracted data as a dictionary, plus metadata
            about the extraction process.

        Raises
        ------
        ScrapingError
            If the AI could not interpret the instruction.

        Examples
        --------
        >>> html = "<h1>Widget Pro</h1><span class='price'>$29.99</span>"
        >>> result = client.extract(html, "product name and price")
        >>> print(result.data)
        {'product_name': 'Widget Pro', 'price': '$29.99'}
        """
        payload = ExtractRequest(html=html, instruction=instruction, url=url)
        body = payload.model_dump(exclude_none=True)

        resp = self._request("POST", "/v1/extract", json_body=body)
        return ExtractResponse.model_validate(resp.json())

    async def aextract(
        self,
        html: str,
        instruction: str,
        *,
        url: Optional[str] = None,
    ) -> ExtractResponse:
        """Asynchronously extract data from HTML with AI.

        See :meth:`extract` for parameter documentation.
        """
        payload = ExtractRequest(html=html, instruction=instruction, url=url)
        body = payload.model_dump(exclude_none=True)

        resp = await self._arequest("POST", "/v1/extract", json_body=body)
        return ExtractResponse.model_validate(resp.json())

    def parse_structured(
        self,
        html: str,
        *,
        parser: str = "auto",
        url: Optional[str] = None,
    ) -> ParseStructuredResponse:
        """Parse HTML into structured data using built-in or custom parsers.

        Parameters
        ----------
        html : str
            Raw HTML content to parse.
        parser : str, optional
            Parser to use: ``"auto"``, ``"article"``, ``"product"``,
            ``"recipe"``, ``"job"``, ``"event"``, or ``"custom"``.
            Default is ``"auto"`` (auto-detect).
        url : str, optional
            Source URL (helps the parser select the right schema).

        Returns
        -------
        ParseStructuredResponse
            Structured data extracted according to the parser schema.

        Examples
        --------
        >>> result = client.parse_structured(html, parser="product")
        >>> print(result.data)
        {'name': 'Widget Pro', 'price': 29.99, 'currency': 'USD'}
        """
        payload = ParseStructuredRequest(html=html, parser=parser, url=url)
        body = payload.model_dump(exclude_none=True)

        resp = self._request("POST", "/v1/parse/structured", json_body=body)
        return ParseStructuredResponse.model_validate(resp.json())

    async def aparse_structured(
        self,
        html: str,
        *,
        parser: str = "auto",
        url: Optional[str] = None,
    ) -> ParseStructuredResponse:
        """Asynchronously parse HTML into structured data.

        See :meth:`parse_structured` for parameter documentation.
        """
        payload = ParseStructuredRequest(html=html, parser=parser, url=url)
        body = payload.model_dump(exclude_none=True)

        resp = await self._arequest("POST", "/v1/parse/structured", json_body=body)
        return ParseStructuredResponse.model_validate(resp.json())

    # ==================================================================
    # SERP API METHODS
    # ==================================================================

    def serp(
        self,
        query: str,
        *,
        engine: str = "google",
        num: Optional[int] = None,
        start: Optional[int] = None,
        geo: Optional[str] = None,
        language: Optional[str] = None,
        safe: Optional[bool] = None,
        period: Optional[str] = None,
        proxy_country: Optional[str] = None,
    ) -> SerpResponse:
        """Search engine results page (SERP) API.

        Retrieve search results from Google, Bing, or other search engines
        without being blocked or receiving CAPTCHAs.

        Parameters
        ----------
        query : str
            Search query string.
        engine : str, optional
            Search engine: ``"google"``, ``"bing"``, or ``"duckduckgo"``.
            Default is ``"google"``.
        num : int, optional
            Number of results to return (1-100). Default is ``10``.
        start : int, optional
            Offset for pagination (0-based). Default is ``0``.
        geo : str, optional
            Geographic location for results (e.g. ``"us"``, ``"uk"``).
        language : str, optional
            Language code for results (e.g. ``"en"``, ``"fr"``).
        safe : bool, optional
            Enable safe search. Default is ``True``.
        period : str, optional
            Time period filter: ``"day"``, ``"week"``, ``"month"``,
            ``"year"``, or ``None`` for all time.
        proxy_country : str, optional
            Country for geo-targeted proxy.

        Returns
        -------
        SerpResponse
            Search results including organic results, featured snippets,
            ads, and related searches.

        Examples
        --------
        >>> results = client.serp("web scraping tools", engine="google", num=5)
        >>> for r in results.organic:
        ...     print(r.position, r.title, r.url)
        """
        payload = SerpRequest(
            query=query,
            engine=engine,
            num=num,
            start=start,
            geo=geo,
            language=language,
            safe=safe,
            period=period,
            proxy_country=proxy_country,
        )
        body = payload.model_dump(exclude_none=True)

        resp = self._request("POST", "/v1/serp", json_body=body)
        return SerpResponse.model_validate(resp.json())

    async def aserp(
        self,
        query: str,
        *,
        engine: str = "google",
        num: Optional[int] = None,
        start: Optional[int] = None,
        geo: Optional[str] = None,
        language: Optional[str] = None,
        safe: Optional[bool] = None,
        period: Optional[str] = None,
        proxy_country: Optional[str] = None,
    ) -> SerpResponse:
        """Asynchronously retrieve search engine results.

        See :meth:`serp` for parameter documentation.
        """
        payload = SerpRequest(
            query=query,
            engine=engine,
            num=num,
            start=start,
            geo=geo,
            language=language,
            safe=safe,
            period=period,
            proxy_country=proxy_country,
        )
        body = payload.model_dump(exclude_none=True)

        resp = await self._arequest("POST", "/v1/serp", json_body=body)
        return SerpResponse.model_validate(resp.json())

    # ==================================================================
    # SESSION MANAGEMENT
    # ==================================================================

    def create_session(
        self,
        *,
        proxy_tier: Optional[str] = None,
        proxy_country: Optional[str] = None,
        ttl: Optional[int] = None,
        max_requests: Optional[int] = None,
    ) -> Session:
        """Create a sticky proxy session for consistent IP usage.

        A session ensures all subsequent requests use the same proxy IP,
        which is essential for multi-step interactions like login flows,
        shopping carts, or paginated browsing.

        Parameters
        ----------
        proxy_tier : str, optional
            Proxy tier: ``"datacenter"``, ``"residential"``, or
            ``"mobile"``.
        proxy_country : str, optional
            ISO country code for the proxy location.
        ttl : int, optional
            Session time-to-live in seconds. Default is ``600`` (10 min).
        max_requests : int, optional
            Maximum requests before session rotates. Default is unlimited.

        Returns
        -------
        Session
            Session object with ``session_id``, proxy details, and
            expiration time.

        Examples
        --------
        >>> session = client.create_session(proxy_country="us", proxy_tier="residential")
        >>> result = client.scrape("https://example.com/login", session_id=session.session_id)
        """
        payload = CreateSessionRequest(
            proxy_tier=proxy_tier,
            proxy_country=proxy_country,
            ttl=ttl,
            max_requests=max_requests,
        )
        body = payload.model_dump(exclude_none=True)

        resp = self._request("POST", "/v1/sessions", json_body=body)
        return Session.model_validate(resp.json())

    async def acreate_session(
        self,
        *,
        proxy_tier: Optional[str] = None,
        proxy_country: Optional[str] = None,
        ttl: Optional[int] = None,
        max_requests: Optional[int] = None,
    ) -> Session:
        """Asynchronously create a sticky proxy session.

        See :meth:`create_session` for parameter documentation.
        """
        payload = CreateSessionRequest(
            proxy_tier=proxy_tier,
            proxy_country=proxy_country,
            ttl=ttl,
            max_requests=max_requests,
        )
        body = payload.model_dump(exclude_none=True)

        resp = await self._arequest("POST", "/v1/sessions", json_body=body)
        return Session.model_validate(resp.json())

    def list_sessions(
        self,
        *,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> SessionListResponse:
        """List all active sticky sessions.

        Parameters
        ----------
        limit : int, optional
            Maximum number of sessions to return. Default is ``50``.
        offset : int, optional
            Pagination offset. Default is ``0``.

        Returns
        -------
        SessionListResponse
            List of active sessions with pagination info.
        """
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset

        resp = self._request("GET", "/v1/sessions", params=params)
        return SessionListResponse.model_validate(resp.json())

    async def alist_sessions(
        self,
        *,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> SessionListResponse:
        """Asynchronously list all active sessions.

        See :meth:`list_sessions` for parameter documentation.
        """
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset

        resp = await self._arequest("GET", "/v1/sessions", params=params)
        return SessionListResponse.model_validate(resp.json())

    def delete_session(self, session_id: str) -> Dict[str, Any]:
        """Terminate a sticky proxy session.

        Parameters
        ----------
        session_id : str
            The session ID to terminate.

        Returns
        -------
        dict
            Confirmation message.

        Raises
        ------
        ScrapeSuiteError
            If the session does not exist.
        """
        resp = self._request("DELETE", f"/v1/sessions/{session_id}")
        return resp.json()

    async def adelete_session(self, session_id: str) -> Dict[str, Any]:
        """Asynchronously terminate a sticky proxy session.

        See :meth:`delete_session` for parameter documentation.
        """
        resp = await self._arequest("DELETE", f"/v1/sessions/{session_id}")
        return resp.json()

    # ==================================================================
    # MONITORING
    # ==================================================================

    def create_monitor(
        self,
        url: str,
        fields: List[str],
        schedule: str,
        *,
        name: Optional[str] = None,
        proxy_tier: Optional[str] = None,
        proxy_country: Optional[str] = None,
        webhook_id: Optional[str] = None,
        alert_email: Optional[str] = None,
        css_selector: Optional[str] = None,
        render_js: Optional[bool] = None,
        timeout: Optional[float] = None,
    ) -> Monitor:
        """Create a monitor that tracks changes on a web page.

        Monitors periodically scrape a URL, extract specified fields,
        and notify you when values change.

        Parameters
        ----------
        url : str
            URL to monitor.
        fields : list[str]
            List of field names or CSS selectors to track.
        schedule : str
            Cron-style schedule (e.g. ``"*/30 * * * *"`` for every
            30 minutes) or simple interval: ``"5m"``, ``"1h"``, ``"1d"``.
        name : str, optional
            Human-readable monitor name.
        proxy_tier : str, optional
            Proxy tier for monitoring requests.
        proxy_country : str, optional
            Country for geo-targeted proxy.
        webhook_id : str, optional
            Webhook ID to trigger on changes.
        alert_email : str, optional
            Email address for change alerts.
        css_selector : str, optional
            CSS selector to scope monitoring to a specific element.
        render_js : bool, optional
            Whether to render JavaScript. Default is ``True``.
        timeout : float, optional
            Per-check timeout in seconds.

        Returns
        -------
        Monitor
            Created monitor with ID, schedule, and status.

        Examples
        --------
        >>> monitor = client.create_monitor(
        ...     url="https://example.com/product",
        ...     fields=["price", "availability"],
        ...     schedule="1h",
        ...     name="Price Tracker",
        ... )
        >>> print(monitor.monitor_id, monitor.status)
        """
        payload = CreateMonitorRequest(
            url=url,
            fields=fields,
            schedule=schedule,
            name=name,
            proxy_tier=proxy_tier,
            proxy_country=proxy_country,
            webhook_id=webhook_id,
            alert_email=alert_email,
            css_selector=css_selector,
            render_js=render_js,
            timeout=timeout,
        )
        body = payload.model_dump(exclude_none=True)

        resp = self._request("POST", "/v1/monitors", json_body=body)
        return Monitor.model_validate(resp.json())

    async def acreate_monitor(
        self,
        url: str,
        fields: List[str],
        schedule: str,
        *,
        name: Optional[str] = None,
        proxy_tier: Optional[str] = None,
        proxy_country: Optional[str] = None,
        webhook_id: Optional[str] = None,
        alert_email: Optional[str] = None,
        css_selector: Optional[str] = None,
        render_js: Optional[bool] = None,
        timeout: Optional[float] = None,
    ) -> Monitor:
        """Asynchronously create a monitor.

        See :meth:`create_monitor` for parameter documentation.
        """
        payload = CreateMonitorRequest(
            url=url,
            fields=fields,
            schedule=schedule,
            name=name,
            proxy_tier=proxy_tier,
            proxy_country=proxy_country,
            webhook_id=webhook_id,
            alert_email=alert_email,
            css_selector=css_selector,
            render_js=render_js,
            timeout=timeout,
        )
        body = payload.model_dump(exclude_none=True)

        resp = await self._arequest("POST", "/v1/monitors", json_body=body)
        return Monitor.model_validate(resp.json())

    def list_monitors(
        self,
        *,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        status: Optional[str] = None,
    ) -> MonitorListResponse:
        """List all monitors.

        Parameters
        ----------
        limit : int, optional
            Maximum number of monitors to return. Default is ``50``.
        offset : int, optional
            Pagination offset.
        status : str, optional
            Filter by status: ``"active"``, ``"paused"``, or ``"error"``.

        Returns
        -------
        MonitorListResponse
            List of monitors with pagination info.
        """
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset
        if status is not None:
            params["status"] = status

        resp = self._request("GET", "/v1/monitors", params=params)
        return MonitorListResponse.model_validate(resp.json())

    async def alist_monitors(
        self,
        *,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        status: Optional[str] = None,
    ) -> MonitorListResponse:
        """Asynchronously list all monitors.

        See :meth:`list_monitors` for parameter documentation.
        """
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset
        if status is not None:
            params["status"] = status

        resp = await self._arequest("GET", "/v1/monitors", params=params)
        return MonitorListResponse.model_validate(resp.json())

    def get_monitor(self, monitor_id: str) -> Monitor:
        """Get details of a specific monitor.

        Parameters
        ----------
        monitor_id : str
            The monitor ID.

        Returns
        -------
        Monitor
            Monitor details including last check time, field values,
            and change history.
        """
        resp = self._request("GET", f"/v1/monitors/{monitor_id}")
        return Monitor.model_validate(resp.json())

    async def aget_monitor(self, monitor_id: str) -> Monitor:
        """Asynchronously get monitor details.

        See :meth:`get_monitor` for parameter documentation.
        """
        resp = await self._arequest("GET", f"/v1/monitors/{monitor_id}")
        return Monitor.model_validate(resp.json())

    # ==================================================================
    # WEBHOOKS
    # ==================================================================

    def create_webhook(
        self,
        url: str,
        events: List[str],
        *,
        name: Optional[str] = None,
        secret: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
        active: Optional[bool] = None,
    ) -> Webhook:
        """Create a webhook endpoint.

        Parameters
        ----------
        url : str
            The URL that will receive webhook POST requests.
        events : list[str]
            Event types to subscribe to: ``"scrape.complete"``,
            ``"scrape.error"``, ``"monitor.change"``, ``"batch.complete"``,
            ``"session.expired"``, ``"quota.warning"``.
        name : str, optional
            Human-readable name for the webhook.
        secret : str, optional
            Secret key for verifying webhook signatures.
        headers : dict, optional
            Custom HTTP headers to include in webhook requests.
        active : bool, optional
            Whether the webhook is active. Default is ``True``.

        Returns
        -------
        Webhook
            Created webhook with ID and signing secret.

        Examples
        --------
        >>> wh = client.create_webhook(
        ...     url="https://myapp.com/webhooks/scrapesuite",
        ...     events=["scrape.complete", "monitor.change"],
        ...     name="Production Webhook",
        ... )
        >>> print(wh.webhook_id)
        """
        payload = CreateWebhookRequest(
            url=url,
            events=events,
            name=name,
            secret=secret,
            headers=headers,
            active=active,
        )
        body = payload.model_dump(exclude_none=True)

        resp = self._request("POST", "/v1/webhooks", json_body=body)
        return Webhook.model_validate(resp.json())

    async def acreate_webhook(
        self,
        url: str,
        events: List[str],
        *,
        name: Optional[str] = None,
        secret: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
        active: Optional[bool] = None,
    ) -> Webhook:
        """Asynchronously create a webhook endpoint.

        See :meth:`create_webhook` for parameter documentation.
        """
        payload = CreateWebhookRequest(
            url=url,
            events=events,
            name=name,
            secret=secret,
            headers=headers,
            active=active,
        )
        body = payload.model_dump(exclude_none=True)

        resp = await self._arequest("POST", "/v1/webhooks", json_body=body)
        return Webhook.model_validate(resp.json())

    def list_webhooks(
        self,
        *,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> WebhookListResponse:
        """List all webhooks.

        Parameters
        ----------
        limit : int, optional
            Maximum number of webhooks to return. Default is ``50``.
        offset : int, optional
            Pagination offset.

        Returns
        -------
        WebhookListResponse
            List of webhooks with pagination info.
        """
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset

        resp = self._request("GET", "/v1/webhooks", params=params)
        return WebhookListResponse.model_validate(resp.json())

    async def alist_webhooks(
        self,
        *,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> WebhookListResponse:
        """Asynchronously list all webhooks.

        See :meth:`list_webhooks` for parameter documentation.
        """
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset

        resp = await self._arequest("GET", "/v1/webhooks", params=params)
        return WebhookListResponse.model_validate(resp.json())

    def test_webhook(self, webhook_id: str) -> WebhookTestResponse:
        """Send a test payload to a webhook endpoint.

        Parameters
        ----------
        webhook_id : str
            The webhook ID to test.

        Returns
        -------
        WebhookTestResponse
            Test result including HTTP status code, response time, and
            whether the delivery was successful.
        """
        resp = self._request("POST", f"/v1/webhooks/{webhook_id}/test")
        return WebhookTestResponse.model_validate(resp.json())

    async def atest_webhook(self, webhook_id: str) -> WebhookTestResponse:
        """Asynchronously test a webhook endpoint.

        See :meth:`test_webhook` for parameter documentation.
        """
        resp = await self._arequest("POST", f"/v1/webhooks/{webhook_id}/test")
        return WebhookTestResponse.model_validate(resp.json())

    # ==================================================================
    # PROXY & INFRASTRUCTURE
    # ==================================================================

    def get_proxy_stats(self) -> ProxyStats:
        """Get statistics about the ScrapeSuite proxy pool.

        Returns
        -------
        ProxyStats
            Pool statistics including total IPs, active proxies,
            geo-distribution, and success rates.

        Examples
        --------
        >>> stats = client.get_proxy_stats()
        >>> print(f"Total IPs: {stats.total_ips}")
        >>> print(f"Residential: {stats.residential_count}")
        """
        resp = self._request("GET", "/v1/proxy/stats")
        return ProxyStats.model_validate(resp.json())

    async def aget_proxy_stats(self) -> ProxyStats:
        """Asynchronously get proxy pool statistics.

        See :meth:`get_proxy_stats` for details.
        """
        resp = await self._arequest("GET", "/v1/proxy/stats")
        return ProxyStats.model_validate(resp.json())

    def estimate_cost(
        self,
        url: str,
        *,
        strategy: Optional[str] = None,
        proxy_tier: Optional[str] = None,
        render_js: Optional[bool] = None,
        solve_captcha: Optional[bool] = None,
        output_format: Optional[str] = None,
    ) -> CostEstimate:
        """Estimate the cost of a scrape request before executing it.

        Parameters
        ----------
        url : str
            The URL to estimate.
        strategy : str, optional
            Scraping strategy.
        proxy_tier : str, optional
            Proxy tier.
        render_js : bool, optional
            Whether JavaScript rendering is needed.
        solve_captcha : bool, optional
            Whether CAPTCHA solving is needed.
        output_format : str, optional
            Desired output format.

        Returns
        -------
        CostEstimate
            Estimated credits, proxy cost, and total cost breakdown.

        Examples
        --------
        >>> estimate = client.estimate_cost(
        ...     "https://example.com",
        ...     strategy="stealth",
        ...     proxy_tier="residential",
        ... )
        >>> print(f"Estimated cost: {estimate.total_credits} credits")
        """
        payload = CostEstimateRequest(
            url=url,
            strategy=strategy,
            proxy_tier=proxy_tier,
            render_js=render_js,
            solve_captcha=solve_captcha,
            output_format=output_format,
        )
        body = payload.model_dump(exclude_none=True)

        resp = self._request("POST", "/v1/cost/estimate", json_body=body)
        return CostEstimate.model_validate(resp.json())

    async def aestimate_cost(
        self,
        url: str,
        *,
        strategy: Optional[str] = None,
        proxy_tier: Optional[str] = None,
        render_js: Optional[bool] = None,
        solve_captcha: Optional[bool] = None,
        output_format: Optional[str] = None,
    ) -> CostEstimate:
        """Asynchronously estimate scrape cost.

        See :meth:`estimate_cost` for parameter documentation.
        """
        payload = CostEstimateRequest(
            url=url,
            strategy=strategy,
            proxy_tier=proxy_tier,
            render_js=render_js,
            solve_captcha=solve_captcha,
            output_format=output_format,
        )
        body = payload.model_dump(exclude_none=True)

        resp = await self._arequest("POST", "/v1/cost/estimate", json_body=body)
        return CostEstimate.model_validate(resp.json())

    # ==================================================================
    # SCRAPING BROWSER (CDP)
    # ==================================================================

    @contextmanager
    def scraping_browser(
        self,
        *,
        proxy_tier: Optional[str] = None,
        proxy_country: Optional[str] = None,
        session_id: Optional[str] = None,
        stealth: Optional[bool] = None,
        fingerprint: Optional[Dict[str, Any]] = None,
        block_resources: Optional[List[str]] = None,
    ) -> Generator[Any, None, None]:
        """Connect to a ScrapeSuite headless browser via Chrome DevTools Protocol.

        Returns a Playwright ``Browser`` instance connected to ScrapeSuite's
        CDP endpoint. Use this for complex interactions that require full
        browser control (clicking, typing, scrolling, file downloads).

        Parameters
        ----------
        proxy_tier : str, optional
            Proxy tier for the browser session.
        proxy_country : str, optional
            Country for geo-targeted proxy.
        session_id : str, optional
            Sticky session ID for consistent IP.
        stealth : bool, optional
            Enable stealth mode (anti-detection). Default is ``True``.
        fingerprint : dict, optional
            Browser fingerprint override (user agent, viewport, etc.).
        block_resources : list[str], optional
            Resource types to block: ``"images"``, ``"fonts"``,
            ``"stylesheets"``, ``"media"``.

        Yields
        ------
        playwright.sync_api.Browser
            A Playwright Browser instance connected to ScrapeSuite's
            remote browser.

        Raises
        ------
        ImportError
            If ``playwright`` is not installed.

        Examples
        --------
        >>> with client.scraping_browser(stealth=True) as browser:
        ...     page = browser.new_page()
        ...     page.goto("https://example.com")
        ...     title = page.title()
        ...     print(title)
        """
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise ImportError(
                "The 'playwright' package is required for scraping_browser. "
                "Install it with: pip install scrapesuite[browser]"
            )

        # Request a CDP endpoint from the API
        cdp_body: Dict[str, Any] = {}
        if proxy_tier:
            cdp_body["proxy_tier"] = proxy_tier
        if proxy_country:
            cdp_body["proxy_country"] = proxy_country
        if session_id:
            cdp_body["session_id"] = session_id
        if stealth is not None:
            cdp_body["stealth"] = stealth
        if fingerprint:
            cdp_body["fingerprint"] = fingerprint
        if block_resources:
            cdp_body["block_resources"] = block_resources

        resp = self._request("POST", "/v1/browser/cdp", json_body=cdp_body)
        cdp_data = resp.json()
        ws_endpoint = cdp_data["ws_endpoint"]

        pw = sync_playwright().start()
        browser = None
        try:
            browser = pw.chromium.connect_over_cdp(ws_endpoint)
            yield browser
        finally:
            if browser:
                try:
                    browser.close()
                except Exception:
                    pass
            try:
                pw.stop()
            except Exception:
                pass

    @asynccontextmanager
    async def ascraping_browser(
        self,
        *,
        proxy_tier: Optional[str] = None,
        proxy_country: Optional[str] = None,
        session_id: Optional[str] = None,
        stealth: Optional[bool] = None,
        fingerprint: Optional[Dict[str, Any]] = None,
        block_resources: Optional[List[str]] = None,
    ) -> AsyncIterator[Any]:
        """Asynchronously connect to a ScrapeSuite headless browser via CDP.

        Returns an async Playwright ``Browser`` instance connected to
        ScrapeSuite's CDP endpoint.

        See :meth:`scraping_browser` for parameter documentation.

        Examples
        --------
        >>> async with client.ascraping_browser(stealth=True) as browser:
        ...     page = await browser.new_page()
        ...     await page.goto("https://example.com")
        ...     title = await page.title()
        ...     print(title)
        """
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise ImportError(
                "The 'playwright' package is required for scraping_browser. "
                "Install it with: pip install scrapesuite[browser]"
            )

        cdp_body: Dict[str, Any] = {}
        if proxy_tier:
            cdp_body["proxy_tier"] = proxy_tier
        if proxy_country:
            cdp_body["proxy_country"] = proxy_country
        if session_id:
            cdp_body["session_id"] = session_id
        if stealth is not None:
            cdp_body["stealth"] = stealth
        if fingerprint:
            cdp_body["fingerprint"] = fingerprint
        if block_resources:
            cdp_body["block_resources"] = block_resources

        resp = await self._arequest("POST", "/v1/browser/cdp", json_body=cdp_body)
        cdp_data = resp.json()
        ws_endpoint = cdp_data["ws_endpoint"]

        pw = await async_playwright().start()
        browser = None
        try:
            browser = await pw.chromium.connect_over_cdp(ws_endpoint)
            yield browser
        finally:
            if browser:
                try:
                    await browser.close()
                except Exception:
                    pass
            try:
                await pw.stop()
            except Exception:
                pass

    # ==================================================================
    # UTILITY / CONVENIENCE
    # ==================================================================

    @property
    def rate_limit_info(self) -> Dict[str, Any]:
        """Current rate-limit state from the most recent API response.

        Returns
        -------
        dict
            Keys: ``remaining``, ``limit``, ``reset_at``.
        """
        return {
            "remaining": self._rate_limit.remaining,
            "limit": self._rate_limit.limit,
            "reset_at": self._rate_limit.reset_at,
        }

    def __repr__(self) -> str:
        mode = "async" if self._async_mode else "sync"
        return (
            f"ScrapeSuiteClient(base_url={self._base_url!r}, "
            f"mode={mode!r}, max_retries={self._max_retries})"
        )
