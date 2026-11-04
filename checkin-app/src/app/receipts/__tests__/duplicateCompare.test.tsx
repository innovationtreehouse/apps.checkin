import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  api: (path: string) => {
    if (mockErrors[path]) return Promise.reject(new Error(mockErrors[path]));
    return mockLoads[path] ? Promise.resolve(mockLoads[path]) : new Promise(() => {});
  },
}));

const flagged = {
  id: "r1", uploadedAt: "2026-10-02T00:00:00Z", uploadedByUserId: 1, fileHash: "aaaaaaaaaaaaffff", mimeType: "application/pdf",
  retailer: "Acme", receiptDate: "2026-10-01", receiptNumber: "R-9", orderNumber: null, currency: "USD",
  receiptTotalCents: 1000, taxCents: 80, shippingCents: 0, discountCents: 0, state: "duplicate_flagged",
  needsReimbursement: false, isInKind: false, duplicateSuspectReceiptId: null, financialReviewReasons: [],
  lineItems: [{ id: 1, lineNumber: 1, description: "Arduino", partNumber: "A-1", quantity: 1, unitPriceCents: 920, totalPriceCents: 920, isDelayed: false }],
};
const earlier = {
  ...flagged, id: "r0", uploadedAt: "2026-09-30T00:00:00Z", uploadedByUserId: 3, receiptNumber: "R-8", state: "submitter_review",
  lineItems: [{ id: 9, lineNumber: 1, description: "Arduino Uno", partNumber: null, quantity: 2, unitPriceCents: 460, totalPriceCents: 920, isDelayed: false }],
};
const later = { ...earlier, id: "r2", uploadedAt: "2026-10-03T00:00:00Z", receiptNumber: "R-7", fileHash: "cccccccccccc0000", lineItems: [] };

type Member = { id: string; state: string; label?: string; copyOfId?: string | null; uploaderName?: string | null };
const group = (members: Member[], dismissed: string[] = []) => ({ members: members.map((m) => ({ label: m.state, copyOfId: null, ...m })), dismissed });
const r0 = { id: "r0", state: "submitter_review", uploaderName: "Pat Doe" };
const r1 = { id: "r1", state: "duplicate_flagged", uploaderName: "Sam Roe" };
const r2 = { id: "r2", state: "duplicate_flagged", uploaderName: "Lee Poe" };

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
    "/r0": earlier,
    "/r2": later,
    "/r1/audit-logs": [],
    "/r1/duplicate-group": group([r0, r1, r2]),
  };
  mockErrors = {};
  mockSend.mockResolvedValue(true);
});

const page = () => <MantineProvider><ReceiptDetailPage queueBase="/finance/review" /></MantineProvider>;
async function wrap() {
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(page());
  });
  return view as ReturnType<typeof render>;
}
function row(label: string): HTMLElement {
  const found = screen.getAllByRole("row").find((r) => within(r).queryAllByRole("cell")[0]?.textContent === label);
  if (!found) throw new Error(`no compare row ${label}`);
  return found;
}

describe("the N-way compare", () => {
  it("shows every member side by side, the viewed receipt first and the rest in upload order", async () => {
    await wrap();
    expect(within(row("Receipt #")).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Receipt #", "R-9", "R-8", "R-7"]);
    expect(within(row("Uploaded by")).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Uploaded by", "Sam Roe", "Pat Doe", "Lee Poe"]);
    expect(screen.getByRole("figure", { name: "This receipt's file" })).toHaveAttribute("data-src", "/api/receipts/r1/file");
    expect(screen.getByRole("figure", { name: "File of match 2" })).toHaveAttribute("data-src", "/api/receipts/r2/file");
    expect(screen.getByText("Arduino Uno")).toBeInTheDocument();
  });

  it("marks what each match shares with the viewed receipt and why it matched", async () => {
    await wrap();
    const cells = within(row("Matched on")).getAllByRole("cell");
    expect(cells[2]).toHaveTextContent("Same file, Same vendor, date and total");
    expect(cells[3]).toHaveTextContent("Same vendor, date and total");
    expect(within(within(row("Vendor")).getAllByRole("cell")[3]).getByText("Same")).toBeInTheDocument();
    expect(within(within(row("Receipt #")).getAllByRole("cell")[3]).queryByText("Same")).toBeNull();
  });

  it("says a match is linked through another receipt when it shares nothing with this one", async () => {
    mockLoads["/r2"] = { ...later, retailer: "Other" };
    await wrap();
    expect(within(row("Matched on")).getAllByRole("cell")[3]).toHaveTextContent("Linked through another receipt");
  });

  it("dismisses one match with Not this one and stays to redraw", async () => {
    await wrap();
    fireEvent.click(screen.getByRole("button", { name: "Not this one: match 2" }));
    await waitFor(() => expect(mockReload).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith("/r1/not-this-one", "POST", { otherId: "r2" }, "Dismissed as a different purchase", "Couldn't dismiss this match");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("lists dismissed matches in a strip with Undo, which deletes that decision", async () => {
    mockLoads["/r1/duplicate-group"] = group([r0, r1], ["r2"]);
    await wrap();
    const strip = screen.getByLabelText("Dismissed matches");
    expect(within(strip).getByRole("link", { name: "Acme, 1 Oct" })).toHaveAttribute("href", "/receipts/r2?queue=duplicate_flagged");
    fireEvent.click(within(strip).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith("/r1/not-this-one/r2", "DELETE", {}, "Dismissal undone", "Couldn't undo this dismissal"));
    expect(mockReload).toHaveBeenCalled();
  });

  it("offers no Undo once the viewed receipt has left the hold", async () => {
    mockLoads["/r1"] = { ...flagged, state: "submitter_review" };
    mockLoads["/r1/duplicate-group"] = group([r0, { ...r1, state: "submitter_review" }], ["r2"]);
    await wrap();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("names exactly the live members it showed on a group decision, leaving a withdrawn one out", async () => {
    mockLoads["/r1/duplicate-group"] = group([{ ...r0, state: "discarded", label: "Withdrawn by its submitter on 2 Oct" }, r1, r2]);
    await wrap();
    fireEvent.click(screen.getByRole("button", { name: "Different purchases" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/finance/review?queue=duplicate_flagged"));
    expect(mockSend).toHaveBeenCalledWith("/r1/different-purchases", "POST", { shownIds: ["r1", "r2"] }, "Recorded as different purchases", "Couldn't record different purchases");
  });

  it("keeps this receipt and returns to the queue", async () => {
    await wrap();
    fireEvent.click(screen.getByRole("button", { name: "Keep this one" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith("/r1/keep-this-one", "POST", { shownIds: ["r0", "r1", "r2"] }, "Kept; the other copies are rejected", "Couldn't keep this receipt");
  });

  it("beside a finalized copy offers one-click reject with the reason filled in, and no Keep this one", async () => {
    mockLoads["/r0"] = { ...earlier, state: "receipt_finalized" };
    mockLoads["/r1/duplicate-group"] = group([{ ...r0, state: "receipt_finalized", label: "Finalized" }, r1]);
    await wrap();
    expect(screen.getByText("A finalized copy exists: keep it and reject this one as a copy?")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keep this one" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reject as a copy" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith("/r1/reject", "POST", { reason: "Copy of Acme, uploaded 30 Sept" }, "Rejected", "Couldn't reject this receipt"));
  });

  it("rejects one match with a reason and stays to redraw", async () => {
    await wrap();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason to reject match 1" }), { target: { value: " a copy " } });
    fireEvent.click(screen.getByRole("button", { name: "Reject match 1" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith("/r0/reject", "POST", { reason: "a copy" }, "That copy is rejected", "Couldn't reject that copy"));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("warns when one is a gift and another is for reimbursement", async () => {
    mockLoads["/r1"] = { ...flagged, isInKind: true };
    mockLoads["/r2"] = { ...later, needsReimbursement: true };
    await wrap();
    expect(screen.getByRole("alert")).toHaveTextContent("One is recorded as a gift of goods and another is for reimbursement.");
  });

  it("shows BOARD the compare without actions", async () => {
    mockRoles = { isFinance: false, isBoard: true };
    await wrap();
    expect(screen.getByText("Finance decides whether this is a duplicate.")).toBeInTheDocument();
    for (const name of [/^Not this one/, "Different purchases", "Keep this one", /^Reject/]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("offers the uploader in finance a discard of their own receipt, and no decision", async () => {
    mockUserId = 1;
    await wrap();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    for (const name of [/^Not this one/, "Different purchases", "Keep this one", /^Reject/]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getByText("Someone else in finance decides whether your own receipt is a duplicate.")).toBeInTheDocument();
  });

  it("raises a chip that stays and offers retry when one match can't load, holding back the group decisions", async () => {
    delete mockLoads["/r0"];
    mockErrors["/r0"] = "Receipt not found";
    await wrap();
    expect(mockShow).toHaveBeenCalledWith({ title: "Couldn't load a possible copy", message: expect.any(String), color: "red", autoClose: false });
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not this one: match 2" })).toBeInTheDocument();
    for (const name of ["Different purchases", "Keep this one"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("raises a chip that stays when the group cannot be loaded", async () => {
    mockLoads["/r1/duplicate-group"] = null;
    mockErrors["/r1/duplicate-group"] = "Receipt not found";
    await wrap();
    expect(mockShow).toHaveBeenCalledWith({ title: "Couldn't load the possible copies", message: "Receipt not found", color: "red", autoClose: false });
  });

  it("offers Different purchases on this receipt alone when no other receipt still matches it", async () => {
    mockLoads["/r1/duplicate-group"] = group([r1]);
    await wrap();
    expect(screen.getByText("No other receipt matches this one now.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Different purchases" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith("/r1/different-purchases", "POST", { shownIds: ["r1"] }, "Released from the duplicate hold", "Couldn't release this receipt"));
  });
});

describe("member labels", () => {
  it("links the kept receipt on a member rejected as a copy, in red", async () => {
    mockLoads["/r1/duplicate-group"] = group([
      { ...r0, state: "rejected", label: "Rejected as a copy of Acme, uploaded 3 Oct", copyOfId: "r2" },
      r1,
      r2,
    ]);
    await wrap();
    const link = screen.getByRole("link", { name: "Acme, uploaded 3 Oct" });
    expect(link).toHaveAttribute("href", "/receipts/r2?queue=duplicate_flagged");
    expect(link.parentElement).toHaveTextContent("Rejected as a copy of Acme, uploaded 3 Oct");
  });

  it("shows a finalized member whose expense finance rejected, with the reason", async () => {
    mockLoads["/r0"] = { ...earlier, state: "receipt_finalized" };
    mockLoads["/r1/duplicate-group"] = group([{ ...r0, state: "receipt_finalized", label: "Finalized · expense rejected by finance: personal purchase" }, r1]);
    await wrap();
    const label = screen.getByText("Finalized · expense rejected by finance: personal purchase");
    expect(label.getAttribute("style") ?? "").toContain("red");
  });
});

describe("when the group changes after the panel was drawn", () => {
  it("tags only a column that arrived later as New", async () => {
    mockLoads["/r1/duplicate-group"] = group([r0, r1]);
    const view = await wrap();
    expect(screen.queryByText("New")).toBeNull();
    mockLoads["/r1/duplicate-group"] = group([r0, r1, r2]);
    await act(async () => {
      view.rerender(page());
    });
    const header = screen.getByRole("link", { name: "Open match 2" }).closest("th") as HTMLElement;
    expect(within(header).getByText("New")).toBeInTheDocument();
    expect(within(screen.getByRole("link", { name: "Open match 1" }).closest("th") as HTMLElement).queryByText("New")).toBeNull();
  });

  it("redraws from the fresh group after a refused decision, keeping the server's chip to itself", async () => {
    mockSend.mockResolvedValue(false);
    await wrap();
    fireEvent.click(screen.getByRole("button", { name: "Different purchases" }));
    await waitFor(() => expect(mockReload).toHaveBeenCalled());
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("reloads the group when the tab regains focus", async () => {
    await wrap();
    mockReload.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(mockReload).toHaveBeenCalled();
  });
});

describe("the badge and the submitter's message", () => {
  it("badges an open earlier copy for finance, counting live members only", async () => {
    mockLoads["/r1"] = { ...flagged, state: "submitter_review" };
    mockLoads["/r1/duplicate-group"] = group([{ ...r0, state: "discarded" }, { ...r1, state: "submitter_review" }, r2]);
    await wrap();
    expect(screen.getByText("Possible duplicate: in a group of 2")).toBeInTheDocument();
  });

  it("gives a submitter neither the group nor the badge", async () => {
    mockRoles = { isFinance: false, isBoard: false };
    mockUserId = 1;
    await wrap();
    expect(screen.queryByText(/in a group of/)).toBeNull();
    expect(screen.queryByText("Pat Doe")).toBeNull();
    expect(screen.getByText("Finance will check this for a possible duplicate.")).toBeInTheDocument();
  });

  it("tells a submitter about their own copy, linked, with the discard they already have", async () => {
    mockRoles = { isFinance: false, isBoard: false };
    mockUserId = 1;
    mockLoads["/r1"] = { ...flagged, duplicateNotice: { matchId: "r0", uploadedAt: "2026-10-03T00:00:00Z" } };
    await wrap();
    expect(screen.getByRole("link", { name: "3 Oct" })).toHaveAttribute("href", "/receipts/r0");
    expect(screen.queryByText("Finance will check this for a possible duplicate.")).toBeNull();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
  });

  it("says nothing to a submitter whose open receipt is not held and has no copy of their own", async () => {
    mockRoles = { isFinance: false, isBoard: false };
    mockUserId = 1;
    mockLoads["/r1"] = { ...flagged, state: "submitter_review" };
    await wrap();
    expect(screen.queryByText(/possible duplicate/i)).toBeNull();
    expect(screen.queryByText(/You already sent/)).toBeNull();
  });
});

describe("a receipt with an old flag", () => {
  it("links the original once the flag is cleared", async () => {
    mockLoads["/r1"] = { ...flagged, state: "submitter_review", duplicateSuspectReceiptId: "r0", duplicateFlagClearedAt: "2026-10-03T00:00:00Z" };
    mockLoads["/r1/duplicate-group"] = group([{ ...r1, state: "submitter_review" }]);
    await wrap();
    expect(screen.getByRole("link", { name: "another receipt" })).toHaveAttribute("href", "/receipts/r0?queue=duplicate_flagged");
    expect(screen.getByText(/and cleared as not a duplicate/)).toBeInTheDocument();
  });

  it("badges a receipt discarded while flagged as discarded as a duplicate", async () => {
    mockLoads["/r1"] = { ...flagged, state: "discarded", duplicateFlaggedAt: "2026-10-02T00:00:00Z" };
    await wrap();
    expect(screen.getByText("Discarded as a duplicate")).toBeInTheDocument();
  });
});
