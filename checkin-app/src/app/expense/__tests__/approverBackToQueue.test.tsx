import { act, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";
import ApprovalsDetailPage from "@/app/programs-i-lead/expense-approvals/[id]/page";

let mockLoads: Record<string, unknown> = {};
const mockSend = jest.fn<Promise<boolean>, [string, string, unknown, string]>();
const mockApi = jest.fn<Promise<unknown>, [string]>();
const mockGoTo = jest.fn<void, [string]>();

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({ data: path ? mockLoads[path] ?? null : null, error: null, reload: () => {} }),
  useRoles: () => ({ isFinance: false, isBoard: false }),
  useBuckets: () => [],
  send: (...args: [string, string, unknown, string]) => mockSend(...args),
  api: (path: string) => mockApi(path),
  goTo: (href: string) => mockGoTo(href),
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

beforeEach(() => {
  mockSend.mockReset().mockResolvedValue(true);
  mockApi.mockReset();
  mockGoTo.mockReset();
});

const APPROVALS = "/programs-i-lead/expense-approvals?view=owner_approval&page=1";
const APPROVE = { act: "approve", primary: true, noteRequired: false };

const line = (id: number) => ({
  id, lineNumber: id, description: `Part ${id}`, partNumber: null, quantity: 1, unitPriceCents: 1000, totalPriceCents: 1000,
  gtin13: null, isDelayed: false, isCapital: false, depreciationYears: null, capitalOwnerId: null,
});

const status = (lineItemId: number, actions: unknown[]) => ({
  lineItemId, filled: [], missing: ["TREASURER"], blocked: [], actions, awaiting: [], mayRecordBoardAuthorization: false,
});

const expense = {
  id: "e1", vendorName: "Acme", receiptDate: null, receiptTotalCents: 2000, taxCents: 0, shippingCents: 0, discountCents: 0,
  currency: "USD", submittedAt: "2026-10-01T00:00:00Z", state: "owner_approval", needsReimbursement: false, reimburseePersonId: null, backfill: false,
  lineItems: [line(1), line(2)],
  approvals: [],
};

/** Two lines waiting on the approver; after the decision the server answers with `after`. */
function open(after: unknown[], queueHref?: string) {
  mockLoads = {
    "/expenses/e1": { Expense: expense, ExpenseQueueReason: [] },
    "/expenses/e1/line-item-approvals": [1, 2].map((id) => ({ id: 10 + id, lineItemId: id, ownerId: 3, status: "pending" })),
    "/expenses/e1/signoffs": [status(1, [APPROVE]), status(2, [APPROVE])],
  };
  mockApi.mockImplementation(async (path) => (path.endsWith("/signoffs") ? after : { Expense: expense, ExpenseQueueReason: [] }));
  render(<MantineProvider><ExpenseDetailPage id="e1" listHref={queueHref} queueHref={queueHref} /></MantineProvider>);
}

async function approveFirstLine() {
  await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Approve as Program approver" })[0]); });
  const confirm = await screen.findByRole("button", { name: "Confirm" });
  await act(async () => { fireEvent.click(confirm); });
  await settle();
}

/** Lets the decision's refetch and the modal's close finish inside act. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 300)));

describe("an approver goes back to the approvals list after their last decision (3.12)", () => {
  it("returns to the list the page was opened from once no line has a main act for them", async () => {
    open([status(1, []), status(2, [])], APPROVALS);
    await approveFirstLine();
    expect(mockSend).toHaveBeenCalledWith("/expenses/e1/line-item-approvals/11/approve", "POST", { reason: null }, "Approve as Program approver done");
    expect(mockGoTo).toHaveBeenCalledWith(APPROVALS);
  });

  it("reloads in place after a partial decision, while another line still waits on them", async () => {
    open([status(1, []), status(2, [APPROVE])], APPROVALS);
    await approveFirstLine();
    expect(mockApi).toHaveBeenCalledWith("/expenses/e1/signoffs");
    expect(mockGoTo).not.toHaveBeenCalled();
  });

  it("stays on the page when the refreshed acts can't be read", async () => {
    open([], APPROVALS);
    mockApi.mockImplementation(async (path) => {
      if (path.endsWith("/signoffs")) throw new Error("HTTP 500");
      return { Expense: expense, ExpenseQueueReason: [] };
    });
    await approveFirstLine();
    expect(mockApi).toHaveBeenCalledWith("/expenses/e1/signoffs");
    expect(mockGoTo).not.toHaveBeenCalled();
  });

  it("returns after a seat signature too", async () => {
    mockLoads = {
      "/expenses/e1": { Expense: expense, ExpenseQueueReason: [] },
      "/expenses/e1/line-item-approvals": [],
      "/expenses/e1/signoffs": [status(1, [{ act: "sign", seat: "TREASURER", primary: true, noteRequired: false }]), status(2, [])],
    };
    mockApi.mockImplementation(async (path) => (path.endsWith("/signoffs") ? [status(1, []), status(2, [])] : { Expense: expense, ExpenseQueueReason: [] }));
    render(<MantineProvider><ExpenseDetailPage id="e1" queueHref="/finance/review?queue=to_sign" /></MantineProvider>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign as Treasurer" })); });
    await settle();
    expect(mockGoTo).toHaveBeenCalledWith("/finance/review?queue=to_sign");
  });

  it("returns after Approve All too", async () => {
    open([status(1, []), status(2, [])], APPROVALS);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Approve all 2 as Program approver" })); });
    await settle();
    expect(mockSend).toHaveBeenCalledWith("/expenses/e1/approve-lines", "POST", { approvalIds: [11, 12] }, "Approved 2 lines");
    expect(mockGoTo).toHaveBeenCalledWith(APPROVALS);
  });

  it("always reloads in place when opened from anywhere else", async () => {
    open([status(1, []), status(2, [])]);
    await approveFirstLine();
    expect(mockSend).toHaveBeenCalled();
    expect(mockApi).not.toHaveBeenCalled();
    expect(mockGoTo).not.toHaveBeenCalled();
  });
});

describe("the Expense approvals host page", () => {
  it.each([
    [{}, "/programs-i-lead/expense-approvals"],
    [{ from: APPROVALS }, APPROVALS],
    [{ from: "//evil.example" }, "/programs-i-lead/expense-approvals"],
  ])("with %p passes %s as both the back link and the queue", async (searchParams, href) => {
    const el = await ApprovalsDetailPage({ params: Promise.resolve({ id: "e1" }), searchParams: Promise.resolve(searchParams) });
    expect(el.props.listHref).toBe(href);
    expect(el.props.queueHref).toBe(href);
  });
});
