import crypto from "crypto";
import { config } from "../../../../config";
import { Document } from "../../../../controllers/v1/types";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import {
  getIndexFromGCS,
  hashURL,
  index_supabase_service,
  normalizeURLForIndex,
  saveIndexToGCS,
  generateURLSplits,
  addIndexInsertJob,
  generateDomainSplits,
  addOMCEJob,
} from "../../../../services";
import {
  AgentIndexOnlyError,
  EngineError,
  IndexMissError,
  NoCachedDataError,
} from "../../error";
import { shouldParsePDF } from "../../../../controllers/v2/types";
import { hasFormatOfType } from "../../../../lib/format-utils";

export async function sendDocumentToIndex(meta: Meta, document: Document) {
  // Skip caching if screenshot format has custom viewport or quality settings
  const screenshotFormat = hasFormatOfType(meta.options.formats, "screenshot");
  const hasCustomScreenshotSettings =
    screenshotFormat?.viewport !== undefined ||
    screenshotFormat?.quality !== undefined;

  const shouldCache =
    meta.options.storeInCache &&
    !meta.internalOptions.zeroDataRetention &&
    meta.winnerEngine !== "index" &&
    meta.winnerEngine !== "index;documents" &&
    !(meta.winnerEngine === "pdf" && !shouldParsePDF(meta.options.parsers)) &&
    !meta.options.parsers?.some(parser => {
      if (
        typeof parser === "object" &&
        parser !== null &&
        "maxPages" in parser
      ) {
        return true;
      }
      return false;
    }) &&
    !meta.featureFlags.has("actions") &&
    !hasCustomScreenshotSettings &&
    (meta.options.headers === undefined ||
      Object.keys(meta.options.headers).length === 0) &&
    meta.options.profile === undefined;

  if (!shouldCache) {
    return document;
  }

  // Generate indexId synchronously and set it on document immediately
  // so it's available to other transformers (e.g., search index)
  const indexId = crypto.randomUUID();
  document.metadata.indexId = indexId;

  (async () => {
    try {
      const normalizedURL = normalizeURLForIndex(meta.url);
      const urlHash = hashURL(normalizedURL);

      const urlSplits = generateURLSplits(normalizedURL);
      const urlSplitsHash = urlSplits.map(split => hashURL(split));

      const urlObj = new URL(normalizedURL);
      const hostname = urlObj.hostname;

      const fakeDomain = meta.options.__experimental_omceDomain;
      const domainSplits = generateDomainSplits(hostname, fakeDomain);
      const domainSplitsHash = domainSplits.map(split => hashURL(split));

      try {
        await saveIndexToGCS(indexId, {
          url:
            document.metadata.url ??
            document.metadata.sourceURL ??
            meta.rewrittenUrl ??
            meta.url,
          html: document.rawHtml!,
          statusCode: document.metadata.statusCode,
          error: document.metadata.error,
          screenshot: document.screenshot,
          pdfMetadata:
            document.metadata.numPages !== undefined
              ? {
                  // reconstruct pdfMetadata from numPages and title
                  numPages: document.metadata.numPages,
                  title: document.metadata.title ?? undefined,
                }
              : undefined,
          contentType: document.metadata.contentType,
          postprocessorsUsed: document.metadata.postprocessorsUsed,
        });
      } catch (error) {
        meta.logger.error("Failed to save document to index", {
          error,
        });
        return document;
      }

      let title = document.metadata.title ?? document.metadata.ogTitle ?? null;
      let description =
        document.metadata.description ??
        document.metadata.ogDescription ??
        document.metadata.dcDescription ??
        null;

      if (typeof title === "string") {
        title = title.trim();
        if (title.length > 60) {
          title = title.slice(0, 57) + "...";
        }
      } else {
        title = null;
      }

      if (typeof description === "string") {
        description = description.trim();
        if (description.length > 160) {
          description = description.slice(0, 157) + "...";
        }
      } else {
        description = null;
      }

      try {
        await addIndexInsertJob({
          id: indexId,
          url: normalizedURL,
          url_hash: urlHash,
          original_url: document.metadata.sourceURL ?? meta.url,
          resolved_url:
            document.metadata.url ??
            document.metadata.sourceURL ??
            meta.rewrittenUrl ??
            meta.url,
          has_screenshot:
            document.screenshot !== undefined &&
            meta.featureFlags.has("screenshot"),
          has_screenshot_fullscreen:
            document.screenshot !== undefined &&
            meta.featureFlags.has("screenshot@fullScreen"),
          is_mobile: meta.options.mobile,
          block_ads: meta.options.blockAds,
          location_country: meta.options.location?.country ?? null,
          location_languages: meta.options.location?.languages ?? null,
          status: document.metadata.statusCode,
          is_precrawl: meta.internalOptions.isPreCrawl === true,
          is_stealth: meta.featureFlags.has("stealthProxy"),
          wait_time_ms: meta.options.waitFor > 0 ? meta.options.waitFor : null,
          ...urlSplitsHash.slice(0, 10).reduce(
            (a, x, i) => ({
              ...a,
              [`url_split_${i}_hash`]: x,
            }),
            {},
          ),
          ...domainSplitsHash.slice(0, 5).reduce(
            (a, x, i) => ({
              ...a,
              [`domain_splits_${i}_hash`]: x,
            }),
            {},
          ),
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
        });
      } catch (error) {
        meta.logger.error("Failed to add document to index insert queue", {
          error,
        });
      }

      if (domainSplits.length > 0) {
        try {
          await addOMCEJob([
            domainSplits.length - 1,
            domainSplitsHash.slice(-1)[0],
          ]);
        } catch (error) {
          meta.logger.warn("Failed to add domain to OMCE job queue", {
            error,
          });
        }
      }
    } catch (error) {
      meta.logger.error("Failed to save document to index (outer)", {
        error,
      });
    }
  })();

  return document;
}

const DEFAULT_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000; // 2 days
const MAX_AGE_LOOKUP_TIMEOUT_MS = 200;
const ERROR_ROWS_BEFORE_FALLBACK = 3;

/**
 * Resolve the effective maxAge. User-provided value wins; otherwise query the
 * per-domain default from the index, falling back to 2 days if the lookup is
 * unavailable or slow.
 */
async function resolveMaxAge(meta: Meta): Promise<number> {
  if (meta.options.maxAge !== undefined) return meta.options.maxAge;

  const domainSplitsHash = generateDomainSplits(new URL(meta.url).hostname).map(
    x => hashURL(x),
  );
  if (
    domainSplitsHash.length === 0 ||
    config.FIRECRAWL_INDEX_WRITE_ONLY ||
    config.USE_DB_AUTHENTICATION !== true
  ) {
    return DEFAULT_MAX_AGE_MS;
  }

  try {
    const lookup = index_supabase_service
      .rpc("query_max_age", {
        i_domain_hash: domainSplitsHash[domainSplitsHash.length - 1],
      })
      .then(({ data, error }) => {
        if (error || !data || data.length === 0) {
          meta.logger.warn("Failed to get max age from DB", { error });
          return DEFAULT_MAX_AGE_MS;
        }
        return data[0].max_age ?? DEFAULT_MAX_AGE_MS;
      });
    const timeout = new Promise<number>(resolve =>
      setTimeout(() => resolve(DEFAULT_MAX_AGE_MS), MAX_AGE_LOOKUP_TIMEOUT_MS),
    );
    return (await Promise.race([lookup, timeout])) as number;
  } catch (error) {
    meta.logger.warn("Failed to get max age from DB", { error });
    return DEFAULT_MAX_AGE_MS;
  }
}

/**
 * Pick the most relevant row returned by `index_get_recent_4`. Prefer the
 * newest 2xx entry, but if there are fewer than N error rows before it, we
 * fall back to the absolute newest so the caller sees the latest state.
 */
function pickRow<T extends { status: number }>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  const newest2xx = rows.findIndex(r => r.status >= 200 && r.status < 300);
  if (newest2xx === -1 || newest2xx >= ERROR_ROWS_BEFORE_FALLBACK)
    return rows[0];
  return rows[newest2xx];
}

export async function scrapeURLWithIndex(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const normalizedURL = normalizeURLForIndex(meta.url);
  const urlHash = hashURL(normalizedURL);

  const maxAge = await resolveMaxAge(meta);

  const { data, error } = await index_supabase_service.rpc(
    "index_get_recent_4",
    {
      p_url_hash: urlHash,
      p_max_age_ms: maxAge,
      p_is_mobile: meta.options.mobile,
      p_block_ads: meta.options.blockAds,
      p_feature_screenshot: meta.featureFlags.has("screenshot"),
      p_feature_screenshot_fullscreen: meta.featureFlags.has(
        "screenshot@fullScreen",
      ),
      p_location_country: meta.options.location?.country ?? null,
      p_location_languages:
        (meta.options.location?.languages?.length ?? 0) > 0
          ? meta.options.location?.languages
          : null,
      p_wait_time_ms: meta.options.waitFor,
      p_is_stealth: meta.featureFlags.has("stealthProxy"),
      p_min_age_ms: meta.options.minAge ?? null,
    },
  );

  if (error || !data) {
    throw new EngineError("Failed to retrieve URL from DB index", {
      cause: error,
    });
  }

  const selectedRow = pickRow<{
    id: string;
    created_at: string;
    status: number;
  }>(data);
  if (!selectedRow) {
    if (meta.internalOptions.agentIndexOnly) throw new AgentIndexOnlyError();
    // minAge callers opted out of live scraping — don't fall through.
    if (meta.options.minAge !== undefined) throw new NoCachedDataError();
    throw new IndexMissError();
  }

  const doc = await getIndexFromGCS(
    selectedRow.id + ".json",
    meta.logger.child({ module: "index", method: "getIndexFromGCS" }),
  );
  if (!doc) {
    meta.logger.warn("Index document not found in GCS", {
      indexDocumentId: selectedRow.id,
    });
    throw new EngineError("Document not found in GCS");
  }

  // Cache/parse flavor consistency: if the caller wants a (un)parsed PDF but
  // the cached entry is the opposite flavor, treat as a miss.
  const isCachedPdfBase64 = !!doc.html && doc.html.startsWith("JVBERi");
  const wantParsedPdf = shouldParsePDF(meta.options.parsers);
  if (isCachedPdfBase64 && wantParsedPdf) throw new IndexMissError();
  if (!isCachedPdfBase64 && !wantParsedPdf) {
    const lowerUrl = meta.url.toLowerCase();
    if (lowerUrl.endsWith(".pdf") || lowerUrl.includes(".pdf?")) {
      throw new IndexMissError();
    }
  }

  return {
    url: doc.url,
    html: doc.html,
    statusCode: doc.statusCode,
    error: doc.error,
    screenshot: doc.screenshot,
    pdfMetadata:
      doc.pdfMetadata ??
      (doc.numPages !== undefined ? { numPages: doc.numPages } : undefined),
    contentType: doc.contentType,
    cacheInfo: { created_at: new Date(selectedRow.created_at) },
    postprocessorsUsed: doc.postprocessorsUsed,
    proxyUsed: doc.proxyUsed ?? "basic",
  };
}
