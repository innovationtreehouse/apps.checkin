import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ReceiptDetailPage from "@checkin/receipt/pages/detail";

let mockSearch = new URLSearchParams("queue=duplicate_flagged");
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockReload = jest.fn();
const mockSend = jest.fn<Promise<boolean>, unknown[]>();

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "r1" }),
  useSearchParams: () => mockSearch,
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: 2 } } }) }));
jest.mock("@checkin/receipt/components/ReceiptFile", () => ({ __esModule: true, default: () => null }));

const receipt = {
  id: "r1", uploadedAt: "2026-10-01T00:00:00Z", uploadedByUserId: 1, retailer: "Acme", receiptDate: "2026-10-01",
  receiptTotalCents: 1000, state: "financial_review", needsReimbursement: false, isInKind: false,
  mimeType: "application/pdf", taxCents: 0, shippingCents: 0, discountCents: 0, financialReviewReasons: ["tax"], lineItems: [],
};
let mockLoads: Record<string, unknown> = {};

jest.mock("@checkin/receipt/components/api", () => ({
  ...jest.requireActual("@checkin/receipt/components/api"),
  useLoad: (path: string | null) => ({ data: path === null ? null : mockLoads[path] ?? null, error: null, reload: mockReload }),
  useRoles: () => ({ isFinance: true, isBoard: false }),
  send: (...args: unknown[]) => mockSend(...args),
}));

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockLoads = { "/r1": receipt, "/r1/audit-logs": [], "?state=duplicate_flagged": [receipt] };
  mockSend.mockResolvedValue(true);
});

const wrap = (ui: React.ReactElement) => render(<MantineProvider>{ui}</MantineProvider>);

describe("a receipt opened from the finance queue", () => {
  beforeEach(() => {
    mockSearch = new URLSearchParams("queue=duplicate_flagged");
  });

  it("links back to the queue it came from", () => {
    wrap(<ReceiptDetailPage queueBase="/finance/review" />);
    expect(screen.getByRole("link", { name: "← Finance review" })).toHaveAttribute("href", "/finance/review?queue=duplicate_flagged");
  });

  it("returns to that queue once approved", async () => {
    wrap(<ReceiptDetailPage queueBase="/finance/review" />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/finance/review?queue=duplicate_flagged"));
    expect(mockReload).not.toHaveBeenCalled();
  });

  it("stays on the receipt when an approval fails", async () => {
    mockSend.mockResolvedValue(false);
    wrap(<ReceiptDetailPage queueBase="/finance/review" />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("names the finance review reasons in plain words", () => {
    mockLoads["/r1"] = { ...receipt, financialReviewReasons: ["old_date", "submitter_correction"] };
    wrap(<ReceiptDetailPage />);
    expect(
      screen.getByText("Finance review: the receipt is older than the age limit; the submitter changed the tax or date"),
    ).toBeInTheDocument();
  });

  it("shows a reason it has no words for as its code", () => {
    mockLoads["/r1"] = { ...receipt, financialReviewReasons: ["tax", "new_reason"] };
    wrap(<ReceiptDetailPage />);
    expect(screen.getByText("Finance review: tax was charged; new_reason")).toBeInTheDocument();
  });

  it.each([
    [["old_date"], ["2026-10-01"]],
    [["future_date"], ["2026-10-01"]],
    [["tax"], ["tax $0.00"]],
    [["tax", "old_date"], ["2026-10-01", "tax $0.00"]],
    [["submitter_correction"], []],
  ])("for reasons %j marks %j", (reasons, marked) => {
    mockLoads["/r1"] = { ...receipt, financialReviewReasons: reasons };
    const { container } = wrap(<ReceiptDetailPage />);
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(marked);
  });
});

describe("a receipt opened at /receipts/[id]", () => {
  beforeEach(() => {
    mockSearch = new URLSearchParams();
  });

  it("links back to My receipts and stays put after a decision", async () => {
    wrap(<ReceiptDetailPage queueBase="/finance/review" />);
    expect(screen.getByRole("link", { name: "← My receipts" })).toHaveAttribute("href", "/receipts");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(mockReload).toHaveBeenCalled());
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe("the finance decision on a receipt in financial review", () => {
  beforeEach(() => {
    mockSearch = new URLSearchParams();
  });

  it("approves a tax-flagged receipt with no note", async () => {
    wrap(<ReceiptDetailPage />);
    expect(screen.queryAllByRole("textbox", { name: /note/i })).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith("/r1/approve", "POST", {}, "Approved", "Couldn't approve this receipt"));
  });

  it("does not send the reject reason with an approval", async () => {
    wrap(<ReceiptDetailPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "Reason (optional)" }), { target: { value: "personal purchase" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith("/r1/approve", "POST", {}, "Approved", "Couldn't approve this receipt"));
  });

  it("rejects with the reason typed in its own field", async () => {
    wrap(<ReceiptDetailPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "Reason (optional)" }), { target: { value: "  personal purchase " } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith("/r1/reject", "POST", { reason: "personal purchase" }, "Rejected", "Couldn't reject this receipt"));
  });

  it("rejects without a reason", async () => {
    wrap(<ReceiptDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith("/r1/reject", "POST", { reason: null }, "Rejected", "Couldn't reject this receipt"));
  });
});
