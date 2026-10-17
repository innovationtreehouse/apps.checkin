// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, fireEvent, waitFor } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { renderWithProviders, mockFetchJson, setSession, resetRtl, router } from "@/test-helpers/rtl";
import { pinTimezone } from "@/test-helpers/tz";
import HouseholdPage from "../page";

// Successes toast via notifications.show (no inline banner); assert on the mock.
const expectToast = (message: string) =>
  expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message }));

beforeEach(() => {
  resetRtl();
  (notifications.show as jest.Mock).mockClear();
});

// `mockFetchJson`/`mockRoutes` always answer a matched url with 200, and one value
// per url regardless of method. Several branches below need a specific method
// and/or a non-2xx status on a url other tests hit successfully (e.g. GET
// /api/household succeeding while PATCH /api/household fails) — routedFetch
// matches by url substring + method, and `result` may be a function for a
// stateful sequence of responses across repeated calls to the same route.
type RouteResult = { ok?: boolean; status?: number; body?: unknown; throws?: boolean };
function routedFetch(rules: { url: string; method?: string; result: RouteResult | (() => RouteResult) }[]) {
  const fn = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method || "GET").toUpperCase();
    const rule = rules.find((r) => url.includes(r.url) && (!r.method || r.method === method));
    const res = rule ? (typeof rule.result === "function" ? rule.result() : rule.result) : { ok: false, status: 404, body: {} };
    if (res.throws) throw new Error("network error");
    const body = res.body ?? {};
    return {
      ok: res.ok !== false,
      status: res.status ?? (res.ok !== false ? 200 : 500),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const householdData = {
  id: 55,
  name: "Smith Household",
  householdMembers: [
    { id: 10, name: "Sam Smith", email: "sam@example.com", phone: "5125551234", dateOfBirth: "1980-01-01", isHouseholdLead: true },
    { id: 11, name: "Jamie Smith", email: "", dateOfBirth: "2012-05-01", isHouseholdLead: false },
  ],
  orgMembership: { status: "ACTIVE", memberSince: "2024-01-01T00:00:00.000Z", isVolunteer: false },
  line1: "123 Main St", line2: "", city: "Austin", state: "TX", postalCode: "78701",
};

function mockRoutes(overrides: Record<string, unknown | (() => unknown)> = {}) {
  return mockFetchJson({
    "/api/household/emergency-contacts": { contacts: [] },
    "/api/household/settings": {},
    "/api/household/member": {},
    "/api/household/lead": {},
    "/api/household": { household: householdData },
    ...overrides,
  });
}

describe("HouseholdPage", () => {
  pinTimezone();

  // memberSince is a calendar date at UTC midnight; a Jan 1 start read with a
  // local getFullYear() west of UTC reports the previous year.
  it("reads the memberSince year in UTC, not the viewer's local zone", async () => {
    setSession({ id: 10, email: "sam@example.com" });
    mockRoutes();
    renderWithProviders(<HouseholdPage />);

    expect(await screen.findByText("✓ Member since 2024")).toBeInTheDocument();
  });

  it("loads and renders household members", async () => {
    setSession({ id: 10, email: "sam@example.com" });
    mockRoutes();
    renderWithProviders(<HouseholdPage />);

    expect(await screen.findByRole("heading", { name: "Smith Household", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/Member since/)).toBeInTheDocument();
    expect(screen.getByText("Sam Smith")).toBeInTheDocument();
    expect(screen.getByText("Jamie Smith")).toBeInTheDocument();
    expect(screen.getByText("Household Lead")).toBeInTheDocument();
    expect(screen.getByText("No emergency contact on file. Add at least one.")).toBeInTheDocument();
  });

  it("adds a household member", async () => {
    setSession({ id: 10, email: "sam@example.com" });
    const fetchMock = mockRoutes();
    renderWithProviders(<HouseholdPage />);
    await screen.findByRole("heading", { name: "Smith Household", level: 1 });

    fireEvent.click(screen.getByRole("button", { name: "+ Add Household Member" }));
    expect(screen.getByText(/Printed on name badges exactly as typed/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Full Name"), { target: { value: "Robin Smith" } });
    fireEvent.click(screen.getByLabelText("Individual is over 25"));
    // Phone must be capturable on ADD, not only on a later edit.
    fireEvent.change(screen.getByLabelText("Phone (optional)"), { target: { value: "5125551234" } });
    // Allergies (safety data) must be capturable on ADD, not only on a later edit.
    fireEvent.change(screen.getByLabelText("Allergies (optional)"), { target: { value: "Bees" } });
    fireEvent.click(screen.getByRole("button", { name: "Save / Invite" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/household",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ memberName: "Robin Smith", memberEmail: "", memberDob: "", memberPhone: "5125551234", memberOver25: true, memberAllergies: "Bees" }),
        }),
      ),
    );
  });

  it("saves the household address", async () => {
    setSession({ id: 10, email: "sam@example.com" });
    const fetchMock = mockRoutes();
    renderWithProviders(<HouseholdPage />);
    await screen.findByRole("heading", { name: "Smith Household", level: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Save household details" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/household/settings",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    expectToast("Settings updated successfully!");
  });

  it("adds an emergency contact", async () => {
    setSession({ id: 10, email: "sam@example.com" });
    const fetchMock = mockRoutes();
    renderWithProviders(<HouseholdPage />);
    await screen.findByRole("heading", { name: "Smith Household", level: 1 });

    fireEvent.click(screen.getByRole("button", { name: "+ Add Contact" }));
    fireEvent.change(screen.getByLabelText("Contact Name"), { target: { value: "Pat Neighbor" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "5125559999" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Contact" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/household/emergency-contacts",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("prompts a lead to join when the household isn't a member yet", async () => {
    setSession({ id: 10, email: "sam@example.com" });
    mockRoutes({ "/api/household": { household: { ...householdData, orgMembership: null } } });
    renderWithProviders(<HouseholdPage />);
    await screen.findByRole("heading", { name: "Smith Household", level: 1 });

    expect(screen.getByText("Your household isn't a member yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Join the Treehouse!" }));
    expect(router.push).toHaveBeenCalledWith("/membership");
  });

  it("prompts a former member to renew (REVOKED)", async () => {
    setSession({ id: 10, email: "sam@example.com" });
    mockRoutes({ "/api/household": { household: { ...householdData, orgMembership: { status: "REVOKED" } } } });
    renderWithProviders(<HouseholdPage />);
    await screen.findByRole("heading", { name: "Smith Household", level: 1 });

    expect(screen.getByText("Renew your membership now!")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Renew!" }));
    expect(router.push).toHaveBeenCalledWith("/membership");
  });

  it("prompts an ACTIVE member to renew when a renewal is open", async () => {
    setSession({ id: 10, email: "sam@example.com" });
    mockRoutes({ "/api/membership/renewal-status": { renewalDue: true } });
    renderWithProviders(<HouseholdPage />);
    await screen.findByRole("heading", { name: "Smith Household", level: 1 });

    expect(await screen.findByText("Renew your membership now!")).toBeInTheDocument();
    expect(screen.queryByText(/Member since/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Renew!" }));
    expect(router.push).toHaveBeenCalledWith("/membership");
  });

  it("shows a volunteer-only badge when memberSince is absent", async () => {
    setSession({ id: 10, email: "sam@example.com" });
    mockRoutes({ "/api/household": { household: { ...householdData, orgMembership: { status: "ACTIVE", isVolunteer: true } } } });
    renderWithProviders(<HouseholdPage />);
    await screen.findByRole("heading", { name: "Smith Household", level: 1 });

    expect(screen.getByText("✓ Member")).toBeInTheDocument();
    expect(screen.getByText("Volunteer-only family")).toBeInTheDocument();
  });

  it("shows a fallback message when the household fails to load", async () => {
    setSession({ id: 10, email: "sam@example.com" });
    mockFetchJson({ "/api/household/emergency-contacts": { contacts: [] } }); // no /api/household route -> 404
    renderWithProviders(<HouseholdPage />);

    expect(await screen.findByText(/couldn't load your household/)).toBeInTheDocument();
  });

  it("shows a network-error message when the household fetch throws", async () => {
    setSession({ id: 10, email: "sam@example.com" });
    routedFetch([
      { url: "/api/household/emergency-contacts", result: { ok: true, body: { contacts: [] } } },
      { url: "/api/household", result: { throws: true } },
    ]);
    renderWithProviders(<HouseholdPage />);

    await waitFor(() => expectToast("Network error loading household."));
  });

  it("validates required fields, then adds a member and surfaces a contact-collision warning", async () => {
    setSession({ id: 10, email: "sam@example.com" });
    const fetchMock = routedFetch([
      { url: "/api/household/emergency-contacts", method: "GET", result: { ok: true, body: { contacts: [] } } },
      { url: "/api/household", method: "GET", result: { ok: true, body: { household: householdData } } },
      { url: "/api/household", method: "PATCH", result: { ok: true, body: { warning: { message: "Robin matches an existing emergency contact." } } } },
    ]);
    renderWithProviders(<HouseholdPage />);
    await screen.findByRole("heading", { name: "Smith Household", level: 1 });

    fireEvent.click(screen.getByRole("button", { name: "+ Add Household Member" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Full Name")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "+ Add Household Member" }));
    fireEvent.click(screen.getByRole("button", { name: "Save / Invite" }));
    expect(await screen.findByText("Name is required.")).toBeInTheDocument();
    expect(screen.getByText("Date of birth is required for anyone under 25.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Full Name"), { target: { value: "Robin Smith" } });
    fireEvent.change(screen.getByLabelText("Email (Optional)"), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "Save / Invite" }));
    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Date of birth is required for anyone under 25.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email (Optional)"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Date of Birth"), { target: { value: "2000-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Save / Invite" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/household", expect.objectContaining({ method: "PATCH" })),
    );
    expect(await screen.findByText("⚠️ Robin matches an existing emergency contact.")).toBeInTheDocument();
    // applyContactWarning drops the lead straight into the add-contact form.
    expect(screen.getByRole("button", { name: "Add Contact" })).toBeInTheDocument();
  });

  it("shows a server error and a network error when adding a member fails", async () => {
    setSession({ id: 10, email: "sam@example.com" });
    let attempt = 0;
    routedFetch([
      { url: "/api/household/emergency-contacts", method: "GET", result: { ok: true, body: { contacts: [] } } },
      { url: "/api/household", method: "GET", result: { ok: true, body: { household: householdData } } },
      {
        url: "/api/household", method: "PATCH",
        result: () => (attempt++ === 0 ? { ok: false, status: 400, body: { error: "Household is full." } } : { throws: true }),
      },
    ]);
    renderWithProviders(<HouseholdPage />);
    await screen.findByRole("heading", { name: "Smith Household", level: 1 });

    fireEvent.click(screen.getByRole("button", { name: "+ Add Household Member" }));
    fireEvent.change(screen.getByLabelText("Full Name"), { target: { value: "Robin Smith" } });
    fireEvent.click(screen.getByLabelText("Individual is over 25"));
    fireEvent.click(screen.getByRole("button", { name: "Save / Invite" }));
    expect(await screen.findByText("Household is full.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save / Invite" }));
    await waitFor(() => expectToast("Network error adding household member."));
  });

  it("edits a household member: cancels, validates, toggles the lead checkbox, and shows a lead-rejection warning", async () => {
    const editHousehold = {
      ...householdData,
      householdMembers: [
        { id: 10, name: "Sam Smith", email: "sam@example.com", phone: "5125551234", dateOfBirth: "1980-01-01", isHouseholdLead: true },
        { id: 12, name: "Casey Smith", email: "", isDeclaredAdult: true, isHouseholdLead: false },
      ],
    };
    setSession({ id: 10, email: "sam@example.com" });
    let attempt = 0;
    const fetchMock = routedFetch([
      { url: "/api/household/emergency-contacts", method: "GET", result: { ok: true, body: { contacts: [] } } },
      { url: "/api/household", method: "GET", result: { ok: true, body: { household: editHousehold } } },
      {
        url: "/api/household/member", method: "PATCH",
        result: () => (attempt++ === 0
          ? { ok: true, body: { leadRejection: "the household already has the maximum number of leads." } }
          : { ok: true, body: {} }),
      },
    ]);
    renderWithProviders(<HouseholdPage />);
    await screen.findByRole("heading", { name: "Smith Household", level: 1 });

    // Casey (non-lead, no dob, declared adult) -> Household Lead checkbox visible immediately.
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Household Lead")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    const nameInput = screen.getByLabelText("Name");
    fireEvent.change(nameInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Name is required.")).toBeInTheDocument();

    fireEvent.change(nameInput, { target: { value: "Casey Smith" } });
    fireEvent.click(screen.getByLabelText("Household Lead"));
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a valid 10-digit US phone number.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "5125559999" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/household/member",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ participantId: 12, name: "Casey Smith", nickname: "", email: "", dob: "", phone: "5125559999", isLead: true, over25: true, allergies: "" }),
        }),
      ),
    );
    expect(await screen.findByText(/Household member updated, but not added as a lead/)).toBeInTheDocument();

    // Self-edit: the Household Lead checkbox never applies to the viewer's own card.
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.queryByLabelText("Household Lead")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expectToast("Household member updated successfully!"));
  });

  // A member with a linked sign-in keeps their sign-in address: the field is locked
  // with how-to-change help, and the edit leaves email out of the PATCH body.
  describe("signed-in member email", () => {
    const signedInHousehold = {
      ...householdData,
      householdMembers: [
        { id: 10, name: "Sam Smith", email: "sam@example.com", phone: "5125551234", dateOfBirth: "1980-01-01", isHouseholdLead: true, hasSignIn: true },
        { id: 12, name: "Casey Smith", email: "", isDeclaredAdult: true, isHouseholdLead: false, hasSignIn: false },
      ],
    };

    it.each([
      ["Board <board@example.org>", "This is the address you sign in with. To change it, email the board at board@example.org."],
      [null, "This is the address you sign in with. To change it, contact the board."],
    ])("locks the email with help text (reply-to %p) and omits it on save", async (boardReplyTo, help) => {
      setSession({ id: 10, email: "sam@example.com" });
      const fetchMock = mockRoutes({ "/api/household": { household: signedInHousehold, boardReplyTo } });
      renderWithProviders(<HouseholdPage />);
      await screen.findByRole("heading", { name: "Smith Household", level: 1 });

      fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
      expect(screen.getByLabelText("Email")).toBeDisabled();
      expect(screen.getByText(help)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expectToast("Household member updated successfully!"));
      const [, patchOpts] = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/household/member" && init?.method === "PATCH")!;
      expect(JSON.parse(patchOpts!.body as string)).not.toHaveProperty("email");
    });

    it("leaves the email editable for a member without a sign-in", async () => {
      setSession({ id: 10, email: "sam@example.com" });
      mockRoutes({ "/api/household": { household: signedInHousehold, boardReplyTo: null } });
      renderWithProviders(<HouseholdPage />);
      await screen.findByRole("heading", { name: "Smith Household", level: 1 });

      fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
      expect(screen.getByLabelText("Email")).not.toBeDisabled();
      expect(screen.queryByText(/This is the address you sign in with/)).not.toBeInTheDocument();
    });
  });

  it("promotes a household member to lead, and shows a server error on failure", async () => {
    const leadHousehold = {
      ...householdData,
      householdMembers: [
        { id: 10, name: "Sam Smith", email: "sam@example.com", phone: "5125551234", dateOfBirth: "1980-01-01", isHouseholdLead: true },
        { id: 12, name: "Casey Smith", email: "", isDeclaredAdult: true, isHouseholdLead: false },
      ],
    };
    setSession({ id: 10, email: "sam@example.com" });
    let attempt = 0;
    const fetchMock = routedFetch([
      { url: "/api/household/emergency-contacts", method: "GET", result: { ok: true, body: { contacts: [] } } },
      { url: "/api/household", method: "GET", result: { ok: true, body: { household: leadHousehold } } },
      {
        url: "/api/household/lead", method: "POST",
        result: () => (attempt++ === 0 ? { ok: true, body: {} } : { ok: false, status: 400, body: { error: "Already a lead." } }),
      },
    ]);
    renderWithProviders(<HouseholdPage />);
    await screen.findByRole("heading", { name: "Smith Household", level: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Make Lead" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/household/lead",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ participantId: 12 }) }),
      ),
    );
    await waitFor(() => expectToast("Household member promoted to lead successfully!"));

    fireEvent.click(screen.getByRole("button", { name: "Make Lead" }));
    expect(await screen.findByText("Already a lead.")).toBeInTheDocument();
  });

  it("hides add-member controls for staff accounts and renders varied age badges", async () => {
    const variedHousehold = {
      ...householdData,
      householdMembers: [
        { id: 10, name: "Sam Smith", email: "sam@example.com", phone: "5125551234", dateOfBirth: "1980-01-01", isHouseholdLead: true }, // lead, adult via dob
        { id: 11, name: "Jamie Smith", email: "", dateOfBirth: "2012-05-01" }, // kid via dob
        { id: 13, name: "Alex Smith", email: "" }, // no dob, not declared -> Age Unavailable
        { id: 14, name: "Zoe Smith", email: "" }, // no dob, not declared -> both-no-dob sort branch
      ],
    };
    setSession({ id: 10, email: "sam@innovationtreehouse.org", hd: "innovationtreehouse.org" });
    mockRoutes({ "/api/household": { household: variedHousehold } });
    renderWithProviders(<HouseholdPage />);
    await screen.findByRole("heading", { name: "Smith Household", level: 1 });

    expect(screen.getAllByText("Age Unavailable")).toHaveLength(2);
    expect(screen.getByText("Adult")).toBeInTheDocument();
    expect(screen.getByText(/^Age \(/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Add Household Member" })).not.toBeInTheDocument();
  });

  it("blocks deleting the last valid emergency contact via a disabled Remove", async () => {
    setSession({ id: 10, email: "sam@example.com" });
    const fetchMock = mockRoutes({
      "/api/household/emergency-contacts": { contacts: [{ id: 1, name: "Pat Neighbor", phone: "5125551234", email: null, relationship: "Aunt", priority: 1, invalid: false }] },
    });
    renderWithProviders(<HouseholdPage />);
    await screen.findByRole("heading", { name: "Smith Household", level: 1 });

    // Last valid contact: Remove renders data-disabled and a click is a no-op.
    const removeBtn = screen.getByRole("button", { name: "Remove" });
    expect(removeBtn).toHaveAttribute("data-disabled");
    fireEvent.click(removeBtn);
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/emergency-contacts/1"), expect.objectContaining({ method: "DELETE" }));
  });

  it("deletes a non-last emergency contact and edits another", async () => {
    let contactsState = [
      { id: 1, name: "Pat Neighbor", phone: "5125551234", email: null, relationship: "Aunt", priority: 1, invalid: false },
      { id: 2, name: "Jess Friend", phone: "5125555678", email: "jess@example.com", relationship: null, priority: 2, invalid: false },
    ];
    setSession({ id: 10, email: "sam@example.com" });
    const fetchMock = routedFetch([
      { url: "/api/household/emergency-contacts/2", method: "DELETE", result: () => { contactsState = contactsState.filter((c) => c.id !== 2); return { ok: true, body: {} }; } },
      { url: "/api/household/emergency-contacts/1", method: "PATCH", result: { ok: true, body: {} } },
      { url: "/api/household/emergency-contacts", method: "GET", result: () => ({ ok: true, body: { contacts: contactsState } }) },
      { url: "/api/household", method: "GET", result: { ok: true, body: { household: householdData } } },
    ]);
    renderWithProviders(<HouseholdPage />);
    await screen.findByRole("heading", { name: "Smith Household", level: 1 });
    await screen.findByText("Jess Friend");

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/household/emergency-contacts/2", expect.objectContaining({ method: "DELETE" })),
    );
    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Emergency contact removed." })));
    await waitFor(() => expect(screen.queryByText("Jess Friend")).not.toBeInTheDocument());

    const editButtons = screen.getAllByRole("button", { name: "Edit" });
    fireEvent.click(editButtons[editButtons.length - 1]); // Pat's contact-edit button (the only contact left, renders after any household-member edits)
    expect(screen.getByRole("button", { name: "Save Contact" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Contact" }));
    expect(await screen.findByText("Enter a valid 10-digit US phone number.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "5125551234" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Contact" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/household/emergency-contacts/1", expect.objectContaining({ method: "PATCH" })),
    );
    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Emergency contact updated." })));
  });

  it("shows a dismissible contact server error, and validates/cancels the contact form", async () => {
    setSession({ id: 10, email: "sam@example.com" });
    routedFetch([
      { url: "/api/household/emergency-contacts", method: "GET", result: { ok: true, body: { contacts: [] } } },
      { url: "/api/household/emergency-contacts", method: "POST", result: { ok: false, status: 400, body: { error: "Duplicate contact." } } },
      { url: "/api/household", method: "GET", result: { ok: true, body: { household: householdData } } },
    ]);
    renderWithProviders(<HouseholdPage />);
    await screen.findByRole("heading", { name: "Smith Household", level: 1 });

    fireEvent.click(screen.getByRole("button", { name: "+ Add Contact" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Contact Name")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "+ Add Contact" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Contact" }));
    expect(await screen.findByText("Name is required.")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid 10-digit US phone number.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Contact Name"), { target: { value: "Lee Cousin" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "5125550000" } });
    fireEvent.change(screen.getByLabelText("Email (optional)"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Contact" }));
    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email (optional)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Contact" }));
    expect(await screen.findByText("Duplicate contact.")).toBeInTheDocument();

    const closeBtn = document.querySelector('button[class*="CloseButton"]');
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn!);
    expect(screen.queryByText("Duplicate contact.")).not.toBeInTheDocument();
  });

  // ── Remaining server-error and network-error branches, one write route per
  //    test ───────────────────────────────────────────────────────────────────
  // Casey is a promotable non-lead adult; two contacts on file so either row's
  // Remove is enabled (the last valid contact's is not).
  const failureHousehold = { ...householdData, householdMembers: [...householdData.householdMembers, { id: 12, name: "Casey Smith", email: "", isDeclaredAdult: true }] };
  const failureLoadRules = [
    { url: "/api/household/emergency-contacts", method: "GET", result: { ok: true, body: { contacts: [
      { id: 9, name: "Old Contact", phone: "5125550000", email: null, relationship: null, priority: 1, invalid: false },
      { id: 8, name: "Backup Contact", phone: "5125550001", email: null, relationship: null, priority: 2, invalid: false },
    ] } } },
    { url: "/api/household", method: "GET", result: { ok: true, body: { household: failureHousehold } } },
  ];

  /** Render the loaded page as its lead, with `rules` layered over the GET routes. */
  async function renderWithFailingRoutes(rules: Parameters<typeof routedFetch>[0]) {
    setSession({ id: 10, email: "sam@example.com" });
    const fetchMock = routedFetch([...rules, ...failureLoadRules]);
    renderWithProviders(<HouseholdPage />);
    await screen.findByRole("heading", { name: "Smith Household", level: 1 });
    return fetchMock;
  }

  it("surfaces client-validation, server, and network failures when saving the address", async () => {
    let attempt = 0;
    await renderWithFailingRoutes([
      { url: "/api/household/settings", method: "PATCH", result: () => (attempt++ === 0 ? { ok: false, status: 400, body: {} } : { throws: true }) },
    ]);

    fireEvent.change(screen.getByLabelText(/Street Address/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save household details" }));
    expect(await screen.findByText("Street address is required.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Street Address/), { target: { value: "123 Main St" } });
    fireEvent.click(screen.getByRole("button", { name: "Save household details" }));
    expect(await screen.findByText("Failed to update some settings.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save household details" }));
    await waitFor(() => expectToast("Network error saving settings."));
  });

  it("toasts a network failure when adding an emergency contact", async () => {
    await renderWithFailingRoutes([
      { url: "/api/household/emergency-contacts", method: "POST", result: { throws: true } },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "+ Add Contact" }));
    fireEvent.change(screen.getByLabelText("Contact Name"), { target: { value: "New Contact" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "5125559000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Contact" }));

    await waitFor(() => expectToast("Network error saving emergency contact."));
  });

  it("surfaces server and network failures when removing an emergency contact", async () => {
    let attempt = 0;
    await renderWithFailingRoutes([
      { url: "/api/household/emergency-contacts/9", method: "DELETE", result: () => (attempt++ === 0 ? { ok: false, status: 400, body: { error: "Contact not found." } } : { throws: true }) },
    ]);

    // Same row both times — the failed delete leaves it on the list.
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    expect(await screen.findByText("Contact not found.")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    await waitFor(() => expectToast("Network error removing emergency contact."));
  });

  it("surfaces server and network failures when editing a household member", async () => {
    let attempt = 0;
    await renderWithFailingRoutes([
      { url: "/api/household/member", method: "PATCH", result: () => (attempt++ === 0 ? { ok: false, status: 400, body: { error: "Update rejected." } } : { throws: true }) },
    ]);

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Update rejected.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expectToast("Network error updating household member."));
  });

  it("toasts a network failure when promoting a household member to lead", async () => {
    const fetchMock = await renderWithFailingRoutes([
      { url: "/api/household/lead", method: "POST", result: { throws: true } },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Make Lead" }));

    await waitFor(() => expectToast("Network error promoting household member."));
    expect(fetchMock).toHaveBeenCalledWith("/api/household/lead", expect.objectContaining({ method: "POST" }));
  });
});
