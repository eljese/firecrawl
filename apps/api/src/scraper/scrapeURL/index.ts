import type { Document } from "../../controllers/v2/types";
import type { ScrapeOptions } from "../../controllers/v2/types";
import { CostTracking } from "../../lib/cost-tracking";
import { withSpan, setSpanAttributes } from "../../lib/otel-tracer";
import { captureExceptionWithZdrCheck } from "../../services/sentry";
import { hasFormatOfType } from "../../lib/format-utils";
import { useIndex } from "../../services/index";
import {
  fetchRobotsTxt,
  createRobotsChecker,
  isUrlAllowedByRobots,
} from "../../lib/robots-txt";
import { getCrawl } from "../../lib/crawl-redis";
import { CrawlDenialError } from "../../lib/error";

import {
  buildMeta,
  hasFeature,
  activeFeatures,
  type Meta,
  type InternalOptions,
} from "./context";
import type { Engine, EngineScrapeResult, Fetched, FeatureFlag } from "./types";
import {
  ActionError,
  SiteError,
  UnsupportedFileError,
  SSLError,
  PDFInsufficientTimeError,
  PDFOCRRequiredError,
  DNSResolutionError,
  ProxySelectionError,
  BrandingNotSupportedError,
  ZDRViolationError,
} from "./error";
import { AbortManagerThrownError } from "./lib/abort-manager";
import {
  LLMRefusalError,
  performLLMExtract,
  performSummary,
  performCleanContent,
} from "./enrich/llm-extract";
import { performQuery } from "./enrich/query";
import { performAgent } from "./enrich/agent";
import { deriveDiff } from "./enrich/diff";
import { performAttributes } from "./derive/attributes";
import { removeBase64Images } from "./derive/remove-base64-images";
import { deriveHTMLFromRawHTML } from "./derive/html";
import { deriveMarkdownFromHTML } from "./derive/markdown";
import { deriveMetadataFromRawHTML } from "./derive/metadata";
import { deriveLinksFromHTML } from "./derive/links";
import { deriveImagesFromHTML } from "./derive/images";
import { deriveBrandingFromActions } from "./derive/branding";
import { uploadScreenshot } from "./emit/upload-screenshot";
import { fetchAudio } from "./enrich/audio";
import { sendDocumentToSearchIndex } from "./emit/search-index";
import { sendDocumentToIndex } from "./emit/cache-write";
import { shapeForFormats } from "./shape";
import { useSearchIndex } from "../../services/index";
import { fetchProxy, fetchViaGateway, fetchViaCdp } from "./fetch/network";
import { scrapeURLWithWikipedia, isWikimediaUrl } from "./fetch/wikipedia";
import { scrapeURLWithIndex } from "./fetch/cache-lookup";
import { IndexMissError } from "./error";
import { parsePdfBuffer } from "./parse/pdf";
import { parseDocumentBuffer } from "./parse/document";
import { isPdf } from "./parse/pdf/pdf-utils";
import { shouldRunYoutube, runYoutube } from "./parse/youtube";
import { getPDFMaxPages } from "../../controllers/v2/types";
import { config } from "../../config";

export type { Meta, InternalOptions };

export type ScrapeUrlResponse =
  | {
      success: true;
      document: Document;
      unsupportedFeatures?: Set<FeatureFlag>;
    }
  | { success: false; error: any };

export async function scrapeURL(
  id: string,
  url: string,
  options: ScrapeOptions,
  internalOptions: InternalOptions,
  costTracking: CostTracking,
): Promise<ScrapeUrlResponse> {
  return withSpan("scrape", async span => {
    const meta = await buildMeta(
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
      "scrape.features": Array.from(activeFeatures(meta)).join(","),
      ...(meta.url !== url ? { "scrape.rewritten_url": meta.url } : {}),
      ...(internalOptions.isPreCrawl ? { "scrape.is_precrawl": true } : {}),
    });

    meta.logger.info("scrapeURL entered");
    if (meta.url !== url) meta.logger.info("Rewriting URL");

    try {
      if (internalOptions.teamFlags?.checkRobotsOnScrape) {
        const denial = await checkRobots(meta);
        if (denial) return denial;
      }

      const { result, adapter } = await runPipeline(meta);
      setSpanAttributes(span, { "scrape.adapter": adapter });

      const processed = await runPostprocessors(meta, result);
      let document = buildDocument(meta, processed, adapter);

      document = await runDerive(meta, document);
      document = await runEnrich(meta, document);
      await runEmit(meta, document, adapter);
      document = shapeForFormats(meta, document);

      setSpanAttributes(span, {
        "scrape.final_status_code": document.metadata.statusCode,
        "scrape.final_url": document.metadata.url,
        "scrape.content_type": document.metadata.contentType,
        "scrape.proxy_used": document.metadata.proxyUsed,
        "scrape.cache_state": document.metadata.cacheState,
        "scrape.postprocessors_used": processed.postprocessorsUsed?.join(","),
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
    } finally {
      meta.abort.dispose();
    }
  });
}

type Adapter = "wikipedia" | "index" | "gateway" | "cdp" | "pdf" | "document";

async function runPipeline(meta: Meta): Promise<{
  result: EngineScrapeResult;
  adapter: Adapter;
}> {
  meta.logger.info(`Scraping URL ${JSON.stringify(meta.url)}...`);
  meta.abort.throwIfAborted();

  if (isWikimediaUrl(meta.url)) {
    return { result: await scrapeURLWithWikipedia(meta), adapter: "wikipedia" };
  }

  enforceZdrLimits(meta);

  if (shouldUseIndex(meta) || meta.internalOptions.agentIndexOnly) {
    try {
      return { result: await scrapeURLWithIndex(meta), adapter: "index" };
    } catch (error) {
      if (!(error instanceof IndexMissError)) throw error;
      meta.logger.debug("Index miss - falling through to live fetch");
    }
  }

  const proxy = await fetchProxy(
    hasFeature(meta, "stealthProxy") ? "mobile" : "basic",
    meta.options.location?.country,
    meta.logger,
    meta.abort.asSignal(),
  );

  let fetched =
    config.FIRE_ENGINE_HTTP_GATEWAY_URL && proxy
      ? await fetchViaGateway(meta, proxy).catch(error => {
          meta.logger.warn("gateway failed, falling back to cdp", { error });
          return fetchViaCdp(meta, { proxy });
        })
      : await fetchViaCdp(meta, { proxy });

  if (fetched.via === "gateway" && htmlNeedsJs(fetched)) {
    fetched = await fetchViaCdp(meta, { prefetch: fetched, proxy });
  }

  if (isPdf(fetched)) {
    return { result: await parsePdfBuffer(meta, fetched), adapter: "pdf" };
  }
  if (isDocument(fetched)) {
    return {
      result: await parseDocumentBuffer(meta, fetched),
      adapter: "document",
    };
  }
  return {
    result: toHtmlResult(fetched),
    adapter: fetched.via === "cdp" ? "cdp" : "gateway",
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

function isDocument(f: Fetched): boolean {
  const ct = f.contentType?.toLowerCase();
  if (!ct) return false;
  return DOCUMENT_CONTENT_TYPES.some(t => ct.includes(t));
}

function htmlNeedsJs(f: Fetched): boolean {
  const ct = f.contentType;
  if (!ct || !ct.toLowerCase().includes("text/html")) return false;
  const sniff = f.buffer.subarray(0, Math.min(f.buffer.length, 64 * 1024));
  return /<script\b/i.test(sniff.toString("utf8"));
}

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

function toHtmlResult(f: Fetched): EngineScrapeResult {
  return {
    url: f.url,
    html: decodeHtml(f.buffer),
    statusCode: f.status,
    contentType: f.contentType,
    proxyUsed: f.proxyUsed,
    error: f.pageError,
    screenshot: f.screenshots?.[0],
    actions: f.actions,
    youtubeTranscriptContent: f.youtubeTranscriptContent,
    timezone: f.timezone,
  };
}

function enforceZdrLimits(meta: Meta): void {
  if (!meta.internalOptions.zeroDataRetention) return;
  if (hasFeature(meta, "screenshot")) throw new ZDRViolationError("screenshot");
  if (hasFeature(meta, "screenshot@fullScreen")) {
    throw new ZDRViolationError("screenshot@fullScreen");
  }
  if (meta.options.actions?.some(x => x.type === "screenshot")) {
    throw new ZDRViolationError("screenshot action");
  }
  if (meta.options.actions?.some(x => x.type === "pdf")) {
    throw new ZDRViolationError("pdf action");
  }
}

function shouldUseIndex(meta: Meta): boolean {
  const shot = hasFormatOfType(meta.options.formats, "screenshot");
  const hasCustomScreenshotSettings =
    shot?.viewport !== undefined || shot?.quality !== undefined;

  return (
    useIndex &&
    config.FIRECRAWL_INDEX_WRITE_ONLY !== true &&
    !hasFormatOfType(meta.options.formats, "changeTracking") &&
    !hasFormatOfType(meta.options.formats, "branding") &&
    getPDFMaxPages(meta.options.parsers) === undefined &&
    !hasCustomScreenshotSettings &&
    meta.options.maxAge !== 0 &&
    (meta.options.headers === undefined ||
      Object.keys(meta.options.headers).length === 0) &&
    (meta.options.actions === undefined || meta.options.actions.length === 0) &&
    meta.options.profile === undefined
  );
}

async function runDerive(meta: Meta, document: Document): Promise<Document> {
  document = await deriveHTMLFromRawHTML(
    childMeta(meta, "deriveHTMLFromRawHTML"),
    document,
  );
  document = await deriveMarkdownFromHTML(
    childMeta(meta, "deriveMarkdownFromHTML"),
    document,
  );
  document = await deriveLinksFromHTML(
    childMeta(meta, "deriveLinksFromHTML"),
    document,
  );
  document = await deriveImagesFromHTML(
    childMeta(meta, "deriveImagesFromHTML"),
    document,
  );
  document = await deriveBrandingFromActions(
    childMeta(meta, "deriveBrandingFromActions"),
    document,
  );
  document = await deriveMetadataFromRawHTML(
    childMeta(meta, "deriveMetadataFromRawHTML"),
    document,
  );
  document = await performAttributes(
    childMeta(meta, "performAttributes"),
    document,
  );
  return document;
}

async function runEnrich(meta: Meta, document: Document): Promise<Document> {
  document = await performCleanContent(
    childMeta(meta, "performCleanContent"),
    document,
  );
  document = await performLLMExtract(
    childMeta(meta, "performLLMExtract"),
    document,
  );
  document = await performSummary(childMeta(meta, "performSummary"), document);
  document = await performQuery(childMeta(meta, "performQuery"), document);
  document = await performAgent(childMeta(meta, "performAgent"), document);
  document = await removeBase64Images(
    childMeta(meta, "removeBase64Images"),
    document,
  );
  document = await deriveDiff(childMeta(meta, "deriveDiff"), document);
  document = await fetchAudio(childMeta(meta, "fetchAudio"), document);
  return document;
}

async function runEmit(
  meta: Meta,
  document: Document,
  adapter: string,
): Promise<void> {
  await uploadScreenshot(childMeta(meta, "uploadScreenshot"), document);
  if (useIndex) {
    await sendDocumentToIndex(
      childMeta(meta, "sendDocumentToIndex"),
      document,
      adapter,
    );
  }
  if (useSearchIndex) {
    await sendDocumentToSearchIndex(
      childMeta(meta, "sendDocumentToSearchIndex"),
      document,
    );
  }
}

function childMeta(meta: Meta, method: string): Meta {
  return { ...meta, logger: meta.logger.child({ method }) };
}

async function runPostprocessors(
  meta: Meta,
  engineResult: EngineScrapeResult,
): Promise<EngineScrapeResult> {
  if (
    !shouldRunYoutube(
      new URL(engineResult.url),
      engineResult.postprocessorsUsed,
    )
  ) {
    return engineResult;
  }
  meta.logger.info("Running postprocessor youtube");
  try {
    return await runYoutube(
      {
        ...meta,
        logger: meta.logger.child({ method: "postprocessors/youtube" }),
      },
      engineResult,
    );
  } catch (error) {
    meta.logger.warn("Failed to run postprocessor youtube", { error });
    return engineResult;
  }
}

function buildDocument(
  meta: Meta,
  result: EngineScrapeResult,
  adapter: Adapter,
): Document {
  const servedFromIndex = adapter === "index";
  return {
    markdown: result.markdown,
    rawHtml: result.html,
    screenshot: result.screenshot,
    actions: result.actions,
    branding: result.branding,
    metadata: {
      sourceURL: meta.sourceURL,
      url: result.url,
      statusCode: result.statusCode,
      error: result.error,
      numPages: result.pdfMetadata?.numPages,
      ...(result.pdfMetadata?.title ? { title: result.pdfMetadata.title } : {}),
      contentType: result.contentType,
      timezone: result.timezone,
      proxyUsed: result.proxyUsed,
      ...(servedFromIndex
        ? result.cacheInfo
          ? {
              cacheState: "hit" as const,
              cachedAt: result.cacheInfo.created_at.toISOString(),
            }
          : { cacheState: "miss" as const }
        : {}),
      postprocessorsUsed: result.postprocessorsUsed,
    },
  };
}

async function checkRobots(meta: Meta): Promise<ScrapeUrlResponse | undefined> {
  const urlToCheck = meta.url;
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

const ERROR_KINDS: Array<[new (...args: any[]) => Error, string, string]> = [
  [LLMRefusalError, "LLMRefusalError", "LLM refused to extract content"],
  [SiteError, "SiteError", "Site failed to load in browser"],
  [SSLError, "SSLError", "SSL error"],
  [ActionError, "ActionError", "Action(s) failed to complete"],
  [UnsupportedFileError, "UnsupportedFileError", "Unsupported file type"],
  [
    PDFInsufficientTimeError,
    "PDFInsufficientTimeError",
    "Insufficient time to process PDF",
  ],
  [
    PDFOCRRequiredError,
    "PDFOCRRequiredError",
    "PDF requires OCR but fast mode was requested",
  ],
  [
    BrandingNotSupportedError,
    "BrandingNotSupportedError",
    "Branding not supported for this content",
  ],
  [ProxySelectionError, "ProxySelectionError", "Proxy selection error"],
  [DNSResolutionError, "DNSResolutionError", "DNS resolution error"],
];

function classify(meta: Meta, error: any): string {
  if (
    error instanceof Error &&
    error.message.includes("Invalid schema for response_format")
  ) {
    meta.logger.warn("scrapeURL: LLM schema error", { error });
    return "LLMSchemaError";
  }
  for (const [cls, name, msg] of ERROR_KINDS) {
    if (error instanceof cls) {
      meta.logger.warn("scrapeURL: " + msg, { error });
      return name;
    }
  }
  if (error instanceof AbortManagerThrownError)
    return "AbortManagerThrownError";
  return "unknown";
}

function handleScrapeError(
  meta: Meta,
  error: any,
  startTime: number,
  span: any,
  internalOptions: InternalOptions,
): ScrapeUrlResponse {
  const errorType = classify(meta, error);
  if (errorType === "AbortManagerThrownError") {
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

function logScrapeMetrics(
  meta: Meta,
  startTime: number,
  success: boolean,
  indexHit: boolean,
): void {
  const base = {
    module: "scrapeURL/metrics",
    timeTaken: Date.now() - startTime,
    maxAgeValid: (meta.options.maxAge ?? 0) > 0,
    shouldUseIndex: shouldUseIndex(meta),
    success,
    indexHit,
  };
  if (!useIndex) {
    meta.logger.debug("scrapeURL metrics", base);
    return;
  }
  meta.logger.debug("scrapeURL metrics", {
    ...base,
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
  });
}
