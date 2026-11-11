import { screen } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import MissingEmergencyContactsPage from "../page";

beforeEach(() => resetRtl());

describe("membership-audit/emergency-contacts page", () => {
  it("renders the all-clear empty state", async () => {
    mockFetchJson({ "/api/membership-audit/households-missing-contact": { households: [] } });
    renderWithProviders(<MissingEmergencyContactsPage />);

    expect(await screen.findByText(/Every active household has a valid emergency contact/)).toBeInTheDocument();
  });

  it("shows the failure, not the all-clear, when the load fails", async () => {
    mockFetchJson({});
    renderWithProviders(<MissingEmergencyContactsPage />);

    expect(await screen.findByText("Couldn't load households missing a contact")).toBeInTheDocument();
    expect(screen.queryByText(/Every active household/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
