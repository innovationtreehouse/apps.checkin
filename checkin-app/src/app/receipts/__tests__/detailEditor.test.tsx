import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import ReceiptDetailPage from "@checkin/receipt/pages/detail";

const mockReload = jest.fn();
const mockPush = jest.fn();
let mockPathname = "/receipts/r1";
const mockSend = jest.fn<Promise<boolean>, unknown[]>();
const mockApi = jest.fn<Promise<unknown>, unknown[]>();

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "r1" }),
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: 1 } } }) }));
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
jest.mock("@checkin/receipt/components/ReceiptFile", () => ({ __esModule: true, default: () => null }));

const line = (id: number, description: string, quantity: number, unitPriceCents: number) => ({
  id, lineNumber: id, description, partNumber: null, manufacturer: null,
  quantity, unitPriceCents, totalPriceCents: quantity * unitPriceCents, isDelayed: false,
});

// Lines $20 + shipping $5 + tax $1.50 = $26.50, against a $27.00 total.
const receipt = {
  id: "r1", uploadedAt: "2026-10-01T00:00:00Z", uploadedByUserId: 1, retailer: "Acme", receiptDate: "2026-10-01",
  receiptTotalCents: 2700, state: "validation_failed", needsReimbursement: false, isInKind: false,
  validationNotes: "Line items total does not match the receipt total.",
  mimeType: "application/pdf", taxCents: 150, shippingCents: 500, discountCents: 0, financialReviewReasons: [],
  lineItems: [line(11, "Screws", 2, 500), line(12, "Bolts", 1, 1000)],
};
let mockReceipt: unknown = receipt;
// The state the server's flow moves a resubmitted receipt to.
let mockLandsIn = "financial_review";

jest.mock("@checkin/receipt/components/api", () => ({
  ...jest.requireActual("@checkin/receipt/components/api"),
  useLoad: (path: string | null) => ({ data: path === "/r1" ? mockReceipt : null, error: null, reload: mockReload }),
  useRoles: () => ({ isFinance: false, isBoard: false }),
  send: (...args: unknown[]) => mockSend(...args),
  api: (...args: unknown[]) => mockApi(...args),
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
  mockReceipt = receipt;
  mockPathname = "/receipts/r1";
  mockLandsIn = "financial_review";
  mockSend.mockResolvedValue(true);
  mockApi.mockImplementation(async (path) => (String(path).endsWith("/resubmit") ? { ...receipt, state: mockLandsIn } : {}));
});

const wrap = () => render(<MantineProvider><ReceiptDetailPage /></MantineProvider>);
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const shown = () => (notifications.show as jest.Mock).mock.calls.map((c) => c[0]);
const resubmitted = () => mockApi.mock.calls.some((c) => c[0] === "/r1/resubmit");

describe("correcting a receipt whose totals don't add up", () => {
  it("shows how far the lines are from the receipt total, and when they match", () => {
    wrap();
    expect(screen.getByText("Difference: -$0.50")).toBeInTheDocument();
    type("+ Shipping", "5.50");
    expect(screen.getByText("Matches the receipt total")).toBeInTheDocument();
  });

  it("offers one Save changes button, with no separate Resubmit", () => {
    wrap();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /resubmit/i })).not.toBeInTheDocument();
  });

  it("saves, then resubmits when the lines add up to the total", async () => {
    wrap();
    type("Line 2 unit price", "10.50");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(resubmitted()).toBe(true));
    expect(mockApi.mock.calls.map((c) => c[0])).toEqual(["/r1/line-items/12", "/r1/resubmit"]);
    expect(shown()).toContainEqual({ message: "Saved and resubmitted: Finance review", color: "green" });
  });

  it("saves without resubmitting while the totals are still off, and says by how much", async () => {
    wrap();
    type("Line 2 unit price", "10.25");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(shown()).toContainEqual({ message: "Saved. Still $0.25 off; stays in Totals off.", color: "yellow", autoClose: false }));
    expect(mockApi).toHaveBeenCalledWith("/r1/line-items/12", { method: "PATCH", body: JSON.stringify({ unitPrice: 10.25 }) });
    expect(resubmitted()).toBe(false);
  });

  it("does not claim success or leave the page when the flow puts it back in Totals off", async () => {
    mockPathname = "/receipts/review/r1";
    mockLandsIn = "validation_failed";
    wrap();
    type("+ Shipping", "5.50");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(resubmitted()).toBe(true));
    expect(shown()).toContainEqual({ message: "Saved. The totals still don't add up; stays in Totals off.", color: "yellow", autoClose: false });
    expect(shown().some((n) => n.color === "green")).toBe(false);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("returns to the review queue once the receipt leaves Totals off", async () => {
    mockPathname = "/receipts/review/r1";
    wrap();
    type("+ Shipping", "5.50");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/receipts/review?queue=validation_failed"));
  });

  it("resubmits a saved receipt that already adds up, with nothing to save", async () => {
    mockReceipt = { ...receipt, receiptTotalCents: 2650 };
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(resubmitted()).toBe(true));
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(shown()).toContainEqual({ message: "Resubmitted: Finance review", color: "green" });
  });

  it("keeps a failed resubmit on screen, naming what was saved", async () => {
    mockApi.mockImplementation(async (path) => {
      if (String(path).endsWith("/resubmit")) throw new Error("Receipt is not in validation_failed");
      return {};
    });
    wrap();
    type("+ Shipping", "5.50");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(shown()).toContainEqual({ title: "Saved, but couldn't resubmit", message: "Receipt is not in validation_failed", color: "red", autoClose: false }),
    );
  });

  it("adds a line before removing one", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "+ Add line" }));
    type("Line 3 description", "Glue");
    type("Line 3 unit price", "0.50");
    fireEvent.click(screen.getByRole("button", { name: "Remove Line 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(2));
    expect(mockApi.mock.calls.map((c) => [c[0], (c[1] as RequestInit).method])).toEqual([
      ["/r1/line-items", "POST"],
      ["/r1/line-items/11", "DELETE"],
    ]);
    expect(mockReload).toHaveBeenCalled();
  });

  it("does not resubmit when a save fails", async () => {
    mockApi.mockRejectedValue(new Error("Receipt total must be a number"));
    wrap();
    type("Receipt total", "26.50");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalled());
    expect(resubmitted()).toBe(false);
  });

  it("saves part number, manufacturer, quantity and backordered on a line", async () => {
    wrap();
    type("Line 1 part number", "SC-8");
    type("Line 1 manufacturer", "Fastco");
    type("Line 1 quantity", "3");
    fireEvent.click(screen.getByLabelText("Line 1 backordered"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(1));
    expect(mockApi.mock.calls[0][0]).toBe("/r1/line-items/11");
    expect(JSON.parse((mockApi.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      partNumber: "SC-8",
      manufacturer: "Fastco",
      quantity: 3,
      isDelayed: true,
    });
  });

  it("posts a new line once, however many times Save changes is clicked", async () => {
    let finish: (v: unknown) => void = () => {};
    mockApi.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "+ Add line" }));
    type("Line 3 description", "Glue");
    type("Line 3 unit price", "0.50");
    const save = screen.getByRole("button", { name: "Save changes" });
    fireEvent.click(save);
    fireEvent.click(save);
    finish({});
    await waitFor(() => expect(resubmitted()).toBe(true));
    expect(mockApi.mock.calls.map((c) => c[0])).toEqual(["/r1/line-items", "/r1/resubmit"]);
  });

  it("edits the date with a date picker and saves it as YYYY-MM-DD", async () => {
    wrap();
    const date = screen.getByLabelText("Date");
    expect(date).toHaveAttribute("type", "date");
    fireEvent.change(date, { target: { value: "2026-09-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/r1", { method: "PATCH", body: JSON.stringify({ receiptDate: "2026-09-30" }) }));
  });

  it("is read-only once the receipt was sent to receiving", () => {
    mockReceipt = { ...receipt, pushedAt: "2026-10-02T00:00:00Z" };
    wrap();
    expect(screen.queryByText("Correct the receipt")).not.toBeInTheDocument();
  });

  it("is read-only once the receipt leaves the editable states", () => {
    mockReceipt = { ...receipt, state: "financial_review" };
    wrap();
    expect(screen.queryByText("Correct the receipt")).not.toBeInTheDocument();
    expect(screen.getByText("Screws")).toBeInTheDocument();
  });
});

describe("reviewing an OCR-read receipt", () => {
  it("saves the uploader's corrections, then confirms", async () => {
    mockReceipt = { ...receipt, state: "submitter_review", validationNotes: null };
    wrap();
    type("Retailer", "Acme Hardware");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith("/r1/submitter-confirm", "POST", {}, "Confirmed", "Couldn't confirm this receipt"));
    expect(mockApi).toHaveBeenCalledWith("/r1", { method: "PATCH", body: JSON.stringify({ retailer: "Acme Hardware" }) });
  });

  it("saves without resubmitting", async () => {
    mockReceipt = { ...receipt, state: "submitter_review", validationNotes: null };
    wrap();
    type("Retailer", "Acme Hardware");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(shown()).toContainEqual({ message: "Saved", color: "green" }));
    expect(resubmitted()).toBe(false);
  });
});
