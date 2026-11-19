/** The stranded-expense sweep reads only the hold fields and checks holds a batch at a time — no database. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { recoverStrandedQbExpenses } from "../../lib/expense-qb-processor";
import { OUTBOX_HOLD_FIELDS, outboxHeldIds } from "../../lib/signoff-facts";
import { db } from "../../db";

vi.mock("../../db", () => ({
  db: {
    expense: { findMany: vi.fn(), findFirst: vi.fn(async () => null) },
    expenseEvent: { findMany: vi.fn(async () => []) },
  },
  isUniqueConstraintError: () => false,
}));
vi.mock("../../lib/signoff-facts", async (actual) => ({
  ...(await actual<typeof import("../../lib/signoff-facts")>()),
  outboxHeldIds: vi.fn(),
}));

const candidates = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, orgId: "org" }));

beforeEach(() => vi.clearAllMocks());

describe("recoverStrandedQbExpenses", () => {
  it("selects only the fields the hold check reads", async () => {
    vi.mocked(db.expense.findMany).mockResolvedValue([]);
    vi.mocked(outboxHeldIds).mockResolvedValue(new Set());

    await recoverStrandedQbExpenses();

    expect(vi.mocked(db.expense.findMany).mock.calls[0][0]).toMatchObject({ select: OUTBOX_HOLD_FIELDS });
  });

  it("stops checking holds once the batch is full", async () => {
    vi.mocked(db.expense.findMany).mockResolvedValue(candidates(500) as never);
    vi.mocked(outboxHeldIds).mockImplementation(async (_db, page) => new Set(page.filter((_, i) => i % 2 === 0).map((e) => e.id)));

    expect(await recoverStrandedQbExpenses(50)).toEqual({ checked: 50, failed: 0 });

    const checkedSizes = vi.mocked(outboxHeldIds).mock.calls.map(([, page]) => page.length);
    expect(checkedSizes).toEqual([50, 50]);
  });

  it("checks past a full batch of held expenses to reach a stranded one", async () => {
    vi.mocked(db.expense.findMany).mockResolvedValue(candidates(120) as never);
    vi.mocked(outboxHeldIds).mockImplementation(async (_db, page) => new Set(page.filter((e) => e.id !== "e119").map((e) => e.id)));

    expect(await recoverStrandedQbExpenses(50)).toEqual({ checked: 1, failed: 0 });
    expect(db.expense.findFirst).toHaveBeenCalledWith({ where: { id: "e119" } });
  });
});
