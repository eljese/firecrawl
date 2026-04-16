import { Logger } from "winston";
import {
  type Document,
  type ScrapeOptions,
  type TeamFlags,
} from "../../controllers/v2/types";
import { ScrapeOptions as ScrapeOptionsV1 } from "../../controllers/v1/types";
import { logger as _logger } from "../../lib/logger";
import { CostTracking } from "../../lib/cost-tracking";
import { hasFormatOfType } from "../../lib/format-utils";
import { AbortInstance, AbortManager } from "./lib/abort-manager";
import { ScrapeJobTimeoutError } from "../../lib/error";
import { loadMock, MockState } from "./lib/mock";
import { rewriteUrl } from "./lib/rewrite-url";
import { urlSpecificParams } from "./lib/url-specific-params";
import type { FeatureFlag } from "./types";

export type InternalOptions = {
  teamId: string;
  crawlId?: string;
  priority?: number;
  atsv?: boolean;
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

/**
 * Per-scrape state carried through every stage. Built once at the start of
 * `scrapeURL()` and passed by reference; stages read from it but do not mutate
 * it (side-effect transforms mutate the `Document`, not this).
 */
export type Meta = {
  id: string;
  /** URL we actually fetch (after rewrite). Flows into metadata.url. */
  url: string;
  /** The caller's original URL. Flows into metadata.sourceURL. */
  sourceURL: string;
  options: ScrapeOptions & { skipTlsVerification: boolean };
  internalOptions: InternalOptions;
  logger: Logger;
  abort: AbortManager;
  mock: MockState | null;
  costTracking: CostTracking;
};

export async function buildMeta(
  id: string,
  url: string,
  options: ScrapeOptions,
  internalOptions: InternalOptions,
  costTracking: CostTracking,
): Promise<Meta> {
  const sourceURL = internalOptions.unnormalizedSourceURL ?? url;
  const rewritten = rewriteUrl(url);
  const fetchURL = rewritten ?? url;

  const hostname = new URL(fetchURL).hostname.replace(/^www\./, "");
  const specParams = urlSpecificParams[hostname];
  if (specParams) {
    options = Object.assign(options, specParams.scrapeOptions);
    internalOptions = Object.assign(
      internalOptions,
      specParams.internalOptions,
    );
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

  const abort = buildAbortManager(
    internalOptions.externalAbort,
    options.timeout,
  );
  const resolvedOptions = {
    ...options,
    skipTlsVerification: resolveSkipTls(options),
  };

  return {
    id,
    url: fetchURL,
    sourceURL,
    options: resolvedOptions,
    internalOptions,
    logger,
    abort,
    mock:
      options.useMock !== undefined
        ? await loadMock(options.useMock, _logger)
        : null,
    costTracking,
  };
}

function resolveSkipTls(options: ScrapeOptions): boolean {
  if (options.skipTlsVerification !== undefined)
    return options.skipTlsVerification;
  const hasHeaders = options.headers && Object.keys(options.headers).length > 0;
  const hasActions = options.actions && options.actions.length > 0;
  return !(hasHeaders || hasActions);
}

function buildAbortManager(
  external: AbortInstance | undefined,
  timeout: number | undefined,
): AbortManager {
  if (timeout === undefined) {
    return new AbortManager(external);
  }
  const controller = new AbortController();
  const handle = setTimeout(
    () => controller.abort(new ScrapeJobTimeoutError()),
    timeout,
  );
  const scrapeAbort: AbortInstance = {
    signal: controller.signal,
    tier: "scrape",
    timesOutAt: new Date(Date.now() + timeout),
    throwable: () => new ScrapeJobTimeoutError(),
  };
  const manager = new AbortManager(external, scrapeAbort);
  const originalDispose = manager.dispose.bind(manager);
  manager.dispose = () => {
    clearTimeout(handle);
    originalDispose();
  };
  return manager;
}

export function hasFeature(meta: Meta, flag: FeatureFlag): boolean {
  const { options, internalOptions } = meta;
  switch (flag) {
    case "actions":
      return (options.actions?.length ?? 0) > 0;
    case "waitFor":
      return options.waitFor !== 0 && options.waitFor !== undefined;
    case "screenshot": {
      const shot = hasFormatOfType(options.formats, "screenshot");
      return !!shot && !shot.fullPage;
    }
    case "screenshot@fullScreen": {
      const shot = hasFormatOfType(options.formats, "screenshot");
      return !!shot && !!shot.fullPage;
    }
    case "branding":
      return !!hasFormatOfType(options.formats, "branding");
    case "atsv":
      return !!internalOptions.atsv;
    case "location":
      return !!options.location;
    case "mobile":
      return !!options.mobile;
    case "skipTlsVerification":
      return !!options.skipTlsVerification;
    case "useFastMode":
      return !!options.fastMode;
    case "stealthProxy":
      return options.proxy === "stealth" || options.proxy === "enhanced";
    case "disableAdblock":
      return options.blockAds === false;
    case "pdf":
    case "document":
      return false;
  }
}

export function activeFeatures(meta: Meta): Set<FeatureFlag> {
  const all: FeatureFlag[] = [
    "actions",
    "waitFor",
    "screenshot",
    "screenshot@fullScreen",
    "branding",
    "atsv",
    "location",
    "mobile",
    "skipTlsVerification",
    "useFastMode",
    "stealthProxy",
    "disableAdblock",
  ];
  return new Set(all.filter(f => hasFeature(meta, f)));
}
