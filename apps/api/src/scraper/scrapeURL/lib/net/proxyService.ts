import type { Logger } from "winston";
import { config } from "../../../../config";

/**
 * A proxy string in fire-engine's native `host:port:user:pass` format, plus a
 * flag indicating whether the proxy is mobile or not.
 */
export type SelectedProxy = {
  /** Raw `host:port` or `host:port:user:pass`. Fire-engine's `customProxy` field accepts this as-is. */
  proxy: string;
  isMobile: boolean;
};

const PROXY_API_TIMEOUT_MS = config.ENV === "local" ? 2500 : 500;

/**
 * Fetch a proxy from the fire-proxy service. Returns undefined if the service
 * is not configured, times out, or returns an error — callers should then
 * proceed without a proxy rather than fail the scrape.
 */
export async function fetchProxy(
  type: "basic" | "mobile",
  country: string | undefined,
  logger: Logger,
  abort?: AbortSignal,
): Promise<SelectedProxy | undefined> {
  const base = config.PROXY_API_URL;
  if (!base) return undefined;

  const params = new URLSearchParams({
    type,
    country: (country ?? "us").toLowerCase(),
    local: config.ENV === "dev" ? "true" : "false",
  });

  const timeout = AbortSignal.timeout(PROXY_API_TIMEOUT_MS);
  const signal = abort ? AbortSignal.any([abort, timeout]) : timeout;

  try {
    const started = Date.now();
    const res = await fetch(`${base.replace(/\/$/, "")}/proxy?${params}`, {
      signal,
    });
    if (!res.ok) {
      logger.warn("proxy-api non-ok response", {
        status: res.status,
        type,
        country,
      });
      return undefined;
    }
    const data = (await res.json()) as { proxy: string; type: string };
    logger.debug("proxy-api selected", {
      type: data.type,
      elapsedMs: Date.now() - started,
    });
    return { proxy: data.proxy, isMobile: data.type === "mobile" };
  } catch (error) {
    logger.warn("proxy-api request failed", { error, type, country });
    return undefined;
  }
}

/**
 * Convert a `host:port[:user:pass]` proxy string into the `http://user:pass@host:port`
 * URL format expected by the http-gateway forward endpoint.
 */
export function proxyToUrl(proxy: string): string {
  const parts = proxy.split(":");
  if (parts.length >= 4) {
    const [host, port, user, pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  if (parts.length >= 2) {
    const [host, port] = parts;
    return `http://${host}:${port}`;
  }
  throw new Error(`Invalid proxy format: ${proxy}`);
}
