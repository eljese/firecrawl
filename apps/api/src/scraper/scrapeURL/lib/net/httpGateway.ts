import type { Meta } from "../..";
import { config } from "../../../../config";
import type { Fetched } from "../../adapters";
import { proxyToUrl, SelectedProxy } from "./proxyService";

export async function fetchViaHttpGateway(
  meta: Meta,
  opts: { proxy?: SelectedProxy } = {},
): Promise<Fetched> {
  const base = config.FIRE_ENGINE_HTTP_GATEWAY_URL;
  if (!base) throw new Error("FIRE_ENGINE_HTTP_GATEWAY_URL not configured");

  const startedAt = Date.now();
  const res = await fetch(`${base.replace(/\/$/, "")}/forward`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: meta.rewrittenUrl ?? meta.url,
      method: "GET",
      headers: meta.options.headers ?? {},
      // http-gateway's `proxy` field wants a full `http://user:pass@host:port` URL.
      ...(opts.proxy ? { proxy: proxyToUrl(opts.proxy.proxy) } : {}),
    }),
    signal: meta.abort.asSignal(),
  });

  let finalUrl = meta.rewrittenUrl ?? meta.url;
  let contentType: string | undefined;
  const headers: Array<{ name: string; value: string }> = [];

  res.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    // http-gateway sets x-firecrawl-final-url after following redirects so we
    // can re-anchor the document origin. Not a real response header.
    if (lower === "x-firecrawl-final-url") {
      finalUrl = value;
      return;
    }
    if (lower === "content-type") contentType = value;
    headers.push({ name, value });
  });

  const buffer = Buffer.from(await res.arrayBuffer());

  meta.logger.debug("http-gateway forward complete", {
    finalUrl,
    status: res.status,
    bytes: buffer.length,
    elapsedMs: Date.now() - startedAt,
  });

  return {
    source: "gateway",
    url: finalUrl,
    status: res.status,
    headers,
    buffer,
    contentType,
    proxyUsed: opts.proxy?.isMobile ? "stealth" : "basic",
  };
}
