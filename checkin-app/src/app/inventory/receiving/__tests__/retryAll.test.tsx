import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-helpers/rtl";
import ReceivingPage from "@checkin/workflow-mapping/pages/receiving";

jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
import { notifications } from "@mantine/notifications";

let mockSearch = new URLSearchParams("queue=failed");
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
  useRouter: () => ({ replace: jest.fn() }),
}));

let mockUser: Record<string, unknown> = { id: 1, isInventoryManager: true };
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: mockUser } }) }));

const row = (id: number, validationNotes = "Inventory: down") => ({
  id, state: "apply_failed", vendorName: `Vendor ${id}`, receiptTotalCents: 1000, currency: "USD", lineItemCount: 1, validationNotes, createdAt: "2026-10-01T00:00:00Z",
});
const mockReload = jest.fn();
let mockFailed = [row(1), row(2), row(3)];
jest.mock("@checkin/workflow-mapping/components/api", () => ({
  ...jest.requireActual("@checkin/workflow-mapping/components/api"),
  useLoad: (path: string) => ({
    data: path === "/receipts/counts" ? { pending_review: 0, apply_failed: mockFailed.length, applying: 0 } : mockFailed,
    error: null,
    reload: mockReload,
  }),
}));

const fetchMock = jest.fn();
const reply = (status: number, body: unknown) =>
  Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) });
const calls = () => fetchMock.mock.calls.map(([url]) => String(url).replace("/api/workflow-mapping/receipts/", ""));

beforeEach(() => {
  mockSearch = new URLSearchParams("queue=failed");
  mockUser = { id: 1, isInventoryManager: true };
  mockFailed = [row(1), row(2), row(3)];
  mockReload.mockClear();
  (notifications.show as jest.Mock).mockClear();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("Receiving › Apply failed Retry all", () => {
  it("offers Retry all with the row count to an inventory manager", () => {
    renderWithProviders(<ReceivingPage />);
    expect(screen.getByRole("button", { name: "Retry all (3)" })).toBeInTheDocument();
  });

  it("hides Retry all from a viewer who isn't an inventory manager", () => {
    mockUser = { id: 2, isInventoryManager: false };
    renderWithProviders(<ReceivingPage />);
    expect(screen.getByText("Vendor 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry all/ })).not.toBeInTheDocument();
  });

  it("hides Retry all on other tabs", () => {
    mockSearch = new URLSearchParams("queue=all");
    renderWithProviders(<ReceivingPage />);
    expect(screen.getByText("Vendor 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry all/ })).not.toBeInTheDocument();
  });

  it("hides Retry all when the tab is empty", () => {
    mockFailed = [];
    renderWithProviders(<ReceivingPage />);
    expect(screen.queryByRole("button", { name: /Retry all/ })).not.toBeInTheDocument();
  });

  it("retries one receipt at a time, shows progress, and disables per-row Retry while running", async () => {
    let finishFirst: (v: unknown) => void = () => {};
    fetchMock
      .mockImplementationOnce(() => reply(200, { state: "applying" }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockImplementation((url: string) => reply(200, { state: url.endsWith("/apply") ? "resolved" : "applying" }));
    renderWithProviders(<ReceivingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Retry all (3)" }));

    await waitFor(() => expect(calls()).toEqual(["1/retry-apply", "1/apply"]));
    expect(screen.getByText("Retrying 1 of 3…")).toBeInTheDocument();
    for (const b of screen.getAllByRole("button", { name: "Retry" })) expect(b).toBeDisabled();

    await act(async () => { finishFirst(await reply(200, { state: "resolved" })); });
    await waitFor(() => expect(calls()).toHaveLength(6));
    expect(calls()).toEqual(["1/retry-apply", "1/apply", "2/retry-apply", "2/apply", "3/retry-apply", "3/apply"]);
  });

  it("keeps going past a failure, shows one summary, and reloads once at the end", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/1/retry-apply")) return reply(409, { error: "Receipt was already retried" });
      if (url.includes("/2/apply")) return reply(200, { state: "apply_failed", validationNotes: "Inventory: still down" });
      return reply(200, { state: url.endsWith("/apply") ? "resolved" : "applying" });
    });
    renderWithProviders(<ReceivingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Retry all (3)" }));

    await waitFor(() => expect(notifications.show).toHaveBeenCalled());
    expect(calls()).toEqual(["1/retry-apply", "2/retry-apply", "2/apply", "3/retry-apply", "3/apply"]);
    expect(notifications.show).toHaveBeenCalledTimes(1);
    expect(notifications.show).toHaveBeenCalledWith({ message: "1 applied, 2 still failed", color: "red", autoClose: false });
    // One reload each for rows and counts.
    expect(mockReload).toHaveBeenCalledTimes(2);
  });

  it("skips receipts whose stored data can't be read", async () => {
    mockFailed = [row(1), row(2, "Stored receipt data is not valid JSON"), row(3, "Stored receipt data failed validation")];
    fetchMock.mockImplementation((url: string) => reply(200, { state: url.endsWith("/apply") ? "resolved" : "applying" }));
    renderWithProviders(<ReceivingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Retry all (1)" }));

    await waitFor(() => expect(notifications.show).toHaveBeenCalled());
    expect(calls()).toEqual(["1/retry-apply", "1/apply"]);
    expect(notifications.show).toHaveBeenCalledWith({
      message: "1 applied, 0 still failed, 2 skipped (stored data unreadable)",
      color: "green",
    });
  });

  it("hides Retry all when every row's stored data is unreadable", () => {
    mockFailed = [row(1, "Stored receipt data is not valid JSON")];
    renderWithProviders(<ReceivingPage />);
    expect(screen.queryByRole("button", { name: /Retry all/ })).not.toBeInTheDocument();
  });
});
