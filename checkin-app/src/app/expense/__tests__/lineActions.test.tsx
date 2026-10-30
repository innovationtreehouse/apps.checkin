import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";

let mockLoads: Record<string, unknown> = {};
let mockErrors: Record<string, string> = {};
const mockReload: jest.Mock<void, [string]> = jest.fn();
const mockSend: jest.Mock<Promise<boolean>, unknown[]> = jest.fn(async () => true);

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({
    data: path && !mockErrors[path] ? mockLoads[path] ?? null : null,
    error: path ? mockErrors[path] ?? null : null,
    reload: () => { if (path) mockReload(path); },
  }),
  useRoles: () => ({ isFinance: true, isBoard: true }),
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

beforeAll(() => {
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  mockSend.mockClear();
  mockReload.mockClear();
  mockErrors = {};
});

type Act = { act: string; seat?: string; primary: boolean; noteRequired: boolean };
interface LineSpec { actions?: Act[]; awaiting?: string[]; status?: string }

const line = (id: number) => ({
  id, lineNumber: id, description: `Part ${id}`, partNumber: null, quantity: 1, unitPriceCents: 1000, totalPriceCents: 1000,
  gtin13: null, isDelayed: false, isCapital: false, depreciationYears: null, capitalOwnerId: null,
});

function load(specs: LineSpec[], expense: Record<string, unknown> = {}, loads: Record<string, unknown> = {}) {
  mockLoads = {
    "/expenses/e1": {
      id: "e1", vendorName: "Acme", receiptDate: null, receiptTotalCents: 1000 * specs.length, taxCents: 0, shippingCents: 0, discountCents: 0,
      currency: "USD", submittedAt: "2026-10-01T00:00:00Z", state: "owner_approval", needsReimbursement: false, reimburseePersonId: null, backfill: false,
      lineItems: specs.map((_, i) => line(i + 1)),
      approvals: [],
      ...expense,
    },
    "/expenses/e1/line-item-approvals": specs.map((s, i) => ({ id: 10 + i, lineItemId: i + 1, ownerId: 3, status: s.status ?? "pending" })),
    "/expenses/e1/signoffs": specs.map((s, i) => ({
      lineItemId: i + 1, filled: [], missing: ["SUBMITTER", "TREASURER"], blocked: [], actions: s.actions ?? [], awaiting: s.awaiting ?? [],
      mayRecordBoardAuthorization: false,
    })),
    ...loads,
  };
  render(<MantineProvider><ExpenseDetailPage id="e1" /></MantineProvider>);
}

const APPROVE: Act = { act: "approve", primary: true, noteRequired: false };
const RAISE: Act = { act: "raise-exception", primary: false, noteRequired: true };
const SIGN_T: Act = { act: "sign", seat: "TREASURER", primary: false, noteRequired: false };
const rowOf = (n: number) => screen.getAllByRole("row")[n];

describe("only the acts the server returns are drawn (3.15, #2433)", () => {
  it("draws no act and no Sign-as button on a line with none, only its status", () => {
    load([{ actions: [], awaiting: ["Awaiting approval", "Awaiting Treasurer"] }]);
    expect(screen.queryByRole("button", { name: /^Sign as/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
    expect(screen.getByText("Awaiting Treasurer")).toBeInTheDocument();
    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
  });

  it("draws one main act on the line and the rest under More", async () => {
    load([{ actions: [APPROVE, RAISE] }]);
    const row = within(rowOf(1));
    expect(row.getByRole("button", { name: "Approve as Program approver" })).toBeInTheDocument();
    expect(row.queryByRole("button", { name: "Raise exception" })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(row.getByRole("button", { name: "More" })); });
    expect(await screen.findByRole("menuitem", { name: "Raise exception" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Sign as Treasurer" })).not.toBeInTheDocument();
  });

  it("a Board stand-in's approval goes under More while a bucket approver can approve", async () => {
    load([{ actions: [{ ...SIGN_T, primary: true }, { act: "approve", primary: false, noteRequired: true }] }]);
    const row = within(rowOf(1));
    expect(row.getByRole("button", { name: "Sign as Treasurer" })).toBeInTheDocument();
    await act(async () => { fireEvent.click(row.getByRole("button", { name: "More" })); });
    expect(await screen.findByRole("menuitem", { name: "Approve as Board (program approver)" })).toBeInTheDocument();
  });

  it("a main sign act signs its seat", async () => {
    load([{ actions: [{ act: "sign", seat: "TREASURER", primary: true, noteRequired: false }] }]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign as Treasurer" })); });
    expect(mockSend).toHaveBeenCalledWith("/expenses/e1/line-items/1/signoffs", "POST", { seat: "TREASURER" }, "Signed as Treasurer");
  });

  it("Assign bucket on a line with an exception posts to finance's exception route", async () => {
    load([{ status: "exception_raised", actions: [{ act: "assign-bucket", primary: true, noteRequired: false }, { act: "reject-exception", primary: false, noteRequired: true }] }]);
    expect(screen.getByRole("button", { name: "Assign bucket" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject exception" })).not.toBeInTheDocument();
  });
});

describe("a status without acts", () => {
  it("draws no act and does not break the page", () => {
    mockLoads = {
      "/expenses/e1": {
        id: "e1", vendorName: "Acme", receiptDate: null, receiptTotalCents: 1000, taxCents: 0, shippingCents: 0, discountCents: 0,
        currency: "USD", submittedAt: "2026-10-01T00:00:00Z", state: "owner_approval", needsReimbursement: false, reimburseePersonId: null, backfill: false,
        lineItems: [line(1)], approvals: [],
      },
      "/expenses/e1/line-item-approvals": [{ id: 10, lineItemId: 1, ownerId: 3, status: "pending" }],
      "/expenses/e1/signoffs": [{ lineItemId: 1, filled: [], missing: ["SUBMITTER", "TREASURER"], blocked: [] }],
    };
    render(<MantineProvider><ExpenseDetailPage id="e1" /></MantineProvider>);
    expect(screen.getByText("Part 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve|Sign as|More/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/wait on you/)).not.toBeInTheDocument();
  });
});

describe("a final bucket", () => {
  it("finance's Assign bucket on an exception offers Make this final, which asks for a required note", async () => {
    load([{ status: "exception_raised", actions: [{ act: "assign-bucket", primary: true, noteRequired: false }] }]);
    fireEvent.click(screen.getByRole("button", { name: "Assign bucket" }));
    await screen.findByRole("dialog");
    expect(screen.queryByLabelText(/Why this bucket is final/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Make this final/));
    expect(await screen.findByLabelText(/Why this bucket is final/)).toBeRequired();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("shows that finance made the bucket final", () => {
    load([{ status: "finance_assigned", actions: [APPROVE], awaiting: ["Finance made this bucket final"] }]);
    expect(screen.getByText("Finance made this bucket final")).toBeInTheDocument();
  });
});

describe("lines waiting on the caller (3.14)", () => {
  it("bolds a line with a main act, marks it with an arrow, and counts it in the heading", () => {
    load([{ actions: [APPROVE] }, { actions: [], awaiting: ["Awaiting Treasurer"] }, { actions: [{ ...RAISE }] }]);
    expect(screen.getByText("1 of 3 lines wait on you.")).toBeInTheDocument();
    expect(rowOf(1)).toHaveAttribute("data-waiting-on-you", "true");
    expect(within(rowOf(1)).getByLabelText("Waits on you")).toBeInTheDocument();
    expect(rowOf(2)).not.toHaveAttribute("data-waiting-on-you");
    expect(within(rowOf(2)).queryByLabelText("Waits on you")).not.toBeInTheDocument();
    // An act under More alone does not make a line wait on the caller.
    expect(rowOf(3)).not.toHaveAttribute("data-waiting-on-you");
  });

  it("shows no count when nothing waits on the caller", () => {
    load([{ actions: [] }]);
    expect(screen.queryByText(/wait on you/)).not.toBeInTheDocument();
  });
});

describe("required notes (3.16)", () => {
  it("marks a required note and keeps Confirm disabled while it is blank", async () => {
    load([{ actions: [{ ...RAISE, primary: true }] }]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Raise exception" })); });
    const notes = await screen.findByRole("textbox", { name: /Notes/ });
    expect(notes).toBeRequired();
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    fireEvent.change(notes, { target: { value: "   " } });
    expect(confirm).toBeDisabled();
    fireEvent.change(notes, { target: { value: "Wrong bucket" } });
    expect(confirm).toBeEnabled();
    await act(async () => { fireEvent.click(confirm); });
    expect(mockSend).toHaveBeenCalledWith("/expenses/e1/line-item-approvals/10/raise-exception", "POST", { notes: "Wrong bucket" }, "Raise exception done");
  });

  it("marks a Board stand-in's reason required and sends it", async () => {
    load([{ actions: [{ act: "approve", primary: true, noteRequired: true }] }]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Approve as Board (program approver)" })); });
    const reason = await screen.findByRole("textbox", { name: /Reason/ });
    expect(reason).toBeRequired();
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    fireEvent.change(reason, { target: { value: "Leader away all month" } });
    await act(async () => { fireEvent.click(confirm); });
    expect(mockSend).toHaveBeenCalledWith("/expenses/e1/line-item-approvals/10/approve", "POST", { reason: "Leader away all month" }, "Approve as Board (program approver) done");
  });

  it("asks no note of an approval the server takes without one", async () => {
    load([{ actions: [APPROVE] }]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Approve as Program approver" })); });
    const confirm = await screen.findByRole("button", { name: "Confirm" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(confirm).toBeEnabled();
    await act(async () => { fireEvent.click(confirm); });
    expect(mockSend).toHaveBeenCalledWith("/expenses/e1/line-item-approvals/10/approve", "POST", { reason: null }, "Approve as Program approver done");
  });
});

describe("a failed line-actions load", () => {
  it("shows a red error with what failed and a retry that reloads the line actions", () => {
    mockErrors = { "/expenses/e1/signoffs": "Server error (500)" };
    load([{ actions: [APPROVE] }]);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the line actions");
    expect(alert).toHaveTextContent("Server error (500)");
    expect(screen.getByText("Part 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(mockReload).toHaveBeenCalledWith("/expenses/e1/signoffs");
  });

  it("shows no error when the line actions load", () => {
    load([{ actions: [APPROVE] }]);
    expect(screen.queryByText(/Couldn't load/)).not.toBeInTheDocument();
  });
});

describe("other failed loads", () => {
  it("a failed approvals load shows a red error with a retry, and the acts that need it stay disabled", async () => {
    mockErrors = { "/expenses/e1/line-item-approvals": "Server error (500)" };
    load([{ actions: [APPROVE, RAISE] }]);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the bucket approvals");
    expect(alert).toHaveTextContent("Server error (500)");
    expect(screen.getByRole("button", { name: "Approve as Program approver" })).toBeDisabled();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(mockReload).toHaveBeenCalledWith("/expenses/e1/line-item-approvals");
  });

  it("a failed vendor load shows a red error in the Reimbursee panel with a retry", () => {
    mockErrors = { "/expenses/e1/reimbursee-vendor": "Server error (502)" };
    load([{ actions: [] }], { needsReimbursement: true, reimburseePersonId: 4 });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the reimbursee's QuickBooks vendor");
    expect(alert).toHaveTextContent("Server error (502)");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(mockReload).toHaveBeenCalledWith("/expenses/e1/reimbursee-vendor");
  });

  it("a failed bucket list shows a red error in the bucket dialog with a retry", async () => {
    mockErrors = { "/local-owners": "Server error (503)" };
    load([{ status: "exception_raised", actions: [{ act: "assign-bucket", primary: true, noteRequired: false }] }]);
    expect(screen.queryByText(/Couldn't load/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Assign bucket" }));
    const dialog = await screen.findByRole("dialog");
    const alert = within(dialog).getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the bucket list");
    expect(alert).toHaveTextContent("Server error (503)");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(mockReload).toHaveBeenCalledWith("/local-owners");
  });
});

describe("while the approvals load", () => {
  it("keeps the acts that need an approval row disabled, and lets a signature through", async () => {
    load([{ actions: [APPROVE] }, { actions: [{ ...SIGN_T, primary: true }] }], {}, { "/expenses/e1/line-item-approvals": null });
    expect(screen.getByRole("button", { name: "Approve as Program approver" })).toBeDisabled();
    const sign = screen.getByRole("button", { name: "Sign as Treasurer" });
    expect(sign).toBeEnabled();
    await act(async () => { fireEvent.click(sign); });
    expect(mockSend).toHaveBeenCalledWith("/expenses/e1/line-items/2/signoffs", "POST", { seat: "TREASURER" }, "Signed as Treasurer");
  });
});
