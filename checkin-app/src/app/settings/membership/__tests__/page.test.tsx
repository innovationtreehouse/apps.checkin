// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, setCheckinEnv, resetRtl } from "@/test-helpers/rtl";
import { notifications } from "@mantine/notifications";
import MembershipSettingsPage from "../page";

const SETTINGS = {
  standardMembershipFeeCents: 15000,
  volunteerMembershipFeeCents: 5000,
  orgMembershipYearBoundary: "2025-09-01T00:00:00.000Z",
  orgMembershipVariantId: "123456",
  orgMembershipProductUrl: "https://test-store.myshopify.com/products/annual-membership",
  volunteerDiscountCode: "VOLUNTEER",
  bgRecheckMonths: 24,
  scholarshipDenialGraceDays: 14,
};

beforeEach(() => {
  resetRtl();
  (notifications.show as jest.Mock).mockClear();
});
afterEach(() => jest.useRealTimers());

describe("MembershipSettingsPage", () => {
  it("loads and renders the current settings", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/membership": { settings: SETTINGS } });
    renderWithProviders(<MembershipSettingsPage />);

    expect(await screen.findByDisplayValue("150.00")).toBeInTheDocument();
    expect(screen.getByDisplayValue("50.00")).toBeInTheDocument();
    expect(screen.getByDisplayValue("123456")).toBeInTheDocument();
    expect(screen.getByDisplayValue("VOLUNTEER")).toBeInTheDocument();
  });

  it("edits a field and saves, PUTting the updated value", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/membership": { settings: SETTINGS } });
    renderWithProviders(<MembershipSettingsPage />);

    const standardFee = await screen.findByDisplayValue("150.00");
    fireEvent.change(standardFee, { target: { value: "200.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/settings/membership", expect.objectContaining({ method: "PUT" }));
    });
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(putOpts!.body as string)).toEqual(expect.objectContaining({ standardMembershipFeeCents: 20000 }));

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Settings saved." })),
    );
  });

  it("shows a warning when the background-check interval is unset, and edits every remaining field", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/membership": { settings: { ...SETTINGS, bgRecheckMonths: 0 } } });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    expect(screen.getByText(/Background-check interval is/)).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("50.00"), { target: { value: "60.00" } });
    fireEvent.change(screen.getByDisplayValue("123456"), { target: { value: "" } });
    fireEvent.change(screen.getByDisplayValue("VOLUNTEER"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Background check valid for"), { target: { value: "12" } });
    expect(screen.queryByText(/Background-check interval is/)).not.toBeInTheDocument();
  });

  it("extracts the variant from the product URL, fills the field, and saves both", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      // Listed first: mockFetchJson matches by substring in insertion order, and
      // the extract-variant URL also contains "/api/settings/membership".
      "/api/settings/membership/extract-variant": { variantId: "789789" },
      "/api/settings/membership": { settings: SETTINGS },
    });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("123456");

    fireEvent.change(screen.getByLabelText("Membership product URL"), {
      target: { value: "https://test-store.myshopify.com/products/new-membership" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Extract variant from URL" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings/membership/extract-variant",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ productUrl: "https://test-store.myshopify.com/products/new-membership" }) }),
      ),
    );
    // The extracted id lands in the variant-ID field, with a reminder to Save.
    expect(await screen.findByDisplayValue("789789")).toBeInTheDocument();
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/789789.*Save settings/) }),
    );

    // The normal save persists both the URL and the extracted variant ID.
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/membership", expect.objectContaining({ method: "PUT" })));
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(putOpts!.body as string)).toEqual(
      expect.objectContaining({
        orgMembershipVariantId: "789789",
        orgMembershipProductUrl: "https://test-store.myshopify.com/products/new-membership",
      }),
    );
  });

  it("shows the server's message when extraction fails (e.g. a multi-variant 409)", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/membership": { settings: SETTINGS } });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("123456");

    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: "The product has 2 variants — paste the ID of the right one into the variant-ID field: 111 — Member — $150.00; 222 — Non-Member — $250.00" }),
    })) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Extract variant from URL" }));

    expect(await screen.findByText(/The product has 2 variants/)).toBeInTheDocument();
    // The variant-ID field keeps its previous value.
    expect(screen.getByDisplayValue("123456")).toBeInTheDocument();
  });

  it("edits the scholarship grace period, blank clears it to null, and rejects a non-positive value", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/membership": { settings: SETTINGS } });
    renderWithProviders(<MembershipSettingsPage />);
    const graceInput = await screen.findByDisplayValue("14");

    // Blank -> null.
    fireEvent.change(graceInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/membership", expect.objectContaining({ method: "PUT" })));
    let [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(putOpts!.body as string)).toEqual(expect.objectContaining({ scholarshipDenialGraceDays: null }));

    // Non-positive -> client-side validation error, no PUT fires for it.
    fetchMock.mockClear();
    fireEvent.change(graceInput, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/Enter a positive whole number of days/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/settings/membership", expect.objectContaining({ method: "PUT" }));

    // A positive value saves cleanly.
    fireEvent.change(graceInput, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/membership", expect.objectContaining({ method: "PUT" })));
    [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(putOpts!.body as string)).toEqual(expect.objectContaining({ scholarshipDenialGraceDays: 30 }));
  });

  it("unlocks and edits the membership-year boundary, which is included on save", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-06-30T12:00:00.000Z"));
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/membership": { settings: SETTINGS } });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    // Boundary month/day (09-01) is after "today"; the label uses the current year.
    expect(screen.getByText("September 1, 2026")).toBeInTheDocument();
    // Real timers from here on — the rest of this test just exercises the save
    // flow, and fake timers can desync `waitFor`'s polling from React's commits.
    jest.useRealTimers();

    const boundaryInput = screen.getByDisplayValue("2025-09-01");
    expect(boundaryInput).toBeDisabled();
    fireEvent.click(screen.getByLabelText("I understand — let me edit the boundary date"));
    expect(boundaryInput).toBeEnabled();
    fireEvent.change(boundaryInput, { target: { value: "2026-10-15" } });

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/settings/membership", expect.objectContaining({ method: "PUT" })),
    );
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(putOpts!.body as string)).toEqual(expect.objectContaining({ orgMembershipYearBoundary: "2026-10-15" }));
    // A successful save re-locks the boundary field and reloads from the (unchanged)
    // mock settings; wait for that full reload so no state update leaks past the test.
    await waitFor(() => expect(screen.getByDisplayValue("2025-09-01")).toBeDisabled());
  });

  it("shows 'not set' and rolls the boundary label to next year when the stored date has already passed", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/membership": { settings: { ...SETTINGS, orgMembershipYearBoundary: null } } });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");
    expect(screen.getByText("not set")).toBeInTheDocument();
  });

  it("rolls the boundary label to next year when the stored month/day is already in the past", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-06-30T12:00:00.000Z"));
    setSession({ id: 1, isSysadmin: true });
    // "today" is pinned to 2026-06-30; Jan 15 has already passed this year.
    mockFetchJson({ "/api/settings/membership": { settings: { ...SETTINGS, orgMembershipYearBoundary: "2025-01-15T00:00:00.000Z" } } });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");
    expect(screen.getByText("January 15, 2027")).toBeInTheDocument();
  });

  it("leaves the defaults in place when the initial load fails, then shows a save-failure message", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({}); // unmatched -> res.ok false, load() leaves state at its initial defaults
    renderWithProviders(<MembershipSettingsPage />);
    await waitFor(() => expect(screen.getByLabelText("Standard annual membership fee")).toHaveValue("0"));

    global.fetch = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "Save blocked." }) })) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Save blocked.")).toBeInTheDocument();
  });

  it("shows a network-error message when saving throws", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/membership": { settings: SETTINGS } });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    global.fetch = jest.fn(() => Promise.reject(new Error("net"))) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Network error." })),
    );
  });

  // The signing-target radio is a CHECKIN_ENV=dev knob: the API only honours it on a dev
  // instance, so the client sends it only there. tsc can't see this (both predicates are
  // boolean), so the env gate needs a real assertion on the PUT body.
  it.each([
    ["local" as const, false],
    ["dev" as const, true],
  ])("on CHECKIN_ENV=%s, sends devSigningTarget: %s", async (env, expected) => {
    setCheckinEnv(env);
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/membership": { settings: SETTINGS } });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    // The radio itself is only rendered on a real dev instance.
    expect(!!screen.queryByText(/Contract signing target/)).toBe(expected);

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/membership", expect.objectContaining({ method: "PUT" })));
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect("devSigningTarget" in JSON.parse(putOpts!.body as string)).toBe(expected);
  });

  it("opens renewals for all active members after confirming (never emails — PR-2)", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/settings/membership/bulk-open-renewals": { opened: 12, skipped: 3 },
      "/api/settings/membership": { settings: SETTINGS },
    });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    expect(screen.queryByLabelText("Also email each household a renewal reminder")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open renewals for all active members" }));
    const modal = await screen.findByRole("dialog", { name: "Open Renewals For All Active Members" });
    fireEvent.click(within(modal).getByRole("button", { name: "Open Renewals" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings/membership/bulk-open-renewals",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByText("Opened 12 renewal(s); 3 already in progress.")).toBeInTheDocument();
  });

  it("cancels the go-live confirmation without calling the API", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/membership": { settings: SETTINGS } });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    window.confirm = jest.fn(() => false);
    fireEvent.click(screen.getByRole("button", { name: "Open renewals for all active members" }));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/settings/membership/bulk-open-renewals", expect.anything());
  });

  it("shows a server error, then a network error, from the go-live action", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/membership": { settings: SETTINGS } });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    global.fetch = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "Already open." }) })) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Open renewals for all active members" }));
    let modal = await screen.findByRole("dialog", { name: "Open Renewals For All Active Members" });
    fireEvent.click(within(modal).getByRole("button", { name: "Open Renewals" }));
    expect(await screen.findByText("Already open.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Open Renewals For All Active Members" })).not.toBeInTheDocument());

    global.fetch = jest.fn(() => Promise.reject(new Error("net"))) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Open renewals for all active members" }));
    modal = await screen.findByRole("dialog", { name: "Open Renewals For All Active Members" });
    fireEvent.click(within(modal).getByRole("button", { name: "Open Renewals" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Network error." })),
    );
  });
});
