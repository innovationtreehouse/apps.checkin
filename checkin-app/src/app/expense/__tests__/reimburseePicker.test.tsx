import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";

let mockLoads: Record<string, unknown> = {};
const mockSend = jest.fn(async () => true);

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({ data: path ? mockLoads[path] ?? null : null, error: null, reload: () => {} }),
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

function load(options: { personId: number; name: string | null }[]) {
  mockLoads = {
    "/expenses/e1": {
      id: "e1", vendorName: "Acme", receiptDate: null, receiptTotalCents: 1000, currency: "USD", state: "owner_approval",
      needsReimbursement: true, reimburseePersonId: null, backfill: false, lineItems: [], approvals: [],
    },
    "/expenses/e1/line-item-approvals": [],
    "/expenses/e1/signoffs": [],
    "/expenses/e1/reimbursee-vendor": { ExpenseReimburseeVendor: null, ExpenseReimburseeView: null },
    "/expenses/e1/reimbursee/options": options,
  };
}

const wrap = () => render(<MantineProvider><ExpenseDetailPage id="e1" /></MantineProvider>);

describe("reimbursee picker", () => {
  beforeEach(() => mockSend.mockClear());

  it("names the eligible person and sends their id, with no id to type", () => {
    load([{ personId: 12, name: "Pat Lee" }]);
    wrap();
    expect(screen.queryByPlaceholderText("Person id")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reimburse Pat Lee" }));
    expect(mockSend).toHaveBeenCalledWith("/expenses/e1/reimbursee", "PUT", { personId: 12 }, "Reimbursee set");
  });

  it("says so when nobody is eligible", () => {
    load([]);
    wrap();
    expect(screen.getByText(/No eligible reimbursee/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reimburse/ })).not.toBeInTheDocument();
  });
});
