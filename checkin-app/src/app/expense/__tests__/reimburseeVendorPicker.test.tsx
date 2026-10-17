import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ExpenseDetailPage from "@inventory/expense/pages/expenseDetail";

let mockLoads: Record<string, unknown> = {};
let mockErrors: Record<string, string> = {};
const mockSend = jest.fn(async () => true);

jest.mock("@inventory/expense/components/api", () => ({
  useLoad: (path: string | null) => ({
    data: path ? mockLoads[path] ?? null : null,
    error: path ? mockErrors[path] ?? null : null,
    reload: () => {},
  }),
  useRoles: () => ({ isFinance: true, isBoard: false }),
  useBuckets: () => [],
  send: (...args: unknown[]) => mockSend(...(args as [])),
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

// The library's QB_OFF; its lib/ path is not a package export.
const QB_OFF = "QuickBooks isn't connected here, so Vendors can't be searched or linked";
const OPTIONS = "/expenses/e1/reimbursee-vendor/options?q=Pat%20Lee";

function load(link: { qbVendorId: string } | null) {
  mockErrors = {};
  mockLoads = {
    "/expenses/e1": {
      id: "e1", vendorName: "Acme", receiptDate: null, receiptTotalCents: 1000, currency: "USD", state: "qb_pending",
      needsReimbursement: true, reimburseePersonId: 9, backfill: false, lineItems: [], approvals: [],
    },
    "/expenses/e1/line-item-approvals": [],
    "/expenses/e1/signoffs": [],
    "/expenses/e1/reimbursee-vendor": { ExpenseReimburseeVendor: link, ExpenseReimburseeView: { personId: 9, name: "Pat Lee" } },
    [OPTIONS]: [{ id: "55", displayName: "Pat Lee" }],
  };
}

const wrap = () => render(<MantineProvider><ExpenseDetailPage id="e1" /></MantineProvider>);

describe("reimbursee Vendor picker", () => {
  beforeEach(() => mockSend.mockClear());

  it("names the reimbursee and searches QuickBooks for them by name", async () => {
    load(null);
    wrap();
    expect(screen.getByText("Reimbursee Pat Lee")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search QuickBooks Vendors")).toHaveValue("Pat Lee");

    fireEvent.click(screen.getByRole("button", { name: "Create “Pat Lee” in QuickBooks" }));
    expect(mockSend).toHaveBeenCalledWith("/expenses/e1/reimbursee-vendor", "PUT", { createForReimbursee: true }, "Vendor linked");
  });

  it("shows a picked Vendor's name for confirmation before linking it", () => {
    load(null);
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(mockSend).not.toHaveBeenCalled();
    expect(screen.getByText(/Link QuickBooks Vendor “Pat Lee” \(#55\) as Pat Lee’s Vendor\?/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByPlaceholderText("Search QuickBooks Vendors")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm link" }));
    expect(mockSend).toHaveBeenCalledWith("/expenses/e1/reimbursee-vendor", "PUT", { qbVendorId: "55" }, "Vendor linked");
  });

  it("offers nothing to link while QuickBooks is off", () => {
    load(null);
    mockErrors = { [OPTIONS]: QB_OFF };
    wrap();
    expect(screen.getByText(QB_OFF)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search QuickBooks Vendors")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create/ })).not.toBeInTheDocument();
  });

  it("shows the linked Vendor instead of the picker", () => {
    load({ qbVendorId: "55" });
    wrap();
    expect(screen.getByText("QuickBooks Vendor #55")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search QuickBooks Vendors")).not.toBeInTheDocument();
  });
});
