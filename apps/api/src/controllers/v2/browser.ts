import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { Request, Response } from "express";
import { z } from "zod";
import { logger as _logger } from "../../lib/logger";
import { config } from "../../config";
import {
  insertBrowserSession,
  getBrowserSession,
  getBrowserSessionByBrowserId,
  listBrowserSessions,
  updateBrowserSessionActivity,
  updateBrowserSessionStatus,
  updateBrowserSessionCreditsUsed,
  claimBrowserSessionDestroyed,
  invalidateActiveBrowserSessionCount,
  didBrowserSessionUsePrompt,
  clearBrowserSessionPromptFlag,
} from "../../lib/browser-sessions";
import {
  getConcurrencyLimitActiveJobsCount,
  pushConcurrencyLimitActiveJob,
  removeConcurrencyLimitActiveJob,
} from "../../lib/concurrency-limit";
import { RequestWithAuth } from "./types";
import { billTeam } from "../../services/billing/credit_billing";
import { enqueueBrowserSessionActivity } from "../../lib/browser-session-activity";
import { logRequest } from "../../services/logging/log_job";
import { integrationSchema } from "../../utils/integration";
import {
  BROWSER_CREDITS_PER_HOUR,
  INTERACT_CREDITS_PER_HOUR,
  calculateBrowserSessionCredits,
} from "../../lib/browser-billing";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const browserCreateRequestSchema = z.object({
  ttl: z.number().min(30).max(3600).default(600),
  activityTtl: z.number().min(10).max(3600).default(300),
  streamWebView: z.boolean().default(true),
  integration: integrationSchema.optional().transform(val => val || null),
  profile: z
    .object({
      name: z.string().min(1).max(128),
      saveChanges: z.boolean().default(true),
    })
    .optional(),
});

type BrowserCreateRequest = z.infer<typeof browserCreateRequestSchema>;

interface BrowserCreateResponse {
  success: boolean;
  id?: string;
  cdpUrl?: string;
  liveViewUrl?: string;
  interactiveLiveViewUrl?: string;
  expiresAt?: string;
  error?: string;
}

const browserExecuteRequestSchema = z.object({
  code: z.string().min(1).max(100_000),
  language: z.enum(["python", "node", "bash"]).default("node"),
  timeout: z.number().min(1).max(300).default(30),
  origin: z.string().optional(),
});

type BrowserExecuteRequest = z.infer<typeof browserExecuteRequestSchema>;

interface BrowserExecuteResponse {
  success: boolean;
  stdout?: string;
  result?: string;
  stderr?: string;
  exitCode?: number;
  killed?: boolean;
  error?: string;
}

interface BrowserDeleteResponse {
  success: boolean;
  sessionDurationMs?: number;
  creditsBilled?: number;
  error?: string;
}

interface BrowserListResponse {
  success: boolean;
  sessions?: Array<{
    id: string;
    status: string;
    cdpUrl: string;
    liveViewUrl: string;
    interactiveLiveViewUrl: string;
    streamWebView: boolean;
    createdAt: string;
    lastActivity: string;
  }>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build headers for authenticating against the browser service.
 */
function browserServiceHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(extra ?? {}),
  };
  return headers;
}

class BrowserServiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Call the browser service and return parsed JSON.
 * Throws on non-2xx responses.
 */
async function browserServiceRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.BROWSER_SERVICE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: browserServiceHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new BrowserServiceError(
      res.status,
      `Browser service ${method} ${path} failed (${res.status}): ${text}`,
    );
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Browser service (firebox-controller) response types
// ---------------------------------------------------------------------------

interface BrowserServiceCreateResponse {
  id: string;
  token: string;
  mode: string;
  cdp_url: string;
  selkies_url: string;
  screencast_url: string;
  ttl_seconds: number;
  activity_ttl_seconds: number;
  created_at: string;
  status: string;
}

interface BrowserServiceExecResponse {
  stdout: string;
  result: string;
  stderr: string;
  exit_code: number;
  killed: boolean;
}

interface BrowserServiceDeleteResponse {
  status: string;
}

interface BrowserServiceWebhookEvent {
  eventId?: string;
  eventType?: string;
  reason?: string;
  sessionId?: string;
  sessionDurationMs?: number;
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

export async function browserCreateController(
  req: RequestWithAuth<{}, BrowserCreateResponse, BrowserCreateRequest>,
  res: Response<BrowserCreateResponse>,
) {
  // if (!req.acuc?.flags?.browserBeta) {
  //   return res.status(403).json({
  //     success: false,
  //     error:
  //       "Browser is currently in beta. Please contact support@firecrawl.com to request access.",
  //   });
  // }

  const sessionId = uuidv7();
  const logger = _logger.child({
    sessionId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserCreateController",
  });

  req.body = browserCreateRequestSchema.parse(req.body);

  const { ttl, activityTtl, streamWebView, profile, integration } = req.body;

  if (!config.BROWSER_SERVICE_URL) {
    return res.status(503).json({
      success: false,
      error:
        "Browser feature is not configured (BROWSER_SERVICE_URL is missing).",
    });
  }

  logger.info("Creating browser session", {
    ttl,
    activityTtl,
    profile: profile?.name,
  });

  // 0a. Check if team has enough credits for the full TTL
  const estimatedCredits = calculateBrowserSessionCredits(ttl * 1000);
  if (req.acuc && req.acuc.remaining_credits < estimatedCredits) {
    logger.warn("Insufficient credits for browser session TTL", {
      estimatedCredits,
      remainingCredits: req.acuc.remaining_credits,
      ttl,
    });
    return res.status(402).json({
      success: false,
      error: `Insufficient credits for a ${ttl}s browser session (requires ~${estimatedCredits} credits). For more credits, you can upgrade your plan at https://firecrawl.dev/pricing.`,
    });
  }

  // 0b. Enforce concurrency limit (shared pool with scrape/crawl/interact)
  const concurrencyLimit = req.acuc?.concurrency ?? 2;
  const activeCount = await getConcurrencyLimitActiveJobsCount(
    req.auth.team_id,
  );
  if (activeCount >= concurrencyLimit) {
    logger.warn("Concurrency limit reached for browser session", {
      activeCount,
      limit: concurrencyLimit,
    });
    return res.status(429).json({
      success: false,
      error: `You have reached the maximum number of concurrent jobs (${concurrencyLimit}). Please wait for existing jobs to complete or destroy browser sessions before creating new ones.`,
    });
  }

  // 1. Create a browser session via firebox-controller (retry up to 3 times)
  const MAX_CREATE_RETRIES = 3;
  let svcResponse: BrowserServiceCreateResponse | undefined;
  let lastCreateError: unknown;

  for (let attempt = 1; attempt <= MAX_CREATE_RETRIES; attempt++) {
    try {
      const createPayload: Record<string, unknown> = {
        mode: "sandbox",
        ttl_seconds: ttl,
        activity_ttl_seconds: activityTtl ?? 0,
        customer_id: req.auth.team_id,
      };

      if (profile) {
        const teamHash = createHash("sha256")
          .update(req.auth.team_id)
          .digest("hex")
          .slice(0, 16);
        createPayload.persistent_storage = {
          unique_id: `${teamHash}_${profile.name}`,
          write: profile.saveChanges,
        };
      }

      svcResponse = await browserServiceRequest<BrowserServiceCreateResponse>(
        "POST",
        "/v1/sessions",
        createPayload,
      );
      break;
    } catch (err) {
      if (err instanceof BrowserServiceError && err.status === 409) {
        return res.status(409).json({
          success: false,
          error:
            "Another session is currently writing to this profile. Only one writer is allowed at a time. You can still access it with saveChanges: false, or try again later.",
        });
      }
      lastCreateError = err;
      logger.warn("Browser session creation attempt failed", {
        attempt,
        maxRetries: MAX_CREATE_RETRIES,
        error: err,
      });
      if (attempt < MAX_CREATE_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 200 * attempt));
      }
    }
  }

  if (!svcResponse) {
    logger.error("Failed to create browser session after all retries", {
      error: lastCreateError,
      attempts: MAX_CREATE_RETRIES,
    });
    return res.status(502).json({
      success: false,
      error: "Failed to create browser session.",
    });
  }

  // Build user-facing URLs with embedded auth token
  const tokenQuery = `?token=${svcResponse.token}`;
  const cdpUrl = `${svcResponse.cdp_url}${tokenQuery}`;
  const liveViewUrl = `${svcResponse.screencast_url}${tokenQuery}`;
  const interactiveLiveViewUrl = `${svcResponse.selkies_url}${tokenQuery}`;

  const expiresAt = new Date(
    new Date(svcResponse.created_at).getTime() + svcResponse.ttl_seconds * 1000,
  ).toISOString();

  // 2. Persist session in Supabase
  try {
    await logRequest({
      id: sessionId,
      kind: "browser",
      api_version: "v2",
      team_id: req.auth.team_id,
      target_hint: "Browser session",
      origin: "api",
      integration: integration ?? null,
      zeroDataRetention: false,
      api_key_id: req.acuc!.api_key_id,
    });
    await insertBrowserSession({
      id: sessionId,
      team_id: req.auth.team_id,
      browser_id: svcResponse.id,
      workspace_id: "",
      context_id: "",
      cdp_url: cdpUrl,
      cdp_path: liveViewUrl,
      cdp_interactive_path: interactiveLiveViewUrl,
      stream_web_view: streamWebView,
      status: "active",
      ttl_total: ttl,
      ttl_without_activity: activityTtl ?? null,
      credits_used: null,
    });
  } catch (err) {
    // If we can't persist, tear down the browser session
    logger.error("Failed to persist browser session, cleaning up", {
      error: err,
    });
    await browserServiceRequest(
      "DELETE",
      `/v1/sessions/${svcResponse.id}`,
    ).catch(() => {});
    return res.status(500).json({
      success: false,
      error: "Failed to persist browser session.",
    });
  }

  // Invalidate cached count so next check reflects the new session
  invalidateActiveBrowserSessionCount(req.auth.team_id).catch(() => {});

  // Register in the shared concurrency limiter so this session counts
  // against the team's concurrent job limit while it's active.
  pushConcurrencyLimitActiveJob(req.auth.team_id, sessionId, ttl * 1000).catch(
    () => {},
  );

  logger.info("Browser session created", {
    sessionId,
    browserId: svcResponse.id,
  });

  return res.status(200).json({
    success: true,
    id: sessionId,
    cdpUrl,
    liveViewUrl,
    interactiveLiveViewUrl,
    expiresAt,
  });
}

export async function browserExecuteController(
  req: RequestWithAuth<
    { sessionId: string },
    BrowserExecuteResponse,
    BrowserExecuteRequest
  >,
  res: Response<BrowserExecuteResponse>,
) {
  // if (!req.acuc?.flags?.browserBeta) {
  //   return res.status(403).json({
  //     success: false,
  //     error:
  //       "Browser is currently in beta. Please contact support@firecrawl.com to request access.",
  //   });
  // }

  req.body = browserExecuteRequestSchema.parse(req.body);

  const id = req.params.sessionId;
  const { code, language, timeout, origin } = req.body;

  const logger = _logger.child({
    sessionId: id,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserExecuteController",
  });

  // Look up session from Supabase
  const session = await getBrowserSession(id);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Browser session not found.",
    });
  }

  if (session.team_id !== req.auth.team_id) {
    return res.status(403).json({
      success: false,
      error: "Forbidden.",
    });
  }

  if (session.status === "destroyed") {
    return res.status(410).json({
      success: false,
      error: "Browser session has been destroyed.",
    });
  }

  // Update activity timestamp (fire-and-forget)
  updateBrowserSessionActivity(id).catch(() => {});

  logger.info("Executing code in browser session", { language, timeout });

  // Execute code via firebox-controller
  let execResult: BrowserServiceExecResponse;
  try {
    execResult = await browserServiceRequest<BrowserServiceExecResponse>(
      "POST",
      `/v1/sessions/${session.browser_id}/exec`,
      { code, language, timeout, origin },
    );
  } catch (err) {
    logger.error("Failed to execute code via browser service", { error: err });
    return res.status(502).json({
      success: false,
      error: "Failed to execute code in browser session.",
    });
  }

  logger.debug("Execution result", {
    exitCode: execResult.exit_code,
    killed: execResult.killed,
    stdoutLength: execResult.stdout?.length,
    stderrLength: execResult.stderr?.length,
  });

  enqueueBrowserSessionActivity({
    team_id: req.auth.team_id,
    session_id: id,
    source: "browser",
    language,
    timeout,
    exit_code: execResult.exit_code ?? null,
    killed: execResult.killed ?? false,
  });

  const hasError = execResult.exit_code !== 0 || execResult.killed;

  return res.status(200).json({
    success: true,
    stdout: execResult.stdout,
    result: execResult.result,
    stderr: execResult.stderr,
    exitCode: execResult.exit_code,
    killed: execResult.killed,
    ...(hasError ? { error: execResult.stderr || "Execution failed" } : {}),
  });
}

export async function browserDeleteController(
  req: RequestWithAuth<{ sessionId: string }, BrowserDeleteResponse>,
  res: Response<BrowserDeleteResponse>,
) {
  // if (!req.acuc?.flags?.browserBeta) {
  //   return res.status(403).json({
  //     success: false,
  //     error:
  //       "Browser is currently in beta. Please contact support@firecrawl.com to request access.",
  //   });
  // }

  const id = req.params.sessionId;

  const logger = _logger.child({
    sessionId: id,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserDeleteController",
  });

  const session = await getBrowserSession(id);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Browser session not found.",
    });
  }

  if (session.team_id !== req.auth.team_id) {
    return res.status(403).json({
      success: false,
      error: "Forbidden.",
    });
  }

  logger.info("Deleting browser session");

  // Release the browser session via firebox-controller
  try {
    await browserServiceRequest<BrowserServiceDeleteResponse>(
      "DELETE",
      `/v1/sessions/${session.browser_id}`,
    );
  } catch (err) {
    logger.warn("Failed to delete browser session via browser service", {
      error: err,
    });
  }

  const claimed = await claimBrowserSessionDestroyed(session.id);

  // Invalidate cached count so next check reflects the destroyed session
  invalidateActiveBrowserSessionCount(session.team_id).catch(() => {});
  removeConcurrencyLimitActiveJob(session.team_id, session.id).catch(error => {
    logger.error(
      "Failed to remove concurrency limiter entry for browser session",
      {
        error,
        sessionId: session.id,
        teamId: session.team_id,
      },
    );
  });

  if (!claimed) {
    // The webhook (or another DELETE call) already transitioned and billed.
    logger.info("Session already destroyed by another path, skipping billing", {
      sessionId: session.id,
    });
    return res.status(200).json({
      success: true,
    });
  }

  const durationMs = Date.now() - new Date(session.created_at).getTime();

  const usedPrompt = await didBrowserSessionUsePrompt(session.id);
  const rate = usedPrompt
    ? INTERACT_CREDITS_PER_HOUR
    : BROWSER_CREDITS_PER_HOUR;
  const creditsBilled = calculateBrowserSessionCredits(durationMs, rate);

  clearBrowserSessionPromptFlag(session.id).catch(() => {});

  updateBrowserSessionCreditsUsed(session.id, creditsBilled).catch(error => {
    logger.error("Failed to update credits_used on browser session", {
      error,
      sessionId: session.id,
      creditsBilled,
    });
  });

  billTeam(
    req.auth.team_id,
    req.acuc?.sub_id ?? undefined,
    creditsBilled,
    req.acuc?.api_key_id ?? null,
    { endpoint: usedPrompt ? "interact" : "browser", jobId: session.id },
  ).catch(error => {
    logger.error("Failed to bill team for browser session", {
      error,
      creditsBilled,
      durationMs,
    });
  });

  logger.info("Browser session destroyed", {
    sessionDurationMs: durationMs,
    creditsBilled,
  });

  return res.status(200).json({
    success: true,
  });
}

export async function browserListController(
  req: RequestWithAuth<{}, BrowserListResponse>,
  res: Response<BrowserListResponse>,
) {
  // if (!req.acuc?.flags?.browserBeta) {
  //   return res.status(403).json({
  //     success: false,
  //     error:
  //       "Browser is currently in beta. Please contact support@firecrawl.com to request access.",
  //   });
  // }

  const logger = _logger.child({
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserListController",
  });

  logger.info("Listing browser sessions");

  const statusFilter = (req.query as Record<string, string>).status as
    | "active"
    | "destroyed"
    | undefined;

  const rows = await listBrowserSessions(req.auth.team_id, {
    status: statusFilter,
  });

  return res.status(200).json({
    success: true,
    sessions: rows.map(r => ({
      id: r.id,
      status: r.status,
      cdpUrl: r.cdp_url,
      liveViewUrl: r.cdp_path,
      interactiveLiveViewUrl: r.cdp_interactive_path,
      streamWebView: r.stream_web_view,
      createdAt: r.created_at,
      lastActivity: r.updated_at,
    })),
  });
}

export async function browserWebhookDestroyedController(
  req: Request,
  res: Response,
) {
  const logger = _logger.child({
    module: "api/v2",
    method: "browserWebhookDestroyedController",
  });

  // Validate browser service secret
  const secret = req.headers["x-browser-service-secret"];
  if (
    !config.BROWSER_SERVICE_WEBHOOK_SECRET ||
    !secret ||
    secret !== config.BROWSER_SERVICE_WEBHOOK_SECRET
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const event = req.body as BrowserServiceWebhookEvent;
  const browserId = event.sessionId;
  if (!browserId) {
    return res.status(400).json({ error: "Missing sessionId" });
  }

  logger.info("Received destroyed webhook from browser service", {
    browserId,
    eventType: event.eventType,
    reason: event.reason,
  });

  const session = await getBrowserSessionByBrowserId(browserId);
  if (!session) {
    logger.warn("No session found for destroyed webhook", { browserId });
    return res.status(200).json({ ok: true });
  }

  const claimed = await claimBrowserSessionDestroyed(session.id);

  invalidateActiveBrowserSessionCount(session.team_id).catch(() => {});
  removeConcurrencyLimitActiveJob(session.team_id, session.id).catch(error => {
    logger.error(
      "Failed to remove concurrency limiter entry for browser session via webhook",
      {
        error,
        sessionId: session.id,
        teamId: session.team_id,
      },
    );
  });

  if (!claimed) {
    logger.info("Session already destroyed by another path, skipping billing", {
      sessionId: session.id,
      browserId,
    });
    return res.status(200).json({ ok: true });
  }

  const wallClockMs = Date.now() - new Date(session.created_at).getTime();
  const durationMs =
    event.sessionDurationMs && event.sessionDurationMs > 0
      ? event.sessionDurationMs
      : wallClockMs;

  const usedPrompt = await didBrowserSessionUsePrompt(session.id);
  const rate = usedPrompt
    ? INTERACT_CREDITS_PER_HOUR
    : BROWSER_CREDITS_PER_HOUR;
  const creditsBilled = calculateBrowserSessionCredits(durationMs, rate);

  clearBrowserSessionPromptFlag(session.id).catch(() => {});

  updateBrowserSessionCreditsUsed(session.id, creditsBilled).catch(error => {
    logger.error(
      "Failed to update credits_used on browser session via webhook",
      {
        error,
        sessionId: session.id,
        creditsBilled,
      },
    );
  });

  billTeam(
    session.team_id,
    undefined, // subscription_id — billTeam will look it up
    creditsBilled,
    null, // api_key_id not available in webhook context
    { endpoint: usedPrompt ? "interact" : "browser", jobId: session.id },
  ).catch(error => {
    logger.error("Failed to bill team for browser session via webhook", {
      error,
      teamId: session.team_id,
      sessionId: session.id,
      creditsBilled,
      durationMs,
    });
  });

  logger.info("Session marked as destroyed via webhook", {
    sessionId: session.id,
    browserId,
    durationMs,
    creditsBilled,
    usedPrompt,
    rate,
  });

  return res.status(200).json({ ok: true });
}
