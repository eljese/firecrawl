import { FirecrawlClient } from "../../../v2/client";

describe("v2.parse unit", () => {
  test("rejects empty filenames before making requests", async () => {
    const client = new FirecrawlClient({
      apiKey: "test-key",
      apiUrl: "https://localhost:3002",
    });

    await expect(
      client.parse(
        {
          data: "<html><body>test</body></html>",
          filename: "   ",
          contentType: "text/html",
        },
        { formats: ["markdown"] },
      ),
    ).rejects.toThrow("filename cannot be empty");
  });
});
