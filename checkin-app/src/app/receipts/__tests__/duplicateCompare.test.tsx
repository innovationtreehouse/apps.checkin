import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ReceiptDetailPage from "@checkin/receipt/pages/detail";

const mockPush = jest.fn();
const mockReload = jest.fn();
const mockSend = jest.fn<Promise<boolean>, unknown[]>();
const mockShow = jest.fn();
let mockRoles = { isFinance: true, isBoard: false };
let mockUserId = 2;
let mockLoads: Record<string, unknown> = {};
let mockErrors: Record<string, string> = {};

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "r1" }),
  usePathname: () => "/receipts/review/r1",
  useSearchParams: () => new URLSearchParams("queue=duplicate_flagged"),
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: mockUserId } } }) }));
jest.mock("@mantine/notifications", () => ({ notifications: { show: (...args: unknown[]) => mockShow(...args) } }));
jest.mock("@checkin/receipt/components/ReceiptFile", () => ({ __esModule: true, default: () => null }));
jest.mock("@checkin/receipt/components/api", () => ({
  ...jest.requireActual("@checkin/receipt/components/api"),
  useLoad: (path: string | null) => ({ data: path === null ? null : mockLoads[path] ?? null, error: path === null ? null : mockErrors[path] ?? null, reload: mockReload }),
  useRoles: () => mockRoles,
  send: (...args: unknown[]) => mockSend(...args),
}));

const flagged = {
  id: "r1", uploadedAt: "2026-10-02T00:00:00Z", uploadedByUserId: 1, fileHash: "aaaaaaaaaaaaffff", mimeType: "application/pdf",
  retailer: "Acme", receiptDate: "2026-10-01", receiptNumber: "R-9", orderNumber: null, currency: "USD",
  receiptTotalCents: 1000, taxCents: 80, shippingCents: 0, discountCents: 0, state: "duplicate_flagged",
  needsReimbursement: false, isInKind: false, duplicateSuspectReceiptId: "r0", financialReviewReasons: [],
  lineItems: [{ id: 1, lineNumber: 1, description: "Arduino", partNumber: "A-1", quantity: 1, unitPriceCents: 920, totalPriceCents: 920, isDelayed: false }],
};
const original = {
  ...flagged, id: "r0", uploadedAt: "2026-09-30T00:00:00Z", uploadedByUserId: 3, receiptNumber: "R-8", state: "submitter_review",
  duplicateSuspectReceiptId: null,
  lineItems: [{ id: 9, lineNumber: 1, description: "Arduino Uno", partNumber: null, quantity: 2, unitPriceCents: 460, totalPriceCents: 920, isDelayed: false }],
};

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
  mockRoles = { isFinance: true, isBoard: false };
  mockUserId = 2;
  mockLoads = { "/r1": flagged, "/r0": original, "/r1/audit-logs": [] };
  mockErrors = {};
  mockSend.mockResolvedValue(true);
});

const wrap = () => render(<MantineProvider><ReceiptDetailPage /></MantineProvider>);
/** The compare row whose first cell is `label`, with or without its "Same" badge. */
function row(label: string): HTMLElement {
  const found = screen.getAllByRole("row").find((r) => within(r).queryAllByRole("cell")[0]?.textContent?.replace(/Same$/, "") === label);
  if (!found) throw new Error(`no compare row ${label}`);
  return found;
}

describe("a suspected duplicate's detail page", () => {
  it("shows the suspected original beside it and marks the fields that match", () => {
    wrap();
    expect(within(row("Vendor")).getAllByText("Acme")).toHaveLength(2);
    expect(within(row("Vendor")).getByText("Same")).toBeInTheDocument();
    expect(within(row("Receipt #")).getByText("R-9")).toBeInTheDocument();
    expect(within(row("Receipt #")).getByText("R-8")).toBeInTheDocument();
    expect(within(row("Receipt #")).queryByText("Same")).toBeNull();
    expect(within(row("Order #")).queryByText("Same")).toBeNull();
    expect(within(row("Total")).getByText("Same")).toBeInTheDocument();
    expect(screen.getByText("Both receipts are the same file.")).toBeInTheDocument();
    expect(screen.getByText("Arduino Uno")).toBeInTheDocument();
  });

  it("says when the files differ", () => {
    mockLoads["/r0"] = { ...original, fileHash: "bbbbbbbbbbbb0000" };
    wrap();
    expect(screen.getByText("The files differ; the receipts match on their details.")).toBeInTheDocument();
    expect(within(row("File")).queryByText("Same")).toBeNull();
  });

  it("links to the original under the review queue", () => {
    wrap();
    expect(screen.getByRole("link", { name: "Open the suspected original" })).toHaveAttribute("href", "/receipts/review/r0?queue=duplicate_flagged");
    expect(screen.getByRole("link", { name: "View its file" })).toHaveAttribute("href", "/api/receipts/r0/file");
  });

  it("clears the flag and returns to the queue", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Not a duplicate" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/receipts/review?queue=duplicate_flagged"));
    expect(mockSend).toHaveBeenCalledWith("/r1/clear-duplicate", "POST", {}, "Cleared as not a duplicate", "Couldn't clear the duplicate flag");
  });

  it("discards this receipt and returns to the queue", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Discard this receipt" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith("/r1/discard", "POST", {}, "Discarded", "Couldn't discard this receipt");
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  it("discards the original and stays to decide this receipt", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Discard the original" }));
    await waitFor(() => expect(mockReload).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith("/r0/discard", "POST", {}, "The original is discarded", "Couldn't discard the original");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it.each([
    ["is finalized", { state: "receipt_finalized" }],
    ["is discarded", { state: "discarded" }],
    ["was sent to receiving", { pushedAt: "2026-10-01T00:00:00Z" }],
  ])("offers no discard of an original that %s", (_why, change) => {
    mockLoads["/r0"] = { ...original, ...change };
    wrap();
    expect(screen.queryByRole("button", { name: "Discard the original" })).toBeNull();
    expect(screen.getByRole("button", { name: "Not a duplicate" })).toBeInTheDocument();
  });

  it("shows BOARD the compare without actions", () => {
    mockRoles = { isFinance: false, isBoard: true };
    wrap();
    expect(within(row("Vendor")).getByText("Same")).toBeInTheDocument();
    expect(screen.getByText("Finance decides whether this is a duplicate.")).toBeInTheDocument();
    for (const name of ["Not a duplicate", "Discard this receipt", "Discard the original", "Discard"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("does not offer the uploader in finance to clear their own receipt or discard its original", () => {
    mockUserId = 1;
    wrap();
    expect(screen.queryByRole("button", { name: "Not a duplicate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard the original" })).toBeNull();
    expect(screen.getByText("Someone else in finance decides whether your own receipt is a duplicate.")).toBeInTheDocument();
  });

  it("raises a chip that stays when the original cannot be loaded", () => {
    mockLoads["/r0"] = null;
    mockErrors["/r0"] = "Receipt not found";
    wrap();
    expect(mockShow).toHaveBeenCalledWith({ title: "Couldn't load the suspected original", message: "Receipt not found", color: "red", autoClose: false });
    expect(screen.getByText("The suspected original is not loaded.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not a duplicate" })).toBeInTheDocument();
  });

  it("links the original once the flag is cleared", () => {
    mockLoads["/r1"] = { ...flagged, state: "submitter_review", duplicateFlagClearedAt: "2026-10-03T00:00:00Z" };
    wrap();
    expect(screen.getByRole("link", { name: "another receipt" })).toHaveAttribute("href", "/receipts/review/r0?queue=duplicate_flagged");
    expect(screen.getByText(/and cleared as not a duplicate/)).toBeInTheDocument();
    expect(screen.queryByText("Possible duplicate", { selector: "h5" })).toBeNull();
  });

  it("badges a receipt discarded while flagged as discarded as a duplicate", () => {
    mockLoads["/r1"] = { ...flagged, state: "discarded", duplicateFlaggedAt: "2026-10-02T00:00:00Z" };
    wrap();
    expect(screen.getByText("Discarded as a duplicate")).toBeInTheDocument();
  });

  it("badges a receipt discarded after its flag was cleared as plainly discarded", () => {
    mockLoads["/r1"] = { ...flagged, state: "discarded", duplicateFlaggedAt: "2026-10-02T00:00:00Z", duplicateFlagClearedAt: "2026-10-03T00:00:00Z" };
    wrap();
    expect(screen.getByText("Discarded")).toBeInTheDocument();
    expect(screen.queryByText("Discarded as a duplicate")).toBeNull();
  });
});
