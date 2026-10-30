import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MantineProvider } from "@mantine/core";
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";

let mockLoads: Record<string, unknown> = {};
const mockSend = jest.fn<Promise<boolean>, [string, string, unknown, string]>();
const mockApi = jest.fn<Promise<unknown>, [string]>();
const mockGoTo = jest.fn<void, [string]>();

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({ data: path ? mockLoads[path] ?? null : null, error: null, reload: () => {} }),
  useRoles: () => ({ isFinance: true, isBoard: false }),
  useBuckets: () => [],
  send: (...args: [string, string, unknown, string]) => mockSend(...args),
  api: (path: string) => mockApi(path),
  goTo: (href: string) => mockGoTo(href),
}));

beforeAll(() => {
  // Mantine's Select measures itself; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
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

const reason = (code: string, over: Record<string, unknown> = {}) => ({ code, tab: "expenses", actionable: true, amountCents: null, count: null, detail: null, ...over });

const expense = (over: Record<string, unknown> = {}) => ({
  id: "e1", vendorName: "Acme", receiptDate: "2026-10-01", receiptTotalCents: 234_000, taxCents: 1240, shippingCents: 0, discountCents: 0,
  currency: "USD", submittedAt: "2026-10-01T00:00:00Z", state: "owner_approval", needsReimbursement: false, reimburseePersonId: null, backfill: false,
  qbMatchState: "UNMATCHED",
  lineItems: [{ id: 1, lineNumber: 1, description: "Bolts", partNumber: null, quantity: 1, unitPriceCents: 1000, totalPriceCents: 1000, isCapital: false, depreciationYears: null, capitalOwnerId: null }],
  approvals: [],
  flags: [],
  ...over,
});

function load(e: Record<string, unknown>, reasons: unknown[], extra: Record<string, unknown> = {}) {
  mockLoads = {
    "/expenses/e1": { Expense: e, ExpenseQueueReason: reasons },
    "/expenses/e1/line-item-approvals": [],
    "/expenses/e1/signoffs": [],
    ...extra,
  };
}

beforeEach(() => {
  mockSend.mockReset().mockResolvedValue(true);
  mockApi.mockReset();
  mockGoTo.mockReset();
});

describe("the reasons alert", () => {
  it("lists each reason in words with where it is answered, and marks the field", () => {
    load(expense(), [reason("TAX_NOT_REVIEWED", { amountCents: 1240 }), reason("BOARD_APPROVAL", { tab: "board", amountCents: 234_000 })]);
    wrap(<ExpenseDetailPage id="e1" />);
    expect(screen.getByText("Waiting on finance:")).toBeInTheDocument();
    expect(screen.getByText("Tax $12.40 not reviewed on the receipt · Approve tax, beside the tax")).toBeInTheDocument();
    expect(screen.getByText("Waiting on the Board:")).toBeInTheDocument();
    expect(screen.getByText("Board approval of a $2,340.00 purchase not recorded · Board authorization panel")).toBeInTheDocument();
    expect(screen.getByText("$12.40").closest("mark")).not.toBeNull();
    expect(screen.getByText("$2,340.00").closest("mark")).not.toBeNull();
  });

  it("shows nothing when the expense waits on no one", () => {
    load(expense(), []);
    wrap(<ExpenseDetailPage id="e1" />);
    expect(screen.queryByText("Waiting on finance:")).not.toBeInTheDocument();
    expect(screen.getByText("$12.40").closest("mark")).toBeNull();
  });
});

describe("Approve tax", () => {
  it("approves with the note optional", async () => {
    load(expense(), [reason("TAX_NOT_REVIEWED", { amountCents: 1240 })]);
    wrap(<ExpenseDetailPage id="e1" />);
    fireEvent.click(screen.getByRole("button", { name: "Approve tax" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith("/expenses/e1/tax-approval", "POST", { note: null }, "Tax approved"));
  });
});

describe("Skip in QuickBooks", () => {
  const unbooked = () => load(expense({ qbMatchState: "UNBOOKED" }), [reason("QB_UNBOOKED", { tab: "qb" })], { "/expenses/e1/qb-candidates": [] });

  it("takes a required reason, then posts it", async () => {
    unbooked();
    wrap(<ExpenseDetailPage id="e1" />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    const confirm = await screen.findByRole("button", { name: "Skip this expense" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Why it is skipped/), { target: { value: "Booked by hand" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith("/expenses/e1/qb-resolve", "POST", { action: "skip", reason: "Booked by hand" }, "Skipped in QuickBooks"));
  });

  it("is not offered to a viewer who cannot act on the reason", () => {
    load(expense({ qbMatchState: "UNBOOKED" }), [reason("QB_UNBOOKED", { tab: "qb", actionable: false })], { "/expenses/e1/qb-candidates": [] });
    wrap(<ExpenseDetailPage id="e1" />);
    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
  });

  it("says a skipped expense was not sent, and offers nothing more", () => {
    load(expense({ qbMatchState: "SKIPPED" }), []);
    wrap(<ExpenseDetailPage id="e1" />);
    expect(screen.getByText(/finance skipped it/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
  });
});

describe("the Reviews panel", () => {
  const drift = { id: 9, kind: "QB_DRIFT", audience: "FINANCE", detail: "amount", observed: JSON.stringify({ amount: 1500 }), checkedOffAt: null };

  it("keeps Accept the change disabled until the note says what finance did", async () => {
    load(expense({ qbMatchState: "CREATED", flags: [drift] }), [reason("QB_DRIFT", { tab: "qb", detail: "amount" })]);
    wrap(<ExpenseDetailPage id="e1" />);
    const accept = screen.getByRole("button", { name: "Accept the change" });
    expect(accept).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/What finance did/), { target: { value: "Treasurer corrected the amount in QuickBooks" } });
    expect(accept).toBeEnabled();
    fireEvent.click(accept);
    await waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith("/flags/9/check-off", "POST", { notes: "Treasurer corrected the amount in QuickBooks", shown: { detail: drift.detail, observed: drift.observed } }, "Review closed"),
    );
  });

  it("shows the posted and current values side by side", () => {
    load(expense({ qbMatchState: "CREATED", flags: [drift] }), []);
    wrap(<ExpenseDetailPage id="e1" />);
    expect(screen.getByRole("columnheader", { name: "Posted" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "amount $10.00 $15.00" })).toBeInTheDocument();
  });

  it("names a duplicate to void and a closed expense never posted, and hides a retired kind", () => {
    load(expense({
      flags: [
        { id: 1, kind: "QB_DUPLICATE_TO_VOID", audience: "FINANCE", detail: "the entry posted for this expense needs voiding", checkedOffAt: null },
        { id: 2, kind: "QB_POST_HELD", audience: "FINANCE", detail: "closed but not posted: a line is missing a sign-off seat", checkedOffAt: null },
        { id: 3, kind: "QB_POST_FAILED", audience: "FINANCE", detail: "Account is inactive", checkedOffAt: null },
      ],
    }), []);
    wrap(<ExpenseDetailPage id="e1" />);
    expect(screen.getByRole("button", { name: "I voided it" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mark handled" })).toBeDisabled();
    expect(screen.queryByText("Account is inactive")).not.toBeInTheDocument();
    expect(screen.queryByText(/Flags screen/)).not.toBeInTheDocument();
  });
});

describe("the QuickBooks panel for a post waiting on finance", () => {
  const candidates = [{ id: "77", txnDate: "2026-10-02", totalCents: 234_000, accountRef: "Card", vendorRef: null }];

  it("says why it was not sent, and picks a matching entry", async () => {
    load(expense({ qbMatchState: "AMBIGUOUS" }), [reason("QB_AWAITING_MATCH", { tab: "qb" })], { "/expenses/e1/qb-candidates": candidates });
    wrap(<ExpenseDetailPage id="e1" />);
    expect(screen.getByText(/Not sent to QuickBooks: waiting for finance/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pick" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith("/expenses/e1/qb-match", "POST", { qbTxnId: "77" }, "Matched to the QuickBooks entry"));
  });

  it("excludes an entry only with a reason", async () => {
    load(expense({ qbMatchState: "AMBIGUOUS" }), [reason("QB_AWAITING_MATCH", { tab: "qb" })], { "/expenses/e1/qb-candidates": candidates });
    wrap(<ExpenseDetailPage id="e1" />);
    fireEvent.click(screen.getByRole("button", { name: "Exclude" }));
    const confirm = screen.getByRole("button", { name: "Confirm exclusion" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Why this entry belongs to no expense/), { target: { value: "hand-booked rent" } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith("/qb-exclusions", "POST", { qbTxnId: "77", reason: "hand-booked rent" }, "Entry excluded from matching"),
    );
  });

  it("points a reimbursee without a vendor to the Reimbursee panel instead", () => {
    load(expense({ qbMatchState: "AMBIGUOUS", needsReimbursement: true, reimburseePersonId: 4 }), [reason("QB_VENDOR_MISSING", { tab: "qb" })]);
    wrap(<ExpenseDetailPage id="e1" />);
    expect(screen.getByText(/link one in the Reimbursee panel below/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pick" })).not.toBeInTheDocument();
  });
});

describe("back to the queue", () => {
  const retry = () => {
    load(expense({ qbMatchState: "NEEDS_FINANCE" }), [reason("QB_POST_FAILED", { tab: "qb", count: 5 })]);
  };
  /** The refreshed expense and its lines' acts, as the page refetches them after a decision. */
  const refetch = (detail: unknown, lines: unknown[] = []) =>
    mockApi.mockImplementation(async (path) => (path.endsWith("/signoffs") ? lines : detail));

  it("returns to the queue tab when the decision leaves the viewer nothing to act on", async () => {
    retry();
    refetch({ Expense: expense(), ExpenseQueueReason: [reason("SIGNER_HELD", { tab: "board", actionable: false })] });
    wrap(<ExpenseDetailPage id="e1" queueHref="/finance/review?queue=qb" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry QuickBooks post" }));
    await waitFor(() => expect(mockGoTo).toHaveBeenCalledWith("/finance/review?queue=qb"));
  });

  it("stays on the page while another reason is left for the viewer", async () => {
    retry();
    refetch({ Expense: expense(), ExpenseQueueReason: [reason("REIMBURSEE_TO_NAME")] });
    wrap(<ExpenseDetailPage id="e1" queueHref="/finance/review?queue=qb" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry QuickBooks post" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/expenses/e1"));
    expect(mockGoTo).not.toHaveBeenCalled();
  });

  it("returns to the Account holds tab after Resubmit clears the last hold", async () => {
    const line = { id: 1, lineNumber: 1, description: "Bolts", partNumber: null, quantity: 1, unitPriceCents: 1000, totalPriceCents: 1000, isCapital: false, depreciationYears: null, capitalOwnerId: null, manualQbAccount: "6110" };
    load(
      expense({ lineItems: [line], holds: [{ id: 3, lineItemId: 1, reason: "NO_PART_NUMBER", matchedRows: "[]", status: "PENDING" }] }),
      [reason("ACCOUNT_HOLD", { tab: "holds", count: 1 })],
    );
    refetch({ Expense: expense(), ExpenseQueueReason: [] });
    wrap(<ExpenseDetailPage id="e1" queueHref="/finance/review?queue=holds" />);
    fireEvent.click(screen.getByRole("button", { name: "Resubmit" }));
    await waitFor(() => expect(mockGoTo).toHaveBeenCalledWith("/finance/review?queue=holds"));
  });

  it("stays on the page while a line still has a main act for the viewer", async () => {
    retry();
    const line = { lineItemId: 1, filled: [], missing: ["TREASURER"], blocked: [], awaiting: [], mayRecordBoardAuthorization: false };
    refetch({ Expense: expense(), ExpenseQueueReason: [] }, [{ ...line, actions: [{ act: "sign", seat: "TREASURER", primary: true, noteRequired: false }] }]);
    wrap(<ExpenseDetailPage id="e1" queueHref="/finance/review?queue=qb" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry QuickBooks post" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/expenses/e1/signoffs"));
    expect(mockGoTo).not.toHaveBeenCalled();
  });

  it("always reloads in place when opened from anywhere else", async () => {
    retry();
    wrap(<ExpenseDetailPage id="e1" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry QuickBooks post" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockApi).not.toHaveBeenCalled();
    expect(mockGoTo).not.toHaveBeenCalled();
  });
});

describe("required notes", () => {
  it("marks the exception note required", async () => {
    load(expense({ state: "owner_approval" }), [], {
      "/expenses/e1/line-item-approvals": [{ id: 5, lineItemId: 1, ownerId: 7, status: "pending" }],
      "/expenses/e1/signoffs": [{
        lineItemId: 1, filled: [], missing: [], blocked: [], awaiting: [],
        actions: [{ act: "raise-exception", primary: true, noteRequired: true }],
      }],
    });
    wrap(<ExpenseDetailPage id="e1" />);
    fireEvent.click(screen.getByRole("button", { name: "Raise exception" }));
    expect(await screen.findByLabelText(/Notes/)).toBeRequired();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });
});
