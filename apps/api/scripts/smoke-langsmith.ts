/**
 * Live LangSmith smoke test for the /interact tracing wiring.
 *
 * Runs two simulated interact invocations under a single browser_session_id
 * so you can confirm in the LangSmith UI that:
 *   - prompt-mode (wrapped generateText) + its child tool spans nest correctly
 *   - code-mode (traceInteract) appears as a non-LLM sibling
 *   - both share the same thread_id, grouping them as one conversation
 *
 * Does NOT touch the browser service or fire-engine — the "tool" just returns
 * fake snapshot data so the agent loop terminates quickly.
 *
 * Usage:
 *   cd apps/api
 *   npx tsx scripts/smoke-langsmith.ts
 *
 * Required env (loaded from apps/api/.env by config.ts):
 *   LANGSMITH_API_KEY, LANGSMITH_PROJECT, LANGSMITH_TRACING,
 *   GOOGLE_GENERATIVE_AI_API_KEY (or OPENAI_API_KEY if you switch models)
 */
import { v7 as uuidv7 } from "uuid";
import { tool, stepCountIs } from "ai";
import { z } from "zod";
import { getModel } from "../src/lib/generic-ai";
import {
  generateText,
  buildLangSmithProviderOptions,
  traceInteract,
  isLangSmithEnabled,
  InteractTraceMetadata,
} from "../src/lib/scrape-interact/langsmith";
import { config } from "../src/config";

async function main() {
  if (!isLangSmithEnabled) {
    console.error(
      "LangSmith is disabled. Set LANGSMITH_API_KEY in apps/api/.env to run this smoke.",
    );
    process.exit(1);
  }

  const sessionId = uuidv7();
  const scrapeId = uuidv7();
  const browserId = `browser-${uuidv7().slice(0, 8)}`;
  const teamId = "smoke-team";

  const baseMeta = (mode: "prompt" | "code"): InteractTraceMetadata => ({
    thread_id: sessionId,
    session_id: sessionId,
    scrape_id: scrapeId,
    team_id: teamId,
    browser_id: browserId,
    mode,
  });

  console.log("==== LangSmith smoke ====");
  console.log("Project:      ", config.LANGSMITH_PROJECT ?? "(default)");
  console.log("Endpoint:     ", config.LANGSMITH_ENDPOINT ?? "(default)");
  console.log("thread_id:    ", sessionId);
  console.log("scrape_id:    ", scrapeId);
  console.log("browser_id:   ", browserId);
  console.log("");

  // ------------------------------------------------------------------
  // Run 1: prompt-mode (wrapped generateText + fake browser tool)
  // ------------------------------------------------------------------
  const langsmith = buildLangSmithProviderOptions(baseMeta("prompt"), {
    name: "interact:prompt",
    extra: { smoke: true, prompt_length: 42 },
  });

  console.log("Run 1 (prompt-mode) — calling wrapped generateText…");

  const fakeSnapshotText = [
    "[1] @e1 button 'Search'",
    "[2] @e2 textbox 'Query'",
    "[3] @e3 link 'Pricing'",
  ].join("\n");

  let toolCalls = 0;
  const browserTool = tool({
    description: "Fake agent-browser command runner for smoke testing.",
    inputSchema: z.object({
      code: z.string().describe("agent-browser command"),
    }),
    execute: async ({ code }) => {
      toolCalls++;
      if (code.includes("snapshot")) {
        return { result: fakeSnapshotText };
      }
      if (code.includes("click")) {
        return { result: "clicked" };
      }
      return { result: `stub for ${code}` };
    },
  });

  const t0 = Date.now();
  const result = await generateText({
    model: getModel("gemini-2.5-flash", "google"),
    system:
      "You are a smoke test. Make exactly two tool calls: a 'agent-browser snapshot' then a 'agent-browser click @e3'. Then reply 'done'.",
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: "Simulate two browser actions to produce a trace, then say done.",
          },
        ],
      },
    ],
    tools: { browser: browserTool },
    stopWhen: stepCountIs(5),
    temperature: 0,
    ...(langsmith
      ? { providerOptions: { langsmith } as Record<string, any> }
      : {}),
  });
  console.log(
    `Run 1 complete in ${Date.now() - t0}ms — ${toolCalls} tool call(s). Text: ${(result.text || "").slice(0, 80)}`,
  );

  // ------------------------------------------------------------------
  // Run 2: code-mode (traceInteract on a fake browser exec)
  // ------------------------------------------------------------------
  console.log("");
  console.log("Run 2 (code-mode) — calling traceInteract wrapper…");

  const fakeExec = traceInteract(
    async (payload: { code: string; language: string }) => {
      await new Promise(r => setTimeout(r, 50));
      return {
        stdout: "fake stdout",
        stderr: "",
        exitCode: 0,
        killed: false,
        result: `executed ${payload.language}`,
      };
    },
    baseMeta("code"),
    { name: "interact:code" },
  );

  const t1 = Date.now();
  const execResult = await fakeExec({
    code: "console.log('hello from smoke')",
    language: "node",
  });
  console.log(
    `Run 2 complete in ${Date.now() - t1}ms — exitCode=${execResult.exitCode} result=${execResult.result}`,
  );

  // ------------------------------------------------------------------
  // Flush pending traces, then verify via the LangSmith API that runs for
  // this thread_id actually landed. listRuns is eventually consistent so we
  // retry briefly.
  // ------------------------------------------------------------------
  console.log("");
  console.log("Flushing + verifying traces landed in LangSmith…");

  const { Client } = require("langsmith");
  const lsClient = new Client();
  await lsClient.flush();

  const projectName = config.LANGSMITH_PROJECT ?? undefined;
  const filter = `and(in(metadata_key, ["thread_id","session_id"]), eq(metadata_value, "${sessionId}"))`;

  let found: Array<{ name?: string; id?: string; run_type?: string }> = [];
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    found = [];
    try {
      for await (const run of lsClient.listRuns({
        projectName,
        filter,
        isRoot: true,
      })) {
        found.push(run as { name?: string; id?: string; run_type?: string });
      }
    } catch (err) {
      console.warn(
        "  listRuns error (will retry):",
        err instanceof Error ? err.message : err,
      );
    }
    if (found.length >= 2) break;
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log("");
  console.log(`Root runs found for thread_id=${sessionId}: ${found.length}`);
  for (const r of found) {
    console.log(`  - ${r.run_type ?? "?"} :: ${r.name ?? "(no name)"} :: ${r.id}`);
  }

  console.log("");
  console.log("==== Done ====");
  console.log(
    `Open LangSmith → ${config.LANGSMITH_PROJECT ?? "(default project)"}`,
  );
  console.log(
    `Filter: metadata.thread_id = "${sessionId}"`,
  );

  if (found.length < 2) {
    console.error(
      `Expected 2 root runs (prompt-mode + code-mode), got ${found.length}. Check network / API key.`,
    );
    process.exit(2);
  }
}

main().catch(err => {
  console.error("Smoke failed:", err);
  process.exit(1);
});
