import { fireEvent, render, screen } from "@testing-library/react";
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

function load(status: string) {
  mockLoads = {
    "/expenses/e1": {
      id: "e1", vendorName: "Acme", receiptDate: null, receiptTotalCents: 1000, currency: "USD", state: "owner_approval",
      needsReimbursement: true, reimburseePersonId: 7, backfill: false,
      lineItems: [{ id: 1, lineNumber: 1, description: "Bolts", partNumber: null, quantity: 1, totalPriceCents: 1000, isCapital: false, depreciationYears: null, capitalOwnerId: null }],
      approvals: [],
    },
    "/expenses/e1/line-item-approvals": [{ id: 10, lineItemId: 1, ownerId: 3, status }],
    "/expenses/e1/signoffs": [{ lineItemId: 1, filled: [], missing: ["SUBMITTER", "TREASURER"], blocked: [] }],
  };
  render(<MantineProvider><ExpenseDetailPage id="e1" /></MantineProvider>);
}

describe("approving a line is the program approver's sign-off", () => {
  it("offers no program-approver seat to sign", () => {
    load("pending");
    expect(screen.queryByRole("button", { name: "Sign as Program approver" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign as Treasurer" })).toBeEnabled();
  });

  it("asks for a Board stand-in's reason, not a finance override comment", async () => {
    load("pending");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByLabelText("Reason (required when a Board member approves in place of the bucket's approvers)")).toBeInTheDocument();
    expect(screen.queryByText(/FINANCE approves outside its own buckets/)).not.toBeInTheDocument();
  });

  it("offers Approve on a line finance moved to another bucket", () => {
    load("finance_assigned");
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });
});
