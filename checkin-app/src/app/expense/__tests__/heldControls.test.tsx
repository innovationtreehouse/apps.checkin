import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
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

const wrap = (ui: ReactElement) => render(<MantineProvider>{ui}</MantineProvider>);

describe("Sign as… on the expense detail page", () => {
  const loadExpense = (reimburseePersonId: number | null, line: { actions: unknown[]; awaiting: string[] }) => {
    mockLoads = {
      "/expenses/e1": {
        id: "e1", vendorName: "Acme", receiptDate: null, receiptTotalCents: 1000, currency: "USD", state: "qb_pending",
        needsReimbursement: true, reimburseePersonId, backfill: false,
        lineItems: [{ id: 1, lineNumber: 1, description: "Bolts", partNumber: null, quantity: 1, totalPriceCents: 1000, isCapital: false, depreciationYears: null, capitalOwnerId: null }],
        approvals: [],
      },
      "/expenses/e1/line-item-approvals": [],
      "/expenses/e1/signoffs": [{ lineItemId: 1, filled: [], missing: ["TREASURER"], blocked: [], mayRecordBoardAuthorization: false, ...line }],
    };
  };

  it("draws no Sign button and says why while the reimbursee is unknown", () => {
    loadExpense(null, { actions: [], awaiting: ["Held until finance names the reimbursee"] });
    wrap(<ExpenseDetailPage id="e1" />);
    expect(screen.queryByRole("button", { name: "Sign as Treasurer" })).not.toBeInTheDocument();
    expect(screen.getByText("Held until finance names the reimbursee")).toBeInTheDocument();
  });

  it("draws Sign as Treasurer once the reimbursee is known", () => {
    loadExpense(7, { actions: [{ act: "sign", seat: "TREASURER", primary: true, noteRequired: false }], awaiting: [] });
    wrap(<ExpenseDetailPage id="e1" />);
    expect(screen.getByRole("button", { name: "Sign as Treasurer" })).toBeEnabled();
    expect(screen.queryByText("Held until finance names the reimbursee")).not.toBeInTheDocument();
  });
});
