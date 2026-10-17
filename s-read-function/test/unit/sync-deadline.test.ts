/**
 * armSyncDeadline is the "limited duration" half of the deploy contract
 * (trigger Lambda → one-off ECS task): a wedged run must force-fail instead of
 * billing until someone notices. Timer behavior only — the orchestrators are
 * covered elsewhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@checkin/s-ingest-core", () => ({
  prisma: {},
  loadDbConfig: vi.fn(),
  loadShopifyConfig: vi.fn(),
  reapStaleRuns: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ConcurrentRunError: class extends Error {},
}));
vi.mock("../../src/shopify/client.js", () => ({ createShopifyClient: vi.fn() }));
vi.mock("../../src/sync/store.js", () => ({ ensureStore: vi.fn() }));
vi.mock("../../src/sync/incremental.js", () => ({ runIncremental: vi.fn() }));
vi.mock("../../src/sync/backfill.js", () => ({ runBackfill: vi.fn() }));
vi.mock("../../src/monitoring.js", () => ({ buildHeartbeatSink: vi.fn() }));

import { armSyncDeadline } from "../../src/handler.js";

describe("armSyncDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.SYNC_DEADLINE_MINUTES;
  });

  it("force-exits(1) once the default 55-minute deadline passes", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    armSyncDeadline("incremental");
    vi.advanceTimersByTime(55 * 60 * 1000 - 1);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("honors the SYNC_DEADLINE_MINUTES override", () => {
    process.env.SYNC_DEADLINE_MINUTES = "2";
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    armSyncDeadline("backfill");
    vi.advanceTimersByTime(2 * 60 * 1000 - 1);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
