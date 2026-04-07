import { Meta } from "../..";
import { config } from "../../../../config";
import { robustFetch } from "../../lib/fetch";
import { z } from "zod";
import * as marked from "marked";
import type { PDFProcessorResult } from "./types";
import { computeSimilarityMetrics } from "./similarityMetrics";
import {
  getPdfResultFromCache,
  savePdfResultToCache,
} from "../../../../lib/gcs-pdf-cache";

export function runSelfHostedOCRExperiment(
  meta: Meta,
  base64Content: string,
  muV1Result: { markdown: string; durationMs: number },
  maxPages?: number,
  pagesProcessed?: number,
): void {
  if (
    !config.PDF_OCR_EXPERIMENT_ENABLE ||
    !config.PDF_OCR_BASE_URL ||
    Math.random() * 100 >= config.PDF_OCR_EXPERIMENT_PERCENT
  ) {
    return;
  }

  (async () => {
    const startedAt = Date.now();
    const logger = meta.logger.child({ method: "scrapePDF/selfHostedOCR" });
    try {
      const resp = await robustFetch({
        url: `${config.PDF_OCR_BASE_URL}/ocr`,
        method: "POST",
        headers: config.PDF_OCR_API_KEY
          ? { Authorization: `Bearer ${config.PDF_OCR_API_KEY}` }
          : undefined,
        body: {
          pdf: base64Content,
          scrape_id: meta.id,
          ...(maxPages !== undefined && { max_pages: maxPages }),
        },
        logger,
        schema: z.object({
          markdown: z.string(),
          failed_pages: z.array(z.number()).nullable(),
          pages_processed: z.number().optional(),
        }),
        mock: meta.mock,
        abort: meta.abort.asSignal(),
      });
      const ocrDurationMs = Date.now() - startedAt;
      const similarity = computeSimilarityMetrics(
        resp.markdown,
        muV1Result.markdown,
      );
      const pages = resp.pages_processed ?? pagesProcessed;
      const timeDiffMs = muV1Result.durationMs - ocrDurationMs;
      const speedup =
        muV1Result.durationMs > 0 && ocrDurationMs > 0
          ? Math.round((muV1Result.durationMs / ocrDurationMs) * 100) / 100
          : undefined;

      logger.info("Self-hosted OCR experiment completed", {
        scrapeId: meta.id,
        url: meta.rewrittenUrl ?? meta.url,
        ocrDurationMs,
        muV1DurationMs: muV1Result.durationMs,
        timeDiffMs,
        speedup,
        ocrMarkdownLength: resp.markdown.length,
        muV1MarkdownLength: muV1Result.markdown.length,
        wordSimilarity: similarity.jaccard,
        wordSimilarityPrecision: similarity.precision,
        wordSimilarityRecall: similarity.recall,
        wordSimilarityF1: similarity.f1,
        failedPages: resp.failed_pages,
        pagesProcessed: pages,
        ocrPerPageMs: pages ? Math.round(ocrDurationMs / pages) : undefined,
        muV1PerPageMs: pages
          ? Math.round(muV1Result.durationMs / pages)
          : undefined,
      });
    } catch {
      // Non-blocking: instance may be down at any time, silently skip
    }
  })();
}

export async function scrapePDFWithFirePDF(
  meta: Meta,
  base64Content: string,
  maxPages?: number,
  pagesProcessed?: number,
): Promise<PDFProcessorResult> {
  const logger = meta.logger.child({ method: "scrapePDF/firePDF" });

  if (!maxPages && !meta.internalOptions.zeroDataRetention) {
    try {
      const cached = await getPdfResultFromCache(base64Content, "firepdf");
      if (cached) {
        logger.info("Using cached Fire PDF result", {
          scrapeId: meta.id,
        });
        return cached;
      }
    } catch (error) {
      logger.warn("Error checking Fire PDF cache, proceeding", { error });
    }
  }

  meta.abort.throwIfAborted();

  const startedAt = Date.now();

  logger.info("Fire PDF started", {
    scrapeId: meta.id,
    url: meta.rewrittenUrl ?? meta.url,
    maxPages,
    pagesProcessed,
  });

  const resp = await robustFetch({
    url: `${config.FIRE_PDF_BASE_URL}/ocr`,
    method: "POST",
    headers: config.FIRE_PDF_API_KEY
      ? { Authorization: `Bearer ${config.FIRE_PDF_API_KEY}` }
      : undefined,
    body: {
      pdf: base64Content,
      scrape_id: meta.id,
      ...(maxPages !== undefined && { max_pages: maxPages }),
    },
    logger,
    schema: z.object({
      markdown: z.string(),
      failed_pages: z.array(z.number()).nullable(),
      pages_processed: z.number().optional(),
    }),
    mock: meta.mock,
    abort: meta.abort.asSignal(),
  });

  const durationMs = Date.now() - startedAt;
  const pages = resp.pages_processed ?? pagesProcessed;

  logger.info("Fire PDF completed", {
    scrapeId: meta.id,
    url: meta.rewrittenUrl ?? meta.url,
    durationMs,
    markdownLength: resp.markdown.length,
    failedPages: resp.failed_pages,
    pagesProcessed: pages,
    perPageMs: pages ? Math.round(durationMs / pages) : undefined,
  });

  const processorResult = {
    markdown: resp.markdown,
    html: await marked.parse(resp.markdown, { async: true }),
  };

  if (!maxPages && !meta.internalOptions.zeroDataRetention) {
    try {
      await savePdfResultToCache(base64Content, processorResult, "firepdf");
    } catch (error) {
      logger.warn("Error saving Fire PDF result to cache", { error });
    }
  }

  return processorResult;
}
