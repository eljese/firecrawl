import type { Meta } from "./context";
import type { Document } from "../../controllers/v2/types";
import { hasFormatOfType } from "../../lib/format-utils";

/**
 * Final projection: trim the populated Document down to only the fields the
 * caller actually asked for. Logs a warning whenever a requested format ended
 * up missing (indicates a bug upstream) or a non-requested field slipped in
 * (indicates wasted work upstream).
 */
export function shapeForFormats(meta: Meta, document: Document): Document {
  const hasMarkdown = hasFormatOfType(meta.options.formats, "markdown");
  const hasRawHtml = hasFormatOfType(meta.options.formats, "rawHtml");
  const hasHtml = hasFormatOfType(meta.options.formats, "html");
  const hasLinks = hasFormatOfType(meta.options.formats, "links");
  const hasImages = hasFormatOfType(meta.options.formats, "images");
  const hasChangeTracking = hasFormatOfType(
    meta.options.formats,
    "changeTracking",
  );
  const hasJson = hasFormatOfType(meta.options.formats, "json");
  const hasScreenshot = hasFormatOfType(meta.options.formats, "screenshot");
  const hasSummary = hasFormatOfType(meta.options.formats, "summary");
  const hasBranding = hasFormatOfType(meta.options.formats, "branding");
  const hasQueryFormat = hasFormatOfType(meta.options.formats, "query");

  if (!hasMarkdown && document.markdown !== undefined) {
    delete document.markdown;
  } else if (hasMarkdown && document.markdown === undefined) {
    meta.logger.warn(
      "Request had format: markdown, but there was no markdown field in the result.",
    );
  }

  if (!hasRawHtml && document.rawHtml !== undefined) {
    delete document.rawHtml;
  } else if (hasRawHtml && document.rawHtml === undefined) {
    meta.logger.warn(
      "Request had format: rawHtml, but there was no rawHtml field in the result.",
    );
  }

  if (!hasHtml && document.html !== undefined) {
    delete document.html;
  } else if (hasHtml && document.html === undefined) {
    meta.logger.warn(
      "Request had format: html, but there was no html field in the result.",
    );
  }

  if (!hasScreenshot && document.screenshot !== undefined) {
    meta.logger.warn(
      "Removed screenshot from Document because it wasn't in formats -- this is very wasteful and indicates a bug.",
    );
    delete document.screenshot;
  } else if (hasScreenshot && document.screenshot === undefined) {
    meta.logger.warn(
      "Request had format: screenshot / screenshot@fullPage, but there was no screenshot field in the result.",
    );
  }

  if (!hasLinks && document.links !== undefined) {
    meta.logger.warn(
      "Removed links from Document because it wasn't in formats -- this is wasteful and indicates a bug.",
    );
    delete document.links;
  } else if (hasLinks && document.links === undefined) {
    meta.logger.warn(
      "Request had format: links, but there was no links field in the result.",
    );
  }

  if (!hasImages && document.images !== undefined) {
    meta.logger.warn(
      "Removed images from Document because it wasn't in formats -- this is wasteful and indicates a bug.",
    );
    delete document.images;
  } else if (hasImages && document.images === undefined) {
    meta.logger.warn(
      "Request had format: images, but there was no images field in the result.",
    );
  }

  // V1 backward-compat: preserve document.extract / document.json when v1 caller
  // asked for "extract" or "json" format (v2 uses json but v1 shape stays).
  const shouldKeepExtract = meta.internalOptions.v1OriginalFormat === "extract";
  const shouldKeepJson = meta.internalOptions.v1OriginalFormat === "json";

  if (
    !hasJson &&
    (document.extract !== undefined || document.json !== undefined)
  ) {
    if (!shouldKeepExtract && document.extract !== undefined) {
      meta.logger.warn(
        "Removed extract from Document because it wasn't in formats -- this is extremely wasteful and indicates a bug.",
      );
      delete document.extract;
    }
    if (!shouldKeepJson && document.json !== undefined) {
      meta.logger.warn(
        "Removed json from Document because it wasn't in formats -- this is extremely wasteful and indicates a bug.",
      );
      delete document.json;
    }
  } else if (
    hasJson &&
    document.extract === undefined &&
    document.json === undefined
  ) {
    meta.logger.warn(
      "Request had format json, but there was no json field in the result.",
    );
  }

  if (!hasSummary && document.summary !== undefined) {
    meta.logger.warn(
      "Removed summary from Document because it wasn't in formats -- this is wasteful and indicates a bug.",
    );
    delete document.summary;
  } else if (hasSummary && document.summary === undefined) {
    meta.logger.warn(
      "Request had format summary, but there was no summary field in the result.",
    );
  }

  if (!hasQueryFormat && document.answer !== undefined) {
    meta.logger.warn(
      "Removed answer from Document because query wasn't in formats -- this is wasteful and indicates a bug.",
    );
    delete document.answer;
  } else if (hasQueryFormat && document.answer === undefined) {
    meta.logger.warn(
      "Request had format query, but there was no answer field in the result.",
    );
  }

  if (!hasBranding && document.branding !== undefined) {
    meta.logger.warn(
      "Removed branding from Document because it wasn't in formats -- this indicates the engine returned unexpected data.",
    );
    delete document.branding;
  } else if (hasBranding && document.branding === undefined) {
    meta.logger.warn(
      "Request had format branding, but there was no branding field in the result.",
    );
  }

  const hasAudio = hasFormatOfType(meta.options.formats, "audio");
  if (!hasAudio && document.audio !== undefined) {
    delete document.audio;
  } else if (hasAudio && document.audio === undefined) {
    meta.logger.warn(
      "Request had format: audio, but there was no audio field in the result.",
    );
  }

  if (!hasChangeTracking && document.changeTracking !== undefined) {
    meta.logger.warn(
      "Removed changeTracking from Document because it wasn't in formats -- this is extremely wasteful and indicates a bug.",
    );
    delete document.changeTracking;
  } else if (hasChangeTracking && document.changeTracking === undefined) {
    meta.logger.warn(
      "Request had format changeTracking, but there was no changeTracking field in the result.",
    );
  }

  if (
    document.changeTracking &&
    !hasChangeTracking?.modes?.includes("git-diff") &&
    document.changeTracking.diff !== undefined
  ) {
    meta.logger.warn(
      "Removed diff from changeTracking because git-diff mode wasn't specified in changeTrackingOptions.modes.",
    );
    delete document.changeTracking.diff;
  }

  if (
    document.changeTracking &&
    !hasChangeTracking?.modes?.includes("json") &&
    document.changeTracking.json !== undefined
  ) {
    meta.logger.warn(
      "Removed structured from changeTracking because structured mode wasn't specified in changeTrackingOptions.modes.",
    );
    delete document.changeTracking.json;
  }

  if (meta.options.actions === undefined || meta.options.actions.length === 0) {
    delete document.actions;
  } else if (document.actions) {
    const hasScreenshots =
      document.actions.screenshots && document.actions.screenshots.length > 0;
    const hasScrapes =
      document.actions.scrapes && document.actions.scrapes.length > 0;
    const hasJsReturns =
      document.actions.javascriptReturns &&
      document.actions.javascriptReturns.length > 0;
    const hasPdfs = document.actions.pdfs && document.actions.pdfs.length > 0;
    if (!hasScreenshots && !hasScrapes && !hasJsReturns && !hasPdfs) {
      delete document.actions;
    }
  }

  return document;
}
