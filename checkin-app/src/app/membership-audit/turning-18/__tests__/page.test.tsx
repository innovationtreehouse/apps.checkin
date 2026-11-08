import { screen } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import TurningEighteenPage from "../page";

beforeEach(() => resetRtl());

const ROUTE = "/api/membership-audit/turning-18";

describe("membership-audit/turning-18 page", () => {
  it("lists a household member with a birthdate", async () => {
    mockFetchJson({
      [ROUTE]: {
        BoardSettings: { orgMembershipYearBoundary: "2026-09-01T00:00:00.000Z" },
        Person: [{ id: 7, name: "Sam Young", dateOfBirth: "2008-03-01", household: { id: 3, name: "Young" }, programParticipants: [] }],
      },
    });
    renderWithProviders(<TurningEighteenPage />);
    expect(await screen.findByText("Sam Young")).toBeInTheDocument();
  });

  it("shows the failure, not an empty roster, when the load fails", async () => {
    mockFetchJson({});
    renderWithProviders(<TurningEighteenPage />);
    expect(await screen.findByText("Couldn't load the roster")).toBeInTheDocument();
    expect(screen.queryByText(/Nobody with a birthdate/)).not.toBeInTheDocument();
  });
});
