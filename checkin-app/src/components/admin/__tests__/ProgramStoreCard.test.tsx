jest.mock("@mantine/modals", () => ({ modals: { openConfirmModal: (opts: { onConfirm: () => void }) => opts.onConfirm() } }));

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { notifications, notificationsStore } from "@mantine/notifications";
import { renderWithProviders, resetRtl } from "@/test-helpers/rtl";
import { ProgramStoreCard } from "../ProgramStoreCard";

beforeEach(() => resetRtl());
afterEach(() => act(() => notifications.clean()));

describe("ProgramStoreCard", () => {
  it("shows the route's words when the store switch is refused, and keeps the store open", async () => {
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ error: "Shopify is not configured." }), { status: 409 }),
    ) as unknown as typeof fetch;
    renderWithProviders(<ProgramStoreCard initialClosedAt={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Close the store" }));
    await waitFor(() =>
      expect(notificationsStore.getState().notifications[0]).toMatchObject({ message: "Shopify is not configured.", color: "red" }),
    );
    expect(screen.getByRole("button", { name: "Close the store" })).toBeInTheDocument();
  });
});
