import type { Meta } from "../..";
import type { Fetched } from "../../adapters";
import { httpGateway } from "../../../../lib/http-gateway";
import type { SelectedProxy } from "./proxyService";

export async function fetchViaHttpGateway(
  meta: Meta,
  opts: { proxy?: SelectedProxy } = {},
): Promise<Fetched> {
  const startedAt = Date.now();
  const res = await httpGateway(meta.rewrittenUrl ?? meta.url, {
    headers: meta.options.headers,
    proxy: opts.proxy?.proxy,
    signal: meta.abort.asSignal(),
  });
  meta.logger.debug("http-gateway forward complete", {
    status: res.status,
    elapsedMs: Date.now() - startedAt,
  });
  return {
    source: "gateway",
    url: res.url,
    status: res.status,
    headers: res.headers,
    buffer: res.buffer,
    contentType: res.headers.find(h => h.name.toLowerCase() === "content-type")
      ?.value,
    proxyUsed: opts.proxy?.isMobile ? "stealth" : "basic",
  };
}
