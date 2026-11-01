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

jest.mock("next/navigation", () => ({ useParams: () => ({ id: "4" }) }));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: 1 } } }) }));
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
jest.mock("@checkin/bulk-donation/components/api", () => ({
  ...jest.requireActual("@checkin/bulk-donation/components/api"),
  useLoad: (path: string | null) => {
    mockPath = path;
    return { data: mockGift, error: null, reload: mockReload };
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
  withdrawnAfterMoneyAt: null,
  withdrawalSettledAt: null,
  replayConflictAt: null,
  outcome: "ACCEPTED",
  decidedAt: "2026-10-03T12:00:00.000Z",
  budgetOwnerName: "Robotics",
  bucketHeld: false,
  totalValueCents: 3500,
  state: "booking",
  revenueBooking: null,
  expenseBooking: null,
  inventoryLoadedAt: "2026-10-02T12:00:01.000Z",
  lines: [{ id: 9, gtin13: "0011111111116", description: "Drill", quantity: 2, valueCents: 3500, suggestedValueCents: 4000 }],
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
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCanWrite = true;
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

  it("keeps a failed retry's error up until dismissed", async () => {
    mockGift = { ...manual, inventoryLoadedAt: null };
    mockApi.mockRejectedValue(new HttpError("Catalog item 0011111111116 not found", 409));
    wrap(<ManualGiftPage />);
    fireEvent.click(screen.getByRole("button", { name: "Load again" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Catalog item 0011111111116 not found", color: "red", autoClose: false }),
      ),
    );
    expect(mockReload).not.toHaveBeenCalled();
  });

  it("offers no retry to the Board, which cannot load inventory", () => {
    mockCanWrite = false;
    mockGift = { ...manual, inventoryLoadedAt: null };
    wrap(<ManualGiftPage />);
    expect(screen.queryByRole("button", { name: "Load again" })).not.toBeInTheDocument();
  });

  it("sends a receipt gift's file and goods to its receipt", () => {
    mockGift = { ...receipt, withdrawnAfterMoneyAt: "2026-09-05T00:00:00.000Z", state: "withdrawal" };
    wrap(<ReceiptGiftPage />);
    expect(mockPath).toBe("/in-kind/receipt/4");
    expect(screen.getByRole("link", { name: "Receipt r-77" })).toHaveAttribute("href", "/receipts/r-77");
    expect(screen.getByRole("link", { name: "on the receipt" })).toHaveAttribute("href", "/receipts/r-77");
    expect(screen.getByRole("link", { name: "its receipt" })).toHaveAttribute("href", "/receipts/r-77");
    expect(screen.getByText(/after the money arrived/)).toBeInTheDocument();
    expect(screen.queryByText("Suggested")).not.toBeInTheDocument();
  });
});
