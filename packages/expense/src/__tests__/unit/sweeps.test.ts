import { afterEach, describe, expect, it, vi } from "vitest";
import { drainExpenseOutbox } from "../../lib/expense-qb-poster";
import { checkQbDrift } from "../../lib/expense-qb-drift";
import { recoverStrandedQbExpenses } from "../../lib/expense-qb-processor";
import { catchUpCatalogEvents } from "../../services/catalogEventConsumer";
import { replayReceivedPayloads } from "../../services/intakeService";
import { runExpenseCatchUp, runExpenseQbPosting } from "../../services/sweeps";

vi.mock("../../lib/expense-qb-processor", () => ({ recoverStrandedQbExpenses: vi.fn() }));
vi.mock("../../lib/expense-qb-poster", () => ({ drainExpenseOutbox: vi.fn() }));
vi.mock("../../lib/expense-qb-drift", () => ({ checkQbDrift: vi.fn() }));
vi.mock("../../services/catalogEventConsumer", () => ({ catchUpCatalogEvents: vi.fn() }));
vi.mock("../../services/intakeService", () => ({ replayReceivedPayloads: vi.fn() }));

function loggedLines(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.map(([line]) => JSON.parse(String(line)) as { event: string; part: string; error: string });
}

afterEach(() => vi.restoreAllMocks());

describe("expense sweeps", () => {
  it("logs a failed catch-up part's cause, keeps the error shape and runs the next part", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const catalogEvents = { processed: 1, duplicate: 0, failed: 0, unprocessed: 0, unreadable: false };
    vi.mocked(replayReceivedPayloads).mockRejectedValue(new Error("intake db down"));
    vi.mocked(catchUpCatalogEvents).mockResolvedValue(catalogEvents);

    expect(await runExpenseCatchUp()).toEqual({ intake: { error: true }, catalogEvents });

    expect(loggedLines(logged)).toEqual([expect.objectContaining({ event: "expense_sweep_failed", part: "intake", error: "intake db down" })]);
  });

  it("logs each failed QuickBooks part by name and returns the names", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(recoverStrandedQbExpenses).mockRejectedValue(new Error("stranded"));
    vi.mocked(drainExpenseOutbox).mockRejectedValue(new Error("drain"));
    vi.mocked(checkQbDrift).mockRejectedValue(new Error("drift"));

    expect(await runExpenseQbPosting()).toEqual({
      stranded: { error: true },
      qbPost: { error: true },
      qbDrift: { error: true },
      failedParts: ["stranded", "qbPost", "qbDrift"],
    });

    expect(loggedLines(logged).map((l) => l.part)).toEqual(["stranded", "qbPost", "qbDrift"]);
  });

  it("names only the part that failed, and none when counts or unbound come back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stranded = { checked: 1, failed: 1 };
    vi.mocked(recoverStrandedQbExpenses).mockResolvedValue(stranded);
    vi.mocked(drainExpenseOutbox).mockRejectedValue(new Error("drain"));
    vi.mocked(checkQbDrift).mockResolvedValue("unbound");

    expect((await runExpenseQbPosting()).failedParts).toEqual(["qbPost"]);

    vi.mocked(drainExpenseOutbox).mockResolvedValue("unbound");
    expect((await runExpenseQbPosting()).failedParts).toEqual([]);
  });
});
