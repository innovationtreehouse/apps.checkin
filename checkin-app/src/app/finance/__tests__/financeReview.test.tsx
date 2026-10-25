import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import FinanceReview from "@/components/finance/FinanceReview";

let mockSearch = new URLSearchParams();
const mockReplace = jest.fn();
let mockIsFinance = true;
let mockReceiptLoads: Record<string, { data: unknown; error: string | null }> = {};
let mockExpenseLoads: Record<string, { data: unknown; error: string | null }> = {};
const mockReloadCounts = jest.fn();
const mockReceiptLoad = jest.fn((path: string | null) => ({ data: null, error: null, ...(path === null ? {} : mockReceiptLoads[path]), reload: path === "/queue-counts" ? mockReloadCounts : jest.fn() }));
const mockExpenseLoad = jest.fn((path: string | null) => ({ data: null, error: null, ...(path === null ? {} : mockExpenseLoads[path]), reload: jest.fn() }));

jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
}));
const mockShow = jest.fn();
jest.mock("@mantine/notifications", () => ({ notifications: { show: (...args: unknown[]) => mockShow(...args) } }));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: 2, isFinance: mockIsFinance, isBoardMember: !mockIsFinance } } }) }));
jest.mock("@checkin/receipt/components/api", () => ({
  ...jest.requireActual("@checkin/receipt/components/api"),
  useLoad: (path: string | null) => mockReceiptLoad(path),
}));
jest.mock("@checkin/expense/components/api", () => ({
  ...jest.requireActual("@checkin/expense/components/api"),
  useLoad: (path: string | null) => mockExpenseLoad(path),
}));

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ||= () => {};
});

const tab = (actionable = 0, total = actionable, byReason: Record<string, number> = {}) => ({ actionable, total, byReason });
const EMPTY_EXPENSES = { expenses: tab(), toSign: tab(), accountHolds: tab(), quickbooks: tab(), board: tab() };
const EMPTY_RECEIPTS = { byState: {}, notPushed: 0, pushGivenUp: 0 };
let fetchSpy: jest.SpyInstance;

const counts = (receipts: unknown, expenses: unknown) => {
  mockReceiptLoads["/queue-counts"] = { data: receipts, error: null };
  mockExpenseLoads["/finance-queue/counts"] = { data: expenses, error: null };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSearch = new URLSearchParams();
  mockIsFinance = true;
  mockReceiptLoads = {};
  mockExpenseLoads = {};
  counts(EMPTY_RECEIPTS, EMPTY_EXPENSES);
  fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({ apply_failed: 0 }) } as Response);
});
afterEach(() => fetchSpy.mockRestore());

const wrap = () => render(<MantineProvider><FinanceReview /></MantineProvider>);
const tabButton = (name: RegExp) => screen.getByRole("button", { name });

describe("landing", () => {
  it("opens the first tab, in order, with work for the viewer", () => {
    counts({ byState: { validation_failed: 2 }, notPushed: 0, pushGivenUp: 0 }, { ...EMPTY_EXPENSES, quickbooks: tab(2) });
    wrap();
    expect(tabButton(/^QuickBooks/)).toHaveAttribute("aria-pressed", "true");
    expect(mockExpenseLoad).toHaveBeenCalledWith("/finance-queue?tab=qb");
  });

  it("opens Finance review and says nothing waits when no tab has work", () => {
    wrap();
    expect(tabButton(/^Finance review/)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Nothing waiting on you.")).toBeInTheDocument();
  });

  it("lands a Board member on the Board tab when it has their signatures", () => {
    mockIsFinance = false;
    counts({ byState: { financial_review: 3 }, notPushed: 0, pushGivenUp: 0 }, { ...EMPTY_EXPENSES, board: tab(1, 2) });
    wrap();
    expect(tabButton(/^Board/)).toHaveAttribute("aria-pressed", "true");
  });

  it("names the next tab with work when the current one is empty", () => {
    mockSearch = new URLSearchParams("queue=financial_review");
    counts(EMPTY_RECEIPTS, { ...EMPTY_EXPENSES, quickbooks: tab(2) });
    wrap();
    expect(screen.getByText(/Nothing left here\. Next:/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "QuickBooks (2)" }));
    expect(mockReplace).toHaveBeenCalledWith("/finance/review?queue=qb", { scroll: false });
  });
});

describe("the receipt tabs", () => {
  const moreStates = () => screen.getByRole("textbox", { name: "More receipt states" });

  it.each([
    ["submitter_review", "?state=submitter_review", "Submitter review"],
    ["receipt_finalized", "?state=receipt_finalized", "Receipt finalized"],
    ["not_pushed", "?state=receipt_finalized&pushed=0", "Not delivered to part mapping"],
    ["discarded", "?state=discarded", "Discarded"],
  ])("?queue=%s lists %s and names it in the More picker", (queue, path, label) => {
    mockSearch = new URLSearchParams(`queue=${queue}`);
    wrap();
    expect(mockReceiptLoad).toHaveBeenCalledWith(path);
    expect(moreStates()).toHaveValue(label);
  });

  it("lists every receipt on All", () => {
    mockSearch = new URLSearchParams("queue=all");
    wrap();
    expect(mockReceiptLoad).toHaveBeenCalledWith("");
  });

  it("switches to the state picked", async () => {
    mockSearch = new URLSearchParams("queue=financial_review");
    wrap();
    fireEvent.click(moreStates());
    fireEvent.click(await screen.findByRole("option", { name: "Submitter review" }));
    expect(mockReplace).toHaveBeenCalledWith("/finance/review?queue=submitter_review", { scroll: false });
  });

  it("opens a receipt at /receipts/[id], carrying the queue", () => {
    mockSearch = new URLSearchParams("queue=duplicate_flagged");
    mockReceiptLoads["?state=duplicate_flagged"] = {
      data: [{ id: "r1", uploadedAt: "2026-10-01T00:00:00Z", uploadedByUserId: 1, retailer: "Acme", receiptDate: null, receiptTotalCents: 1000, state: "duplicate_flagged", needsReimbursement: false, isInKind: false }],
      error: null,
    };
    wrap();
    expect(screen.getByRole("link", { name: /2026/ })).toHaveAttribute("href", "/receipts/r1?queue=duplicate_flagged");
  });

  it("names a duplicate discard on the Discarded tab and links the receipt it duplicates, carrying the queue", () => {
    mockSearch = new URLSearchParams("queue=discarded");
    const base = { uploadedAt: "2026-10-01T00:00:00Z", uploadedByUserId: 1, receiptDate: null, receiptTotalCents: 1000, state: "discarded", needsReimbursement: false, isInKind: false };
    mockReceiptLoads["?state=discarded"] = {
      data: [
        { ...base, id: "r1", retailer: "Acme", duplicateFlaggedAt: "2026-10-02T00:00:00Z", duplicateSuspectReceiptId: "r0" },
        { ...base, id: "r2", retailer: "Bolt" },
      ],
      error: null,
    };
    wrap();
    const [acme, bolt] = ["Acme", "Bolt"].map((name) => screen.getByText(name).closest("tr") as HTMLElement);
    expect(acme).toHaveTextContent("Discarded as a duplicate of another receipt");
    expect(within(acme).getByRole("link", { name: "another receipt" })).toHaveAttribute("href", "/receipts/r0?queue=discarded");
    expect(bolt).not.toHaveTextContent("as a duplicate");
  });

  it("counts FINANCE's own queues in green and the rest in gray, and only gray for the Board", () => {
    const receipts = { byState: { financial_review: 3, validation_failed: 2 }, notPushed: 0, pushGivenUp: 0 };
    counts(receipts, EMPTY_EXPENSES);
    const { unmount } = wrap();
    expect(tabButton(/^Finance review/)).toContainElement(screen.getByLabelText("3 to act on"));
    expect(tabButton(/^Totals off/)).toContainElement(screen.getByLabelText("2 in this queue"));
    unmount();
    mockIsFinance = false;
    wrap();
    expect(screen.getByLabelText("3 in this queue")).toBeInTheDocument();
    expect(screen.queryByLabelText(/to act on/)).not.toBeInTheDocument();
  });

  it("reloads the counts when a write tells the nav to refetch", () => {
    wrap();
    act(() => {
      window.dispatchEvent(new Event("nav-counts-mutated"));
    });
    expect(mockReloadCounts).toHaveBeenCalled();
  });

  it("points Not delivered at Part mapping › Apply failed when receipts failed to apply", async () => {
    mockSearch = new URLSearchParams("queue=not_pushed");
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ apply_failed: 3 }) } as Response);
    wrap();
    expect(await screen.findByRole("link", { name: "3 receipts failed to apply in part mapping" })).toHaveAttribute("href", "/inventory/receiving?queue=failed");
    expect(fetchSpy).toHaveBeenCalledWith("/api/workflow-mapping/receipts/counts");
  });

  it("shows a failed receipt count load as a chip that stays up, naming the route, never inline", () => {
    mockReceiptLoads["/queue-counts"] = { data: null, error: "Internal Server Error" };
    wrap();
    expect(mockShow).toHaveBeenCalledWith(expect.objectContaining({
      title: "Couldn't load the receipt tab counts",
      message: "GET /api/receipts/queue-counts failed on the server (HTTP 500); the server log names the cause under that route.",
      color: "red",
      autoClose: false,
    }));
    expect(screen.queryByText(/Internal Server Error/)).not.toBeInTheDocument();
  });
});

describe("the expense tabs", () => {
  const row = (expenseId: string | null, reasons: { code: string; text: string; href?: string }[]) => ({
    expenseId, vendorName: "Acme", date: "2026-10-01", amountCents: 234000, currency: "USD", reasons, waitingSince: "2026-10-01T00:00:00Z",
  });

  it("shows each row's date, vendor, amount and plain-word reasons, linking to the expense with the tab", () => {
    mockSearch = new URLSearchParams("queue=board");
    counts(EMPTY_RECEIPTS, { ...EMPTY_EXPENSES, board: tab(1) });
    mockExpenseLoads["/finance-queue?tab=board"] = { data: [row("e1", [{ code: "BOARD_APPROVAL", text: "Board approval of a $2,340.00 purchase not recorded" }])], error: null };
    wrap();
    expect(screen.getByText("Board approval of a $2,340.00 purchase not recorded")).toBeInTheDocument();
    expect(screen.getByText("$2,340.00")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "2026-10-01" })).toHaveAttribute("href", `/expense/expenses/e1?queue=board&from=${encodeURIComponent("/finance/review?queue=board")}`);
    expect(screen.queryByText("BOARD_APPROVAL")).not.toBeInTheDocument();
  });

  it("splits a tab by reason with a chip per reason that rides in the URL", () => {
    mockSearch = new URLSearchParams("queue=expenses");
    counts(EMPTY_RECEIPTS, { ...EMPTY_EXPENSES, expenses: tab(3, 3, { REIMBURSEE_TO_NAME: 1, CAPITAL_REVIEW: 2 }) });
    mockExpenseLoads["/finance-queue?tab=expenses"] = {
      data: [row("e1", [{ code: "REIMBURSEE_TO_NAME", text: "Reimbursee to name" }]), row("e2", [{ code: "CAPITAL_REVIEW", text: "Capital review" }])],
      error: null,
    };
    wrap();
    fireEvent.click(screen.getByRole("checkbox", { name: "Capital review 2" }));
    expect(mockReplace).toHaveBeenCalledWith("/finance/review?queue=expenses&reason=CAPITAL_REVIEW", { scroll: false });
  });

  it("filters to the chip in the URL and carries it to the expense", () => {
    mockSearch = new URLSearchParams("queue=expenses&reason=CAPITAL_REVIEW");
    counts(EMPTY_RECEIPTS, { ...EMPTY_EXPENSES, expenses: tab(3, 3, { REIMBURSEE_TO_NAME: 1, CAPITAL_REVIEW: 2 }) });
    mockExpenseLoads["/finance-queue?tab=expenses"] = {
      data: [row("e1", [{ code: "REIMBURSEE_TO_NAME", text: "Reimbursee to name" }]), row("e2", [{ code: "CAPITAL_REVIEW", text: "Capital review" }])],
      error: null,
    };
    wrap();
    const links = screen.getAllByRole("link", { name: "2026-10-01" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", `/expense/expenses/e2?queue=expenses&from=${encodeURIComponent("/finance/review?queue=expenses&reason=CAPITAL_REVIEW")}`);
  });

  it("links a failed intake row to Part mapping", () => {
    mockSearch = new URLSearchParams("queue=expenses");
    counts(EMPTY_RECEIPTS, { ...EMPTY_EXPENSES, expenses: tab(1) });
    mockExpenseLoads["/finance-queue?tab=expenses"] = {
      data: [row(null, [{ code: "INTAKE_FAILED", text: "Receipt didn't become an expense", href: "/inventory/receiving?queue=failed" }])],
      error: null,
    };
    wrap();
    expect(screen.getByRole("link", { name: "2026-10-01" })).toHaveAttribute("href", "/inventory/receiving?queue=failed");
  });

  it("dims a tab with nothing for the viewer and badges the rest", async () => {
    counts(EMPTY_RECEIPTS, { ...EMPTY_EXPENSES, toSign: tab(2), accountHolds: tab(0, 1) });
    wrap();
    await waitFor(() => expect(tabButton(/^To sign/)).toContainElement(screen.getByLabelText("2 to act on")));
    expect(tabButton(/^Account holds/)).toContainElement(screen.getByLabelText("1 in this queue"));
    expect(tabButton(/^Account holds/)).toHaveStyle({ opacity: "0.6" });
  });
});

describe("load failures", () => {
  it("shows a failed expense count load as a chip that stays up, naming the route, never inline", () => {
    mockExpenseLoads["/finance-queue/counts"] = { data: null, error: "Internal Server Error" };
    wrap();
    expect(mockShow).toHaveBeenCalledWith(expect.objectContaining({
      title: "Couldn't load the expense tab counts",
      message: "GET /api/expense/finance-queue/counts failed on the server (HTTP 500); the server log names the cause under that route.",
      color: "red",
      autoClose: false,
    }));
    expect(screen.queryByText(/Internal Server Error/)).not.toBeInTheDocument();
  });

  it("shows a tab that fails to load as a chip naming the tab and its route, and keeps the Board tab for FINANCE", () => {
    mockSearch = new URLSearchParams("queue=board");
    mockExpenseLoads["/finance-queue?tab=board"] = { data: null, error: "Internal Server Error" };
    wrap();
    expect(tabButton(/^Board/)).toHaveAttribute("aria-pressed", "true");
    expect(mockShow).toHaveBeenCalledWith(expect.objectContaining({
      title: "Couldn't load the Board tab",
      message: "GET /api/expense/finance-queue?tab=board failed on the server (HTTP 500); the server log names the cause under that route.",
      autoClose: false,
    }));
    expect(screen.queryByText(/Internal Server Error/)).not.toBeInTheDocument();
  });

  it("passes a refusal's own words through", () => {
    mockSearch = new URLSearchParams("queue=expenses");
    mockExpenseLoads["/finance-queue?tab=expenses"] = { data: null, error: "Forbidden" };
    wrap();
    expect(mockShow).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't load the Expenses tab", message: "GET /api/expense/finance-queue?tab=expenses answered: Forbidden" }));
  });
});
