import { Response } from "express";
import { v7 as uuidv7 } from "uuid";
import { logger } from "../../lib/logger";
import { getCrawl } from "../../lib/crawl-redis";
import * as Sentry from "@sentry/node";
import { configDotenv } from "dotenv";
import { RequestWithAuth } from "./types";
import { crawlFinishedQueue, crawlGroup } from "../../services/worker/nuq";
configDotenv();

export async function crawlCompleteController(
  req: RequestWithAuth<{ jobId: string }>,
  res: Response,
) {
  try {
    const sc = await getCrawl(req.params.jobId);
    if (!sc) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (sc.team_id !== req.auth.team_id) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const group = await crawlGroup.getGroup(req.params.jobId);
    if (!group) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (group.status === "completed") {
      return res.status(409).json({ error: "Crawl is already completed" });
    }

    await crawlFinishedQueue.addJob(
      uuidv7(),
      {},
      {
        priority: 0,
        ownerId: req.auth.team_id,
        groupId: req.params.jobId,
      },
    );

    res.json({
      status: "completing",
    });
  } catch (error) {
    Sentry.captureException(error);
    logger.error(error);
    return res.status(500).json({ error: error.message });
  }
}
