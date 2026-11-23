import { HttpError } from "@checkin/component-ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { ManualGiftPage, ReceiptGiftPage } from "@checkin/bulk-donation/pages/inKindGift";

const mockReload = jest.fn();
const mockApi = jest.fn<Promise<unknown>, unknown[]>();
let mockCanWrite = true;
let mockGift: unknown = null;
let mockPath: string | null = null;
let mockError: string | null = null;

jest.mock("next/navigation", () => ({ useParams: () => ({ id: "4" }) }));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: 1 } } }) }));
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), update: jest.fn() } }));
jest.mock("@checkin/bulk-donation/components/api", () => ({
  ...jest.requireActual("@checkin/bulk-donation/components/api"),
  useOwners: () => ({ data: [{ id: 1, name: "Robotics" }, { id: 2, name: "Shop" }], error: null, reload: jest.fn() }),
  useLoad: (path: string | null) => {
    mockPath = path;
    return { data: mockGift, error: mockError, reload: mockReload };
  },
  useCanWrite: () => mockCanWrite,
  api: (...args: unknown[]) => mockApi(...args),
}));

const base = {
  id: 4,
  receiptId: null,
  receiptTotalCents: null,
  receiptDate: null,
  donationDate: "2026-10-02",
  moneyReceivedAt: null,
  recordedAt: "2026-10-02T12:00:00.000Z",
  recordedByUsername: "ops-pat",
  donorFirstName: "Sam",
  donorLastName: "Giver",
  donorCompanyName: null,
  donorReplacedAt: null,
  replayConflictAt: null,
  outcome: "ACCEPTED",
  decidedAt: "2026-10-03T12:00:00.000Z",
  budgetOwnerName: "Robotics",
  bucketHeld: false,
  totalValueCents: 3500,
  state: "booking",
  waitingOn: ["booking"],
  budgetOwnerId: 1,
  capitalReviewNeeded: false,
  revenueBooking: null,
  expenseBooking: null,
  inventoryLoadedAt: "2026-10-02T12:00:01.000Z",
  inventoryLoadFailureReason: null,
  lines: [{ id: 9, gtin13: "0011111111116", description: "Drill", quantity: 2, valueCents: 3500, suggestedValueCents: 4000, isCapital: null, depreciationYears: null, capitalBucketId: null, registeredAt: null }],
  events: [
    { id: 1, eventType: "MANUAL_IN_KIND_RECORDED", actorUsername: "ops-pat", occurredAt: "2026-10-02T12:00:00.000Z", payload: "{}" },
    { id: 2, eventType: "IN_KIND_DECIDED", actorUsername: "fin-lee", occurredAt: "2026-10-03T12:00:00.000Z", payload: '{"outcome":"ACCEPTED"}' },
  ],
};
const manual = { ...base, source: "manual", inventorySourceKey: "donation:4" };
const receipt = {
  ...base,
  source: "receipt",
  receiptId: "r-77",
  receiptTotalCents: 2500,
  receiptDate: "2026-09-01",
  donationDate: null,
  recordedAt: null,
  recordedByUsername: null,
  totalValueCents: 2500,
  inventorySourceKey: null,
  inventoryLoadedAt: null,
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
  mockCanWrite = true;
  mockError = null;
  mockApi.mockResolvedValue({});
});

const wrap = (page: React.ReactNode) => render(<MantineProvider>{page}</MantineProvider>);

describe("in-kind gift page", () => {
  it("shows a gift without a receipt: donor, date, value, lines, no file, its inventory load and history", () => {
    mockGift = manual;
    wrap(<ManualGiftPage />);
    expect(mockPath).toBe("/in-kind/manual/4");
    expect(screen.getByText("Donor: Sam Giver")).toBeInTheDocument();
    expect(screen.getByText("Date: 2026-10-02")).toBeInTheDocument();
    expect(screen.getByText("Value: $35.00")).toBeInTheDocument();
    expect(screen.getByText("File: None; recorded without a receipt")).toBeInTheDocument();
    expect(screen.getByText("Drill")).toBeInTheDocument();
    expect(screen.getByText("$40.00")).toBeInTheDocument();
    expect(screen.getByText(/as donation:4: 1 line/)).toBeInTheDocument();
    expect(screen.getByText(/fin-lee · Decided \(Accepted\)/)).toBeInTheDocument();
    expect(screen.getByText("Ready to book")).toBeInTheDocument();
  });

  it("names a failed inventory load and lets finance load it again", async () => {
    mockGift = { ...manual, inventoryLoadedAt: null };
    wrap(<ManualGiftPage />);
    expect(screen.getByText("The load for donation:4 failed or has not run.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load again" }));
    await waitFor(() => expect(mockReload).toHaveBeenCalled());
    expect(mockApi).toHaveBeenCalledWith("/in-kind/manual/4/load-inventory", { method: "POST" });
  });

  it("shows why a failed inventory load failed", () => {
    mockGift = { ...manual, inventoryLoadedAt: null, inventoryLoadFailureReason: "Not a provisional Part ID: 0011111111116" };
    wrap(<ManualGiftPage />);
    expect(screen.getByText("The load for donation:4 failed: Not a provisional Part ID: 0011111111116")).toBeInTheDocument();
  });

  it("keeps a failed retry's error up until dismissed, and lets it be tried again", async () => {
    mockGift = { ...manual, inventoryLoadedAt: null };
    mockApi.mockRejectedValue(new HttpError("Inventory is unavailable", 503));
    wrap(<ManualGiftPage />);
    fireEvent.click(screen.getByRole("button", { name: "Load again" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Inventory is unavailable", color: "red", autoClose: false }),
      ),
    );
    expect(mockReload).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Load again" })).toBeEnabled();
  });

  it("turns the button off with the server's reason when inventory refuses the load", async () => {
    mockGift = { ...manual, inventoryLoadedAt: null };
    mockApi.mockRejectedValue(new HttpError("This source was already applied with a different inventory delta.", 409));
    wrap(<ManualGiftPage />);
    fireEvent.click(screen.getByRole("button", { name: "Load again" }));
    expect(await screen.findByRole("button", { name: "Can't be loaded: adjust stock by hand" })).toBeDisabled();
    expect(screen.getByText("This source was already applied with a different inventory delta.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load again" })).not.toBeInTheDocument();
    expect(mockReload).not.toHaveBeenCalled();
  });

  it("tells a viewer without permission they can't load, and keeps the load open for someone who can", async () => {
    mockGift = { ...manual, inventoryLoadedAt: null };
    mockApi.mockRejectedValue(new HttpError("Forbidden", 403));
    wrap(<ManualGiftPage />);
    fireEvent.click(screen.getByRole("button", { name: "Load again" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: "You don't have permission to load goods into inventory.", color: "red" }),
      ),
    );
    expect(screen.queryByRole("button", { name: "Can't be loaded: adjust stock by hand" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load again" })).toBeEnabled();
  });

  it("offers no retry to the Board, which cannot load inventory", () => {
    mockCanWrite = false;
    mockGift = { ...manual, inventoryLoadedAt: null };
    wrap(<ManualGiftPage />);
    expect(screen.queryByRole("button", { name: "Load again" })).not.toBeInTheDocument();
  });

  it("sends a receipt gift's file and goods to its receipt", () => {
    mockGift = { ...receipt, replayConflictAt: "2026-09-05T00:00:00.000Z", state: "replay" };
    wrap(<ReceiptGiftPage />);
    expect(mockPath).toBe("/in-kind/receipt/4");
    expect(screen.getByRole("link", { name: "Receipt r-77" })).toHaveAttribute("href", "/receipts/r-77");
    expect(screen.getByRole("link", { name: "on the receipt" })).toHaveAttribute("href", "/receipts/r-77");
    expect(screen.getByRole("link", { name: "its receipt" })).toHaveAttribute("href", "/receipts/r-77");
    expect(screen.getByText(/^The receipt was resent with different values/)).toBeInTheDocument();
    expect(screen.queryByText("Suggested")).not.toBeInTheDocument();
  });
});

describe("a stuck gift's last error", () => {
  const ERROR = "QBO create JournalEntry failed: socket hang up";
  const STUCK = { qbFirstFailedAt: "2026-11-01T00:00:00.000Z", qbLastError: ERROR };

  it.each([
    ["a gift without a receipt", manual, ManualGiftPage],
    ["a receipt gift", receipt, ReceiptGiftPage],
  ])("shows the last error on %s while it is stuck", (_what, gift, Page) => {
    mockGift = { ...gift, ...STUCK };
    wrap(<Page />);
    expect(screen.getByText(`Last error: ${ERROR}`)).toBeInTheDocument();
  });

  it("says no error was recorded when a stuck gift has none", () => {
    mockGift = { ...manual, qbFirstFailedAt: STUCK.qbFirstFailedAt, qbLastError: null };
    wrap(<ManualGiftPage />);
    expect(screen.getByText("Last error: no error recorded")).toBeInTheDocument();
  });

  it("shows no error line once the gift is no longer stuck", () => {
    mockGift = { ...manual, qbFirstFailedAt: null, qbLastError: ERROR };
    wrap(<ManualGiftPage />);
    expect(screen.queryByText(/Last error/)).not.toBeInTheDocument();
  });

  it("shows a reader the route refuses no error line", () => {
    mockGift = { ...manual, ...STUCK };
    mockError = "You don't have permission to view this.";
    wrap(<ManualGiftPage />);
    expect(screen.queryByText(/Last error/)).not.toBeInTheDocument();
  });
});

describe("a gift's capital review", () => {
  const LATHE = { id: 10, gtin13: null, description: "Lathe", quantity: 1, valueCents: 250000, suggestedValueCents: null, isCapital: null, depreciationYears: null, capitalBucketId: null, registeredAt: null };
  const review = { ...manual, capitalReviewNeeded: true, state: "capital", waitingOn: ["capital", "booking"], lines: [...manual.lines, LATHE] };

  it("designates every line, the capital one owned by the gift's bucket", async () => {
    mockGift = review;
    wrap(<ManualGiftPage />);
    fireEvent.click(screen.getByLabelText("Lathe"));
    fireEvent.click(screen.getByRole("button", { name: "Save designation" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalled());
    const [path, init] = mockApi.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe("/in-kind/manual/4/capital-review");
    expect(JSON.parse(init.body)).toEqual({ lineItems: [{ lineItemId: 9, isCapital: false }, { lineItemId: 10, isCapital: true, capitalOwnerId: 1 }] });
  });

  it("then sets the period and owner of each capital line only", async () => {
    mockGift = { ...review, lines: [{ ...manual.lines[0], isCapital: false }, { ...LATHE, isCapital: true, capitalBucketId: 2 }] };
    wrap(<ManualGiftPage />);
    expect(screen.getByRole("button", { name: "Save period" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Years"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save period" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalled());
    const [path, init] = mockApi.mock.calls[0] as [string, { body: string }];
    expect(path).toBe("/in-kind/manual/4/set-depreciation-cycle");
    expect(JSON.parse(init.body)).toEqual({ items: [{ lineItemId: 10, depreciationYears: 7, ownerId: 2 }] });
  });

  it("shows each line's decision once the gift waits on its asset numbers, with no form", () => {
    mockGift = { ...review, state: "register", waitingOn: ["register", "booking"], lines: [{ ...manual.lines[0], isCapital: false }, { ...LATHE, isCapital: true, depreciationYears: 7, capitalBucketId: 2 }] };
    wrap(<ManualGiftPage />);
    expect(screen.getByText("Waiting for asset numbers")).toBeInTheDocument();
    expect(screen.getByText("Not capital")).toBeInTheDocument();
    expect(screen.getByText("Capital, 7 years, Shop")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
  });

  it("tells a viewer who cannot write that finance reviews it", () => {
    mockCanWrite = false;
    mockGift = review;
    wrap(<ManualGiftPage />);
    expect(screen.getByText("Waiting on finance's capital review.")).toBeInTheDocument();
  });
});
