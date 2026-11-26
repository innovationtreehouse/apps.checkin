import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { notifications, notificationsStore } from "@mantine/notifications";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import { renderWithProviders, resetRtl } from "@/test-helpers/rtl";
import { SigningStatusCard } from "../SigningStatusCard";

beforeEach(() => resetRtl());
afterEach(() => act(() => notifications.clean()));

describe("SigningStatusCard", () => {
  it("shows the route's words when a reset is refused, and keeps the reason open", async () => {
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ error: "The agreement is already signed." }), { status: 409 }),
    ) as unknown as typeof fetch;
    const onChange = jest.fn();
    renderWithProviders(
      <SigningStatusCard signing={{ processId: 7, contractStarted: true, signerName: "Pat", contractSignedAt: null }} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reset signing…" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Stuck request" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset signing" }));

    await waitFor(() =>
      expect(notificationsStore.getState().notifications[0]).toMatchObject({ message: "The agreement is already signed.", color: "red" }),
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Reason")).toHaveValue("Stuck request");
  });

  it("dates the signature in the org's configured zone", () => {
    renderWithProviders(
      <SigningStatusCard signing={{ processId: 7, contractStarted: true, signerName: "Pat", contractSignedAt: "2026-10-01T18:00:00Z" }} onChange={jest.fn()} />,
      { wrapper: ({ children }) => <TimezoneProvider value="Asia/Tokyo">{children}</TimezoneProvider> },
    );
    expect(screen.getByText("Signed by Pat, Oct 2, 2026")).toBeInTheDocument();
  });
});
