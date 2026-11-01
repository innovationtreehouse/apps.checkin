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
  useSearchParams: () => new URLSearchParams("queue=duplicate_flagged"),
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: mockUserId } } }) }));
jest.mock("@mantine/notifications", () => ({ notifications: { show: (...args: unknown[]) => mockShow(...args) } }));
jest.mock("@checkin/receipt/components/ReceiptFile", () => ({
  __esModule: true,
  default: ({ src, mimeType, title }: { src: string; mimeType: string; title: string }) => <figure aria-label={title} data-src={src} data-type={mimeType} />,
}));
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

const group = (...members: Array<{ id: string; state: string }>) => ({ members: members.map((m) => ({ ...m, label: m.state })), dismissed: [] });

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
  mockLoads = {
    "/r1": flagged,
    "/r0": original,
    "/r1/audit-logs": [],
    "/r1/duplicate-group": group({ id: "r0", state: "submitter_review" }, { id: "r1", state: "duplicate_flagged" }),
  };
  mockErrors = {};
  mockSend.mockResolvedValue(true);
});

const wrap = () => render(<MantineProvider><ReceiptDetailPage queueBase="/finance/review" /></MantineProvider>);
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

  it.each([
    ["this receipt is the gift", { isInKind: true }, { needsReimbursement: true }, "Gift of goods", "For reimbursement"],
    ["this receipt is for reimbursement", { needsReimbursement: true }, { isInKind: true }, "For reimbursement", "Gift of goods"],
  ])("warns when %s and the other is the opposite", (_name, mine, theirs, mineLabel, theirsLabel) => {
    mockLoads["/r1"] = { ...flagged, ...mine };
    mockLoads["/r0"] = { ...original, ...theirs };
    wrap();
    const cells = within(row("Recorded as")).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent(mineLabel);
    expect(cells[2]).toHaveTextContent(theirsLabel);
    expect(screen.getByRole("alert")).toHaveTextContent("One is recorded as a gift of goods and the other is for reimbursement.");
  });

  it("gives no warning on two ordinary purchases, and does not count that as a match", () => {
    wrap();
    expect(within(row("Recorded as")).getAllByText("Purchase")).toHaveLength(2);
    expect(within(row("Recorded as")).queryByText("Same")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("names no donor on the compare panel", () => {
    mockLoads["/r1"] = { ...flagged, isInKind: true, donorFirstName: "Dana", donorLastName: "Donor" };
    mockLoads["/r0"] = { ...original, needsReimbursement: true };
    wrap();
    expect(within(row("Recorded as")).queryByText(/Dana|Donor/)).toBeNull();
    expect(screen.getByRole("alert")).not.toHaveTextContent(/Dana|Donor/);
  });

  it("links to the original under the review queue", () => {
    wrap();
    expect(screen.getByRole("link", { name: "Open the suspected original" })).toHaveAttribute("href", "/receipts/r0?queue=duplicate_flagged");
  });

  it("shows both files side by side from the file route, each with a download link", () => {
    mockLoads["/r0"] = { ...original, mimeType: "image/jpeg" };
    wrap();
    const mine = screen.getByRole("figure", { name: "This receipt's file" });
    const theirs = screen.getByRole("figure", { name: "The original's file" });
    expect(mine).toHaveAttribute("data-src", "/api/receipts/r1/file");
    expect(mine).toHaveAttribute("data-type", "application/pdf");
    expect(theirs).toHaveAttribute("data-src", "/api/receipts/r0/file");
    expect(theirs).toHaveAttribute("data-type", "image/jpeg");
    expect(mine.parentElement?.parentElement).toBe(theirs.parentElement?.parentElement);
    const downloads = screen.getAllByRole("link", { name: "Download" });
    expect(downloads.map((a) => a.getAttribute("href"))).toEqual(["/api/receipts/r1/file", "/api/receipts/r0/file"]);
    for (const a of downloads) expect(a).toHaveAttribute("download");
  });

  it("records different purchases for the two receipts shown and returns to the queue", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Different purchases" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/finance/review?queue=duplicate_flagged"));
    expect(mockSend).toHaveBeenCalledWith("/r1/different-purchases", "POST", { shownIds: ["r0", "r1"] }, "Recorded as different purchases", "Couldn't record different purchases");
  });

  it("keeps this receipt, rejecting the other as its copy, and returns to the queue", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Keep this one" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/finance/review?queue=duplicate_flagged"));
    expect(mockSend).toHaveBeenCalledWith("/r1/keep-this-one", "POST", { shownIds: ["r0", "r1"] }, "Kept; the other copy is rejected", "Couldn't keep this receipt");
  });

  it("dismisses the match shown with Not this one and stays to redraw", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Not this one" }));
    await waitFor(() => expect(mockReload).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith("/r1/not-this-one", "POST", { otherId: "r0" }, "Dismissed as a different purchase", "Couldn't dismiss this match");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("offers only Not this one when the group holds more receipts than the two shown", () => {
    mockLoads["/r1/duplicate-group"] = group({ id: "r0", state: "submitter_review" }, { id: "r1", state: "duplicate_flagged" }, { id: "r2", state: "duplicate_flagged" });
    wrap();
    expect(screen.getByRole("button", { name: "Not this one" })).toBeInTheDocument();
    for (const name of ["Different purchases", "Keep this one"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("offers no Keep this one beside a finalized copy", () => {
    mockLoads["/r0"] = { ...original, state: "receipt_finalized" };
    mockLoads["/r1/duplicate-group"] = group({ id: "r0", state: "receipt_finalized" }, { id: "r1", state: "duplicate_flagged" });
    wrap();
    expect(screen.getByRole("button", { name: "Different purchases" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keep this one" })).toBeNull();
  });

  it("offers Different purchases on this receipt alone when no other receipt still matches it", async () => {
    mockLoads["/r1/duplicate-group"] = group({ id: "r1", state: "duplicate_flagged" });
    wrap();
    expect(screen.getByText("No other receipt matches this one now.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Different purchases" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith("/r1/different-purchases", "POST", { shownIds: ["r1"] }, "Released from the duplicate hold", "Couldn't release this receipt");
  });

  it("raises a chip that stays when the group cannot be loaded", () => {
    mockLoads["/r1/duplicate-group"] = null;
    mockErrors["/r1/duplicate-group"] = "Receipt not found";
    wrap();
    expect(mockShow).toHaveBeenCalledWith({ title: "Couldn't load the possible copies", message: "Receipt not found", color: "red", autoClose: false });
  });

  it("rejects this receipt with a reason and returns to the queue, offering finance no discard", async () => {
    wrap();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason to reject" }), { target: { value: "a copy of r0" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith("/r1/reject", "POST", { reason: "a copy of r0" }, "Rejected", "Couldn't reject this receipt");
  });

  it("rejects the original with a reason and stays to decide this receipt", async () => {
    wrap();
    expect(screen.getByRole("button", { name: "Reject the original" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason to reject the original" }), { target: { value: " a copy " } });
    fireEvent.click(screen.getByRole("button", { name: "Reject the original" }));
    await waitFor(() => expect(mockReload).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith("/r0/reject", "POST", { reason: "a copy" }, "The original is rejected", "Couldn't reject the original");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it.each([
    ["is finalized", { state: "receipt_finalized" }],
    ["is discarded", { state: "discarded" }],
    ["was sent to receiving", { pushedAt: "2026-10-01T00:00:00Z" }],
  ])("offers no reject of an original that %s", (_why, change) => {
    mockLoads["/r0"] = { ...original, ...change };
    wrap();
    expect(screen.queryByRole("button", { name: "Reject the original" })).toBeNull();
    expect(screen.getByRole("button", { name: "Not this one" })).toBeInTheDocument();
  });

  it("names a finalized original's state in plain words", () => {
    mockLoads["/r0"] = { ...original, state: "receipt_finalized" };
    wrap();
    expect(screen.getByText("Receipt finalized")).toBeInTheDocument();
  });

  it("shows BOARD the compare without actions", () => {
    mockRoles = { isFinance: false, isBoard: true };
    wrap();
    expect(within(row("Vendor")).getByText("Same")).toBeInTheDocument();
    expect(screen.getByText("Finance decides whether this is a duplicate.")).toBeInTheDocument();
    for (const name of ["Not this one", "Different purchases", "Keep this one", "Reject the original", "Reject", "Discard"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("offers the uploader in finance a discard of their own receipt, and no decision or reject", () => {
    mockUserId = 1;
    wrap();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    for (const name of ["Not this one", "Different purchases", "Keep this one", "Reject the original", "Reject"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByText("Someone else in finance decides whether your own receipt is a duplicate.")).toBeInTheDocument();
  });

  it("raises a chip that stays when the original cannot be loaded", () => {
    mockLoads["/r0"] = null;
    mockErrors["/r0"] = "Receipt not found";
    wrap();
    expect(mockShow).toHaveBeenCalledWith({ title: "Couldn't load the suspected original", message: "Receipt not found", color: "red", autoClose: false });
    expect(screen.getByText("The suspected original is not loaded.")).toBeInTheDocument();
    expect(screen.getByText("The original's file is not loaded.")).toBeInTheDocument();
    expect(screen.getByRole("figure", { name: "This receipt's file" })).toBeInTheDocument();
  });

  it("offers a retry and no group decision when the original cannot be loaded", () => {
    mockLoads["/r0"] = null;
    mockErrors["/r0"] = "Receipt not found";
    wrap();
    for (const name of ["Not this one", "Different purchases", "Keep this one"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getByText(/Receipt not found/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockReload).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("offers no decision on the match until the original has loaded", () => {
    mockLoads["/r0"] = null;
    wrap();
    for (const name of ["Not this one", "Different purchases", "Keep this one", "Retry"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getByText("Loading the suspected original…")).toBeInTheDocument();
  });

  it("links the original once the flag is cleared", () => {
    mockLoads["/r1"] = { ...flagged, state: "submitter_review", duplicateFlagClearedAt: "2026-10-03T00:00:00Z" };
    wrap();
    expect(screen.getByRole("link", { name: "another receipt" })).toHaveAttribute("href", "/receipts/r0?queue=duplicate_flagged");
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
