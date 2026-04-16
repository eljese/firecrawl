import type { Meta } from "../context";
import type { Document } from "../../../controllers/v2/types";
import { extractLinks } from "../lib/html/extract-links";
import { hasFormatOfType } from "../../../lib/format-utils";
import { indexerQueue } from "../../../services/indexing/indexer-queue";
import { config } from "../../../config";

export async function deriveLinksFromHTML(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (document.html === undefined) {
    throw new Error(
      "html is undefined -- this transformer is being called out of order",
    );
  }

  const rate = config.INDEXER_TRAFFIC_SHARE
    ? Math.max(0, Math.min(1, Number(config.INDEXER_TRAFFIC_SHARE)))
    : 0;

  const shouldForwardTraffic =
    rate > 0 && Math.random() <= rate && !!config.INDEXER_RABBITMQ_URL;

  const forwardToIndexer =
    !!meta.internalOptions.teamId &&
    !meta.internalOptions.teamId?.includes("robots-txt") &&
    !meta.internalOptions.teamId?.includes("sitemap") &&
    shouldForwardTraffic;

  const requiresLinks = !!hasFormatOfType(meta.options.formats, "links");

  if (!forwardToIndexer && !requiresLinks) {
    return document;
  }

  document.links = await extractLinks(
    document.html,
    document.metadata.url ?? document.metadata.sourceURL ?? meta.url,
  );

  if (forwardToIndexer) {
    try {
      const linksDeduped = new Set(document.links ?? []);
      indexerQueue
        .sendToWorker({
          id: meta.id,
          type: "links",
          discovery_url:
            document.metadata.url ?? document.metadata.sourceURL ?? meta.url,
          urls: [...linksDeduped],
        })
        .catch(error => {
          meta.logger.error("Failed to queue links for indexing", {
            error: (error as Error)?.message,
            url: meta.url,
          });
        });
    } catch (error) {
      meta.logger.error("Failed to queue links for indexing", {
        error: (error as Error)?.message,
        url: meta.url,
      });
    }
  }

  if (!requiresLinks) {
    delete document.links;
  }

  return document;
}
