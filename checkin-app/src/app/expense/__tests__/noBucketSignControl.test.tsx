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

const HINT = "Waiting for Finance to assign a budget bucket";

function load(ownerId: number | null) {
  mockLoads = {
    "/expenses/e1": {
      id: "e1", vendorName: "Acme", receiptDate: null, receiptTotalCents: 1000, currency: "USD", state: "owner_approval",
      needsReimbursement: true, reimburseePersonId: 7, backfill: false,
      lineItems: [{ id: 1, lineNumber: 1, description: "Bolts", partNumber: null, quantity: 1, totalPriceCents: 1000, isCapital: false, depreciationYears: null, capitalOwnerId: null }],
      approvals: [],
    },
    "/expenses/e1/line-item-approvals": [{ id: 10, lineItemId: 1, ownerId, status: "pending" }],
    "/expenses/e1/signoffs": [{ lineItemId: 1, filled: [], missing: ["PROGRAM_APPROVER", "TREASURER"], blocked: [] }],
  };
  render(<MantineProvider><ExpenseDetailPage id="e1" /></MantineProvider>);
}

describe("Sign as Program approver on a line's budget bucket", () => {
  it("is disabled with a hint while the line has no bucket; other seats stay enabled", () => {
    load(null);
    expect(screen.getByRole("button", { name: "Sign as Program approver" })).toBeDisabled();
    expect(screen.getByText(HINT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign as Treasurer" })).toBeEnabled();
  });

  it("is enabled once the line has a bucket", () => {
    load(3);
    expect(screen.getByRole("button", { name: "Sign as Program approver" })).toBeEnabled();
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });
});
