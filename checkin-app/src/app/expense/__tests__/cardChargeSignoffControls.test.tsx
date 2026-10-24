import { act, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";

let mockLoads: Record<string, unknown> = {};
let mockRoles = { isFinance: false, isBoard: false };
const mockSend: jest.Mock<Promise<boolean>, unknown[]> = jest.fn(async () => true);

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({ data: path ? mockLoads[path] ?? null : null, error: null, reload: () => {} }),
  useRoles: () => mockRoles,
  useBuckets: () => [],
  send: (...args: unknown[]) => mockSend(...args),
}));

beforeAll(() => {
  window.matchMedia =
    window.matchMedia ||
    ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList);
});

beforeEach(() => mockSend.mockClear());

function load(roles: { isFinance?: boolean; isBoard?: boolean }, opts: { missing?: string[]; mayRecord?: boolean; expense?: Record<string, unknown> } = {}) {
  mockRoles = { isFinance: roles.isFinance ?? false, isBoard: roles.isBoard ?? false };
  mockLoads = {
    "/expenses/e1": {
      id: "e1", vendorName: "Acme", receiptDate: null, receiptTotalCents: 60000, currency: "USD", state: "qb_pending",
      needsReimbursement: false, reimburseePersonId: null, backfill: false,
      lineItems: [{ id: 1, lineNumber: 1, description: "Laser tube", partNumber: null, quantity: 1, totalPriceCents: 60000, isCapital: false, depreciationYears: null, capitalOwnerId: null }],
      approvals: [],
      ...opts.expense,
    },
    "/expenses/e1/line-item-approvals": [{ id: 10, lineItemId: 1, ownerId: 3, status: "approved" }],
    "/expenses/e1/signoffs": [{
      lineItemId: 1, filled: ["SUBMITTER", "TREASURER"], missing: opts.missing ?? ["BOARD"], blocked: [], actions: [], awaiting: [],
      mayRecordBoardAuthorization: opts.mayRecord ?? false,
    }],
  };
  render(<MantineProvider><ExpenseDetailPage id="e1" /></MantineProvider>);
}

const RECORD = { name: "Record Board authorization" };

describe("Board authorization control", () => {
  it.each([["FINANCE", { isFinance: true }], ["Board", { isBoard: true }]])("%s records it when the server allows, and the text is required", async (_who, roles) => {
    load(roles, { mayRecord: true });
    const button = screen.getByRole("button", RECORD);
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/What the Board authorized/), { target: { value: "   " } });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/What the Board authorized/), { target: { value: "Board vote, 2026-10-01" } });
    await act(async () => { fireEvent.click(button); });
    expect(mockSend).toHaveBeenCalledWith("/expenses/e1/board-authorization", "POST", { authorization: "Board vote, 2026-10-01" }, "Board authorization recorded");
  });

  it("is not shown when the server says the caller may not record it, whatever their roles", () => {
    load({ isFinance: true, isBoard: true }, { mayRecord: false });
    expect(screen.queryByRole("button", RECORD)).not.toBeInTheDocument();
  });

  it("is not shown once the authorization is recorded", () => {
    load({ isFinance: true }, { missing: [], mayRecord: false });
    expect(screen.queryByRole("button", RECORD)).not.toBeInTheDocument();
  });
});

describe("Everyday", () => {
  it("FINANCE has no control to mark a card charge not Everyday: the amounts alone decide it", () => {
    load({ isFinance: true }, { missing: [] });
    expect(screen.queryByText("Not Everyday")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Single-source purchase" })).not.toBeInTheDocument();
  });
});
