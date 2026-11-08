jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock({ followUrl: true }));
import { HttpError } from "@checkin/component-ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import ManualInKindPage from "@checkin/bulk-donation/pages/manualInKind";
import { resetRtl } from "@/test-helpers/rtl";

beforeEach(() => resetRtl());

const mockReload = jest.fn();
const mockApi = jest.fn<Promise<unknown>, unknown[]>();

jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: 1 } } }) }));
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
jest.mock("@checkin/component-ui", () => ({
  ...jest.requireActual("@checkin/component-ui"),
  useViewer: () => ({ id: 1, isInventoryManager: true }),
}));
jest.mock("@checkin/bulk-donation/components/api", () => ({
  ...jest.requireActual("@checkin/bulk-donation/components/api"),
  useLoad: () => ({ data: [unloaded], error: null, reload: mockReload }),
  api: (...args: unknown[]) => mockApi(...args),
}));

const unloaded = {
  id: 4,
  donationDate: "2026-10-02",
  recordedByUsername: "ops-pat",
  recordedAt: "2026-10-02T12:00:00.000Z",
  inventoryLoadedAt: null,
  lines: [{ id: 1, gtin13: "0011111111116", description: "Drill", quantity: 2, valueCents: null, suggestedValueCents: null }],
};

function wrap() {
  return render(
    <MantineProvider>
      <ManualInKindPage />
    </MantineProvider>,
  );
}

beforeAll(() => {
  // jsdom has no ResizeObserver, which Mantine's Select uses.
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => jest.clearAllMocks());

describe("in-kind gifts without a receipt: retrying a failed load", () => {
  it("keeps Retry load after a failure that may pass later", async () => {
    mockApi.mockRejectedValue(new HttpError("Inventory is unavailable", 503));
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Retry load" }));
    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Inventory is unavailable", color: "red" })));
    expect(screen.getByRole("button", { name: "Retry load" })).toBeEnabled();
  });

  it("turns the button off when inventory refuses the load, and shows the server's reason", async () => {
    mockApi.mockRejectedValue(new HttpError("This source was already applied with a different inventory delta.", 409));
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Retry load" }));
    expect(await screen.findByRole("button", { name: "Can't be loaded: adjust stock by hand" })).toBeDisabled();
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "This source was already applied with a different inventory delta.", color: "red" }),
    );
    expect(mockReload).not.toHaveBeenCalled();
  });

  it("tells a viewer without permission they can't load, and keeps the load open for someone who can", async () => {
    mockApi.mockRejectedValue(new HttpError("Forbidden", 403));
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Retry load" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: "You don't have permission to load goods into inventory.", color: "red" }),
      ),
    );
    expect(screen.queryByRole("button", { name: "Can't be loaded: adjust stock by hand" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry load" })).toBeEnabled();
  });
});
