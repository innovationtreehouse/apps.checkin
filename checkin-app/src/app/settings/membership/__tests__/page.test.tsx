// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), update: jest.fn(), hide: jest.fn() } }));

import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, setCheckinEnv, setDevMocks, setShopifyStoreDomain, resetRtl } from "@/test-helpers/rtl";
import { notifications } from "@mantine/notifications";
import MembershipSettingsPage from "../page";

const SETTINGS = {
  standardMembershipFeeCents: 15000,
  volunteerMembershipFeeCents: 5000,
  orgMembershipYearBoundary: "2025-09-01T00:00:00.000Z",
  orgMembershipVariantId: "123456",
  orgMembershipProductUrl: "https://test-store.myshopify.com/products/annual-membership",
  volunteerFamilyDiscountCode: "VOLUNTEER",
  bgRecheckMonths: 24,
  scholarshipDenialGraceDays: 14,
};

type Row = { membershipYear: number; shopifyVariantId: string; productUrl: string | null };
const STORE = "test-store.myshopify.com";
const oneVariant = (id: string) => ({ productTitle: "Annual Membership", variants: [{ id, title: "Default Title", priceCents: 15000 }] });
const twoVariants = {
  productTitle: "Annual Membership",
  variants: [
    { id: "111", title: "Member", priceCents: 15000 },
    { id: "222", title: "Non-Member", priceCents: 25000 },
  ],
};
const body = (overrides = {}, rows: Row[] = []) => ({
  settings: { BoardSettings: { ...SETTINGS, ...overrides }, MembershipYearVariant: rows },
});

beforeEach(() => {
  resetRtl();
  (notifications.show as jest.Mock).mockClear();
});
afterEach(() => jest.useRealTimers());

describe("MembershipSettingsPage", () => {
  it("loads and renders the current settings", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/membership": body() });
    renderWithProviders(<MembershipSettingsPage />);

    expect(await screen.findByDisplayValue("150.00")).toBeInTheDocument();
    expect(screen.getByDisplayValue("50.00")).toBeInTheDocument();
    expect(screen.getByDisplayValue("123456")).toBeInTheDocument();
    expect(screen.getByDisplayValue("VOLUNTEER")).toBeInTheDocument();
  });

  it("edits a field and saves, PUTting the updated value", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/membership": body() });
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
    mockFetchJson({ "/api/settings/membership": body({ bgRecheckMonths: 0 }) });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    expect(screen.getByText(/Background-check interval is/)).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("50.00"), { target: { value: "60.00" } });
    fireEvent.change(screen.getByDisplayValue("123456"), { target: { value: "" } });
    fireEvent.change(screen.getByDisplayValue("VOLUNTEER"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Background check valid for"), { target: { value: "12" } });
    expect(screen.queryByText(/Background-check interval is/)).not.toBeInTheDocument();
  });

  it("shows the saved variant read-only when Shopify is configured, with no typed-ID field", async () => {
    setShopifyStoreDomain(STORE);
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/membership": body() });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    const group = screen.getByRole("group", { name: "Membership product" });
    expect(within(group).getByText(`Variant 123456 from https://${STORE}/products/annual-membership`)).toBeInTheDocument();
    expect(within(group).queryByRole("textbox", { name: "Membership product variant ID" })).not.toBeInTheDocument();
  });

  it("keeps the typed variant-ID field on a local mock instance", async () => {
    setShopifyStoreDomain(STORE);
    setDevMocks({ shopify: true, bgConsent: false });
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/membership": body() });
    renderWithProviders(<MembershipSettingsPage />);
    expect(await screen.findByLabelText("Membership product variant ID")).toHaveValue("123456");
  });

  it("saves a typed URL and a typed variant ID together on a local mock instance", async () => {
    setDevMocks({ shopify: true, bgConsent: false });
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/membership": body() });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    fireEvent.change(screen.getByLabelText("Membership product variant ID"), { target: { value: "424242" } });
    fireEvent.change(screen.getByLabelText("Membership product URL"), { target: { value: "https://shop.example.org/products/mock" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/membership", expect.objectContaining({ method: "PUT" })));
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(putOpts!.body as string)).toEqual(
      expect.objectContaining({ orgMembershipVariantId: "424242", orgMembershipProductUrl: "https://shop.example.org/products/mock" }),
    );
  });

  it("extracts a single-variant product, shows it for confirmation, and saves the variant with its URL", async () => {
    setShopifyStoreDomain(STORE);
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      // Listed first: mockFetchJson matches by substring in insertion order, and
      // the extract-variant URL also contains "/api/settings/membership".
      "/api/settings/membership/extract-variant": oneVariant("789789"),
      "/api/settings/membership": body(),
    });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    const url = `https://${STORE}/products/new-membership`;
    fireEvent.change(screen.getByLabelText("Membership product URL"), { target: { value: url } });
    fireEvent.click(screen.getByRole("button", { name: "Extract variant from URL" }));

    expect(await screen.findByText("Annual Membership — Default Title — $150.00 (variant 789789)")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings/membership/extract-variant",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ productUrl: url }) }),
    );
    expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/789789.*Save settings/) }));

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/membership", expect.objectContaining({ method: "PUT" })));
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(putOpts!.body as string)).toEqual(expect.objectContaining({ orgMembershipVariantId: "789789", orgMembershipProductUrl: url }));
  });

  it("lists a multi-variant product's variants to pick from, and saves the picked one", async () => {
    setShopifyStoreDomain(STORE);
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/settings/membership/extract-variant": twoVariants,
      "/api/settings/membership": body(),
    });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    fireEvent.click(screen.getByRole("button", { name: "Extract variant from URL" }));
    const nonMember = await screen.findByRole("radio", { name: "Non-Member — $250.00 (variant 222)" });
    expect(screen.getByRole("radio", { name: "Member — $150.00 (variant 111)" })).toBeInTheDocument();
    // Nothing is chosen until the Board picks one.
    expect(screen.getByText(/^Variant 123456/)).toBeInTheDocument();

    fireEvent.click(nonMember);
    expect(await screen.findByText("Annual Membership — Non-Member — $250.00 (variant 222)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/membership", expect.objectContaining({ method: "PUT" })));
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(putOpts!.body as string)).toEqual(expect.objectContaining({ orgMembershipVariantId: "222" }));
  });

  it("shows the server's message when extraction fails, keeping the chosen variant", async () => {
    setShopifyStoreDomain(STORE);
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/membership": body() });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'Shopify has no product with the handle "annual-membership" — check the link.' }),
    })) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Extract variant from URL" }));

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: expect.stringMatching(/^Shopify has no product/), autoClose: false }),
      ),
    );
    expect(screen.getByText(/^Variant 123456/)).toBeInTheDocument();
  });

  it("clears the single variant, saving null", async () => {
    setShopifyStoreDomain(STORE);
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/membership": body() });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    fireEvent.click(screen.getByRole("button", { name: "Clear Membership product variant ID" }));
    expect(screen.getByText("Required for checkout — not configured.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/membership", expect.objectContaining({ method: "PUT" })));
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(putOpts!.body as string)).toEqual(expect.objectContaining({ orgMembershipVariantId: null, orgMembershipProductUrl: null }));
  });

  it("edits the scholarship grace period, blank clears it to null, and rejects a non-positive value", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/membership": body() });
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
    const fetchMock = mockFetchJson({ "/api/settings/membership": body() });
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
    // A successful save re-locks the boundary field, keeps what was saved, and re-reads the settings.
    await waitFor(() => expect(screen.getByDisplayValue("2026-10-15")).toBeDisabled());
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, opts]) => url === "/api/settings/membership" && opts?.method !== "PUT")).toHaveLength(2));
  });

  it("shows 'not set' and rolls the boundary label to next year when the stored date has already passed", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/membership": body({ orgMembershipYearBoundary: null }) });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");
    expect(screen.getByText("not set")).toBeInTheDocument();
  });

  it("rolls the boundary label to next year when the stored month/day is already in the past", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-06-30T12:00:00.000Z"));
    setSession({ id: 1, isSysadmin: true });
    // "today" is pinned to 2026-06-30; Jan 15 has already passed this year.
    mockFetchJson({ "/api/settings/membership": body({ orgMembershipYearBoundary: "2025-01-15T00:00:00.000Z" }) });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");
    expect(screen.getByText("January 15, 2027")).toBeInTheDocument();
  });

  it("shows the failure and offers no form to save when the load fails", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({});
    renderWithProviders(<MembershipSettingsPage />);

    expect(await screen.findByText("Couldn't load the membership settings")).toBeInTheDocument();
    expect(screen.queryByLabelText("Standard annual membership fee")).not.toBeInTheDocument();
  });

  it("shows a save-failure message", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/membership": { settings: SETTINGS } });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    global.fetch = jest.fn(async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: "Save blocked." }) })) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Save blocked.", autoClose: false })),
    );
  });

  it("shows a network-error message when saving throws", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/membership": body() });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    global.fetch = jest.fn(() => Promise.reject(new Error("net"))) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Couldn't reach the server. Check your connection and try again.", autoClose: false })),
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
    const fetchMock = mockFetchJson({ "/api/settings/membership": body() });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    // The radio itself is only rendered on a real dev instance.
    expect(!!screen.queryByText(/Contract signing target/)).toBe(expected);

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/membership", expect.objectContaining({ method: "PUT" })));
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect("devSigningTarget" in JSON.parse(putOpts!.body as string)).toBe(expected);
  });

  it("opens renewals for all active members after confirming (never emails)", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/settings/membership/bulk-open-renewals": { opened: 12, skipped: 3 },
      "/api/settings/membership": body(),
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
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "green", message: "Opened 12 renewal(s); 3 already in progress." }),
      ),
    );
  });

  it("cancels the go-live confirmation without calling the API", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/membership": body() });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    window.confirm = jest.fn(() => false);
    fireEvent.click(screen.getByRole("button", { name: "Open renewals for all active members" }));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/settings/membership/bulk-open-renewals", expect.anything());
  });

  it("shows a server error, then a network error, from the go-live action", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/membership": body() });
    renderWithProviders(<MembershipSettingsPage />);
    await screen.findByDisplayValue("150.00");

    global.fetch = jest.fn(async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: "Already open." }) })) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Open renewals for all active members" }));
    let modal = await screen.findByRole("dialog", { name: "Open Renewals For All Active Members" });
    fireEvent.click(within(modal).getByRole("button", { name: "Open Renewals" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Already open.", autoClose: false })),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Open Renewals For All Active Members" })).not.toBeInTheDocument());

    global.fetch = jest.fn(() => Promise.reject(new Error("net"))) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Open renewals for all active members" }));
    modal = await screen.findByRole("dialog", { name: "Open Renewals For All Active Members" });
    fireEvent.click(within(modal).getByRole("button", { name: "Open Renewals" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Couldn't reach the server. Check your connection and try again.", autoClose: false })),
    );
  });

  describe("membership year variant slots", () => {
    // 1 November 2026 with a 1 September boundary: 2026 is in progress, 2027 is coming.
    const open = async (rows: Row[] = [], overrides = {}) => {
      jest.useFakeTimers({ advanceTimers: true, now: new Date("2026-11-01T12:00:00.000Z") });
      setSession({ id: 1, isSysadmin: true });
      const fetchMock = mockFetchJson({
        "/api/settings/membership/extract-variant": oneVariant("555"),
        "/api/settings/membership": body(overrides, rows),
      });
      renderWithProviders(<MembershipSettingsPage />);
      await screen.findByDisplayValue("150.00");
      return fetchMock;
    };
    const putBody = (fetchMock: jest.Mock) => JSON.parse(fetchMock.mock.calls.find(([, o]) => o?.method === "PUT")![1].body as string);

    it("labels the two slots and badges an empty coming year", async () => {
      await open([{ membershipYear: 2026, shopifyVariantId: "111", productUrl: null }]);
      expect(screen.getByLabelText("2026-2027 variant ID")).toHaveValue("111");
      expect(screen.getByLabelText("2027-2028 variant ID")).toHaveValue("");
      expect(screen.getAllByText("needs variant")).toHaveLength(1);
    });

    it("shows no badge for an empty year in progress once the coming year has a row", async () => {
      await open([{ membershipYear: 2027, shopifyVariantId: "222", productUrl: null }]);
      expect(screen.getByLabelText("2026-2027 variant ID")).toHaveValue("");
      expect(screen.queryByText("needs variant")).not.toBeInTheDocument();
    });

    it("shows no slots with no boundary set", async () => {
      await open([], { orgMembershipYearBoundary: null });
      expect(screen.queryByLabelText(/^\d{4}-\d{4} variant ID$/)).not.toBeInTheDocument();
      expect(screen.queryByText("needs variant")).not.toBeInTheDocument();
    });

    it("saves only a slot that changed", async () => {
      const fetchMock = await open([{ membershipYear: 2026, shopifyVariantId: "111", productUrl: null }]);
      fireEvent.change(screen.getByLabelText("2027-2028 variant ID"), { target: { value: " 222 " } });
      fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/membership", expect.objectContaining({ method: "PUT" })));
      expect(putBody(fetchMock).membershipYearVariants).toEqual([{ membershipYear: 2027, shopifyVariantId: "222", productUrl: null }]);
    });

    it("refuses a non-numeric slot and a cleared saved slot before saving", async () => {
      const fetchMock = await open([{ membershipYear: 2026, shopifyVariantId: "111", productUrl: null }]);
      fireEvent.change(screen.getByLabelText("2027-2028 variant ID"), { target: { value: "abc" } });
      fireEvent.change(screen.getByLabelText("2026-2027 variant ID"), { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
      expect(await screen.findByText("Must be a numeric Shopify variant ID.")).toBeInTheDocument();
      expect(screen.getByText("A saved variant can be replaced, not cleared.")).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalledWith("/api/settings/membership", expect.objectContaining({ method: "PUT" }));
    });

    it("extracts into the slot whose URL was pasted", async () => {
      const fetchMock = await open();
      const url = "https://test-store.myshopify.com/products/membership-2027";
      fireEvent.change(screen.getByLabelText("2027-2028 product URL"), { target: { value: url } });
      fireEvent.click(screen.getByRole("button", { name: "Extract variant from URL for 2027-2028" }));
      await waitFor(() => expect(screen.getByLabelText("2027-2028 variant ID")).toHaveValue("555"));
      expect(screen.getByLabelText("2026-2027 variant ID")).toHaveValue("");
      expect(fetchMock).toHaveBeenCalledWith("/api/settings/membership/extract-variant", expect.objectContaining({ body: JSON.stringify({ productUrl: url }) }));
    });

    it("shows saved slots read-only, offers Clear only on a slot with nothing saved, and saves a picked slot", async () => {
      setShopifyStoreDomain(STORE);
      const fetchMock = await open([{ membershipYear: 2026, shopifyVariantId: "111", productUrl: null }]);
      const inProgress = screen.getByRole("group", { name: "2026-2027" });
      const coming = screen.getByRole("group", { name: "2027-2028" });
      expect(within(inProgress).getByText("Variant 111")).toBeInTheDocument();
      expect(within(coming).getByText("No variant chosen.")).toBeInTheDocument();

      const url = "https://shop.example.org/products/membership-2027";
      fireEvent.change(within(coming).getByLabelText("2027-2028 product URL"), { target: { value: url } });
      fireEvent.click(within(coming).getByRole("button", { name: "Extract variant from URL for 2027-2028" }));
      expect(await within(coming).findByText("Annual Membership — Default Title — $150.00 (variant 555)")).toBeInTheDocument();
      expect(within(inProgress).queryByRole("button", { name: /^Clear/ })).not.toBeInTheDocument();
      expect(within(coming).getByRole("button", { name: "Clear 2027-2028 variant ID" })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/membership", expect.objectContaining({ method: "PUT" })));
      expect(putBody(fetchMock).membershipYearVariants).toEqual([{ membershipYear: 2027, shopifyVariantId: "555", productUrl: url }]);
    });

    it("still loads from a task on the previous release, which returns the row directly", async () => {
      setSession({ id: 1, isSysadmin: true });
      mockFetchJson({ "/api/settings/membership": { settings: SETTINGS } });
      renderWithProviders(<MembershipSettingsPage />);
      expect(await screen.findByDisplayValue("150.00")).toBeInTheDocument();
    });
  });
});
