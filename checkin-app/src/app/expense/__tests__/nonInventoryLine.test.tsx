import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";
import HoldsPage from "@checkin/expense/pages/holds";

let mockLoads: Record<string, unknown> = {};

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({ data: path ? mockLoads[path] ?? null : null, error: null, reload: () => {} }),
  useRoles: () => ({ isFinance: true, isBoard: false }),
  useBuckets: () => [{ value: "3", label: "Robotics" }],
  paged: (path: string, page: number) => `${path}?page=${page}`,
  PAGE_SIZE: 50,
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
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const ALWAYS = "Always use this bucket for this part";

async function openAssignDialog(line: { gtin13: string | null; nonInventory: boolean }) {
  mockLoads = {
    "/expenses/e1": {
      id: "e1", vendorName: "Pizza Place", receiptDate: null, receiptTotalCents: 1000, currency: "USD", state: "assign_ownership",
      needsReimbursement: false, backfill: false,
      lineItems: [{ id: 1, lineNumber: 1, description: "Pizza", partNumber: "PZ-LG", quantity: 1, totalPriceCents: 1000, isCapital: false, depreciationYears: null, capitalOwnerId: null, ...line }],
      approvals: [],
    },
    "/expenses/e1/line-item-approvals": [{ id: 10, lineItemId: 1, ownerId: null, status: "pending" }],
    "/expenses/e1/signoffs": [],
  };
  render(<MantineProvider><ExpenseDetailPage id="e1" /></MantineProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Assign bucket" }));
  await screen.findByRole("dialog");
}

describe("Assign bucket on a line without a GTIN", () => {
  it("shows the line as Non-inventory and hides Always use this bucket", async () => {
    await openAssignDialog({ gtin13: null, nonInventory: true });
    expect(screen.getByText("Non-inventory")).toBeInTheDocument();
    expect(screen.queryByLabelText(ALWAYS)).not.toBeInTheDocument();
  });

  it("hides Always use this bucket for any line with no GTIN", async () => {
    await openAssignDialog({ gtin13: null, nonInventory: false });
    expect(screen.queryByText("Non-inventory")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(ALWAYS)).not.toBeInTheDocument();
  });

  it("offers Always use this bucket for a line with a GTIN", async () => {
    await openAssignDialog({ gtin13: "0000000000017", nonInventory: false });
    expect(screen.getByLabelText(ALWAYS)).toBeInTheDocument();
  });
});

describe("Holds row for a non-inventory line", () => {
  it("shows the line as Non-inventory", () => {
    mockLoads = {
      "/expense-holds?page=1": [{
        id: 5, expenseId: "e1", lineItemId: 1, reason: "NON_INVENTORY",
        lineItem: { description: "Pizza", partNumber: "PZ-LG", totalPriceCents: 1000, manualQbAccount: null, nonInventory: true },
        expense: { vendorName: "Pizza Place", receiptDate: null, currency: "USD" },
      }],
      "/qb-accounts": [],
    };
    render(<MantineProvider><HoldsPage /></MantineProvider>);
    expect(screen.getByText("Non-inventory")).toBeInTheDocument();
  });
});
