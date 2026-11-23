import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders, resetRtl, setCheckinEnv } from "@/test-helpers/rtl";
import DevMockPaymentButton from "../DevMockPaymentButton";

beforeEach(() => {
  resetRtl();
  setCheckinEnv("local");
});

describe("DevMockPaymentButton", () => {
  it("passes the route's words to onFailed when the mock payment is refused", async () => {
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ error: "No membership variant configured" }), { status: 409 }),
    ) as unknown as typeof fetch;
    const onPaid = jest.fn(async () => {});
    const onFailed = jest.fn();
    const setSaving = jest.fn();
    renderWithProviders(<DevMockPaymentButton processId={4} saving={false} setSaving={setSaving} onPaid={onPaid} onFailed={onFailed} />);

    fireEvent.click(screen.getByRole("button", { name: /Pay now/ }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith({ error: "No membership variant configured" }));
    expect(onPaid).not.toHaveBeenCalled();
    expect(setSaving).toHaveBeenLastCalledWith(false);
  });
});
