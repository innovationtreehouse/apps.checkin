import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";

let mockLoads: Record<string, unknown> = {};
let mockRoles = { isFinance: true, isBoard: false };

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({ data: path ? mockLoads[path] ?? null : null, error: null, reload: () => {} }),
  useRoles: () => mockRoles,
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

const ERROR = "QBO create Purchase failed: socket hang up";

function show(fields: Record<string, unknown>, roles = { isFinance: true, isBoard: false }) {
  mockRoles = roles;
  mockLoads = {
    "/expenses/e1": {
      id: "e1", vendorName: "Acme", receiptDate: "2026-10-01", receiptTotalCents: 1000, taxCents: 0, shippingCents: 0,
      discountCents: 0, currency: "USD", submittedAt: "2026-10-02T15:30:00Z", state: "closed",
      needsReimbursement: false, backfill: false, lineItems: [], approvals: [], ...fields,
    },
    "/expenses/e1/line-item-approvals": [],
    "/expenses/e1/signoffs": [],
  };
  render(<MantineProvider><ExpenseDetailPage id="e1" /></MantineProvider>);
}

describe("a stuck expense's last error", () => {
  const STUCK = { qbMatchState: "NEEDS_FINANCE", qbFirstFailedAt: "2026-11-01T00:00:00Z" };

  it.each([
    ["finance", { isFinance: true, isBoard: false }],
    ["the Board", { isFinance: false, isBoard: true }],
  ])("shows %s the last error while the expense is stuck", (_who, roles) => {
    show({ ...STUCK, qbLastError: ERROR }, roles);
    expect(screen.getByText(`Last error: ${ERROR}`)).toBeInTheDocument();
  });

  it("says no error was recorded when a stuck expense has none", () => {
    show(STUCK);
    expect(screen.getByText("Last error: no error recorded")).toBeInTheDocument();
  });

  it("shows a bucket approver no error line", () => {
    show({ ...STUCK, qbLastError: ERROR }, { isFinance: false, isBoard: false });
    expect(screen.queryByText(/Last error/)).not.toBeInTheDocument();
  });

  it("shows no error line once the expense is no longer stuck", () => {
    show({ qbMatchState: "CREATED", qbFirstFailedAt: null, qbLastError: ERROR });
    expect(screen.queryByText(/Last error/)).not.toBeInTheDocument();
  });
});
