jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, waitFor } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import MissingEmergencyContactsPage from "../page";

beforeEach(() => resetRtl());

describe("membership-audit/emergency-contacts page", () => {
  it("renders the all-clear empty state", async () => {
    mockFetchJson({ "/api/membership-audit/households-missing-contact": { households: [] } });
    renderWithProviders(<MissingEmergencyContactsPage />);

    expect(await screen.findByText(/Every active household has a valid emergency contact/)).toBeInTheDocument();
  });

  it("toasts a network-error notification when the fetch rejects", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = jest.fn(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    renderWithProviders(<MissingEmergencyContactsPage />);

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "Network error loading households." }),
      ),
    );
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Failed to load"), expect.anything());
    spy.mockRestore();
  });
});
