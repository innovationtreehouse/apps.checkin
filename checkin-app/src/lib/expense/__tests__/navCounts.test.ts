import { expenseLibraryCounts } from "../navCounts";

const mockBuckets = jest.fn<Promise<number[]>, [number]>();
const mockActionCounts = jest.fn();
const mockOpsCounts = jest.fn();

jest.mock("@checkin/expense", () => ({
  getExpenseRuntime: () => ({ signoff: { bucketsApprovedBy: (id: number) => mockBuckets(id) } }),
  expenseOpsCounts: () => mockOpsCounts(),
  signoffsAwaitingCount: async () => 4,
  expenseActionCounts: (p: unknown) => mockActionCounts(p),
}));

const ACTIONS = {
  assign_ownership: 1,
  owner_approval: 2,
  owner_exception: 0,
  capital_review: 3,
  set_depreciation_cycle: 0,
  qb_pending: 1,
};

beforeEach(() => {
  mockBuckets.mockReset().mockResolvedValue([]);
  mockActionCounts.mockReset().mockResolvedValue(ACTIONS);
  mockOpsCounts.mockReset().mockResolvedValue({ holds: 2, openFlags: 1 });
});

describe("expenseLibraryCounts", () => {
  it("reports each view's action count and their sum to FINANCE", async () => {
    expect(await expenseLibraryCounts({ id: 1, isFinance: true })).toEqual({
      holds: 2,
      openFlags: 1,
      awaitingMySignoff: 0,
      approver: 0,
      "actionable:assign_ownership": 1,
      "actionable:owner_approval": 2,
      "actionable:owner_exception": 0,
      "actionable:capital_review": 3,
      "actionable:set_depreciation_cycle": 0,
      "actionable:qb_pending": 1,
      actionable: 7,
    });
    expect(mockActionCounts).toHaveBeenCalledWith({ id: 1, name: null, isFinance: true, isBoard: false });
  });

  it("passes the Board role through, so the service can leave out FINANCE-only steps", async () => {
    await expenseLibraryCounts({ id: 2, isBoardMember: true });
    expect(mockActionCounts).toHaveBeenCalledWith({ id: 2, name: null, isFinance: false, isBoard: true });
  });

  it("counts a bucket approver who holds no role", async () => {
    mockBuckets.mockResolvedValue([100]);
    expect(await expenseLibraryCounts({ id: 3 })).toMatchObject({ approver: 1, awaitingMySignoff: 4, "actionable:owner_approval": 2 });
  });

  it("asks nothing more of a viewer who approves no bucket and holds no role", async () => {
    expect(await expenseLibraryCounts({ id: 4 })).toEqual({ approver: 0 });
    expect(mockActionCounts).not.toHaveBeenCalled();
  });

  describe("when a count fails", () => {
    beforeEach(() => jest.spyOn(console, "error").mockImplementation(() => {}));
    afterEach(() => jest.restoreAllMocks());

    it("keeps the holds, flags and sign-off pills when the action counts fail", async () => {
      mockBuckets.mockResolvedValue([100]);
      mockActionCounts.mockRejectedValue(new Error("db down"));
      expect(await expenseLibraryCounts({ id: 1, isFinance: true })).toEqual({ holds: 2, openFlags: 1, awaitingMySignoff: 4, approver: 1 });
    });

    it("keeps the action pills when the holds and flags counts fail", async () => {
      mockOpsCounts.mockRejectedValue(new Error("db down"));
      expect(await expenseLibraryCounts({ id: 1, isFinance: true })).toMatchObject({ "actionable:capital_review": 3, actionable: 7 });
    });

    it("leaves out a view the service could not count, and sums the rest", async () => {
      mockActionCounts.mockResolvedValue({ assign_ownership: 1, capital_review: 3 });
      const out = await expenseLibraryCounts({ id: 1, isFinance: true });
      expect(out).toMatchObject({ "actionable:assign_ownership": 1, "actionable:capital_review": 3, actionable: 4 });
      expect(out).not.toHaveProperty("actionable:qb_pending");
    });
  });
});
