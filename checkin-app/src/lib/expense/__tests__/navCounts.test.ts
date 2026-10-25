import { expenseLibraryCounts } from "../navCounts";

const mockBuckets = jest.fn<Promise<number[]>, [number]>();
const mockActionCounts = jest.fn();
const mockQueueCount = jest.fn();

jest.mock("@checkin/expense", () => ({
  getExpenseRuntime: () => ({ signoff: { bucketsApprovedBy: (id: number) => mockBuckets(id) } }),
  financeQueueActionable: () => mockQueueCount(),
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
  mockQueueCount.mockReset().mockResolvedValue(5);
});

describe("expenseLibraryCounts", () => {
  it("reports the finance queue count and each view's action count to FINANCE", async () => {
    expect(await expenseLibraryCounts({ id: 1, isFinance: true })).toEqual({
      financeQueue: 5,
      awaitingMySignoff: 0,
      approver: 0,
      "actionable:assign_ownership": 1,
      "actionable:owner_approval": 2,
      "actionable:owner_exception": 0,
      "actionable:capital_review": 3,
      "actionable:set_depreciation_cycle": 0,
      "actionable:qb_pending": 1,
    });
    expect(mockActionCounts).toHaveBeenCalledWith({ id: 1, name: null, isFinance: true, isBoard: false });
  });

  it("passes the Board role through, so the service can leave out FINANCE-only steps", async () => {
    await expenseLibraryCounts({ id: 2, isBoardMember: true });
    expect(mockActionCounts).toHaveBeenCalledWith({ id: 2, name: null, isFinance: false, isBoard: true });
  });

  it("counts a bucket approver who holds no role, without a finance queue count", async () => {
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

    it("keeps the finance queue and sign-off pills when the action counts fail", async () => {
      mockBuckets.mockResolvedValue([100]);
      mockActionCounts.mockRejectedValue(new Error("db down"));
      expect(await expenseLibraryCounts({ id: 1, isFinance: true })).toEqual({ financeQueue: 5, awaitingMySignoff: 4, approver: 1 });
    });

    it("keeps the action pills when the finance queue count fails", async () => {
      mockQueueCount.mockRejectedValue(new Error("db down"));
      const out = await expenseLibraryCounts({ id: 1, isFinance: true });
      expect(out).toMatchObject({ "actionable:capital_review": 3 });
      expect(out).not.toHaveProperty("financeQueue");
    });

    it("leaves out a view the service could not count", async () => {
      mockActionCounts.mockResolvedValue({ assign_ownership: 1, capital_review: 3 });
      const out = await expenseLibraryCounts({ id: 1, isFinance: true });
      expect(out).toMatchObject({ "actionable:assign_ownership": 1, "actionable:capital_review": 3 });
      expect(out).not.toHaveProperty("actionable:qb_pending");
    });
  });
});
