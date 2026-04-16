import { config } from "../../../config";
import type { EngineScrapeResult } from "../types";
import type { Meta } from "../context";
import { hasFeature } from "../context";
import {
  getIndexFromGCS,
  hashURL,
  index_supabase_service,
  normalizeURLForIndex,
  generateDomainSplits,
} from "../../../services";
import {
  AgentIndexOnlyError,
  EngineError,
  IndexMissError,
  NoCachedDataError,
} from "../error";
import { shouldParsePDF } from "../../../controllers/v2/types";

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
      p_feature_screenshot: hasFeature(meta, "screenshot"),
      p_feature_screenshot_fullscreen: hasFeature(
        meta,
        "screenshot@fullScreen",
      ),
      p_location_country: meta.options.location?.country ?? null,
      p_location_languages:
        (meta.options.location?.languages?.length ?? 0) > 0
          ? meta.options.location?.languages
          : null,
      p_wait_time_ms: meta.options.waitFor,
      p_is_stealth: hasFeature(meta, "stealthProxy"),
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
