// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { act, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { notifications, notificationsStore } from "@mantine/notifications";
import { renderWithProviders, mockFetchJson, setSession, resetRtl, router } from "@/test-helpers/rtl";
import { pinTimezone } from "@/test-helpers/tz";
import AdminHouseholdsPage from "../page";

beforeEach(() => resetRtl());
afterEach(() => act(() => notifications.clean()));

const households = {
  households: [
    {
      id: 1,
      name: "The Smiths",
      orgMembership: { status: "ACTIVE" },
      householdMembers: [{ id: 10, name: "Pat Smith", email: "pat@example.com", isBoardMember: false }],
    },
    {
      id: 2,
      name: "The Joneses",
      orgMembership: null,
      householdMembers: [{ id: 20, name: "Jo Jones", email: "jo@example.com", isBoardMember: false }],
    },
  ],
  grantYears: [{ year: 2026, label: "2026-2027" }],
};

describe("membership-ops/households page", () => {
  pinTimezone();

  it("says the list failed instead of showing no households", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({}); // every fetch 404s
    renderWithProviders(<AdminHouseholdsPage />);

    expect(await screen.findByText("Couldn't load the households")).toBeInTheDocument();
    expect(screen.queryByText("No households found.")).not.toBeInTheDocument();
  });

  it("renders a UTC-midnight memberSince as its own calendar day, not the day before", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/membership-ops/households": {
        ...households,
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

  it("shows the members CSV download to the Board only", async () => {
    mockFetchJson({ "/api/membership-ops/households": households });
    setSession({ id: 1, isSysadmin: true });
    const { unmount } = renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Smiths");
    expect(screen.queryByRole("button", { name: /Download current members/ })).not.toBeInTheDocument();
    unmount();

    setSession({ id: 1, isBoardMember: true });
    renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Smiths");
    expect(screen.getByRole("button", { name: /Download current members/ })).toBeInTheDocument();
  });

  it("offers the year's renewal beside Revoke only on a lapsed active household", async () => {
    setSession({ id: 1, isBoardMember: true, householdId: 500 });
    mockFetchJson({
      "/api/membership-ops/households": {
        ...households,
        households: [
          { ...households.households[0], validUntil: "2026-08-01T00:00:00.000Z" },
          { ...households.households[0], id: 3, name: "The Currents", validUntil: "2099-08-01T00:00:00.000Z" },
        ],
      },
    });
    renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Smiths");

    expect(screen.getAllByRole("button", { name: "Revoke Membership" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Open renewal 2026-2027" })).toHaveLength(1);
  });

  it("offers a sysadmin the lapsed row's Open renewal, but not a Grant that maps a payment", async () => {
    setSession({ id: 1, isSysadmin: true, householdId: 500 });
    const lapsed = { ...households.households[0], validUntil: "2026-08-01T00:00:00.000Z" };
    mockFetchJson({
      "/api/membership-ops/households": {
        ...households,
        households: [lapsed, { ...lapsed, id: 4, name: "The Payables", awaitingPayment: true }],
      },
    });
    renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Payables");

    expect(screen.getAllByRole("button", { name: "Open renewal 2026-2027" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Grant 2026-2027" })).not.toBeInTheDocument();
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
    await waitFor(() => expect(notificationsStore.getState().notifications).toHaveLength(1));
    const shown = notificationsStore.getState().notifications[0];
    expect(shown).toMatchObject({ message: "Membership revoked.", color: "green", role: "status" });
    expect(shown.autoClose).not.toBe(false);
  });

  it("shows the route's words when a revoke is refused, and re-reads the list once on success", async () => {
    setSession({ id: 1, isSysadmin: true });
    let refuse = true;
    const fetchMock = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify(refuse ? { error: "That household has an open review." } : {}), { status: refuse ? 409 : 200 })
        : new Response(JSON.stringify(households)),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Smiths");

    fireEvent.click(screen.getByRole("button", { name: "Revoke Membership" }));
    await waitFor(() =>
      expect(notificationsStore.getState().notifications[0]).toMatchObject({ message: "That household has an open review.", color: "red" }),
    );

    refuse = false;
    const reads = () => fetchMock.mock.calls.filter(([, init]) => init?.method === undefined).length;
    const before = reads();
    fireEvent.click(screen.getByRole("button", { name: "Revoke Membership" }));
    await waitFor(() => expect(reads()).toBe(before + 1));
  });

  it("posts the year on the button pressed, with a required reason", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/membership-ops/households": households });
    renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Joneses");

    fireEvent.click(screen.getByRole("button", { name: "Open application 2026-2027" }));
    const reasonInput = await screen.findByLabelText(/^Reason/);
    expect(screen.getByRole("button", { name: "Open application" })).toBeDisabled();
    fireEvent.change(reasonInput, { target: { value: "Paid by check" } });
    fireEvent.click(screen.getByRole("button", { name: "Open application" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/membership-ops/households",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ householdId: 2, year: 2026, reason: "Paid by check" }),
        }),
      ),
    );
  });

  it("disables Grant for a board member's OWN household (conflict of interest)", async () => {
    setSession({ id: 99, isBoardMember: true, householdId: 2 }); // same household as The Joneses (id 2)
    mockFetchJson({ "/api/membership-ops/households": households });
    renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Joneses");

    expect(screen.getByRole("button", { name: "Open application 2026-2027" })).toBeDisabled();
  });

  it("keeps Grant enabled for a board member in a different household", async () => {
    setSession({ id: 99, isBoardMember: true, householdId: 500 });
    mockFetchJson({ "/api/membership-ops/households": households });
    renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Joneses");

    expect(screen.getByRole("button", { name: "Open application 2026-2027" })).toBeEnabled();
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

  it("labels a household that said it won't renew with the year and the date it said so", async () => {
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({
      "/api/membership-ops/households": {
        ...households,
        households: [{ ...households.households[0], notRenewing: { year: 2026, since: "2026-07-03T15:00:00.000Z" } }, households.households[1]],
      },
    });
    renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Smiths");

    expect(screen.getByText(/Not renewing 2026-2027 · said .*2026/)).toBeInTheDocument();
    expect(screen.getAllByText(/Not renewing/)).toHaveLength(1);
  });

  it("navigates to the add-participant page for a household", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/membership-ops/households": households });
    renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Smiths");

    fireEvent.click(screen.getAllByRole("button", { name: "+ Add Participant" })[0]);

    expect(router.push).toHaveBeenCalledWith("/membership-ops/participants/new?householdId=1");
  });

  it("shows no Grant when no year can be granted (no boundary set)", async () => {
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({ "/api/membership-ops/households": { ...households, grantYears: [] } });
    renderWithProviders(<AdminHouseholdsPage />);
    await screen.findByText("The Joneses");

    expect(screen.queryByRole("button", { name: /^(Grant|Open)/ })).not.toBeInTheDocument();
  });

  describe("names the effect a click will have", () => {
    const grantYears = [{ year: 2026, label: "2026-2027" }];
    const lapsed = { ...households.households[0], validUntil: "2026-08-01T00:00:00.000Z" };
    const rows = [
      { ...lapsed, id: 4, name: "The Payables", awaitingPayment: true },
      { ...lapsed, id: 5, name: "The Renewers" },
      { ...households.households[1], id: 6, name: "The Joiners" },
    ];

    const confirmOn = async (rowName: string, control: string, confirm: string, serverMessage?: string) => {
      const fetchMock = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Response(JSON.stringify(init?.method === "POST" ? (serverMessage ? { message: serverMessage } : {}) : { households: rows, grantYears })),
      );
      global.fetch = fetchMock as unknown as typeof fetch;
      renderWithProviders(<AdminHouseholdsPage />);
      await screen.findByText(rowName);

      const row = screen.getByText(rowName).closest("tr") as HTMLElement;
      fireEvent.click(within(row).getByRole("button", { name: control }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(control)).toBeInTheDocument();
      fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: "Board decision" } });
      fireEvent.click(within(dialog).getByRole("button", { name: confirm }));
      await waitFor(() => expect(notificationsStore.getState().notifications).toHaveLength(1));
      return notificationsStore.getState().notifications[0];
    };

    it("labels each row by what it will do: Grant only where an application awaits payment", async () => {
      setSession({ id: 1, isBoardMember: true, householdId: 500 });
      mockFetchJson({ "/api/membership-ops/households": { households: rows, grantYears } });
      renderWithProviders(<AdminHouseholdsPage />);
      await screen.findByText("The Joiners");

      const control = (name: string) => within(screen.getByText(name).closest("tr") as HTMLElement).getByRole("button", { name: /^(Grant|Open) / });
      expect(control("The Payables")).toHaveTextContent("Grant 2026-2027");
      expect(control("The Renewers")).toHaveTextContent("Open renewal 2026-2027");
      expect(control("The Joiners")).toHaveTextContent("Open application 2026-2027");
    });

    it("confirms a grant as Granted", async () => {
      setSession({ id: 1, isBoardMember: true, householdId: 500 });
      const shown = await confirmOn("The Payables", "Grant 2026-2027", "Grant");
      expect(shown).toMatchObject({ message: "Granted 2026-2027.", color: "green" });
    });

    it("confirms an opened renewal without saying Granted", async () => {
      setSession({ id: 1, isBoardMember: true, householdId: 500 });
      const shown = await confirmOn("The Renewers", "Open renewal 2026-2027", "Open renewal");
      expect(shown).toMatchObject({ message: "Renewal opened.", color: "green" });
    });

    it("confirms an opened application without saying Granted", async () => {
      setSession({ id: 1, isBoardMember: true, householdId: 500 });
      const shown = await confirmOn("The Joiners", "Open application 2026-2027", "Open application");
      expect(shown).toMatchObject({ message: "Application opened.", color: "green" });
    });

    it("shows the server's words for the effect it took", async () => {
      setSession({ id: 1, isBoardMember: true, householdId: 500 });
      const message = "Renewal opened: the family completes it, then grant once it reaches payment.";
      const shown = await confirmOn("The Renewers", "Open renewal 2026-2027", "Open renewal", message);
      expect(shown).toMatchObject({ message });
    });
  });

  describe("the coming year's Grant", () => {
    const YEAR = "Grant 2026-2027";
    const COMING = "Grant 2027-2028";
    const grantYears = [{ year: 2026, label: "2026-2027" }, { year: 2027, label: "2027-2028" }];
    // The Smiths are renewing and The Joneses joining; both await payment.
    const inSeason = {
      households: households.households.map((h) => ({ ...h, awaitingPayment: true })),
      grantYears,
    };

    it("is hidden outside the renewal window: only the year in progress shows", async () => {
      setSession({ id: 1, isBoardMember: true });
      mockFetchJson({ "/api/membership-ops/households": { ...inSeason, grantYears: grantYears.slice(0, 1) } });
      renderWithProviders(<AdminHouseholdsPage />);
      await screen.findByText("The Smiths");

      expect(screen.getAllByRole("button", { name: YEAR })).toHaveLength(2);
      expect(screen.queryByRole("button", { name: COMING })).not.toBeInTheDocument();
    });

    it("shows both years to a joining and a renewing household awaiting payment", async () => {
      setSession({ id: 1, isBoardMember: true });
      mockFetchJson({ "/api/membership-ops/households": inSeason });
      renderWithProviders(<AdminHouseholdsPage />);
      await screen.findByText("The Smiths");

      expect(screen.getAllByRole("button", { name: YEAR })).toHaveLength(2);
      expect(screen.getAllByRole("button", { name: COMING })).toHaveLength(2);
    });

    it("offers no certifying Grant to a sysadmin who is not on the Board", async () => {
      setSession({ id: 1, isSysadmin: true });
      mockFetchJson({ "/api/membership-ops/households": inSeason });
      renderWithProviders(<AdminHouseholdsPage />);
      await screen.findByText("The Smiths");

      expect(screen.queryByRole("button", { name: YEAR })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: COMING })).not.toBeInTheDocument();
    });

    it("opens a modal requiring a reason, then posts that year", async () => {
      setSession({ id: 1, isBoardMember: true });
      const fetchMock = mockFetchJson({ "/api/membership-ops/households": inSeason });
      renderWithProviders(<AdminHouseholdsPage />);
      await screen.findByText("The Smiths");

      fireEvent.click(screen.getAllByRole("button", { name: COMING })[0]);

      // Mantine's `required` prop appends a visible " *" to the label text.
      const reasonInput = await screen.findByLabelText(/^Reason/);
      expect(screen.getByRole("button", { name: "Grant" })).toBeDisabled();

      fireEvent.change(reasonInput, { target: { value: "Family paid cash at the front desk" } });
      fireEvent.click(screen.getByRole("button", { name: "Grant" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/membership-ops/households",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ householdId: 1, year: 2027, reason: "Family paid cash at the front desk" }),
          }),
        ),
      );
    });

    it("disables it once the live year is settled", async () => {
      setSession({ id: 1, isBoardMember: true });
      mockFetchJson({
        "/api/membership-ops/households": {
          grantYears,
          households: [{ ...households.households[0], settledForComingYear: true }, inSeason.households[1]],
        },
      });
      renderWithProviders(<AdminHouseholdsPage />);
      await screen.findByText("The Smiths");

      expect(screen.getByRole("button", { name: "Granted 2027-2028" })).toBeDisabled();
      expect(screen.getByRole("button", { name: COMING })).toBeEnabled();
    });

    it("hides it for a board member's OWN household (conflict of interest)", async () => {
      setSession({ id: 99, isBoardMember: true, householdId: 2 }); // same household as The Joneses (id 2)
      mockFetchJson({ "/api/membership-ops/households": inSeason });
      renderWithProviders(<AdminHouseholdsPage />);
      await screen.findByText("The Joneses");

      expect(screen.getAllByRole("button", { name: COMING })).toHaveLength(1);
    });

    it("hides it when no application awaits payment", async () => {
      setSession({ id: 1, isBoardMember: true });
      mockFetchJson({ "/api/membership-ops/households": { ...households, grantYears } });
      renderWithProviders(<AdminHouseholdsPage />);
      await screen.findByText("The Smiths");

      expect(screen.queryByRole("button", { name: COMING })).not.toBeInTheDocument();
    });
  });
});
