import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";

let mockLoads: Record<string, unknown> = {};
const mockSend = jest.fn(async () => true);

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({ data: path ? mockLoads[path] ?? null : null, error: null, reload: () => {} }),
  useRoles: () => ({ isFinance: true, isBoard: false }),
  useBuckets: () => [{ value: "3", label: "Robotics" }, { value: "7", label: "Woodshop" }],
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
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ||= () => {};
});

function load(capitalOwnerId: number | null) {
  mockLoads = {
    "/expenses/e1": {
      id: "e1", vendorName: "Acme", receiptDate: null, receiptTotalCents: 90000, currency: "USD", state: "set_depreciation_cycle",
      needsReimbursement: false, backfill: false, approvals: [],
      lineItems: [{
        id: 11, lineNumber: 1, description: "Bandsaw", partNumber: null, quantity: 1, totalPriceCents: 90000,
        isCapital: true, depreciationYears: 5, capitalOwnerId,
      }],
    },
    "/expenses/e1/line-item-approvals": [],
    "/expenses/e1/signoffs": [],
  };
}

const wrap = () => render(<MantineProvider><ExpenseDetailPage id="e1" /></MantineProvider>);

describe("depreciation owner picker", () => {
  beforeEach(() => mockSend.mockClear());

  it("offers buckets, not a typed id, and holds Submit until one is picked", () => {
    load(null);
    wrap();
    expect(screen.queryByPlaceholderText("Owner person id")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();

    fireEvent.click(screen.getByRole("textbox", { name: "Owner bucket for Bandsaw" }));
    fireEvent.click(screen.getByRole("option", { name: "Woodshop" }));
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(mockSend).toHaveBeenCalledWith("/expenses/e1/set-depreciation-cycle/submit", "POST", {
      items: [{ lineItemId: 11, depreciationYears: 5, ownerId: 7 }],
    }, "Depreciation cycle set");
  });

  it("starts from the line's recorded owner bucket", () => {
    load(3);
    wrap();
    expect(screen.getByRole("textbox", { name: "Owner bucket for Bandsaw" })).toHaveValue("Robotics");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(mockSend).toHaveBeenCalledWith("/expenses/e1/set-depreciation-cycle/submit", "POST", {
      items: [{ lineItemId: 11, depreciationYears: 5, ownerId: 3 }],
    }, "Depreciation cycle set");
  });
});
