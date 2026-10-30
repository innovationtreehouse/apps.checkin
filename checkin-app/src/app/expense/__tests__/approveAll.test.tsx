import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MantineProvider } from "@mantine/core";
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";

let mockLoads: Record<string, unknown> = {};
const mockSend = jest.fn<Promise<boolean>, unknown[]>(async () => true);

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({ data: path ? mockLoads[path] ?? null : null, error: null, reload: () => {} }),
  useRoles: () => ({ isFinance: false, isBoard: false }),
  send: (...args: unknown[]) => mockSend(...args),
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

type Act = { act: string; primary: boolean; noteRequired?: boolean };
const approve: Act = { act: "approve", primary: true, noteRequired: false };

/** Three lines, each with its approval row (id = 10 + line id) and the given acts for the caller. */
function load(acts: Act[][]) {
  const lines = acts.map((_, i) => ({
    id: i + 1, lineNumber: i + 1, description: `Line ${i + 1}`, partNumber: null, quantity: 1, unitPriceCents: 100, totalPriceCents: 100,
    isCapital: false, depreciationYears: null, capitalOwnerId: null,
  }));
  mockLoads = {
    "/expenses/e1": {
      id: "e1", vendorName: "Acme", receiptDate: null, receiptTotalCents: 300, taxCents: 0, shippingCents: 0, discountCents: 0,
      currency: "USD", submittedAt: "2026-10-01T00:00:00Z", state: "owner_approval", needsReimbursement: false, backfill: false,
      lineItems: lines, approvals: [],
    },
    "/expenses/e1/line-item-approvals": lines.map((l) => ({ id: 10 + l.id, lineItemId: l.id, ownerId: 100, status: "pending" })),
    "/expenses/e1/signoffs": lines.map((l, i) => ({ lineItemId: l.id, filled: [], missing: [], blocked: [], actions: acts[i], awaiting: [], mayRecordBoardAuthorization: false })),
  };
}

describe("Approve All on the expense detail page", () => {
  beforeEach(() => mockSend.mockClear());

  it("is shown when the caller's main act is an approval on two or more lines, counting only those", () => {
    load([[approve], [approve], [{ act: "sign", primary: true }]]);
    wrap(<ExpenseDetailPage id="e1" />);
    expect(screen.getByRole("button", { name: "Approve all 2 as Program approver" })).toBeInTheDocument();
  });

  it("sends one request naming each of those lines' approvals", async () => {
    load([[approve], [{ act: "sign", primary: true }], [approve]]);
    wrap(<ExpenseDetailPage id="e1" />);
    fireEvent.click(screen.getByRole("button", { name: "Approve all 2 as Program approver" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith("/expenses/e1/approve-lines", "POST", { approvalIds: [11, 13] }, "Approved 2 lines"));
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("is hidden with only one such line", () => {
    load([[approve], [], [{ act: "approve", primary: false }]]);
    wrap(<ExpenseDetailPage id="e1" />);
    expect(screen.queryByRole("button", { name: /^Approve all/ })).not.toBeInTheDocument();
  });

  it("leaves out an approval that needs a note, which is approved on its own", () => {
    load([[approve], [{ act: "approve", primary: true, noteRequired: true }], []]);
    wrap(<ExpenseDetailPage id="e1" />);
    expect(screen.queryByRole("button", { name: /^Approve all/ })).not.toBeInTheDocument();
  });
});
