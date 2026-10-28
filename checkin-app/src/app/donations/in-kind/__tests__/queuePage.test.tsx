import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import InKindQueuePage from "@checkin/bulk-donation/pages/inKindQueue";

const mockReload = jest.fn();
const mockApi = jest.fn<Promise<unknown>, unknown[]>();
let mockUser: Record<string, unknown> = { id: 1, isFinance: true };
let mockQueue: unknown[] = [];

jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: mockUser } }) }));
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
jest.mock("@checkin/bulk-donation/components/api", () => ({
  ...jest.requireActual("@checkin/bulk-donation/components/api"),
  useLoad: (path: string) => ({ data: path === "/in-kind/queue" ? mockQueue : [], error: null, reload: mockReload }),
  api: (...args: unknown[]) => mockApi(...args),
}));

const unbooked = {
  id: 4,
  source: "manual",
  receiptId: null,
  receiptDate: null,
  donationDate: "2026-10-02",
  moneyReceivedAt: "2026-10-02T12:00:00.000Z",
  budgetOwnerId: 1,
  budgetOwnerName: "Robotics",
  totalValueCents: 3500,
  outcome: "ACCEPTED",
  state: "booking",
  waitingOn: ["booking"],
  revenueBooking: null,
  expenseBooking: null,
  qbState: "UNBOOKED",
  qbNote: "Dated in closed books: the app will not book it; finance skips it",
  warnDonorSurnameMatch: false,
  warnDonorIsRecorder: false,
  warnLargeValue: false,
  warnDonorReplaced: false,
  callerConflicted: false,
  allFinanceConflicted: false,
  lines: [],
};

const wrap = () => render(<MantineProvider><InKindQueuePage /></MantineProvider>);
const lastBody = () => JSON.parse(String((mockApi.mock.calls.at(-1)?.[1] as RequestInit).body));

beforeEach(() => {
  mockApi.mockReset();
  mockApi.mockResolvedValue({});
  mockUser = { id: 1, isFinance: true };
  mockQueue = [unbooked];
});

describe("in-kind queue: finance's QuickBooks actions", () => {
  it("books, skips with a reason, and matches by id", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "QuickBooks" }));
    // The note shows in the row and again in the open panel.
    expect(screen.getAllByText(/Dated in closed books/)).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Book" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/in-kind/manual/4/qb-resolve", expect.objectContaining({ method: "POST" })));
    expect(lastBody()).toEqual({ action: "book" });

    fireEvent.click(screen.getByRole("button", { name: "QuickBooks" }));
    const skip = screen.getByRole("button", { name: "Skip" });
    expect(skip).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Booked by hand in 2025" } });
    fireEvent.click(skip);
    await waitFor(() => expect(lastBody()).toEqual({ action: "skip", reason: "Booked by hand in 2025" }));

    fireEvent.click(screen.getByRole("button", { name: "QuickBooks" }));
    fireEvent.change(screen.getByLabelText("Deposit id"), { target: { value: "51" } });
    fireEvent.change(screen.getByLabelText("Purchase id"), { target: { value: "52" } });
    fireEvent.click(screen.getByRole("button", { name: "Match pair" }));
    await waitFor(() => expect(lastBody()).toEqual({ action: "match", depositId: "51", purchaseId: "52" }));
  });

  it("offers the actions only to finance, and only on a gift the drain handed over", () => {
    mockQueue = [unbooked, { ...unbooked, id: 5, qbState: null, qbNote: null }];
    wrap();
    expect(screen.getAllByRole("button", { name: "QuickBooks" })).toHaveLength(1);
  });

  it("shows a gift that stays only for its QuickBooks note, and clears the note with how it was answered", async () => {
    const qbNote = "QuickBooks JournalEntry 9100 carries this gift's key but is not linked to it; void it or link it";
    mockQueue = [{ ...unbooked, state: null, waitingOn: [], qbState: "DISMISSED", qbNote }];
    wrap();
    expect(screen.getByText("QuickBooks note")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "QuickBooks" }));
    expect(screen.queryByRole("button", { name: "Book" })).toBeNull();
    fireEvent.change(screen.getByLabelText("How it was answered"), { target: { value: "Voided 9100" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear note" }));
    await waitFor(() => expect(lastBody()).toEqual({ action: "clear", reason: "Voided 9100" }));
  });

  it("shows a board member no QuickBooks actions", () => {
    mockUser = { id: 1, isBoardMember: true };
    wrap();
    expect(screen.queryByRole("button", { name: "QuickBooks" })).toBeNull();
  });
});
