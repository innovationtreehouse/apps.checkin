import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ExpenseDetailPage from "@inventory/expense/pages/expenseDetail";

let mockLoads: Record<string, unknown> = {};

jest.mock("@inventory/expense/components/api", () => ({
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

const HINT = "Held until the Treasurer records the Board authorization";

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

describe("a card charge held for Board authorization", () => {
  it("shows the hold as a note, never as a seat to sign", () => {
    load(["TREASURER", "BOARD_AUTHORIZATION"]);
    expect(screen.getByText(HINT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign as Treasurer" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /BOARD_AUTHORIZATION/ })).not.toBeInTheDocument();
  });

  it("shows no note once the authorization is recorded", () => {
    load(["TREASURER"]);
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });
});
