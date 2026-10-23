import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";

let mockLoads: Record<string, unknown> = {};

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({ data: path ? mockLoads[path] ?? null : null, error: null, reload: () => {} }),
  useRoles: () => ({ isFinance: false, isBoard: false }),
  useBuckets: () => [],
  send: jest.fn(),
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

function load(missing: string[]) {
  mockLoads = {
    "/expenses/e1": {
      id: "e1", vendorName: "Acme", receiptDate: null, receiptTotalCents: 60000, currency: "USD", state: "qb_pending",
      needsReimbursement: false, reimburseePersonId: null, backfill: false,
      lineItems: [{ id: 1, lineNumber: 1, description: "Laser tube", partNumber: null, quantity: 1, totalPriceCents: 60000, isCapital: false, depreciationYears: null, capitalOwnerId: null }],
      approvals: [],
    },
    "/expenses/e1/line-item-approvals": [{ id: 10, lineItemId: 1, ownerId: 3, status: "approved" }],
    "/expenses/e1/signoffs": [{ lineItemId: 1, filled: ["SUBMITTER", "PROGRAM_APPROVER"], missing, blocked: [] }],
  };
  render(<MantineProvider><ExpenseDetailPage id="e1" /></MantineProvider>);
}

describe("the Board seat on a card-charge line", () => {
  it("is a seat to sign, like the others", () => {
    load(["TREASURER", "BOARD"]);
    expect(screen.getByRole("button", { name: "Sign as Treasurer" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Sign as Board" })).toBeEnabled();
    expect(screen.queryByText(/Held until the Treasurer records/)).not.toBeInTheDocument();
  });

  it("a $2,000 purchase's Board approval is a note, never a seat to sign", () => {
    load(["TREASURER", "BOARD_APPROVAL"]);
    expect(screen.getByText("Held until the Board approval of this purchase is recorded")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /BOARD_APPROVAL/ })).not.toBeInTheDocument();
  });

  it("is not offered on a line that does not take it", () => {
    load(["TREASURER"]);
    expect(screen.queryByRole("button", { name: "Sign as Board" })).not.toBeInTheDocument();
  });
});
