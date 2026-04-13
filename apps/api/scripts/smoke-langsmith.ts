/**
 * Live LangSmith smoke test for the /interact tracing wiring.
 *
 * Simulates a real interact session: one browser session that receives
 * multiple /interact calls interleaving prompt-mode and code-mode. Each call
 * is a separate root run in LangSmith; they all share the same thread_id so
 * they weave into a single conversation thread in the LangSmith UI.
 *
 * Produces four root runs under one thread_id:
 *   1. prompt-mode  — "find the pricing link"
 *   2. code-mode    — console.log follow-up
 *   3. prompt-mode  — "click the pricing link"
 *   4. code-mode    — grab page title
 *
 * Does NOT touch the browser service or fire-engine — the "tool" returns
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

  console.log("==== LangSmith smoke — thread weaving ====");
  console.log("Project:      ", config.LANGSMITH_PROJECT ?? "(default)");
  console.log("Endpoint:     ", config.LANGSMITH_ENDPOINT ?? "(default)");
  console.log("thread_id:    ", sessionId);
  console.log("scrape_id:    ", scrapeId);
  console.log("browser_id:   ", browserId);
  console.log("");

  const fakeSnapshotText = [
    "[1] @e1 button 'Search'",
    "[2] @e2 textbox 'Query'",
    "[3] @e3 link 'Pricing'",
  ].join("\n");

  // Fake browser tool that mimics the real agent's tool — returns stubbed
  // snapshot / click output so the Gemini loop can terminate quickly.
  const makeBrowserTool = () => {
    let toolCalls = 0;
    const t = tool({
      description: "Fake agent-browser command runner for smoke testing.",
      inputSchema: z.object({
        code: z.string().describe("agent-browser command"),
      }),
      execute: async ({ code }) => {
        toolCalls++;
        if (code.includes("snapshot")) return { result: fakeSnapshotText };
        if (code.includes("click")) return { result: "clicked" };
        if (code.includes("get title"))
          return { result: "Pricing — Firecrawl" };
        return { result: `stub for ${code}` };
      },
    });
    return { tool: t, calls: () => toolCalls };
  };

  // Shared traced code-exec — rebuilt per call so metadata is per-invocation.
  const makeTracedExec = (meta: InteractTraceMetadata) =>
    traceInteract(
      async (payload: { code: string; language: string }) => {
        await new Promise(r => setTimeout(r, 40));
        return {
          stdout: `echo: ${payload.code}`,
          stderr: "",
          exitCode: 0,
          killed: false,
          result: `executed ${payload.language}`,
        };
      },
      meta,
      { name: "interact:code" },
    );

  // Drives one prompt-mode invocation against the fake tool.
  const runPrompt = async (
    label: string,
    taskDescription: string,
    systemHint: string,
  ) => {
    const { tool: browserTool, calls } = makeBrowserTool();
    const langsmith = buildLangSmithProviderOptions(baseMeta("prompt"), {
      name: "interact:prompt",
      extra: { smoke: true, label },
    });
    const t0 = Date.now();
    const result = await generateText({
      model: getModel("gemini-2.5-flash", "google"),
      system: `You are a smoke test. ${systemHint} After the tool calls, reply 'done'.`,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: taskDescription }],
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
      `  ${label} complete in ${Date.now() - t0}ms — ${calls()} tool call(s). Text: ${(result.text || "").slice(0, 60)}`,
    );
  };

  const runCode = async (
    label: string,
    code: string,
    language: "node" | "python" | "bash" = "node",
  ) => {
    const tracedExec = makeTracedExec(baseMeta("code"));
    const t0 = Date.now();
    const execResult = await tracedExec({ code, language });
    console.log(
      `  ${label} complete in ${Date.now() - t0}ms — exitCode=${execResult.exitCode} result=${execResult.result}`,
    );
  };

  // ------------------------------------------------------------------
  // Interleave prompt + code invocations against the same session.
  // Each is a separate root run; they all share the same thread_id.
  // ------------------------------------------------------------------
  console.log("Invocation 1 (prompt-mode) — find the pricing link");
  await runPrompt(
    "Invocation 1",
    "Simulate finding the pricing link: call 'agent-browser snapshot'.",
    "Make exactly one tool call: 'agent-browser snapshot'.",
  );

  console.log("Invocation 2 (code-mode) — console.log follow-up");
  await runCode("Invocation 2", "console.log('pricing found')");

  console.log("Invocation 3 (prompt-mode) — click the pricing link");
  await runPrompt(
    "Invocation 3",
    "Simulate clicking the pricing link: call 'agent-browser click @e3'.",
    "Make exactly one tool call: 'agent-browser click @e3'.",
  );

  console.log("Invocation 4 (code-mode) — grab page title via JS");
  await runCode(
    "Invocation 4",
    "const t = await page.title(); console.log(t);",
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

  const expectedRoots = 4;
  type LsRun = {
    name?: string;
    id?: string;
    run_type?: string;
    start_time?: string;
    extra?: { metadata?: Record<string, unknown> };
  };

  let found: LsRun[] = [];
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    found = [];
    try {
      for await (const run of lsClient.listRuns({
        projectName,
        filter,
        isRoot: true,
      })) {
        found.push(run as LsRun);
      }
    } catch (err) {
      console.warn(
        "  listRuns error (will retry):",
        err instanceof Error ? err.message : err,
      );
    }
    if (found.length >= expectedRoots) break;
    await new Promise(r => setTimeout(r, 1500));
  }

  // Sort by start_time so the order matches the invocation order.
  found.sort((a, b) => {
    const ta = a.start_time ? Date.parse(a.start_time) : 0;
    const tb = b.start_time ? Date.parse(b.start_time) : 0;
    return ta - tb;
  });

  console.log("");
  console.log(
    `Root runs found for thread_id=${sessionId}: ${found.length} (expected ${expectedRoots})`,
  );
  for (const r of found) {
    const meta = r.extra?.metadata ?? {};
    const mode = (meta as { mode?: string }).mode ?? "?";
    console.log(`  - [${mode.padEnd(6)}] ${r.name ?? "(no name)"} :: ${r.id}`);
  }

  const threadIdsMatch = found.every(
    r =>
      (r.extra?.metadata as { thread_id?: string } | undefined)?.thread_id ===
      sessionId,
  );
  console.log(
    `All runs share thread_id=${sessionId}? ${threadIdsMatch ? "yes" : "no"}`,
  );

  console.log("");
  console.log("==== Done ====");
  console.log(
    `Open LangSmith → ${config.LANGSMITH_PROJECT ?? "(default project)"}`,
  );
  console.log(`Filter: metadata.thread_id = "${sessionId}"`);

  if (found.length < expectedRoots || !threadIdsMatch) {
    console.error(
      `Expected ${expectedRoots} root runs sharing thread_id, got ${found.length} (thread match: ${threadIdsMatch}).`,
    );
    process.exit(2);
  }
}

main().catch(err => {
  console.error("Smoke failed:", err);
  process.exit(1);
});
