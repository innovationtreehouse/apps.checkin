import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { MantineProvider } from "@mantine/core";
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";

let mockLoads: Record<string, unknown> = {};

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({ data: path ? mockLoads[path] ?? null : null, error: null, reload: () => {} }),
  useRoles: () => ({ isFinance: true, isBoard: false }),
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

const line = {
  id: 1, lineNumber: 1, description: "Bolts", partNumber: "B-100", manufacturer: "Acme Fasteners", quantity: 4,
  unitPriceCents: 250, totalPriceCents: 1000, gtin13: "0012345678905", isDelayed: false, isCapital: false,
  depreciationYears: null, capitalOwnerId: null,
};

function loadExpense(overrides: Record<string, unknown> = {}, lineItems: unknown[] = [line]) {
  mockLoads = {
    "/expenses/e1": {
      id: "e1", vendorName: "Acme", receiptDate: "2026-10-01", receiptTotalCents: 1180, taxCents: 80, shippingCents: 0,
      discountCents: 0, currency: "USD", submittedAt: "2026-10-02T15:30:00Z", state: "owner_approval",
      needsReimbursement: false, backfill: false, lineItems, approvals: [], ...overrides,
    },
    "/expenses/e1/line-item-approvals": [],
    "/expenses/e1/signoffs": [],
  };
}

describe("expense detail fields", () => {
  it("shows each line's part #, manufacturer, quantity, unit price, total and GTIN", () => {
    loadExpense();
    wrap(<ExpenseDetailPage id="e1" />);
    const row = screen.getByText("Bolts").closest("tr") as HTMLElement;
    for (const text of ["B-100", "Acme Fasteners", "4", "$2.50", "$10.00", "0012345678905"]) {
      expect(within(row).getByText(text)).toBeInTheDocument();
    }
    for (const header of ["Part #", "Manufacturer", "Qty", "Unit", "Total", "GTIN-13"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
  });

  it("shows a dash for a line with no part #, manufacturer or GTIN", () => {
    loadExpense({}, [{ ...line, partNumber: null, manufacturer: null, gtin13: null }]);
    wrap(<ExpenseDetailPage id="e1" />);
    const row = screen.getByText("Bolts").closest("tr") as HTMLElement;
    const cells = within(row).getAllByRole("cell");
    const column = (name: string) => screen.getAllByRole("columnheader").findIndex((h) => h.textContent === name);
    for (const header of ["Part #", "Manufacturer", "GTIN-13"]) expect(cells[column(header)]).toHaveTextContent(/^—$/);
  });

  it("badges delayed and capital lines, and only those", () => {
    loadExpense({}, [
      { ...line, id: 1, description: "Bolts", isDelayed: true },
      { ...line, id: 2, lineNumber: 2, description: "Lathe", isCapital: true },
      { ...line, id: 3, lineNumber: 3, description: "Nuts" },
    ]);
    wrap(<ExpenseDetailPage id="e1" />);
    const rowOf = (d: string) => screen.getByText(d).closest("tr") as HTMLElement;
    expect(within(rowOf("Bolts")).getByText("Delayed")).toBeInTheDocument();
    expect(within(rowOf("Bolts")).queryByText("Capital")).not.toBeInTheDocument();
    expect(within(rowOf("Lathe")).getByText("Capital")).toBeInTheDocument();
    expect(within(rowOf("Nuts")).queryByText("Delayed")).not.toBeInTheDocument();
    expect(within(rowOf("Nuts")).queryByText("Capital")).not.toBeInTheDocument();
  });

  it("shows the total, tax and submitted time in the header, and hides zero shipping and discount", () => {
    loadExpense();
    wrap(<ExpenseDetailPage id="e1" />);
    expect(screen.getByText("$11.80")).toBeInTheDocument();
    expect(screen.getByText("Tax")).toBeInTheDocument();
    expect(screen.getByText("$0.80")).toBeInTheDocument();
    expect(screen.getByText("Submitted")).toBeInTheDocument();
    expect(screen.getByText(new Date("2026-10-02T15:30:00Z").toLocaleString())).toBeInTheDocument();
    expect(screen.queryByText("Shipping")).not.toBeInTheDocument();
    expect(screen.queryByText("Discount")).not.toBeInTheDocument();
  });

  it("shows tax even when it is zero", () => {
    loadExpense({ taxCents: 0 });
    wrap(<ExpenseDetailPage id="e1" />);
    expect(screen.getByText("Tax")).toBeInTheDocument();
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("shows non-zero shipping, and a discount as a deduction", () => {
    loadExpense({ shippingCents: 599, discountCents: 150 });
    wrap(<ExpenseDetailPage id="e1" />);
    expect(screen.getByText("Shipping")).toBeInTheDocument();
    expect(screen.getByText("$5.99")).toBeInTheDocument();
    expect(screen.getByText("Discount")).toBeInTheDocument();
    expect(screen.getByText("−$1.50")).toBeInTheDocument();
  });
});
