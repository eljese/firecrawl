import { Meta } from "../..";
import { Fetched } from "..";
import {
  fireEngineScrape,
  fireEngineURL,
  FireEngineScrapeRequestChromeCDP,
  FireEngineScrapeRequestCommon,
} from "./scrape";
import {
  fireEngineCheckStatus,
  FireEngineCheckStatusSuccess,
  StillProcessingError,
} from "./checkStatus";
import {
  ActionError,
  EngineError,
  DNSResolutionError,
  SiteError,
  SSLError,
  UnsupportedFileError,
  FEPageLoadFailed,
  ProxySelectionError,
} from "../../error";
import * as Sentry from "@sentry/node";
import { fireEngineDelete } from "./delete";
import { getInnerJson } from "@mendable/firecrawl-rs";
import { hasFormatOfType } from "../../../../lib/format-utils";
import { InternalAction } from "../../../../controllers/v1/types";
import { AbortManagerThrownError } from "../../lib/abortManager";
import { youtubePostprocessor } from "../../postprocessors/youtube";
import { withSpan, setSpanAttributes } from "../../../../lib/otel-tracer";
import { getBrandingScript } from "./brandingScript";
import { abTestFireEngine } from "../../../../services/ab-test";
import { scheduleABComparison } from "../../../../services/ab-test-comparison";
import { createHash } from "node:crypto";
import { SelectedProxy } from "../../lib/net/proxyService";

/** Default wait before the branding script runs so the DOM has settled. */
const BRANDING_DEFAULT_WAIT_MS = 2000;

/** Errors from `fireEngineCheckStatus` that mean the scrape is dead — no retry. */
const TERMINAL_CHECK_STATUS_ERRORS = [
  EngineError,
  SiteError,
  SSLError,
  DNSResolutionError,
  ActionError,
  UnsupportedFileError,
  FEPageLoadFailed,
  ProxySelectionError,
];

type FetchViaChromeCdpOptions = {
  /** HTML bytes from a previous gateway fetch — injected via Fetch.fulfillRequest. */
  prefetch?: Fetched;
  /** Pre-resolved proxy from the fire-proxy service. When undefined, no proxy. */
  proxy?: SelectedProxy;
};

export async function fetchViaChromeCdp(
  meta: Meta,
  opts: FetchViaChromeCdpOptions = {},
): Promise<Fetched> {
  return withSpan("adapter.chrome-cdp", async span => {
    setSpanAttributes(span, {
      "adapter.type": "chrome-cdp",
      "adapter.url": meta.url,
      "adapter.team_id": meta.internalOptions.teamId,
      "adapter.has_prefetch": !!opts.prefetch,
      "adapter.has_proxy": !!opts.proxy,
      "adapter.proxy_mobile": !!opts.proxy?.isMobile,
    });

    const actions = buildCdpActions(meta);
    const request = buildCdpRequest(meta, actions, opts);
    const response = await performFireEngineScrape(meta, request);
    return unpackCdpResponse(meta, response, actions, opts.proxy);
  });
}

// ---- internals ---------------------------------------------------------

function buildCdpActions(meta: Meta): InternalAction[] {
  const hasBranding = hasFormatOfType(meta.options.formats, "branding");
  const defaultWait = hasBranding ? BRANDING_DEFAULT_WAIT_MS : 0;
  const effectiveWait =
    meta.options.waitFor != null && meta.options.waitFor !== 0
      ? meta.options.waitFor
      : defaultWait;
  const screenshot = hasFormatOfType(meta.options.formats, "screenshot");

  const actions: InternalAction[] = [];
  // waitFor is unsupported on chrome-cdp directly — transform into a wait action.
  if (effectiveWait > 0) {
    actions.push({
      type: "wait",
      milliseconds: Math.min(effectiveWait, 30000),
    });
  }
  for (const action of meta.options.actions ?? []) {
    const { metadata: _, ...rest } = action as InternalAction;
    actions.push(rest);
  }
  if (screenshot) {
    actions.push({
      type: "screenshot",
      fullPage: screenshot.fullPage ?? false,
      ...(screenshot.viewport ? { viewport: screenshot.viewport } : {}),
    });
  }
  if (hasBranding) {
    actions.push({
      type: "executeJavascript",
      script: getBrandingScript(),
      metadata: { __firecrawl_internal: true },
    });
  }
  return actions;
}

function buildCdpRequest(
  meta: Meta,
  actions: InternalAction[],
  opts: FetchViaChromeCdpOptions,
): FireEngineScrapeRequestCommon & FireEngineScrapeRequestChromeCDP {
  const shouldAllowMedia =
    hasFormatOfType(meta.options.formats, "branding") ||
    youtubePostprocessor.shouldRun(
      meta,
      new URL(meta.rewrittenUrl ?? meta.url),
    );

  // If the gateway followed redirects, navigate the browser to the final URL
  // so cookies/subresources resolve against the right host.
  const targetUrl = opts.prefetch?.url ?? meta.rewrittenUrl ?? meta.url;

  return {
    url: targetUrl,
    scrapeId: meta.id,
    engine: "chrome-cdp",
    instantReturn: false,
    skipTlsVerification: meta.options.skipTlsVerification,
    headers: meta.options.headers,
    ...(actions.length > 0 ? { actions } : {}),
    priority: meta.internalOptions.priority,
    geolocation: meta.options.location,
    mobile: meta.options.mobile,
    timeout: meta.abort.scrapeTimeout() ?? 300000,
    disableSmartWaitCache: meta.internalOptions.disableSmartWaitCache,
    // customProxy tells fire-engine to skip its own proxy selection entirely.
    // mobileProxy is only used for telemetry so usedMobileProxy reflects reality.
    ...(opts.proxy
      ? { customProxy: opts.proxy.proxy, mobileProxy: opts.proxy.isMobile }
      : {}),
    saveScrapeResultToGCS:
      !meta.internalOptions.zeroDataRetention &&
      meta.internalOptions.saveScrapeResultToGCS,
    zeroDataRetention: meta.internalOptions.zeroDataRetention,
    ...(shouldAllowMedia ? { blockMedia: false } : {}),
    persistentStorage: meta.options.profile
      ? {
          uniqueId: `${createHash("sha256").update(meta.internalOptions.teamId).digest("hex").slice(0, 16)}_${meta.options.profile.name}`,
        }
      : undefined,
    ...(opts.prefetch
      ? {
          prefetch: {
            html: opts.prefetch.buffer.toString("utf8"),
            status: opts.prefetch.status,
            headers: opts.prefetch.headers,
          },
        }
      : {}),
  };
}

async function performFireEngineScrape(
  meta: Meta,
  request: FireEngineScrapeRequestCommon & FireEngineScrapeRequestChromeCDP,
): Promise<FireEngineCheckStatusSuccess> {
  return withSpan("adapter.chrome-cdp.perform_scrape", async span => {
    const startTime = Date.now();
    const abTest = abTestFireEngine(request);
    const baseUrl = abTest.mode === "split" ? abTest.baseUrl : fireEngineURL;

    setSpanAttributes(span, {
      "fire-engine.url": request.url,
      "fire-engine.priority": request.priority,
      "fire-engine.proxy": request.mobileProxy,
      "fire-engine.mobile": request.mobile,
      "fire-engine.skip_tls": request.skipTlsVerification,
      "fire-engine.ab_mode": abTest.mode,
    });

    const scrape = await fireEngineScrape(
      meta,
      meta.logger.child({ method: "fireEngineScrape" }),
      request,
      meta.mock,
      meta.abort.asSignal(),
      baseUrl,
    );
    const jobId = (scrape as any).jobId as string | undefined;

    // Always clean up, whether we succeed, time out, or hit a terminal error.
    let status: FireEngineCheckStatusSuccess;
    try {
      status = (scrape as any).processing
        ? await pollFireEngineStatus(meta, jobId!, baseUrl)
        : (scrape as FireEngineCheckStatusSuccess);

      const contentType =
        (Object.entries(status.responseHeaders ?? {}).find(
          x => x[0].toLowerCase() === "content-type",
        ) ?? [])[1] ?? "";
      if (contentType.includes("application/json")) {
        status.content = await getInnerJson(status.content);
      }
      if (status.file) {
        status.content = Buffer.from(status.file.content, "base64").toString(
          "utf8",
        );
        delete status.file;
      }
    } finally {
      if (jobId !== undefined) {
        fireEngineDelete(
          meta.logger.child({ method: "fireEngineDelete" }),
          jobId,
          meta.mock,
          undefined,
          baseUrl,
        ).catch(e => {
          meta.logger.error("Failed to delete job from Fire Engine", {
            error: e,
          });
        });
      }
    }

    if (abTest.mode === "mirror") {
      scheduleABComparison(
        meta.url,
        { content: status.content, pageStatusCode: status.pageStatusCode },
        Date.now() - startTime,
        abTest.mirrorPromise,
        meta.logger,
      );
    }

    const elapsedMs = Date.now() - startTime;
    setSpanAttributes(span, {
      "fire-engine.duration_ms": elapsedMs,
      "fire-engine.status_code": status.pageStatusCode,
      "fire-engine.content_length": status.content?.length,
      "fire-engine.job_id": jobId,
    });
    meta.logger.debug("chrome-cdp scrape complete", {
      status: status.pageStatusCode,
      elapsedMs,
    });

    return status;
  });
}

async function pollFireEngineStatus(
  meta: Meta,
  jobId: string,
  baseUrl: string,
): Promise<FireEngineCheckStatusSuccess> {
  const errorLimit = 3;
  const errors: any[] = [];

  while (true) {
    meta.abort.throwIfAborted();

    try {
      return await fireEngineCheckStatus(
        meta,
        meta.logger.child({ method: "fireEngineCheckStatus" }),
        jobId,
        meta.mock,
        meta.abort.asSignal(),
        baseUrl,
      );
    } catch (error) {
      if (error instanceof StillProcessingError) {
        // keep polling
      } else if (
        TERMINAL_CHECK_STATUS_ERRORS.some(cls => error instanceof cls) ||
        error instanceof AbortManagerThrownError
      ) {
        throw error;
      } else {
        errors.push(error);
        meta.logger.debug(
          `Unexpected error in checkStatus (attempt ${errors.length}/${errorLimit})`,
          { error, jobId },
        );
        Sentry.captureException(error);
        if (errors.length >= errorLimit) {
          throw new Error("Error limit hit on fire-engine status polling", {
            cause: { errors },
          });
        }
      }
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

function unpackCdpResponse(
  meta: Meta,
  response: FireEngineCheckStatusSuccess,
  actions: InternalAction[],
  proxy: SelectedProxy | undefined,
): Fetched {
  if (!response.url) {
    meta.logger.warn("Fire-engine did not return the response's URL", {
      sourceURL: meta.url,
    });
  }

  let screenshots: string[] | undefined = response.screenshots;
  let screenshotForFormat: string | undefined;
  if (hasFormatOfType(meta.options.formats, "screenshot") && screenshots) {
    screenshotForFormat = screenshots.slice(-1)[0];
    screenshots = screenshots.slice(0, -1);
  }

  const headers: Array<{ name: string; value: string }> = Object.entries(
    response.responseHeaders ?? {},
  ).map(([name, value]) => ({ name, value: String(value) }));
  const contentType = headers.find(
    h => h.name.toLowerCase() === "content-type",
  )?.value;

  const actionsPayload =
    actions.length > 0
      ? {
          screenshots: screenshots ?? [],
          scrapes: response.actionContent ?? [],
          javascriptReturns: parseJavascriptReturns(meta, response),
          pdfs: (response.actionResults ?? [])
            .filter(x => x.type === "pdf")
            .map(x => x.result.link),
        }
      : undefined;

  return {
    source: "chrome-cdp",
    url: response.url ?? meta.url,
    status: response.pageStatusCode,
    headers,
    buffer: Buffer.from(response.content, "utf8"),
    contentType,
    screenshots: screenshotForFormat ? [screenshotForFormat] : undefined,
    actions: actionsPayload,
    pageError: response.pageError,
    proxyUsed: proxy?.isMobile ? "stealth" : "basic",
    youtubeTranscriptContent: response.youtubeTranscriptContent,
    timezone: response.timezone,
  };
}

function parseJavascriptReturns(
  meta: Meta,
  response: FireEngineCheckStatusSuccess,
): { type: string; value: unknown }[] {
  return (response.actionResults ?? [])
    .filter(x => x.type === "executeJavascript")
    .map(x => {
      const raw = (x.result as { return: string }).return;
      try {
        const parsed = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === "object" &&
          "type" in parsed &&
          typeof (parsed as any).type === "string" &&
          "value" in parsed
        ) {
          return {
            type: String((parsed as any).type),
            value: (parsed as any).value,
          };
        }
        return { type: "unknown", value: parsed };
      } catch (error) {
        meta.logger.warn("Failed to parse executeJavascript return", { error });
        return { type: "unknown", value: raw };
      }
    });
}
