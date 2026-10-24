import { fireEvent, screen, waitFor } from "@testing-library/react";
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

const row = (id: number, state: string, vendorName: string) => ({
  id, state, vendorName, receiptTotalCents: 1000, currency: "USD", lineItemCount: 1, validationNotes: "Inventory: down", createdAt: "2026-10-01T00:00:00Z",
});
const mockReload = jest.fn();
const mockLoads: Record<string, unknown> = {
  "/receipts/counts": { pending_review: 0, apply_failed: 1, applying: 0 },
  "/receipts?state=apply_failed": [row(7, "apply_failed", "Failed Hardware")],
  "/receipts": [row(7, "apply_failed", "Failed Hardware")],
};
jest.mock("@checkin/workflow-mapping/components/api", () => ({
  ...jest.requireActual("@checkin/workflow-mapping/components/api"),
  useLoad: (path: string) => ({ data: mockLoads[path] ?? [], error: null, reload: mockReload }),
}));

const fetchMock = jest.fn();
const reply = (status: number, body: unknown) =>
  Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) });

beforeEach(() => {
  mockSearch = new URLSearchParams("queue=failed");
  mockUser = { id: 1, isInventoryManager: true };
  mockReload.mockClear();
  (notifications.show as jest.Mock).mockClear();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("Receiving › Apply failed Retry", () => {
  it("offers Retry on each failed row to an inventory manager", () => {
    renderWithProviders(<ReceivingPage />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("hides Retry from a viewer who isn't an inventory manager", () => {
    mockUser = { id: 2, isInventoryManager: false };
    renderWithProviders(<ReceivingPage />);
    expect(screen.getByText("Failed Hardware")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("offers Retry only on the Apply failed tab", () => {
    mockSearch = new URLSearchParams("queue=all");
    renderWithProviders(<ReceivingPage />);
    expect(screen.getByText("Failed Hardware")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("calls retry-apply, then apply, and reloads the list", async () => {
    fetchMock.mockImplementationOnce(() => reply(200, { state: "applying" })).mockImplementationOnce(() => reply(200, { state: "resolved" }));
    renderWithProviders(<ReceivingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "green" })));
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ["/api/workflow-mapping/receipts/7/retry-apply", "POST"],
      ["/api/workflow-mapping/receipts/7/apply", "POST"],
    ]);
    expect(mockReload).toHaveBeenCalled();
  });

  it("shows a refusal as a red chip that stays open, with the server's reason, and doesn't apply", async () => {
    fetchMock.mockImplementationOnce(() => reply(409, { error: "Receipt was already retried" }));
    renderWithProviders(<ReceivingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith({ message: "Receipt was already retried", color: "red", autoClose: false }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Failed Hardware")).toBeInTheDocument();
  });

  it("shows an apply that fails again as a red chip that stays open, with the failure", async () => {
    fetchMock
      .mockImplementationOnce(() => reply(200, { state: "applying" }))
      .mockImplementationOnce(() => reply(200, { state: "apply_failed", validationNotes: "Inventory: still down" }));
    renderWithProviders(<ReceivingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith({ message: "Inventory: still down", color: "red", autoClose: false }),
    );
  });
});
