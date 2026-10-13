// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl, router } from "@/test-helpers/rtl";
import { pinTimezone } from "@/test-helpers/tz";
import AdminHouseholdsPage from "../page";

beforeEach(() => resetRtl());

const households = {
  households: [
    {
      id: 1,
      name: "The Smiths",
      orgMembership: { status: "ACTIVE" },
      householdMembers: [{ id: 10, name: "Pat Smith", email: "pat@example.com", isBoardMember: false }],
      renewalGrantable: true,
    },
    {
      id: 2,
      name: "The Joneses",
      orgMembership: null,
      householdMembers: [{ id: 20, name: "Jo Jones", email: "jo@example.com", isBoardMember: false }],
      renewalGrantable: true,
    },
  ],
};

describe("membership-ops/households page", () => {
  pinTimezone();

  it("renders a UTC-midnight memberSince as its own calendar day, not the day before", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/membership-ops/households": {
        households: [{
          ...households.households[0],
          orgMembership: { status: "ACTIVE", memberSince: "2024-08-15T00:00:00.000Z" },
        }],
      },
    });
    const { container } = renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Smiths");

    expect(container.textContent).toContain("Aug 15, 2024");
    expect(container.textContent).not.toContain("Aug 14, 2024");
  });

  it("loads and renders households with membership status", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/membership-ops/households": households });
    renderWithProviders(<AdminHouseholdsPage />);

    expect(await screen.findByText("The Smiths")).toBeInTheDocument();
    expect(screen.getByText("The Joneses")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
  });

  it("filters households by name", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/membership-ops/households": households });
    renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Smiths");

    fireEvent.change(screen.getByPlaceholderText("Filter by household or participant name, email, or ID"), {
      target: { value: "Jones" },
    });

    expect(screen.queryByText("The Smiths")).not.toBeInTheDocument();
    expect(screen.getByText("The Joneses")).toBeInTheDocument();
  });

  it("revokes an active membership", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/membership-ops/households": households,
    });
    renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Smiths");

    fireEvent.click(screen.getByRole("button", { name: "Revoke Membership" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/membership-ops/households",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ householdId: 1, active: false }),
        }),
      ),
    );
  });

  it("grants the current year with a required reason", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/membership-ops/households": households });
    renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Joneses");

    fireEvent.click(screen.getByRole("button", { name: "Grant Membership" }));
    const reasonInput = await screen.findByLabelText(/^Reason/);
    expect(screen.getByRole("button", { name: "Grant" })).toBeDisabled();
    fireEvent.change(reasonInput, { target: { value: "Paid by check" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/membership-ops/households",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ householdId: 2, active: true, reason: "Paid by check" }),
        }),
      ),
    );
  });

  it("disables Grant for a board member's OWN household (conflict of interest)", async () => {
    setSession({ id: 99, isBoardMember: true, householdId: 2 }); // same household as The Joneses (id 2)
    mockFetchJson({ "/api/membership-ops/households": households });
    renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Joneses");

    expect(screen.getByRole("button", { name: "Grant Membership" })).toBeDisabled();
  });

  it("keeps Grant enabled for a board member in a different household", async () => {
    setSession({ id: 99, isBoardMember: true, householdId: 500 });
    mockFetchJson({ "/api/membership-ops/households": households });
    renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Joneses");

    expect(screen.getByRole("button", { name: "Grant Membership" })).toBeEnabled();
  });

  it("flags a household whose member has an undeliverable email", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/membership-ops/households": {
        households: [
          {
            id: 3,
            name: "The Bounces",
            orgMembership: { status: "ACTIVE" },
            householdMembers: [{ id: 30, name: "Bo Bounce", email: "bo@example.com", isBoardMember: false, emailUndeliverableAt: "2026-07-01T00:00:00.000Z" }],
          },
          ...households.households,
        ],
      },
    });
    renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Bounces");

    // Household-level flag next to the name, and the per-member marker in the list.
    expect(screen.getByText("✉ Broken email")).toBeInTheDocument();
    expect(screen.getByText("✉ undeliverable")).toBeInTheDocument();
    // Households with all-deliverable emails carry neither.
    expect(screen.getAllByText("✉ Broken email")).toHaveLength(1);
  });

  it("navigates to the add-participant page for a household", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/membership-ops/households": households });
    renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Smiths");

    fireEvent.click(screen.getAllByRole("button", { name: "+ Add Participant" })[0]);

    expect(router.push).toHaveBeenCalledWith("/membership-ops/participants/new?householdId=1");
  });

  describe("Grant for coming year (renewal season)", () => {
    const inSeason = { ...households, renewalSeason: true };

    it("is hidden outside renewal season", async () => {
      setSession({ id: 1, isSysadmin: true });
      mockFetchJson({ "/api/membership-ops/households": households }); // no renewalSeason flag
      renderWithProviders(<AdminHouseholdsPage />);
      await screen.findByText("The Smiths");

      expect(screen.queryByRole("button", { name: "Grant for coming year" })).not.toBeInTheDocument();
    });

    it("shows for both an existing member and a non-member in renewal season", async () => {
      setSession({ id: 1, isSysadmin: true });
      mockFetchJson({ "/api/membership-ops/households": inSeason });
      renderWithProviders(<AdminHouseholdsPage />);
      await screen.findByText("The Smiths");

      // The Smiths (ACTIVE) and The Joneses (non-member) both get the button.
      expect(screen.getAllByRole("button", { name: "Grant for coming year" })).toHaveLength(2);
    });

    it("opens a modal requiring a reason, then posts comingYear + reason when confirmed", async () => {
      setSession({ id: 1, isSysadmin: true });
      const fetchMock = mockFetchJson({ "/api/membership-ops/households": inSeason });
      renderWithProviders(<AdminHouseholdsPage />);
      await screen.findByText("The Smiths");

      fireEvent.click(screen.getAllByRole("button", { name: "Grant for coming year" })[0]);

      // Mantine's `required` prop appends a visible " *" to the label text.
      const reasonInput = await screen.findByLabelText(/^Reason/);
      // The confirm button is disabled until a reason is entered.
      expect(screen.getByRole("button", { name: "Grant" })).toBeDisabled();

      fireEvent.change(reasonInput, { target: { value: "Family paid cash at the front desk" } });
      expect(screen.getByRole("button", { name: "Grant" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Grant" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/membership-ops/households",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ householdId: 1, comingYear: true, reason: "Family paid cash at the front desk" }),
          }),
        ),
      );
    });

    it("disables it once the coming year is settled", async () => {
      setSession({ id: 1, isSysadmin: true });
      mockFetchJson({
        "/api/membership-ops/households": {
          ...inSeason,
          households: [{ ...inSeason.households[0], settledForComingYear: true }, inSeason.households[1]],
        },
      });
      renderWithProviders(<AdminHouseholdsPage />);
      await screen.findByText("The Smiths");

      expect(screen.getByRole("button", { name: "Granted for coming year" })).toBeDisabled();
      // The un-settled household keeps a live button.
      expect(screen.getByRole("button", { name: "Grant for coming year" })).toBeEnabled();
    });

    it("hides it for a board member's OWN household (conflict of interest)", async () => {
      setSession({ id: 99, isBoardMember: true, householdId: 2 }); // same household as The Joneses (id 2)
      mockFetchJson({ "/api/membership-ops/households": inSeason });
      renderWithProviders(<AdminHouseholdsPage />);
      await screen.findByText("The Joneses");

      // The gate is now visibility-only: only the Smiths' button renders — the
      // Joneses' (own household) is hidden entirely, not just disabled.
      expect(screen.getAllByRole("button", { name: "Grant for coming year" })).toHaveLength(1);
    });

    it("hides it when the household has no grantable renewal (renewalGrantable false)", async () => {
      setSession({ id: 1, isSysadmin: true });
      mockFetchJson({
        "/api/membership-ops/households": {
          ...inSeason,
          households: inSeason.households.map((h) => ({ ...h, renewalGrantable: false })),
        },
      });
      renderWithProviders(<AdminHouseholdsPage />);
      await screen.findByText("The Smiths");

      expect(screen.queryByRole("button", { name: "Grant for coming year" })).not.toBeInTheDocument();
    });
  });
});
