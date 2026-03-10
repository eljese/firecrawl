/**
 * Unit tests for AutumnService.
 *
 * All external I/O is mocked:
 *   - autumnClient  →  jest.fn() stubs on customers / entities / track
 *   - supabase_rr_service  →  stubbed Supabase query builder
 *   - getACUCTeam  →  jest.fn() returning configurable ACUC chunks
 */

import { jest } from "@jest/globals";

// ---------------------------------------------------------------------------
// Mocks — must be declared before the import under test so Jest hoists them.
// ---------------------------------------------------------------------------

const mockTrack = jest.fn<(args: any) => Promise<void>>().mockResolvedValue(undefined);
const mockGetOrCreate = jest.fn<(args: any) => Promise<unknown>>().mockResolvedValue({ id: "org-1" });
const mockEntityGet = jest.fn<(args: any) => Promise<unknown>>();
const mockEntityCreate = jest.fn<(args: any) => Promise<unknown>>();

const mockAutumnClient = {
  customers: { getOrCreate: mockGetOrCreate },
  entities: { get: mockEntityGet, create: mockEntityCreate },
  track: mockTrack,
};

// Mutable reference so individual tests can set it to null to simulate missing key.
let autumnClientRef: typeof mockAutumnClient | null = mockAutumnClient;

jest.mock("../client", () => ({
  get autumnClient() {
    return autumnClientRef;
  },
}));

const mockGetACUCTeam = jest.fn<(...args: any[]) => Promise<unknown>>();

jest.mock("../../../controllers/auth", () => ({
  getACUCTeam: (...args: any[]) => mockGetACUCTeam(...args),
}));

// Minimal Supabase query-builder stub: .from().select().eq().single() → resolves data/error.
const makeSupabaseStub = (data: unknown, error: unknown = null) => ({
  from: () => ({
    select: () => ({
      eq: () => ({
        single: () => Promise.resolve({ data, error }),
        gte: () => Promise.resolve({ data: [], error: null }),
      }),
      gte: () => Promise.resolve({ data: [], error: null }),
    }),
  }),
});

let supabaseStubData: { data: unknown; error: unknown } = {
  data: { org_id: "org-1" },
  error: null,
};

jest.mock("../../supabase", () => ({
  get supabase_rr_service() {
    return makeSupabaseStub(supabaseStubData.data, supabaseStubData.error);
  },
}));

// Import AFTER mocks are wired up.
import { AutumnService, BoundedMap, BoundedSet } from "../autumn.service";
import { RateLimiterMode } from "../../../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService() {
  return new AutumnService();
}

function makeAcucChunk(adjusted_credits_used: number) {
  return {
    adjusted_credits_used,
    sub_current_period_start: "2024-01-01",
    sub_current_period_end: "2024-02-01",
  };
}

function makeEntity(usage: number) {
  return { balances: { CREDITS: { usage } } };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  autumnClientRef = mockAutumnClient;
  supabaseStubData = { data: { org_id: "org-1" }, error: null };
  mockEntityGet.mockResolvedValue(makeEntity(0));
  mockEntityCreate.mockResolvedValue({ id: "team-1" });
  mockGetACUCTeam.mockResolvedValue(makeAcucChunk(0));
});

// ---------------------------------------------------------------------------
// BoundedMap / BoundedSet (via observable side-effects on the caches)
// ---------------------------------------------------------------------------

describe("BoundedMap eviction", () => {
  it("never exceeds its cap", () => {
    const m = new BoundedMap<number, number>(3);
    m.set(1, 1); m.set(2, 2); m.set(3, 3);
    expect(m.size).toBe(3);
    m.set(4, 4); // evicts key 1
    expect(m.size).toBe(3);
    expect(m.has(1)).toBe(false);
    expect(m.has(4)).toBe(true);
  });

  it("does not evict on update of existing key", () => {
    const m = new BoundedMap<number, number>(2);
    m.set(1, 1); m.set(2, 2);
    m.set(1, 99); // update, not a new entry
    expect(m.size).toBe(2);
    expect(m.get(1)).toBe(99);
    expect(m.has(2)).toBe(true);
  });
});

describe("BoundedSet eviction", () => {
  it("never exceeds its cap", () => {
    const s = new BoundedSet<number>(3);
    s.add(1); s.add(2); s.add(3);
    expect(s.size).toBe(3);
    s.add(4); // evicts value 1
    expect(s.size).toBe(3);
    expect(s.has(1)).toBe(false);
    expect(s.has(4)).toBe(true);
  });

  it("does not evict on re-add of existing value", () => {
    const s = new BoundedSet<number>(2);
    s.add(1); s.add(2);
    s.add(1); // already present, no eviction
    expect(s.size).toBe(2);
    expect(s.has(2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ensureTeamProvisioned
// ---------------------------------------------------------------------------

describe("ensureTeamProvisioned", () => {
  it("skips all HTTP calls for preview teams", async () => {
    const svc = makeService();
    await svc.ensureTeamProvisioned({ teamId: "preview_abc", orgId: "org-1" });
    expect(mockEntityGet).not.toHaveBeenCalled();
    expect(mockEntityCreate).not.toHaveBeenCalled();
  });

  it("skips getEntity when team is already in ensuredTeams cache", async () => {
    const svc = makeService();
    // First call — populates cache.
    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });
    const callsAfterFirst = mockEntityGet.mock.calls.length;

    // Second call — should be a no-op.
    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });
    expect(mockEntityGet.mock.calls.length).toBe(callsAfterFirst);
  });

  it("marks team as ensured without a second getEntity when entity already exists", async () => {
    const svc = makeService();
    mockEntityGet.mockResolvedValue(makeEntity(10));

    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });

    // getEntity called once (existence check), createEntity never called.
    expect(mockEntityGet).toHaveBeenCalledTimes(1);
    expect(mockEntityCreate).not.toHaveBeenCalled();

    // Second call — team is cached, zero additional HTTP calls.
    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });
    expect(mockEntityGet).toHaveBeenCalledTimes(1);
  });

  it("marks team as ensured without a second getEntity when createEntity succeeds", async () => {
    const svc = makeService();
    // First getEntity returns null → entity doesn't exist yet.
    mockEntityGet.mockResolvedValue(null);
    mockEntityCreate.mockResolvedValue({ id: "team-1" });

    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });

    // Only one getEntity call (no confirmation get).
    expect(mockEntityGet).toHaveBeenCalledTimes(1);
    expect(mockEntityCreate).toHaveBeenCalledTimes(1);
  });

  it("marks team as ensured on 409 conflict without a second getEntity", async () => {
    const svc = makeService();
    mockEntityGet.mockResolvedValue(null);
    // createEntity returns null to simulate 409 — the mock throws a 409 error
    // to exercise the conflict branch inside createEntity.
    mockEntityCreate.mockRejectedValue(
      Object.assign(new Error("conflict"), { status: 409 }),
    );

    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });

    expect(mockEntityGet).toHaveBeenCalledTimes(1);
    // Team should still be marked as ensured (entity exists, just raced).
    // Verify by checking that a second provisioning call makes zero HTTP requests.
    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });
    expect(mockEntityGet).toHaveBeenCalledTimes(1);
  });

  it("does NOT mark team as ensured when createEntity has a genuine error", async () => {
    const svc = makeService();
    mockEntityGet.mockResolvedValue(null);
    mockEntityCreate.mockRejectedValue(
      Object.assign(new Error("server error"), { status: 500 }),
    );

    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });

    // Second call must re-attempt (team not cached).
    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });
    expect(mockEntityGet).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// ensureTrackingContext short-circuit (both caches warm)
// ---------------------------------------------------------------------------

describe("ensureTrackingContext warm-cache short-circuit", () => {
  it("makes zero provisioning HTTP calls when both caches are warm", async () => {
    const svc = makeService();
    mockEntityGet.mockResolvedValue(makeEntity(0));

    // Warm the caches.
    await svc.reserveCredits({ teamId: "team-1", value: 5 });
    const callsAfterWarm = mockEntityGet.mock.calls.length;

    // Subsequent call — should not touch provisioning.
    mockGetACUCTeam.mockResolvedValue(makeAcucChunk(0));
    await svc.reserveCredits({ teamId: "team-1", value: 5 });

    // No additional getEntity calls for provisioning.
    expect(mockEntityGet.mock.calls.length).toBe(callsAfterWarm);
  });
});

// ---------------------------------------------------------------------------
// reserveCredits
// ---------------------------------------------------------------------------

describe("reserveCredits", () => {
  it("returns false when autumnClient is null", async () => {
    autumnClientRef = null;
    const svc = makeService();
    const result = await svc.reserveCredits({ teamId: "team-1", value: 10 });
    expect(result).toBe(false);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("returns false for preview teams", async () => {
    const svc = makeService();
    const result = await svc.reserveCredits({ teamId: "preview_abc", value: 10 });
    expect(result).toBe(false);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("calls track with correct feature and value on happy path", async () => {
    const svc = makeService();
    mockGetACUCTeam.mockResolvedValue(makeAcucChunk(0));

    const result = await svc.reserveCredits({
      teamId: "team-1",
      value: 42,
      properties: { source: "test" },
    });

    expect(result).toBe(true);
    // track should have been called for the actual usage event (at minimum).
    const trackCalls = mockTrack.mock.calls;
    const usageCall = trackCalls.find(
      (c: any[]) => c[0].featureId === "CREDITS" && c[0].value === 42,
    );
    expect(usageCall).toBeDefined();
  });

  it("does not call backfill track when firecrawlTotal is 0", async () => {
    const svc = makeService();
    mockGetACUCTeam.mockResolvedValue(makeAcucChunk(0));
    mockEntityGet.mockResolvedValue(makeEntity(0));

    await svc.reserveCredits({ teamId: "team-1", value: 10 });

    // Only one track call — the actual usage event; no backfill.
    const backfillCall = mockTrack.mock.calls.find(
      (c: any[]) => c[0]?.properties?.source === "autumn_backfill",
    );
    expect(backfillCall).toBeUndefined();
  });

  it("still calls track even if backfill throws", async () => {
    const svc = makeService();
    // Force backfill to fail by making getACUCTeam throw.
    mockGetACUCTeam.mockRejectedValue(new Error("ACUC unavailable"));

    const result = await svc.reserveCredits({ teamId: "team-1", value: 5 });

    expect(result).toBe(true);
    const usageCall = mockTrack.mock.calls.find(
      (c: any[]) => c[0].value === 5,
    );
    expect(usageCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// refundCredits
// ---------------------------------------------------------------------------

describe("refundCredits", () => {
  it("calls track with the negated value", async () => {
    const svc = makeService();
    await svc.refundCredits({ teamId: "team-1", value: 30 });

    const refundCall = mockTrack.mock.calls.find(
      (c: any[]) => c[0].value === -30,
    );
    expect(refundCall).toBeDefined();
    expect((refundCall as any[])[0].properties?.source).toBe("autumn_refund");
  });

  it("is a no-op when autumnClient is null", async () => {
    autumnClientRef = null;
    const svc = makeService();
    await svc.refundCredits({ teamId: "team-1", value: 30 });
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("is a no-op for preview teams", async () => {
    const svc = makeService();
    await svc.refundCredits({ teamId: "preview_abc", value: 30 });
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// _backfillUsageIfNeeded
// ---------------------------------------------------------------------------

describe("_backfillUsageIfNeeded (via reserveCredits)", () => {
  it("tracks the delta between firecrawlTotal and autumnUsage", async () => {
    const svc = makeService();
    // Firecrawl says 100 credits used across scrape + extract.
    mockGetACUCTeam
      .mockResolvedValueOnce(makeAcucChunk(60)) // scrape
      .mockResolvedValueOnce(makeAcucChunk(40)); // extract
    // Autumn only recorded 70.
    mockEntityGet.mockResolvedValue(makeEntity(70));

    await svc.reserveCredits({ teamId: "team-1", value: 1 });

    const backfillCall = mockTrack.mock.calls.find(
      (c: any[]) => c[0]?.properties?.source === "autumn_backfill",
    );
    expect(backfillCall).toBeDefined();
    // delta = 100 - 70 = 30
    expect((backfillCall as any[])[0].value).toBe(30);
  });

  it("does not track when delta is zero or negative", async () => {
    const svc = makeService();
    mockGetACUCTeam.mockResolvedValue(makeAcucChunk(50));
    // Autumn already has more usage than Firecrawl — no backfill needed.
    mockEntityGet.mockResolvedValue(makeEntity(200));

    await svc.reserveCredits({ teamId: "team-1", value: 1 });

    const backfillCall = mockTrack.mock.calls.find(
      (c: any[]) => c[0]?.properties?.source === "autumn_backfill",
    );
    expect(backfillCall).toBeUndefined();
  });

  it("does not track when firecrawlTotal is 0", async () => {
    const svc = makeService();
    mockGetACUCTeam.mockResolvedValue(makeAcucChunk(0));
    mockEntityGet.mockResolvedValue(makeEntity(0));

    await svc.reserveCredits({ teamId: "team-1", value: 1 });

    const backfillCall = mockTrack.mock.calls.find(
      (c: any[]) => c[0]?.properties?.source === "autumn_backfill",
    );
    expect(backfillCall).toBeUndefined();
  });

  it("serialises concurrent backfills per team", async () => {
    const svc = makeService();
    let concurrentRuns = 0;
    let maxConcurrentRuns = 0;

    mockGetACUCTeam.mockImplementation(async () => {
      concurrentRuns++;
      maxConcurrentRuns = Math.max(maxConcurrentRuns, concurrentRuns);
      await new Promise(r => setTimeout(r, 20));
      concurrentRuns--;
      return makeAcucChunk(100);
    });
    mockEntityGet.mockResolvedValue(makeEntity(0));

    await Promise.all([
      svc.reserveCredits({ teamId: "team-1", value: 1 }),
      svc.reserveCredits({ teamId: "team-1", value: 1 }),
    ]);

    // Guard: verify backfill actually ran so the concurrency assertion below is
    // not trivially satisfied by _backfillUsageIfNeeded never executing.
    // Two runs × 2 modes (scrape + extract) = 4 total getACUCTeam calls.
    expect(mockGetACUCTeam.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Each backfill run calls getACUCTeam for 2 modes concurrently (scrape +
    // extract). With serialisation, at most one run executes at a time, so the
    // peak concurrent call count is 2 (1 run × 2 modes). Without serialisation
    // all 4 calls (2 runs × 2 modes) could overlap, giving a peak of 4.
    expect(maxConcurrentRuns).toBeLessThanOrEqual(2);
  });
});
