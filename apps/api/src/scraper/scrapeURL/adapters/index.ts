import { ScrapeActionContent } from "../../../lib/entities";
import { config } from "../../../config";
import { Meta } from "..";
import { useIndex } from "../../../services";
import { hasFormatOfType } from "../../../lib/format-utils";
import { getPDFMaxPages } from "../../../controllers/v2/types";
import type { PdfMetadata } from "./pdf/types";
import { BrandingProfile } from "../../../types/branding";

/**
 * Identifiers for the per-source adapter that served a scrape. Used for
 * telemetry + per-request routing (`internalOptions.forceEngine`). The
 * pipeline dispatches on content, not on this string — these labels exist
 * only to describe "what served this request".
 */
export type Engine =
  | "fire-engine;chrome-cdp"
  | "fire-engine(retry);chrome-cdp"
  | "fire-engine;chrome-cdp;stealth"
  | "fire-engine(retry);chrome-cdp;stealth"
  | "pdf"
  | "document"
  | "index"
  | "index;documents"
  | "wikipedia";

const featureFlags = [
  "actions",
  "waitFor",
  "screenshot",
  "screenshot@fullScreen",
  "pdf",
  "document",
  "atsv",
  "location",
  "mobile",
  "skipTlsVerification",
  "useFastMode",
  "stealthProxy",
  "branding",
  "disableAdblock",
] as const;

export type FeatureFlag = (typeof featureFlags)[number];

export type EngineScrapeResult = {
  url: string;

  html: string;
  markdown?: string;
  statusCode: number;
  error?: string;

  screenshot?: string;
  actions?: {
    screenshots: string[];
    scrapes: ScrapeActionContent[];
    javascriptReturns: {
      type: string;
      value: unknown;
    }[];
    pdfs: string[];
  };

  branding?: BrandingProfile;

  pdfMetadata?: PdfMetadata;

  cacheInfo?: {
    created_at: Date;
  };

  contentType?: string;

  youtubeTranscriptContent?: any;
  postprocessorsUsed?: string[];

  proxyUsed: "basic" | "stealth";
  timezone?: string;
};

/**
 * Raw fetch output shared by the two fetch adapters (http-gateway, chrome-cdp).
 * `buffer` is always the raw response body so downstream parsers (pdf, docx,
 * html) read magic bytes without re-downloading.
 */
export type Fetched = {
  source: "gateway" | "chrome-cdp";
  url: string;
  status: number;
  headers: Array<{ name: string; value: string }>;
  buffer: Buffer;
  contentType?: string;
  // CDP-only extras, populated when source === "chrome-cdp"
  screenshots?: string[];
  actions?: EngineScrapeResult["actions"];
  pageError?: string;
  proxyUsed?: "basic" | "stealth";
  youtubeTranscriptContent?: any;
  timezone?: string;
};

export function shouldUseIndex(meta: Meta): boolean {
  // Skip index if screenshot format has custom viewport or quality settings
  const screenshotFormat = hasFormatOfType(meta.options.formats, "screenshot");
  const hasCustomScreenshotSettings =
    screenshotFormat?.viewport !== undefined ||
    screenshotFormat?.quality !== undefined;

  return (
    useIndex &&
    config.FIRECRAWL_INDEX_WRITE_ONLY !== true &&
    !hasFormatOfType(meta.options.formats, "changeTracking") &&
    !hasFormatOfType(meta.options.formats, "branding") &&
    // Skip index if a non-default PDF maxPages is specified
    getPDFMaxPages(meta.options.parsers) === undefined &&
    !hasCustomScreenshotSettings &&
    meta.options.maxAge !== 0 &&
    (meta.options.headers === undefined ||
      Object.keys(meta.options.headers).length === 0) &&
    (meta.options.actions === undefined || meta.options.actions.length === 0) &&
    meta.options.profile === undefined
  );
}
