import { concurrentIf, HAS_AI, TEST_PRODUCTION } from "../lib";
import {
  scrape,
  scrapeRaw,
  scrapeWithFailure,
  scrapeTimeout,
  idmux,
  Identity,
} from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape-query",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

describe("Query format", () => {
  concurrentIf(TEST_PRODUCTION || HAS_AI)(
    "returns a non-empty answer for a valid query",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: [{ type: "query", prompt: "What is Firecrawl?" }],
        },
        identity,
      );

      expect(response.answer).toBeDefined();
      expect(typeof response.answer).toBe("string");
      expect(response.answer!.length).toBeGreaterThan(0);
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_PRODUCTION || HAS_AI)(
    "returns both answer and markdown when formats include markdown and query",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: [
            "markdown",
            { type: "query", prompt: "What is Firecrawl?" },
          ],
        },
        identity,
      );

      expect(response.answer).toBeDefined();
      expect(typeof response.answer).toBe("string");
      expect(response.answer!.length).toBeGreaterThan(0);
      expect(response.markdown).toBeDefined();
      expect(typeof response.markdown).toBe("string");
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_PRODUCTION || HAS_AI)(
    "does not include answer field when query format is not provided",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: ["markdown"],
        },
        identity,
      );

      expect(response.answer).toBeUndefined();
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_PRODUCTION || HAS_AI)(
    "returns citations with character positions when citations: true",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: [
            "markdown",
            { type: "query", prompt: "What is Firecrawl?", citations: true },
          ],
        },
        identity,
      );

      expect(response.answer).toBeDefined();
      expect(response.answer!.length).toBeGreaterThan(0);
      expect(response.citations).toBeDefined();
      expect(Array.isArray(response.citations)).toBe(true);
      expect(response.citations!.length).toBeGreaterThan(0);

      for (const citation of response.citations!) {
        expect(typeof citation.quote).toBe("string");
        expect(citation.quote.length).toBeGreaterThan(0);
        expect(typeof citation.startIndex).toBe("number");
        expect(typeof citation.endIndex).toBe("number");
        expect(citation.endIndex).toBeGreaterThan(citation.startIndex);

        // Verify the citation actually exists in the markdown at the stated position
        const slice = response.markdown!.slice(
          citation.startIndex,
          citation.endIndex,
        );
        expect(slice).toBe(citation.quote);
      }
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_PRODUCTION || HAS_AI)(
    "does not return citations when citations is not set",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: [{ type: "query", prompt: "What is Firecrawl?" }],
        },
        identity,
      );

      expect(response.answer).toBeDefined();
      expect(response.citations).toBeUndefined();
    },
    scrapeTimeout,
  );

  it(
    "rejects query prompt over 10000 characters",
    async () => {
      const longPrompt = "a".repeat(10001);
      const response = await scrapeWithFailure(
        {
          url: "https://firecrawl.dev",
          formats: [{ type: "query", prompt: longPrompt }],
        } as any,
        identity,
      );

      expect(response.success).toBe(false);
      expect(response.error).toBeDefined();
    },
    scrapeTimeout,
  );
});
