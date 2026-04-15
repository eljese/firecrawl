import { Logger } from "winston";
import { withSpan, setSpanAttributes } from "../../lib/otel-tracer";
import { captureExceptionWithZdrCheck } from "../../services/sentry";

import {
  type Document,
  getPDFMaxPages,
  type ScrapeOptions,
  type TeamFlags,
} from "../../controllers/v2/types";
import { ScrapeOptions as ScrapeOptionsV1 } from "../../controllers/v1/types";
import { logger as _logger } from "../../lib/logger";
import {
  Engine,
  EngineScrapeResult,
  Fetched,
  FeatureFlag,
  shouldUseIndex,
} from "./adapters";
import { hasFormatOfType } from "../../lib/format-utils";
import {
  ActionError,
  SiteError,
  UnsupportedFileError,
  SSLError,
  PDFInsufficientTimeError,
  PDFOCRRequiredError,
  DNSResolutionError,
  IndexMissError,
  ProxySelectionError,
  BrandingNotSupportedError,
  ZDRViolationError,
} from "./error";
import { executeTransformers } from "./transformers";
import { LLMRefusalError } from "./transformers/llmExtract";
import { urlSpecificParams } from "./lib/urlSpecificParams";
import { loadMock, MockState } from "./lib/mock";
import { CostTracking } from "../../lib/cost-tracking";
import { getEngineForUrl } from "../WebScraper/utils/engine-forcing";
import { useIndex } from "../../services/index";
import {
  fetchRobotsTxt,
  createRobotsChecker,
  isUrlAllowedByRobots,
} from "../../lib/robots-txt";
import { getCrawl } from "../../lib/crawl-redis";
import {
  AbortInstance,
  AbortManager,
  AbortManagerThrownError,
} from "./lib/abortManager";
import { ScrapeJobTimeoutError, CrawlDenialError } from "../../lib/error";
import { postprocessors } from "./postprocessors";
import { rewriteUrl } from "./lib/rewriteUrl";
import { isPdf } from "./adapters/pdf/pdfUtils";
import { fetchViaChromeCdp } from "./adapters/fire-engine";
import { fetchViaHttpGateway } from "./lib/net/httpGateway";
import { fetchProxy, SelectedProxy } from "./lib/net/proxyService";
import { scrapeURLWithIndex } from "./adapters/index/index";
import { scrapeURLWithWikipedia, isWikimediaUrl } from "./adapters/wikipedia";
import { parsePdfBuffer } from "./adapters/pdf";
import { parseDocumentBuffer } from "./adapters/document";
import { config } from "../../config";

export type ScrapeUrlResponse =
  | {
      success: true;
      document: Document;
      unsupportedFeatures?: Set<FeatureFlag>;
    }
  | { success: false; error: any };

export type Meta = {
  id: string;
  url: string;
  rewrittenUrl?: string;
  options: ScrapeOptions & { skipTlsVerification: boolean };
  internalOptions: InternalOptions;
  logger: Logger;
  abort: AbortManager;
  featureFlags: Set<FeatureFlag>;
  mock: MockState | null;
  pdfPrefetch:
    | {
        filePath: string;
        url?: string;
        status: number;
        proxyUsed: "basic" | "stealth";
        contentType?: string;
      }
    | null
    | undefined;
  documentPrefetch:
    | {
        filePath: string;
        url?: string;
        status: number;
        proxyUsed: "basic" | "stealth";
        contentType?: string;
      }
    | null
    | undefined;
  costTracking: CostTracking;
  winnerEngine?: Engine;
  abortHandle?: NodeJS.Timeout;
};

export type InternalOptions = {
  teamId: string;
  crawlId?: string;
  priority?: number;
  forceEngine?: Engine | Engine[];
  atsv?: boolean;
  v0CrawlOnlyUrls?: boolean;
  v0DisableJsDom?: boolean;
  disableSmartWaitCache?: boolean;
  isBackgroundIndex?: boolean;
  externalAbort?: AbortInstance;
  urlInvisibleInCurrentCrawl?: boolean;
  unnormalizedSourceURL?: string;
  saveScrapeResultToGCS?: boolean;
  bypassBilling?: boolean;
  zeroDataRetention?: boolean;
  teamFlags?: TeamFlags;
  v1Agent?: ScrapeOptionsV1["agent"];
  v1JSONAgent?: Exclude<ScrapeOptionsV1["jsonOptions"], undefined>["agent"];
  v1JSONSystemPrompt?: string;
  v1OriginalFormat?: "extract" | "json";
  isPreCrawl?: boolean;
  agentIndexOnly?: boolean;
};

function buildFeatureFlags(
  options: ScrapeOptions,
  internalOptions: InternalOptions,
): Set<FeatureFlag> {
  const flags: Set<FeatureFlag> = new Set();
  if ((options.actions?.length ?? 0) > 0) flags.add("actions");
  const screenshot = hasFormatOfType(options.formats, "screenshot");
  if (screenshot)
    flags.add(screenshot.fullPage ? "screenshot@fullScreen" : "screenshot");
  if (hasFormatOfType(options.formats, "branding")) flags.add("branding");
  if (options.waitFor !== 0) flags.add("waitFor");
  if (internalOptions.atsv) flags.add("atsv");
  if (options.location) flags.add("location");
  if (options.mobile) flags.add("mobile");
  if (options.skipTlsVerification) flags.add("skipTlsVerification");
  if (options.fastMode) flags.add("useFastMode");
  if (options.proxy === "stealth" || options.proxy === "enhanced")
    flags.add("stealthProxy");
  if (options.blockAds === false) flags.add("disableAdblock");
  return flags;
}

async function buildMetaObject(
  id: string,
  url: string,
  options: ScrapeOptions,
  internalOptions: InternalOptions,
  costTracking: CostTracking,
): Promise<Meta> {
  const specParams =
    urlSpecificParams[new URL(url).hostname.replace(/^www\./, "")];
  if (specParams) {
    options = Object.assign(options, specParams.scrapeOptions);
    internalOptions = Object.assign(
      internalOptions,
      specParams.internalOptions,
    );
  }
  if (internalOptions.forceEngine === undefined) {
    const forced = getEngineForUrl(url);
    if (forced !== undefined) internalOptions.forceEngine = forced;
  }

  const logger = _logger.child({
    module: "ScrapeURL",
    scrapeId: id,
    scrapeURL: url,
    zeroDataRetention: internalOptions.zeroDataRetention,
    teamId: internalOptions.teamId,
    team_id: internalOptions.teamId,
    crawlId: internalOptions.crawlId,
  });

  const abortController = new AbortController();
  const abortHandle =
    options.timeout !== undefined
      ? setTimeout(
          () => abortController.abort(new ScrapeJobTimeoutError()),
          options.timeout,
        )
      : undefined;

  return {
    id,
    url,
    rewrittenUrl: rewriteUrl(url),
    options: {
      ...options,
      skipTlsVerification:
        options.skipTlsVerification ??
        ((options.headers && Object.keys(options.headers).length > 0) ||
        (options.actions && options.actions.length > 0)
          ? false
          : true),
    },
    internalOptions,
    logger,
    abortHandle,
    abort: new AbortManager(
      internalOptions.externalAbort,
      options.timeout !== undefined
        ? {
            signal: abortController.signal,
            tier: "scrape",
            timesOutAt: new Date(Date.now() + options.timeout),
            throwable: () => new ScrapeJobTimeoutError(),
          }
        : undefined,
    ),
    featureFlags: buildFeatureFlags(options, internalOptions),
    mock:
      options.useMock !== undefined
        ? await loadMock(options.useMock, _logger)
        : null,
    pdfPrefetch: undefined,
    documentPrefetch: undefined,
    costTracking,
  };
}

const DOCUMENT_CONTENT_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/msword",
  "application/rtf",
  "text/rtf",
  "application/vnd.oasis.opendocument.text",
];

function getContentType(f: Fetched): string | undefined {
  if (f.contentType) return f.contentType;
  return f.headers.find(h => h.name.toLowerCase() === "content-type")?.value;
}

function isDocument(f: Fetched): boolean {
  const ct = getContentType(f)?.toLowerCase();
  return !!ct && DOCUMENT_CONTENT_TYPES.some(t => ct.includes(t));
}

function htmlNeedsJs(f: Fetched): boolean {
  const ct = getContentType(f);
  if (!ct || !ct.toLowerCase().includes("text/html")) return false;
  // Sniff the first 64KB — enough to see any <script> without decoding the whole body.
  const sniff = f.buffer.subarray(0, Math.min(f.buffer.length, 64 * 1024));
  return /<script\b/i.test(sniff.toString("utf8"));
}

/**
 * Decode fetched bytes to a string. For HTML, honours the `<meta charset>`
 * declaration if present and not UTF-8.
 */
function decodeHtml(buf: Buffer): string {
  const html = buf.toString("utf8");
  const charset = (html.match(
    /<meta\b[^>]*charset\s*=\s*["']?([^"'\s\/>]+)/i,
  ) ?? [])[1];
  if (!charset || charset.trim().toLowerCase() === "utf-8") return html;
  try {
    return new TextDecoder(charset.trim()).decode(buf);
  } catch {
    return html;
  }
}

function fetchedToHtmlResult(f: Fetched): EngineScrapeResult {
  const result: EngineScrapeResult = {
    url: f.url,
    html: decodeHtml(f.buffer),
    statusCode: f.status,
    contentType: getContentType(f),
    proxyUsed: f.proxyUsed ?? "basic",
  };
  if (f.pageError) result.error = f.pageError;
  if (f.screenshots && f.screenshots.length > 0)
    result.screenshot = f.screenshots[0];
  if (f.actions) result.actions = f.actions;
  if (f.youtubeTranscriptContent !== undefined) {
    result.youtubeTranscriptContent = f.youtubeTranscriptContent;
  }
  if (f.timezone) result.timezone = f.timezone;
  return result;
}

type AdapterLabel =
  | "wikipedia"
  | "index"
  | "gateway"
  | "chrome-cdp"
  | "pdf"
  | "document";

export async function scrapeURL(
  id: string,
  url: string,
  options: ScrapeOptions,
  internalOptions: InternalOptions,
  costTracking: CostTracking,
): Promise<ScrapeUrlResponse> {
  return withSpan("scrape", async span => {
    const meta = await buildMetaObject(
      id,
      url,
      options,
      internalOptions,
      costTracking,
    );
    const startTime = Date.now();

    setSpanAttributes(span, {
      "scrape.id": id,
      "scrape.url": url,
      "scrape.team_id": internalOptions.teamId,
      "scrape.crawl_id": internalOptions.crawlId,
      "scrape.zero_data_retention": internalOptions.zeroDataRetention,
      "scrape.force_engine": Array.isArray(internalOptions.forceEngine)
        ? internalOptions.forceEngine.join(",")
        : internalOptions.forceEngine,
      "scrape.features": Array.from(meta.featureFlags).join(","),
      ...(meta.rewrittenUrl
        ? { "scrape.rewritten_url": meta.rewrittenUrl }
        : {}),
      ...(internalOptions.isPreCrawl ? { "scrape.is_precrawl": true } : {}),
    });

    meta.logger.info("scrapeURL entered");
    if (meta.rewrittenUrl) meta.logger.info("Rewriting URL");

    if (internalOptions.teamFlags?.checkRobotsOnScrape) {
      const denial = await checkRobots(meta);
      if (denial) return denial;
    }

    try {
      const { result, adapter } = await runPipeline(meta);
      meta.winnerEngine = adapter as Engine;
      setSpanAttributes(span, { "scrape.adapter": adapter });

      const processedResult = await runPostprocessors(meta, result);

      let document = buildDocument(meta, processedResult, adapter);
      document = await executeTransformers(meta, document);

      setSpanAttributes(span, {
        "scrape.final_status_code": document.metadata.statusCode,
        "scrape.final_url": document.metadata.url,
        "scrape.content_type": document.metadata.contentType,
        "scrape.proxy_used": document.metadata.proxyUsed,
        "scrape.cache_state": document.metadata.cacheState,
        "scrape.postprocessors_used":
          processedResult.postprocessorsUsed?.join(","),
        "scrape.success": true,
        "scrape.duration_ms": Date.now() - startTime,
        "scrape.index_hit": document.metadata.cacheState === "hit",
      });
      logScrapeMetrics(
        meta,
        startTime,
        true,
        document.metadata.cacheState === "hit",
      );

      return { success: true, document, unsupportedFeatures: new Set() };
    } catch (error) {
      logScrapeMetrics(meta, startTime, false, false);
      return handleScrapeError(meta, error, startTime, span, internalOptions);
    }
  });
}

async function runPipeline(
  meta: Meta,
): Promise<{ result: EngineScrapeResult; adapter: AdapterLabel }> {
  meta.logger.info(
    `Scraping URL ${JSON.stringify(meta.rewrittenUrl ?? meta.url)}...`,
  );
  meta.abort.throwIfAborted();

  if (isWikimediaUrl(meta.url)) {
    return {
      result: await scrapeURLWithWikipedia(meta),
      adapter: "wikipedia",
    };
  }

  if (meta.internalOptions.zeroDataRetention) {
    if (meta.featureFlags.has("screenshot"))
      throw new ZDRViolationError("screenshot");
    if (meta.featureFlags.has("screenshot@fullScreen")) {
      throw new ZDRViolationError("screenshot@fullScreen");
    }
    if (meta.options.actions?.some(x => x.type === "screenshot")) {
      throw new ZDRViolationError("screenshot action");
    }
    if (meta.options.actions?.some(x => x.type === "pdf")) {
      throw new ZDRViolationError("pdf action");
    }
  }

  if (shouldUseIndex(meta) || meta.internalOptions.agentIndexOnly) {
    try {
      return { result: await scrapeURLWithIndex(meta), adapter: "index" };
    } catch (error) {
      if (!(error instanceof IndexMissError)) throw error;
      meta.logger.debug("Index miss — falling through to live fetch");
    }
  }

  const proxy: SelectedProxy | undefined = await fetchProxy(
    meta.featureFlags.has("stealthProxy") ? "mobile" : "basic",
    meta.options.location?.country,
    meta.logger,
    meta.abort.asSignal(),
  );

  if (!proxy) {
    throw new ProxySelectionError(); // we can't scrape without a proxy
  }

  let fetched: Fetched = config.FIRE_ENGINE_HTTP_GATEWAY_URL
    ? await fetchViaHttpGateway(meta, { proxy })
    : await fetchViaChromeCdp(meta, { proxy });

  if (fetched.source === "gateway" && htmlNeedsJs(fetched)) {
    fetched = await fetchViaChromeCdp(meta, { prefetch: fetched, proxy });
  }

  if (isPdf(fetched)) {
    return {
      result: await parsePdfBuffer(meta, fetched),
      adapter: "pdf",
    };
  }
  if (isDocument(fetched)) {
    return {
      result: await parseDocumentBuffer(meta, fetched),
      adapter: "document",
    };
  }
  return {
    result: fetchedToHtmlResult(fetched),
    adapter: fetched.source,
  };
}

async function checkRobots(meta: Meta): Promise<ScrapeUrlResponse | undefined> {
  const urlToCheck = meta.rewrittenUrl || meta.url;
  meta.logger.info("Checking robots.txt", { url: urlToCheck });

  try {
    return await withSpan("scrape.robots_check", async robotsSpan => {
      const isRobotsTxtPath = new URL(urlToCheck).pathname === "/robots.txt";
      setSpanAttributes(robotsSpan, {
        "robots.url": urlToCheck,
        "robots.is_robots_txt_path": isRobotsTxtPath,
      });
      if (isRobotsTxtPath) return undefined;

      try {
        let robotsTxt: string | undefined;
        if (meta.internalOptions.crawlId) {
          robotsTxt = (await getCrawl(meta.internalOptions.crawlId))?.robots;
        }
        if (!robotsTxt) {
          const { content } = await fetchRobotsTxt(
            {
              url: urlToCheck,
              zeroDataRetention:
                meta.internalOptions.zeroDataRetention || false,
              location: meta.options.location,
            },
            meta.id,
            meta.logger,
            meta.abort.asSignal(),
          );
          robotsTxt = content;
        }

        const checker = createRobotsChecker(urlToCheck, robotsTxt);
        const allowed = isUrlAllowedByRobots(urlToCheck, checker.robots);
        setSpanAttributes(robotsSpan, { "robots.allowed": allowed });
        if (!allowed) {
          meta.logger.info("URL blocked by robots.txt", { url: urlToCheck });
          throw new CrawlDenialError("URL blocked by robots.txt");
        }
      } catch (error) {
        if (error instanceof CrawlDenialError) throw error;
        meta.logger.debug("Failed to fetch robots.txt, allowing scrape", {
          error,
          url: urlToCheck,
        });
        setSpanAttributes(robotsSpan, { "robots.fetch_failed": true });
      }
      return undefined;
    });
  } catch (error) {
    if (error instanceof CrawlDenialError) {
      return { success: false, error };
    }
    throw error;
  }
}

async function runPostprocessors(
  meta: Meta,
  engineResult: EngineScrapeResult,
): Promise<EngineScrapeResult> {
  let result = engineResult;
  for (const pp of postprocessors) {
    if (pp.shouldRun(meta, new URL(result.url), result.postprocessorsUsed)) {
      meta.logger.info("Running postprocessor " + pp.name);
      try {
        result = await pp.run(
          {
            ...meta,
            logger: meta.logger.child({ method: "postprocessors/" + pp.name }),
          },
          result,
        );
      } catch (error) {
        meta.logger.warn("Failed to run postprocessor " + pp.name, { error });
      }
    }
  }
  return result;
}

function buildDocument(
  meta: Meta,
  engineResult: EngineScrapeResult,
  adapter: AdapterLabel,
): Document {
  const servedFromIndex = adapter === "index";
  return {
    markdown: engineResult.markdown,
    rawHtml: engineResult.html,
    screenshot: engineResult.screenshot,
    actions: engineResult.actions,
    branding: engineResult.branding,
    metadata: {
      sourceURL: meta.internalOptions.unnormalizedSourceURL ?? meta.url,
      url: engineResult.url,
      statusCode: engineResult.statusCode,
      error: engineResult.error,
      numPages: engineResult.pdfMetadata?.numPages,
      ...(engineResult.pdfMetadata?.title
        ? { title: engineResult.pdfMetadata.title }
        : {}),
      contentType: engineResult.contentType,
      timezone: engineResult.timezone,
      proxyUsed: engineResult.proxyUsed ?? "basic",
      ...(servedFromIndex
        ? engineResult.cacheInfo
          ? {
              cacheState: "hit" as const,
              cachedAt: engineResult.cacheInfo.created_at.toISOString(),
            }
          : { cacheState: "miss" as const }
        : {}),
      postprocessorsUsed: engineResult.postprocessorsUsed,
    },
  };
}

function logScrapeMetrics(
  meta: Meta,
  startTime: number,
  success: boolean,
  indexHit: boolean,
): void {
  meta.logger.debug("scrapeURL metrics", {
    module: "scrapeURL/metrics",
    timeTaken: Date.now() - startTime,
    maxAgeValid: (meta.options.maxAge ?? 0) > 0,
    shouldUseIndex: shouldUseIndex(meta),
    success,
    indexHit,
  });

  if (!useIndex) return;
  meta.logger.debug("scrapeURL index metrics", {
    module: "scrapeURL/index-metrics",
    timeTaken: Date.now() - startTime,
    changeTrackingEnabled: !!hasFormatOfType(
      meta.options.formats,
      "changeTracking",
    ),
    summaryEnabled: !!hasFormatOfType(meta.options.formats, "summary"),
    jsonEnabled: !!hasFormatOfType(meta.options.formats, "json"),
    screenshotEnabled: !!hasFormatOfType(meta.options.formats, "screenshot"),
    imagesEnabled: !!hasFormatOfType(meta.options.formats, "images"),
    brandingEnabled: !!hasFormatOfType(meta.options.formats, "branding"),
    pdfMaxPages: getPDFMaxPages(meta.options.parsers),
    maxAge: meta.options.maxAge,
    headers: meta.options.headers
      ? Object.keys(meta.options.headers).length
      : 0,
    actions: meta.options.actions?.length ?? 0,
    proxy: meta.options.proxy,
    success,
    indexHit,
  });
}

function handleScrapeError(
  meta: Meta,
  error: any,
  startTime: number,
  span: any,
  internalOptions: InternalOptions,
): ScrapeUrlResponse {
  const errorType = classifyError(meta, error);
  if (errorType === "AbortManagerThrownError") {
    // Re-throw inner error instead of returning failure envelope.
    throw (error as AbortManagerThrownError).inner;
  }
  if (errorType === "unknown") {
    captureExceptionWithZdrCheck(error, {
      extra: { zeroDataRetention: internalOptions.zeroDataRetention ?? false },
    });
    meta.logger.error("scrapeURL: Unexpected error happened", { error });
  }

  setSpanAttributes(span, {
    "scrape.success": false,
    "scrape.error": error instanceof Error ? error.message : String(error),
    "scrape.error_type": errorType,
    "scrape.duration_ms": Date.now() - startTime,
  });

  return { success: false, error };
}

function classifyError(meta: Meta, error: any): string {
  if (error instanceof LLMRefusalError) {
    meta.logger.warn("scrapeURL: LLM refused to extract content", { error });
    return "LLMRefusalError";
  }
  if (
    error instanceof Error &&
    error.message.includes("Invalid schema for response_format")
  ) {
    meta.logger.warn("scrapeURL: LLM schema error", { error });
    return "LLMSchemaError";
  }
  if (error instanceof SiteError) {
    meta.logger.warn("scrapeURL: Site failed to load in browser", { error });
    return "SiteError";
  }
  if (error instanceof SSLError) {
    meta.logger.warn("scrapeURL: SSL error", { error });
    return "SSLError";
  }
  if (error instanceof ActionError) {
    meta.logger.warn("scrapeURL: Action(s) failed to complete", { error });
    return "ActionError";
  }
  if (error instanceof UnsupportedFileError) {
    meta.logger.warn("scrapeURL: Tried to scrape unsupported file", { error });
    return "UnsupportedFileError";
  }
  if (error instanceof PDFInsufficientTimeError) {
    meta.logger.warn("scrapeURL: Insufficient time to process PDF", { error });
    return "PDFInsufficientTimeError";
  }
  if (error instanceof PDFOCRRequiredError) {
    meta.logger.warn(
      "scrapeURL: PDF requires OCR but fast mode was requested",
      { error },
    );
    return "PDFOCRRequiredError";
  }
  if (error instanceof BrandingNotSupportedError) {
    meta.logger.warn("scrapeURL: Branding not supported for this content", {
      error,
    });
    return "BrandingNotSupportedError";
  }
  if (error instanceof ProxySelectionError) {
    meta.logger.warn("scrapeURL: Proxy selection error", { error });
    return "ProxySelectionError";
  }
  if (error instanceof DNSResolutionError) {
    meta.logger.warn("scrapeURL: DNS resolution error", { error });
    return "DNSResolutionError";
  }
  if (error instanceof AbortManagerThrownError) {
    return "AbortManagerThrownError";
  }
  return "unknown";
}
