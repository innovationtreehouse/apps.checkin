/**
 * @jest-environment node
 */
import { expenseStateCounts } from "@checkin/expense";
import { receiptStateCounts } from "@checkin/receipt";
import { receivingStateCounts } from "@checkin/workflow-mapping";
import { receiptFlowStatus } from "@/lib/receiptFlow/status";

jest.mock("@checkin/receipt", () => ({ receiptStateCounts: jest.fn() }));
jest.mock("@checkin/workflow-mapping", () => ({ receivingStateCounts: jest.fn() }));
jest.mock("@checkin/expense", () => ({ expenseStateCounts: jest.fn() }));

const receipt = receiptStateCounts as jest.MockedFunction<typeof receiptStateCounts>;
const receiving = receivingStateCounts as jest.MockedFunction<typeof receivingStateCounts>;
const expense = expenseStateCounts as jest.MockedFunction<typeof expenseStateCounts>;

const RECEIPT = { states: [{ state: "uploaded", label: "Processing", count: 1 }], notDelivered: 2 };
const RECEIVING = [{ state: "applying", label: "Applying", count: 3 }];
const EXPENSE = [{ state: "qb_error", label: "QB Error", count: 4 }];
const URLS = ["RECEIPT_DATABASE_URL", "WORKFLOW_MAPPING_DATABASE_URL", "EXPENSE_DATABASE_URL"];

beforeEach(() => {
  jest.clearAllMocks();
  receipt.mockResolvedValue(RECEIPT);
  receiving.mockResolvedValue(RECEIVING);
  expense.mockResolvedValue(EXPENSE);
  for (const v of URLS) process.env[v] = "postgres://test";
});

afterAll(() => {
  for (const v of URLS) delete process.env[v];
});

describe("receiptFlowStatus", () => {
  it.each(["isFinance", "isBoardMember"] as const)("gives %s every section and the time", async (role) => {
    const out = await receiptFlowStatus(role);
    expect(out).toEqual({ asOf: expect.any(String), receipt: RECEIPT, receiving: { states: RECEIVING }, expense: { states: EXPENSE } });
    expect(Number.isNaN(Date.parse(out.asOf))).toBe(false);
  });

  it("gives an inventory manager receiving alone, and reads nothing else", async () => {
    expect(await receiptFlowStatus("isInventoryManager")).toEqual({ asOf: expect.any(String), receiving: { states: RECEIVING } });
    expect(receipt).not.toHaveBeenCalled();
    expect(expense).not.toHaveBeenCalled();
  });

  it("returns null for a library with no database here, without calling it", async () => {
    delete process.env.EXPENSE_DATABASE_URL;
    delete process.env.WORKFLOW_MAPPING_DATABASE_URL;
    const out = await receiptFlowStatus("isFinance");
    expect(out.expense).toBeNull();
    expect(out.receiving).toBeNull();
    expect(out.receipt).toEqual(RECEIPT);
    expect(expense).not.toHaveBeenCalled();
    expect(receiving).not.toHaveBeenCalled();
  });
});
