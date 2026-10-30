import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ReceiveQueuePage from "@checkin/local-inventory/pages/receiveQueue";

const mockApi = jest.fn();
const openRow = {
  id: 7, gtin13: "0000000000017", quantity: 3, retailer: "Acme", queuedAt: "2026-10-01T00:00:00Z",
  fulfilledAt: null, cancelledAt: null, cancelReason: null,
};
const cancelledRow = {
  ...openRow, id: 8, gtin13: "0000000000024", cancelledAt: "2026-10-02T00:00:00Z", cancelReason: "Supplier discontinued it",
};

jest.mock("@checkin/local-inventory/components/api", () => ({
  ...jest.requireActual("@checkin/local-inventory/components/api"),
  api: (...args: unknown[]) => mockApi(...args),
  notifyNavCounts: jest.fn(),
  useCanManage: () => true,
  useCatalogNames: () => new Map(),
  useLoad: (path: string) => ({
    data: path.includes("includeFulfilled=true") ? [openRow, cancelledRow] : [openRow],
    error: null,
    reload: jest.fn(),
  }),
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

beforeEach(() => mockApi.mockReset().mockResolvedValue({}));

const renderPage = () => render(<MantineProvider><ReceiveQueuePage /></MantineProvider>);

describe("Cancelling a backorder", () => {
  it("asks for a reason and keeps Confirm disabled while it is blank", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    const confirm = await screen.findByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: /Reason/ }), { target: { value: "   " } });
    expect(confirm).toBeDisabled();
    expect(mockApi).not.toHaveBeenCalled();
  });

  it("sends the trimmed reason with the cancel", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.change(await screen.findByRole("textbox", { name: /Reason/ }), { target: { value: " Ordered twice " } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/receive-queue/7", {
      method: "DELETE",
      body: JSON.stringify({ reason: "Ordered twice" }),
    }));
  });

  it("shows the reason on cancelled rows when closed lines are shown", () => {
    renderPage();
    expect(screen.queryByText(/Supplier discontinued it/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show fulfilled and cancelled" }));
    expect(screen.getByText("Cancelled: Supplier discontinued it")).toBeInTheDocument();
  });
});
