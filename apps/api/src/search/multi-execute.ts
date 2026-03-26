import type { Logger } from "winston";
import { type WebSearchResult, SearchV2Response } from "../lib/entities";
import { ScrapeOptions } from "../controllers/v2/types";
import {
  getItemsToScrape,
  scrapeSearchResults,
  mergeScrapedContent,
  calculateScrapeCredits,
} from "./scrape";
import {
  executeSearch,
  SearchOptions,
  SearchContext,
  SearchExecuteResult,
} from "./execute";

interface MultiSearchQuery {
  query: string;
  limit: number;
}

export interface DecomposedQueryResult {
  query: string;
  results: WebSearchResult[];
}

export interface MultiSearchExecuteResult {
  originalQuery?: string;
  queries: DecomposedQueryResult[];
  totalResultsCount: number;
  searchCredits: number;
  scrapeCredits: number;
  totalCredits: number;
  shouldScrape: boolean;
}

export async function executeMultiSearch(
  originalQuery: string | undefined,
  queries: MultiSearchQuery[],
  baseOptions: Omit<SearchOptions, "query" | "limit" | "scrapeOptions">,
  scrapeOptions: ScrapeOptions | undefined,
  context: SearchContext,
  totalLimit: number,
  logger: Logger,
): Promise<MultiSearchExecuteResult> {
  logger.info("Starting multi-search execution", {
    queryCount: queries.length,
    totalLimit,
  });

  // Run all sub-queries in parallel WITHOUT scraping (scrape after dedup)
  // Use allSettled so one failing sub-query doesn't kill the whole operation
  const settled = await Promise.allSettled(
    queries.map((q, i) =>
      executeSearch(
        {
          ...baseOptions,
          query: q.query,
          limit: q.limit,
          scrapeOptions: undefined,
        },
        context,
        logger.child({ subQuery: i, query: q.query }),
      ),
    ),
  );

  // Collect results, track which query they belong to
  const queryResults: DecomposedQueryResult[] = [];
  const seenUrls = new Set<string>();
  let searchCredits = 0;
  let totalResultsCount = 0;

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled") {
      searchCredits += s.value.searchCredits;

      // Dedup within and across queries
      const dedupedResults: WebSearchResult[] = [];
      for (const item of s.value.response.web ?? []) {
        const norm = normalizeUrl(item.url);
        if (!seenUrls.has(norm)) {
          seenUrls.add(norm);
          dedupedResults.push(item);
        }
      }

      queryResults.push({
        query: queries[i].query,
        results: dedupedResults,
      });
      totalResultsCount += dedupedResults.length;
    } else {
      logger.warn("Sub-query failed, continuing with remaining results", {
        error: s.reason?.message,
        query: queries[i].query,
      });
      // Still include the query with empty results
      queryResults.push({
        query: queries[i].query,
        results: [],
      });
    }
  }

  if (totalResultsCount === 0 && settled.every(s => s.status === "rejected")) {
    const firstRejected = settled.find(
      r => r.status === "rejected",
    ) as PromiseRejectedResult;
    throw firstRejected.reason;
  }

  // Apply top-level limit across all queries
  let remaining = totalLimit;
  for (const qr of queryResults) {
    if (remaining <= 0) {
      qr.results = [];
    } else if (qr.results.length > remaining) {
      qr.results = qr.results.slice(0, remaining);
    }
    remaining -= qr.results.length;
  }

  // Recalculate after limit
  totalResultsCount = queryResults.reduce(
    (sum, qr) => sum + qr.results.length,
    0,
  );

  // Single scrape pass on all unique results across queries
  let scrapeCredits = 0;
  const shouldScrape =
    scrapeOptions?.formats && scrapeOptions.formats.length > 0;

  if (shouldScrape && scrapeOptions) {
    // Collect all results into a temporary SearchV2Response for scraping
    const allResults = queryResults.flatMap(qr => qr.results);
    const tempResponse: SearchV2Response = { web: allResults };
    const itemsToScrape = getItemsToScrape(tempResponse, context.flags);

    if (itemsToScrape.length > 0) {
      const scrapeOpts = {
        teamId: context.teamId,
        origin: context.origin,
        timeout: baseOptions.timeout,
        scrapeOptions,
        bypassBilling: context.bypassBilling ?? false,
        apiKeyId: context.apiKeyId,
        zeroDataRetention: context.zeroDataRetention,
        requestId: context.requestId,
        billing: context.billing,
        agentIndexOnly: context.agentIndexOnly,
      };

      const allDocsWithCostTracking = await scrapeSearchResults(
        itemsToScrape.map(i => i.scrapeInput),
        scrapeOpts,
        logger,
        context.flags,
      );

      mergeScrapedContent(tempResponse, itemsToScrape, allDocsWithCostTracking);
      scrapeCredits = calculateScrapeCredits(allDocsWithCostTracking);

      // The scrape mutated the items in-place via tempResponse.web,
      // which are the same object references in queryResults
    }
  }

  return {
    originalQuery,
    queries: queryResults,
    totalResultsCount,
    searchCredits,
    scrapeCredits,
    totalCredits: searchCredits + scrapeCredits,
    shouldScrape: shouldScrape ?? false,
  };
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    return u.toString();
  } catch {
    return url;
  }
}
