// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl, router } from "@/test-helpers/rtl";
import { notifications } from "@mantine/notifications";
import { pinTimezone } from "@/test-helpers/tz";
import MergeParticipants from "../page";

beforeEach(() => { resetRtl(); (notifications.show as jest.Mock).mockClear(); });

const participantA = {
  id: 1, name: "Alice Adams", email: "alice@example.com", phone: null, googleId: "g1",
  _count: { visits: 5, rawBadgeLogs: 0, programParticipants: 0, programVolunteers: 0 },
  household: { id: 10, name: "Adams House", householdMembers: [{ id: 1 }] },
};
const participantB = {
  id: 2, name: "Bob Adams", email: "bob@example.com", phone: null, googleId: null,
  _count: { visits: 0, rawBadgeLogs: 0, programParticipants: 0, programVolunteers: 0 },
  household: null,
};

function mockRoutes() {
  return mockFetchJson({
    "/api/membership-ops/participants/merge/analyze": { participants: [participantA, participantB] },
    "/api/membership-ops/participants/merge": { success: true },
    "/api/people/search?q=Alice": { people: [participantA] },
    "/api/people/search?q=Bob": { people: [participantB] },
  });
}

async function selectBoth() {
  fireEvent.change(screen.getAllByPlaceholderText("Search by name, email, or ID...")[0], { target: { value: "Alice" } });
  fireEvent.click(await screen.findByText("Alice Adams", { exact: false }));

  // Box A is now a selected card, so only box B's search input remains.
  fireEvent.change(screen.getByPlaceholderText("Search by name, email, or ID..."), { target: { value: "Bob" } });
  fireEvent.click(await screen.findByText("Bob Adams", { exact: false }));
}

describe("membership-ops/participants/merge page", () => {
  pinTimezone();

  it("searches, selects two participants, and analyzes them", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockRoutes();
    renderWithProviders(<MergeParticipants />);

    await selectBoth();

    expect(await screen.findByText("Keep and augment")).toBeInTheDocument();
    expect(screen.getByText("Merge and tombstone")).toBeInTheDocument();
    // Alice scores higher (visits + googleId) so she's recommended to keep.
    expect(screen.getByRole("button", { name: "Proceed to Preview" })).toBeInTheDocument();
  });

  it("renders multiple search results fully, not clipped to a sliver", async () => {
    // Regression test for the merge page's search dropdown being clipped by an
    // ancestor Card's default overflow:hidden (only a sliver of the first result
    // was visible). All results must render, not just the first.
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/people/search?q=Sam": {
        people: [
          { id: 50, name: "Sam One", email: "sam1@example.com" },
          { id: 51, name: "Sam Two", email: "sam2@example.com" },
          { id: 52, name: "Sam Three", email: "sam3@example.com" },
        ],
      },
    });
    renderWithProviders(<MergeParticipants />);

    fireEvent.change(screen.getAllByPlaceholderText("Search by name, email, or ID...")[0], { target: { value: "Sam" } });

    expect(await screen.findByText("Sam One", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Sam Two", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Sam Three", { exact: false })).toBeInTheDocument();
  });

  it("previews and confirms the merge", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockRoutes();
    renderWithProviders(<MergeParticipants />);

    await selectBoth();
    await screen.findByText("Keep and augment");

    fireEvent.click(screen.getByRole("button", { name: "Proceed to Preview" }));
    expect(await screen.findByText("Preview & Confirm Merge")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm Merge & Tombstone" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/membership-ops/participants/merge",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ keepId: 1, mergeId: 2, fieldChoices: { name: "keep", identity: "keep" } }),
        }),
      ),
    );
    expect(await screen.findByText("Merge Successful!")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to Participants" }));
    expect(router.push).toHaveBeenCalledWith("/membership-ops/participants");
  });

  it("keeps the higher-scoring second selection, formats a raw phone, shows Household: None, and swaps kept/merged", async () => {
    const zack = {
      id: 30, name: "Zack Zero", email: null, phone: null, googleId: null,
      _count: { visits: 0, rawBadgeLogs: 0, programParticipants: 0, programVolunteers: 0 },
      household: null,
    };
    const belle = {
      id: 31, name: "Belle Best", email: "belle@example.com", phone: "5125551234", googleId: "g31",
      _count: { visits: 3, rawBadgeLogs: 1, programParticipants: 1, programVolunteers: 0 },
      household: null,
    };
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/membership-ops/participants/merge/analyze": { participants: [zack, belle] },
      "/api/people/search?q=Zack": { people: [zack] },
      "/api/people/search?q=Belle": { people: [belle] },
    });
    renderWithProviders(<MergeParticipants />);

    fireEvent.change(screen.getAllByPlaceholderText("Search by name, email, or ID...")[0], { target: { value: "Zack" } });
    fireEvent.click(await screen.findByText("Zack Zero", { exact: false }));
    fireEvent.change(screen.getByPlaceholderText("Search by name, email, or ID..."), { target: { value: "Belle" } });
    fireEvent.click(await screen.findByText("Belle Best", { exact: false }));

    await screen.findByText("Keep and augment");
    // Belle out-scores Zack (visits/badges/programs/email/google), so she's kept
    // even though she was the second one selected.
    const belleCard = screen.getByText("Belle Best (ID: 31)").closest(".mantine-Card-root") as HTMLElement;
    expect(within(belleCard).getByText("Keep and augment")).toBeInTheDocument();
    expect(within(belleCard).getByText(/512-555-1234/)).toBeInTheDocument();
    expect(within(belleCard).getByText(/Google Auth: Yes/)).toBeInTheDocument();

    const zackCard = screen.getByText("Zack Zero (ID: 30)").closest(".mantine-Card-root") as HTMLElement;
    expect(within(zackCard).getByText("Merge and tombstone")).toBeInTheDocument();
    expect(within(zackCard).getByText(/Household: None/)).toBeInTheDocument();
    expect(within(zackCard).getByText(/Google Auth: No/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Swap Kept / Merged" }));
    expect(within(zackCard).getByText("Keep and augment")).toBeInTheDocument();
    expect(within(belleCard).getByText("Merge and tombstone")).toBeInTheDocument();
  });

  it("lets you change a selected participant back to search", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockRoutes();
    renderWithProviders(<MergeParticipants />);

    fireEvent.change(screen.getAllByPlaceholderText("Search by name, email, or ID...")[0], { target: { value: "Alice" } });
    fireEvent.click(await screen.findByText("Alice Adams", { exact: false }));
    expect(screen.getByText("Alice Adams", { exact: false })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getAllByPlaceholderText("Search by name, email, or ID...")).toHaveLength(2);
    // The re-shown search box still has "Alice" as its value, which re-triggers the
    // search effect; let that settle so it doesn't leak an unawaited update.
    expect(await screen.findByText("Alice Adams", { exact: false })).toBeInTheDocument();
  });

  it("shows a failure message when analysis throws", async () => {
    setSession({ id: 1, isSysadmin: true });
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("q=Alice")) return { ok: true, json: async () => ({ people: [participantA] }) } as Response;
      if (url.includes("q=Bob")) return { ok: true, json: async () => ({ people: [participantB] }) } as Response;
      if (url.includes("merge/analyze")) throw new Error("boom");
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    renderWithProviders(<MergeParticipants />);

    await selectBoth();
    expect(await screen.findByText("Failed to analyze participants")).toBeInTheDocument();
  });

  it("shows a red alert and disables Proceed when the merged participant is a lead of a household with other members", async () => {
    const leo = {
      id: 40, name: "Leo Lead", email: "leo@example.com", phone: "5551234567", googleId: "g40",
      _count: { visits: 0, rawBadgeLogs: 0, programParticipants: 0, programVolunteers: 0 },
      household: { id: 100, name: "Lead House", householdMembers: [{ id: 40, isHouseholdLead: true }, { id: 41 }] },
    };
    const otto = {
      id: 41, name: "Otto Other", email: "otto@example.com", phone: null, googleId: "g41",
      _count: { visits: 10, rawBadgeLogs: 0, programParticipants: 2, programVolunteers: 0 },
      household: null,
    };
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/membership-ops/participants/merge/analyze": { participants: [leo, otto] },
      "/api/people/search?q=Leo": { people: [leo] },
      "/api/people/search?q=Otto": { people: [otto] },
    });
    renderWithProviders(<MergeParticipants />);

    fireEvent.change(screen.getAllByPlaceholderText("Search by name, email, or ID...")[0], { target: { value: "Leo" } });
    fireEvent.click(await screen.findByText("Leo Lead", { exact: false }));
    fireEvent.change(screen.getByPlaceholderText("Search by name, email, or ID..."), { target: { value: "Otto" } });
    fireEvent.click(await screen.findByText("Otto Other", { exact: false }));

    // Otto out-scores Leo, so Leo (the household lead) is the one slated for deletion.
    expect(await screen.findByText(/is the lead of a household with other members/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Proceed to Preview" })).toBeDisabled();
  });

  it("shows a yellow warning when the merged participant has other household members but isn't the lead", async () => {
    const mia = {
      id: 20, name: "Mia Member", email: "mia@example.com", phone: null, googleId: null,
      _count: { visits: 0, rawBadgeLogs: 0, programParticipants: 0, programVolunteers: 0 },
      household: { id: 200, name: "Member House", householdMembers: [{ id: 20 }, { id: 21, isHouseholdLead: true }] },
    };
    const hank = {
      id: 21, name: "Hank High", email: "hank@example.com", phone: null, googleId: "g21",
      _count: { visits: 5, rawBadgeLogs: 0, programParticipants: 0, programVolunteers: 0 },
      household: null,
    };
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/membership-ops/participants/merge/analyze": { participants: [mia, hank] },
      "/api/people/search?q=Mia": { people: [mia] },
      "/api/people/search?q=Hank": { people: [hank] },
    });
    renderWithProviders(<MergeParticipants />);

    fireEvent.change(screen.getAllByPlaceholderText("Search by name, email, or ID...")[0], { target: { value: "Mia" } });
    fireEvent.click(await screen.findByText("Mia Member", { exact: false }));
    fireEvent.change(screen.getByPlaceholderText("Search by name, email, or ID..."), { target: { value: "Hank" } });
    fireEvent.click(await screen.findByText("Hank High", { exact: false }));

    expect(await screen.findByText(/is in a household with others/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Proceed to Preview" })).toBeEnabled();
  });

  it("shows a server error, then a network-error message, when the merge request fails", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockRoutes();
    renderWithProviders(<MergeParticipants />);
    await selectBoth();
    await screen.findByText("Keep and augment");
    fireEvent.click(screen.getByRole("button", { name: "Proceed to Preview" }));
    await screen.findByText("Preview & Confirm Merge");

    global.fetch = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "Cannot merge." }) })) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Confirm Merge & Tombstone" }));
    expect(await screen.findByText("Cannot merge.")).toBeInTheDocument();

    // Network failure surfaces as a persistent toast, and never leaks the raw JS error text.
    global.fetch = jest.fn(() => Promise.reject(new Error("Connection lost"))) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Confirm Merge & Tombstone" }));
    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ color: "red", message: "Network error", autoClose: false })));
    expect(screen.queryByText("Connection lost")).not.toBeInTheDocument();

    global.fetch = jest.fn(() => Promise.reject("not an Error")) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Confirm Merge & Tombstone" }));
    await waitFor(() => expect(notifications.show).toHaveBeenCalledTimes(2));
  });

  it("resets back to the search screen after Merge More", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockRoutes();
    renderWithProviders(<MergeParticipants />);
    await selectBoth();
    await screen.findByText("Keep and augment");
    fireEvent.click(screen.getByRole("button", { name: "Proceed to Preview" }));
    await screen.findByText("Preview & Confirm Merge");
    fireEvent.click(screen.getByRole("button", { name: "Confirm Merge & Tombstone" }));
    await screen.findByText("Merge Successful!");

    fireEvent.click(screen.getByRole("button", { name: "Merge More" }));
    expect(screen.getAllByPlaceholderText("Search by name, email, or ID...")).toHaveLength(2);
  });

  it("cancels out of preview mode back to the analysis screen", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockRoutes();
    renderWithProviders(<MergeParticipants />);
    await selectBoth();
    await screen.findByText("Keep and augment");
    fireEvent.click(screen.getByRole("button", { name: "Proceed to Preview" }));
    await screen.findByText("Preview & Confirm Merge");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Keep and augment")).toBeInTheDocument();
  });

  // Matrix 19
  it("renders a radio group only for true conflicts (shared null phone gets no radio)", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockRoutes();
    renderWithProviders(<MergeParticipants />);
    await selectBoth();
    await screen.findByText("Keep and augment");

    // Alice/Bob differ on name; both have an email so the login identity is a
    // conflict too; both share phone: null and have no dateOfBirth.
    const picker = screen.getByText("Resolve conflicting fields").closest(".mantine-Card-root") as HTMLElement;
    expect(within(picker).getByText("Name")).toBeInTheDocument();
    expect(within(picker).getByText("Login identity")).toBeInTheDocument();
    // email/googleId are no longer their own radios — folded into "Login identity".
    expect(within(picker).queryByText("Email")).not.toBeInTheDocument();
    expect(within(picker).queryByText("Google Account")).not.toBeInTheDocument();
    expect(within(picker).queryByText("Phone")).not.toBeInTheDocument();
    expect(within(picker).queryByText("Date of Birth")).not.toBeInTheDocument();
  });

  // Matrix 20
  it("defaults each conflict radio to the keeper's value; swapping resets defaults to the new keeper", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockRoutes();
    renderWithProviders(<MergeParticipants />);
    await selectBoth();
    await screen.findByText("Keep and augment");

    // Alice out-scores Bob (visits + googleId), so she's the default keeper. The
    // "keep" radio in each group shows the keeper's value (name + login identity).
    expect(screen.getByRole("radio", { name: "Alice Adams" })).toBeChecked();
    expect(screen.getByRole("radio", { name: /alice@example\.com · Google/ })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Swap Kept / Merged" }));

    expect(screen.getByRole("radio", { name: "Bob Adams" })).toBeChecked();
    expect(screen.getByRole("radio", { name: /bob@example\.com · unverified/ })).toBeChecked();
  });

  // Matrix 21
  it("includes the chosen fieldChoices in the merge POST body", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockRoutes();
    renderWithProviders(<MergeParticipants />);
    await selectBoth();
    await screen.findByText("Keep and augment");

    // Pick the tombstone's (Bob's) login identity instead of the keeper's default.
    fireEvent.click(screen.getByRole("radio", { name: /bob@example\.com · unverified/ }));

    fireEvent.click(screen.getByRole("button", { name: "Proceed to Preview" }));
    await screen.findByText("Preview & Confirm Merge");
    fireEvent.click(screen.getByRole("button", { name: "Confirm Merge & Tombstone" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/membership-ops/participants/merge",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ keepId: 1, mergeId: 2, fieldChoices: { name: "keep", identity: "merge" } }),
        }),
      ),
    );
  });

  // Matrix 22
  it("shows each side's own login identity (email + Google + verified marker), not 'Connected'", async () => {
    const gia = {
      id: 60, name: "Gia Google", email: "gia@example.com", phone: null, googleId: "g-gia-000000",
      emailVerified: "2026-01-01T00:00:00.000Z",
      _count: { visits: 5, rawBadgeLogs: 0, programParticipants: 0, programVolunteers: 0 },
      household: null,
    };
    const gary = {
      id: 61, name: "Gary Gmail", email: null, phone: null, googleId: "g-gary-111111",
      emailVerified: null,
      _count: { visits: 0, rawBadgeLogs: 0, programParticipants: 0, programVolunteers: 0 },
      household: null,
    };
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/membership-ops/participants/merge/analyze": { participants: [gia, gary] },
      "/api/people/search?q=Gia": { people: [gia] },
      "/api/people/search?q=Gary": { people: [gary] },
    });
    renderWithProviders(<MergeParticipants />);

    fireEvent.change(screen.getAllByPlaceholderText("Search by name, email, or ID...")[0], { target: { value: "Gia" } });
    fireEvent.click(await screen.findByText("Gia Google", { exact: false }));
    fireEvent.change(screen.getByPlaceholderText("Search by name, email, or ID..."), { target: { value: "Gary" } });
    fireEvent.click(await screen.findByText("Gary Gmail", { exact: false }));

    await screen.findByText("Keep and augment");
    const picker = screen.getByText("Resolve conflicting fields").closest(".mantine-Card-root") as HTMLElement;
    // Gia has a verified email; Gary has none, so his falls back to the googleId
    // tail and shows unverified — neither says the uninformative "Connected".
    expect(within(picker).getByText(/gia@example\.com · Google/)).toBeInTheDocument();
    expect(within(picker).getByText(/· verified$/)).toBeInTheDocument();
    expect(within(picker).getByText(/…111111 · unverified/)).toBeInTheDocument();
    expect(within(picker).queryByText("Connected")).not.toBeInTheDocument();
  });

  // Matrix 23
  it("wraps a dateOfBirth conflict in a warning alert instead of a plain radio", async () => {
    const dan = {
      id: 70, name: "Dan Date", email: "dan@example.com", phone: null, googleId: "g70",
      dateOfBirth: "1990-01-01",
      _count: { visits: 5, rawBadgeLogs: 0, programParticipants: 0, programVolunteers: 0 },
      household: null,
    };
    const dot = {
      id: 71, name: "Dot Different", email: "dot@example.com", phone: null, googleId: null,
      dateOfBirth: "2005-06-15",
      _count: { visits: 0, rawBadgeLogs: 0, programParticipants: 0, programVolunteers: 0 },
      household: null,
    };
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/membership-ops/participants/merge/analyze": { participants: [dan, dot] },
      "/api/people/search?q=Dan": { people: [dan] },
      "/api/people/search?q=Dot": { people: [dot] },
    });
    renderWithProviders(<MergeParticipants />);

    fireEvent.change(screen.getAllByPlaceholderText("Search by name, email, or ID...")[0], { target: { value: "Dan" } });
    fireEvent.click(await screen.findByText("Dan Date", { exact: false }));
    fireEvent.change(screen.getByPlaceholderText("Search by name, email, or ID..."), { target: { value: "Dot" } });
    fireEvent.click(await screen.findByText("Dot Different", { exact: false }));

    await screen.findByText("Keep and augment");
    const warningText = await screen.findByText(/Different birth dates may mean these are NOT the same person/);
    const alertBox = warningText.closest(".mantine-Alert-root") as HTMLElement;
    expect(alertBox).toBeInTheDocument();
    expect(within(alertBox).getAllByRole("radio")).toHaveLength(2);
    // DOB is a calendar date at UTC midnight: both options must read as their own
    // day, not the day before, even west of UTC.
    expect(alertBox.textContent).toContain("1/1/1990");
    expect(alertBox.textContent).toContain("6/15/2005");
  });

  it("renders nothing for a background-check reviewer who navigates directly", () => {
    setSession({ id: 9, isBackgroundCheckReviewer: true });
    mockRoutes();
    renderWithProviders(<MergeParticipants />);

    expect(screen.queryByPlaceholderText("Search by name, email, or ID...")).not.toBeInTheDocument();
    expect(screen.queryByText("Keep and augment")).not.toBeInTheDocument();
  });
});
