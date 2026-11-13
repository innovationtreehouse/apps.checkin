import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";

let mockLoads: Record<string, unknown> = {};

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({ data: path ? mockLoads[path] ?? null : null, error: null, reload: () => {} }),
  useRoles: () => ({ isFinance: true, isBoard: false }),
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

function show(fields: Record<string, unknown>) {
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
  it("shows the last error while the expense is stuck", () => {
    show({ qbMatchState: "NEEDS_FINANCE", qbFirstFailedAt: "2026-11-01T00:00:00Z", qbLastError: ERROR });
    expect(screen.getByText(`Last error: ${ERROR}`)).toBeInTheDocument();
  });

  it("shows no error line when the response carries none, as for a reader without the personal tier", () => {
    show({ qbMatchState: "NEEDS_FINANCE", qbFirstFailedAt: "2026-11-01T00:00:00Z" });
    expect(screen.queryByText(/Last error/)).not.toBeInTheDocument();
  });

  it("shows no error line once the expense is no longer stuck", () => {
    show({ qbMatchState: "CREATED", qbFirstFailedAt: null, qbLastError: ERROR });
    expect(screen.queryByText(/Last error/)).not.toBeInTheDocument();
  });
});
