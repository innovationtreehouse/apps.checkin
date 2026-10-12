// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, fireEvent, waitFor } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { renderWithProviders, mockFetchJson, setSession, setCheckinEnv, resetRtl } from "@/test-helpers/rtl";
import MembershipPage from "../page";

beforeEach(() => { resetRtl(); sessionStorage.clear(); (notifications.show as jest.Mock).mockClear(); });
afterEach(() => window.history.pushState({}, "", "/"));

const emptyPrefill = { household: null, primaryParent: null, secondaryParent: null, children: [] };

function state(overrides: Record<string, unknown>) {
  return {
    hasHousehold: false,
    isLead: true,
    membershipStatus: null,
    process: null,
    external: null,
    prefill: emptyPrefill,
    ...overrides,
  };
}

describe("membership page", () => {
  it("prompts sign-in when unauthenticated", async () => {
    renderWithProviders(<MembershipPage />);
    expect(await screen.findByText("Join the Treehouse")).toBeInTheDocument();
  });

  it("shows the active-member card when there's no process and membership is active", async () => {
    setSession({ id: 1 });
    mockFetchJson({ "/api/membership": state({ membershipStatus: "ACTIVE" }) });
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByText("You're a member 🎉", { exact: false })).toBeInTheDocument();
  });

  it("starts an application from the become-a-member card", async () => {
    setSession({ id: 1 });
    const fetchMock = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return { ok: true, json: async () => ({ state: state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }) }) } as Response;
      }
      return { ok: true, json: async () => state({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<MembershipPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Start application" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/membership", expect.objectContaining({ method: "POST" })),
    );
    expect(await screen.findByText("Your household")).toBeInTheDocument();
  });

  it("hides the Start button and shows a note for a non-lead member", async () => {
    setSession({ id: 2 });
    mockFetchJson({ "/api/membership": state({ isLead: false }) });
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByText("Only a household lead can start the membership application.", { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start application" })).not.toBeInTheDocument();
  });

  it("fills the intake form and saves progress", async () => {
    setSession({ id: 1 });
    const fetchMock = mockFetchJson({
      "/api/membership/intake": { state: state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }), rejections: [] },
      "/api/membership": state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }),
    });
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Your household");

    expect(screen.getAllByText(/Printed on name badges exactly as typed/).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByPlaceholderText("123 Main St"), { target: { value: "1 Treehouse Ln" } });
    fireEvent.change(screen.getByLabelText("City", { exact: false }), { target: { value: "Austin" } });
    fireEvent.change(screen.getByLabelText("State", { exact: false }), { target: { value: "TX" } });
    fireEvent.change(screen.getByLabelText("ZIP", { exact: false }), { target: { value: "78701" } });
    fireEvent.change(screen.getByLabelText(/Emergency contact name/), { target: { value: "Aunt Jo" } });
    fireEvent.change(screen.getByLabelText(/Emergency contact phone/), { target: { value: "512-555-1234" } });
    fireEvent.change(screen.getByLabelText("Full name", { exact: false }), { target: { value: "Pat Parent" } });

    fireEvent.click(screen.getByRole("button", { name: "Save progress" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/membership/intake", expect.objectContaining({ method: "PATCH" })),
    );
    expect(await screen.findByText("Progress saved.")).toBeInTheDocument();
  });

  it("submits the intake form and advances to the next step", async () => {
    setSession({ id: 1 });
    const fetchMock = mockFetchJson({
      "/api/membership/intake/submit": { state: state({ process: { id: 1, kind: "INITIAL", status: "PENDING_EXTERNAL_ACTION" }, external: { contractSigned: false, contractStarted: false, bgConsented: false, bgCleared: false, deepLinkUrl: null } }) },
      "/api/membership/intake": { state: state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }), rejections: [] },
      "/api/membership": state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }),
    });
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Your household");

    fireEvent.change(screen.getByPlaceholderText("123 Main St"), { target: { value: "1 Treehouse Ln" } });
    fireEvent.change(screen.getByLabelText("City", { exact: false }), { target: { value: "Austin" } });
    fireEvent.change(screen.getByLabelText("State", { exact: false }), { target: { value: "TX" } });
    fireEvent.change(screen.getByLabelText("ZIP", { exact: false }), { target: { value: "78701" } });
    fireEvent.change(screen.getByLabelText(/Emergency contact name/), { target: { value: "Aunt Jo" } });
    fireEvent.change(screen.getByLabelText(/Emergency contact phone/), { target: { value: "512-555-1234" } });
    fireEvent.change(screen.getByLabelText("Full name", { exact: false }), { target: { value: "Pat Parent" } });

    fireEvent.click(screen.getByRole("button", { name: "Submit & continue" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/membership/intake/submit", expect.objectContaining({ method: "POST" })),
    );
    expect(await screen.findByText("Sign & start your background check", { exact: false })).toBeInTheDocument();
  });

  it("renders PENDING_EXTERNAL_ACTION and starts signing", async () => {
    setSession({ id: 1 });
    const fetchMock = mockFetchJson({
      "/api/membership/contract/sign": { url: "https://sign.example/doc" },
      "/api/membership": state({
        process: { id: 1, kind: "INITIAL", status: "PENDING_EXTERNAL_ACTION" },
        external: { contractSigned: false, contractStarted: false, bgConsented: false, bgCleared: false, deepLinkUrl: "https://averity.example/consent" },
      }),
    });
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Sign & start your background check", { exact: false });

    expect(screen.getByRole("link", { name: /Consent on Averity/ })).toHaveAttribute("href", "https://averity.example/consent");

    fireEvent.click(screen.getByRole("button", { name: /Sign your membership agreement/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/membership/contract/sign", expect.objectContaining({ method: "POST" })),
    );
  });

  it("gates the consent self-attest checkbox behind the Averity link, then records consent", async () => {
    setSession({ id: 1 });
    const fetchMock = mockFetchJson({
      "/api/membership/bg-consent": { status: { contractSigned: false, contractStarted: false, bgConsented: true, bgCleared: false, deepLinkUrl: "https://averity.example/consent" } },
      "/api/membership": state({
        process: { id: 1, kind: "INITIAL", status: "PENDING_EXTERNAL_ACTION" },
        external: { contractSigned: false, contractStarted: false, bgConsented: false, bgCleared: false, deepLinkUrl: "https://averity.example/consent" },
      }),
    });
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Sign & start your background check", { exact: false });

    // Locked until the applicant has actually opened the Averity form.
    const checkbox = screen.getByRole("checkbox", { name: /I submitted my consent on Averity/ });
    expect(checkbox).toBeDisabled();

    fireEvent.click(screen.getByRole("link", { name: /Consent on Averity/ }));
    expect(checkbox).toBeEnabled();

    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/membership/bg-consent", expect.objectContaining({ method: "POST" })),
    );
  });

  it("renders PENDING_EXTERNAL_ACTION with a cleared background check", async () => {
    setSession({ id: 1 });
    mockFetchJson({
      "/api/membership": state({
        process: { id: 1, kind: "INITIAL", status: "PENDING_EXTERNAL_ACTION" },
        // deepLinkUrl still set (the server keeps returning it) to prove the reopen
        // link is hidden because the household is cleared, not because it's absent.
        external: { contractSigned: true, contractStarted: true, bgConsented: false, bgCleared: true, deepLinkUrl: "https://averity.example/consent" },
      }),
    });
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByText("Agreement signed — thank you!")).toBeInTheDocument();
    expect(screen.getByText("Background check")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Reopen the Averity consent form/ })).not.toBeInTheDocument();
  });

  it("renders PENDING_PAYMENT with a checkout link", async () => {
    setSession({ id: 1 });
    mockFetchJson({
      "/api/membership/payment": { amountCents: 12500, checkoutUrl: "https://shop.example/checkout" },
      "/api/membership": state({ process: { id: 1, kind: "INITIAL", status: "PENDING_PAYMENT" }, external: { contractSigned: true, contractStarted: true, bgConsented: true, bgCleared: false, deepLinkUrl: null } }),
    });
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByText("$125.00", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Pay here with Shopify/ })).toHaveAttribute("href", "https://shop.example/checkout");
  });

  // ── non-lead household members see progress, never a lead-only task ────────
  it("hides the intake form from a non-lead household member", async () => {
    setSession({ id: 2 });
    mockFetchJson({ "/api/membership": state({ isLead: false, process: { id: 1, kind: "INITIAL", status: "INTAKE" } }) });
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByText("Membership application in progress")).toBeInTheDocument();
    expect(screen.queryByText("Your household")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save progress" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit & continue" })).not.toBeInTheDocument();
  });

  it("hides contract signing and background-check consent from a non-lead household member", async () => {
    setSession({ id: 2 });
    mockFetchJson({
      "/api/membership": state({
        isLead: false,
        process: { id: 1, kind: "INITIAL", status: "PENDING_EXTERNAL_ACTION" },
        external: { contractSigned: false, contractStarted: false, bgConsented: false, bgCleared: false, deepLinkUrl: "https://averity.example/consent" },
      }),
    });
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByText("Membership application in progress")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign your membership agreement/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Consent on Averity/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /I submitted my consent on Averity/ })).not.toBeInTheDocument();
  });

  it("hides the renewal confirmation from a non-lead household member", async () => {
    setSession({ id: 2 });
    mockFetchJson({ "/api/membership": state({ isLead: false, process: { id: 1, kind: "RENEWAL", status: "PENDING_RENEWAL" } }) });
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByText("Your household is up for renewal")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Renew now" })).not.toBeInTheDocument();
  });

  it("hides the dues and the checkout link from a non-lead household member", async () => {
    setSession({ id: 2 });
    const fetchMock = mockFetchJson({
      "/api/membership/payment": { amountCents: 12500, checkoutUrl: "https://shop.example/checkout" },
      "/api/membership": state({
        isLead: false,
        process: { id: 1, kind: "INITIAL", status: "PENDING_PAYMENT" },
        external: { contractSigned: true, contractStarted: true, bgConsented: true, bgCleared: true, deepLinkUrl: null },
      }),
    });
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByText("Membership application in progress")).toBeInTheDocument();
    expect(screen.queryByText("$125.00", { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Pay here with Shopify/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Request a scholarship or payment plan/ })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/membership/payment"))).toBe(false);
  });

  it("renders PENDING_BG_CLEARANCE", async () => {
    setSession({ id: 1 });
    mockFetchJson({ "/api/membership": state({ process: { id: 1, kind: "INITIAL", status: "PENDING_BG_CLEARANCE" } }) });
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByText("Payment received 🎉", { exact: false })).toBeInTheDocument();
  });

  it("renders the default in-progress card for other statuses", async () => {
    setSession({ id: 1 });
    mockFetchJson({ "/api/membership": state({ process: { id: 1, kind: "INITIAL", status: "BLOCKED" } }) });
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByText("Application in progress")).toBeInTheDocument();
  });

  it("renders the renewal prompt and starts a renewal", async () => {
    setSession({ id: 1 });
    const fetchMock = mockFetchJson({
      "/api/membership/renew": { ok: true },
      "/api/membership": state({ process: { id: 1, kind: "RENEWAL", status: "PENDING_RENEWAL" } }),
    });
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Time to renew");

    fireEvent.click(screen.getByRole("button", { name: "Renew now" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/membership/renew", expect.objectContaining({ method: "POST" })),
    );
  });

  it("renders the renewal-pending-background-check state", async () => {
    setSession({ id: 1 });
    mockFetchJson({ "/api/membership": state({ process: { id: 1, kind: "RENEWAL", status: "RENEWAL_PENDING_BG" } }) });
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByText("Renewal in progress")).toBeInTheDocument();
  });

  it("silently falls back to the become-a-member card when the initial load fails", async () => {
    setSession({ id: 1 });
    global.fetch = jest.fn(async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByText("Become a member")).toBeInTheDocument();
  });

  // ── Return from Zoho signing (?signed=1 / ?declined=1) ──────────────────────
  it("shows a decline message on ?declined=1 without contacting the sync endpoint", async () => {
    setSession({ id: 1 });
    window.history.pushState({}, "", "/membership?declined=1");
    const fetchMock = mockFetchJson({ "/api/membership": state({}) });
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByText("You declined the agreement. You can restart signing when you're ready.")).toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("contract/sync"))).toBe(false);
  });

  it("syncs the contract and confirms the signature on ?signed=1", async () => {
    setSession({ id: 1 });
    window.history.pushState({}, "", "/membership?signed=1");
    mockFetchJson({
      "/api/membership/contract/sync": { status: { contractSigned: true } },
      "/api/membership": state({
        process: { id: 1, kind: "INITIAL", status: "PENDING_EXTERNAL_ACTION" },
        external: { contractSigned: true, contractStarted: true, bgConsented: false, bgCleared: false, deepLinkUrl: null },
      }),
    });
    renderWithProviders(<MembershipPage />);

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Thanks — your signature was received." })));
    expect(window.location.search).toBe("");
  });

  it("shows a finalizing message when the sync response doesn't confirm signing yet", async () => {
    setSession({ id: 1 });
    window.history.pushState({}, "", "/membership?signed=1");
    mockFetchJson({
      "/api/membership/contract/sync": { status: { contractSigned: false } },
      "/api/membership": state({
        process: { id: 1, kind: "INITIAL", status: "PENDING_EXTERNAL_ACTION" },
        external: { contractSigned: false, contractStarted: true, bgConsented: false, bgCleared: false, deepLinkUrl: null },
      }),
    });
    renderWithProviders(<MembershipPage />);

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Signature received — finalizing.") })));
  });

  it("falls back to a finalizing message when the sync request itself errors", async () => {
    setSession({ id: 1 });
    window.history.pushState({}, "", "/membership?signed=1");
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("contract/sync")) throw new Error("network down");
      return {
        ok: true,
        json: async () => state({
          process: { id: 1, kind: "INITIAL", status: "PENDING_EXTERNAL_ACTION" },
          external: { contractSigned: false, contractStarted: false, bgConsented: false, bgCleared: false, deepLinkUrl: null },
        }),
      } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<MembershipPage />);

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Signature received — finalizing.") })));
  });

  // ── PENDING_PAYMENT dues fetch branches ──────────────────────────────────────
  it("hides the bg-check alert once cleared and shows a not-yet-available checkout link", async () => {
    setSession({ id: 1 });
    mockFetchJson({
      "/api/membership/payment": { amountCents: 9900, checkoutUrl: null },
      "/api/membership": state({
        process: { id: 1, kind: "INITIAL", status: "PENDING_PAYMENT" },
        external: { contractSigned: true, contractStarted: true, bgConsented: true, bgCleared: true, deepLinkUrl: null },
      }),
    });
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByText("$99.00", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("The payment link isn't available yet. Please check back shortly.")).toBeInTheDocument();
    expect(screen.queryByText("Your background check is being reviewed", { exact: false })).not.toBeInTheDocument();
  });

  it("keeps the preparing-invoice placeholder when the dues request fails", async () => {
    setSession({ id: 1 });
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/membership/payment")) return { ok: false, json: async () => ({}) } as Response;
      return {
        ok: true,
        json: async () => state({ process: { id: 1, kind: "INITIAL", status: "PENDING_PAYMENT" }, external: { contractSigned: true, contractStarted: true, bgConsented: true, bgCleared: false, deepLinkUrl: null } }),
      } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByText("Preparing your invoice…")).toBeInTheDocument();
  });

  it("keeps the preparing-invoice placeholder when the dues request throws", async () => {
    setSession({ id: 1 });
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/membership/payment")) throw new Error("boom");
      return { ok: true, json: async () => state({ process: { id: 1, kind: "INITIAL", status: "PENDING_PAYMENT" } }) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByText("Preparing your invoice…")).toBeInTheDocument();
  });

  // ── PENDING_PAYMENT payment holdoff ──────────────────────────────────────────
  const HOLDOFF_MSG = "We'll update your status here when we receive your payment — refresh this page after you finish checkout.";

  it("clicking the Shopify checkout link shows the holdoff message and persists it to sessionStorage", async () => {
    setSession({ id: 1 });
    mockFetchJson({
      "/api/membership/payment": { amountCents: 12500, checkoutUrl: "https://shop.example/checkout" },
      "/api/membership": state({
        process: { id: 1, kind: "INITIAL", status: "PENDING_PAYMENT" },
        external: { contractSigned: true, contractStarted: true, bgConsented: true, bgCleared: true, deepLinkUrl: null },
      }),
    });
    renderWithProviders(<MembershipPage />);

    fireEvent.click(await screen.findByRole("link", { name: /Pay here with Shopify/ }));

    expect(await screen.findByText(HOLDOFF_MSG)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Pay here with Shopify/ })).not.toBeInTheDocument();
    expect(sessionStorage.getItem("membership_awaiting_payment_1")).not.toBeNull();
  });

  it("restores the holdoff on a page load while still pending, then clears it (and sessionStorage) on a load after the payment settled", async () => {
    setSession({ id: 1 });
    mockFetchJson({
      "/api/membership/payment": { amountCents: 12500, checkoutUrl: "https://shop.example/checkout" },
      "/api/membership": state({
        process: { id: 1, kind: "INITIAL", status: "PENDING_PAYMENT" },
        external: { contractSigned: true, contractStarted: true, bgConsented: true, bgCleared: true, deepLinkUrl: null },
      }),
    });
    const first = renderWithProviders(<MembershipPage />);
    fireEvent.click(await screen.findByRole("link", { name: /Pay here with Shopify/ }));
    await screen.findByText(HOLDOFF_MSG);
    first.unmount();

    // Next page load, payment still pending: the sessionStorage record restores
    // the message instead of flashing the pay button back.
    const second = renderWithProviders(<MembershipPage />);
    expect(await screen.findByText(HOLDOFF_MSG)).toBeInTheDocument();
    second.unmount();

    // The orders/paid webhook settles the payment server-side; the next page
    // load renders the real (paid) state and drops the sessionStorage record.
    mockFetchJson({
      "/api/membership": state({ process: { id: 1, kind: "INITIAL", status: "PENDING_BG_CLEARANCE" } }),
    });
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByText("Payment received", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(HOLDOFF_MSG)).not.toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem("membership_awaiting_payment_1")).toBeNull());
  });

  it("the 'Show the payment button again' escape hatch restores the pay button without waiting", async () => {
    setSession({ id: 1 });
    mockFetchJson({
      "/api/membership/payment": { amountCents: 12500, checkoutUrl: "https://shop.example/checkout" },
      "/api/membership": state({ process: { id: 1, kind: "INITIAL", status: "PENDING_PAYMENT" } }),
    });
    renderWithProviders(<MembershipPage />);
    fireEvent.click(await screen.findByRole("link", { name: /Pay here with Shopify/ }));
    await screen.findByText(HOLDOFF_MSG);

    fireEvent.click(screen.getByText("Show the payment button again"));

    expect(await screen.findByRole("link", { name: /Pay here with Shopify/ })).toBeInTheDocument();
    expect(sessionStorage.getItem("membership_awaiting_payment_1")).toBeNull();
  });

  it("never shows the payment holdoff for the local mock payment path", async () => {
    setSession({ id: 1 });
    setCheckinEnv("local");
    mockFetchJson({
      "/api/membership/payment": { amountCents: 9900, checkoutUrl: null },
      "/api/dev/shopify/orders-paid": {},
      "/api/membership": state({
        process: { id: 1, kind: "INITIAL", status: "PENDING_PAYMENT" },
        external: { contractSigned: true, contractStarted: true, bgConsented: true, bgCleared: true, deepLinkUrl: null },
      }),
    });
    renderWithProviders(<MembershipPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Pay now \(local mock\)/ }));

    await waitFor(() => expect(screen.getByText("Payment mocked (local) — updating status.")).toBeInTheDocument());
    expect(screen.queryByText(HOLDOFF_MSG)).not.toBeInTheDocument();
    expect(sessionStorage.getItem("membership_awaiting_payment_1")).toBeNull();
  });

  // ── PENDING_EXTERNAL_ACTION branches ─────────────────────────────────────────
  it("shows the resume-signing label and an in-progress background check", async () => {
    setSession({ id: 1 });
    mockFetchJson({
      "/api/membership": state({
        process: { id: 1, kind: "INITIAL", status: "PENDING_EXTERNAL_ACTION" },
        external: { contractSigned: false, contractStarted: true, bgConsented: true, bgCleared: false, deepLinkUrl: "https://averity.example/consent" },
      }),
    });
    renderWithProviders(<MembershipPage />);

    expect(await screen.findByRole("button", { name: "Resume signing →" })).toBeInTheDocument();
    expect(screen.getByText("Background check started", { exact: false })).toBeInTheDocument();
    // Consented (honor-system) but not yet reviewer-cleared: the Averity link stays
    // reachable so a mis-click or an unfinished form isn't a dead end.
    expect(screen.getByRole("link", { name: /Reopen the Averity consent form/ })).toHaveAttribute("href", "https://averity.example/consent");
  });

  it("shows a not-yet-available background-check link and refreshes status on demand", async () => {
    setSession({ id: 1 });
    const fetchMock = mockFetchJson({
      "/api/membership": state({
        process: { id: 1, kind: "INITIAL", status: "PENDING_EXTERNAL_ACTION" },
        external: { contractSigned: false, contractStarted: false, bgConsented: false, bgCleared: false, deepLinkUrl: null },
      }),
    });
    renderWithProviders(<MembershipPage />);
    await screen.findByText("The background-check link isn't available yet. Please check back shortly.");

    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => u === "/api/membership").length).toBeGreaterThan(1),
    );
  });

  it("shows a fallback message when signing succeeds without a URL", async () => {
    setSession({ id: 1 });
    mockFetchJson({
      "/api/membership/contract/sign": {},
      "/api/membership": state({
        process: { id: 1, kind: "INITIAL", status: "PENDING_EXTERNAL_ACTION" },
        external: { contractSigned: false, contractStarted: false, bgConsented: false, bgCleared: false, deepLinkUrl: null },
      }),
    });
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Sign & start your background check", { exact: false });

    fireEvent.click(screen.getByRole("button", { name: /Sign your membership agreement/ }));

    expect(await screen.findByText("Couldn't open the signing form. Please try again.")).toBeInTheDocument();
  });

  it("shows the server's error when signing fails", async () => {
    setSession({ id: 1 });
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("contract/sign")) return { ok: false, json: async () => ({ error: "Signing closed" }) } as Response;
      return {
        ok: true,
        json: async () => state({
          process: { id: 1, kind: "INITIAL", status: "PENDING_EXTERNAL_ACTION" },
          external: { contractSigned: false, contractStarted: false, bgConsented: false, bgCleared: false, deepLinkUrl: null },
        }),
      } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Sign & start your background check", { exact: false });

    fireEvent.click(screen.getByRole("button", { name: /Sign your membership agreement/ }));

    expect(await screen.findByText("Signing closed")).toBeInTheDocument();
  });

  it("shows a network error when starting to sign throws", async () => {
    setSession({ id: 1 });
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("contract/sign")) throw new Error("down");
      return {
        ok: true,
        json: async () => state({
          process: { id: 1, kind: "INITIAL", status: "PENDING_EXTERNAL_ACTION" },
          external: { contractSigned: false, contractStarted: false, bgConsented: false, bgCleared: false, deepLinkUrl: null },
        }),
      } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Sign & start your background check", { exact: false });

    fireEvent.click(screen.getByRole("button", { name: /Sign your membership agreement/ }));

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Network error.", autoClose: false })));
  });

  // ── startApplication failures ─────────────────────────────────────────────
  it("shows a server error when starting an application fails", async () => {
    setSession({ id: 1 });
    const fetchMock = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: false, json: async () => ({ error: "Applications are closed" }) } as Response;
      return { ok: true, json: async () => state({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<MembershipPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Start application" }));

    expect(await screen.findByText("Applications are closed")).toBeInTheDocument();
  });

  it("shows a network error when starting an application throws", async () => {
    setSession({ id: 1 });
    const fetchMock = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("down");
      return { ok: true, json: async () => state({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<MembershipPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Start application" }));

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Network error.", autoClose: false })));
  });

  // ── save() failures + warnings branches ──────────────────────────────────
  it("shows the server error when saving progress fails", async () => {
    setSession({ id: 1 });
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/membership/intake") && init?.method === "PATCH") {
        return { ok: false, json: async () => ({ error: "constraint violated" }) } as Response;
      }
      return { ok: true, json: async () => state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Your household");

    fireEvent.click(screen.getByRole("button", { name: "Save progress" }));

    expect(await screen.findByText("constraint violated")).toBeInTheDocument();
  });

  it("shows a network error when saving progress throws", async () => {
    setSession({ id: 1 });
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/membership/intake") && init?.method === "PATCH") throw new Error("down");
      return { ok: true, json: async () => state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Your household");

    fireEvent.click(screen.getByRole("button", { name: "Save progress" }));

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Network error.", autoClose: false })));
  });

  it("surfaces save warnings for parts of the update the server rejected", async () => {
    setSession({ id: 1 });
    mockFetchJson({
      "/api/membership/intake": { state: state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }), rejections: [{ message: "Second guardian limit reached." }] },
      "/api/membership": state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }),
    });
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Your household");

    fireEvent.click(screen.getByRole("button", { name: "Save progress" }));

    expect(await screen.findByText("Second guardian limit reached.")).toBeInTheDocument();
    expect(screen.getByText("Saved — with a couple of things to know")).toBeInTheDocument();
  });

  it("clears warnings when a save response omits rejections", async () => {
    setSession({ id: 1 });
    mockFetchJson({
      "/api/membership/intake": { state: state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }) },
      "/api/membership": state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }),
    });
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Your household");

    fireEvent.click(screen.getByRole("button", { name: "Save progress" }));

    expect(await screen.findByText("Progress saved.")).toBeInTheDocument();
    expect(screen.queryByText("Saved — with a couple of things to know")).not.toBeInTheDocument();
  });

  // ── submit() validation + failure branches ───────────────────────────────
  it("blocks submit and highlights every missing required field", async () => {
    setSession({ id: 1 });
    const fetchMock = mockFetchJson({ "/api/membership": state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }) });
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Your household");

    fireEvent.click(screen.getByRole("button", { name: "Submit & continue" }));

    expect(await screen.findByText("Please complete the highlighted fields.")).toBeInTheDocument();
    expect(screen.getByText("Home address is required.")).toBeInTheDocument();
    expect(screen.getByText("City is required.")).toBeInTheDocument();
    expect(screen.getByText("State is required.")).toBeInTheDocument();
    expect(screen.getByText("ZIP is required.")).toBeInTheDocument();
    expect(screen.getByText("Emergency contact name is required.")).toBeInTheDocument();
    expect(screen.getByText("Emergency contact phone is required.")).toBeInTheDocument();
    expect(screen.getByText("Your name is required.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/membership/intake"))).toBe(false);
  });

  it("blocks submit for an invalid emergency-contact email format", async () => {
    setSession({ id: 1 });
    mockFetchJson({ "/api/membership": state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }) });
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Your household");

    fireEvent.change(screen.getByPlaceholderText("123 Main St"), { target: { value: "1 Treehouse Ln" } });
    fireEvent.change(screen.getByLabelText(/Emergency contact name/), { target: { value: "Aunt Jo" } });
    fireEvent.change(screen.getByLabelText(/Emergency contact phone/), { target: { value: "512-555-1234" } });
    fireEvent.change(screen.getByLabelText("Emergency contact email (optional)"), { target: { value: "not-an-email" } });
    fireEvent.change(screen.getByLabelText("Full name", { exact: false }), { target: { value: "Pat Parent" } });

    fireEvent.click(screen.getByRole("button", { name: "Submit & continue" }));

    expect(await screen.findByText("That email address doesn't look right.")).toBeInTheDocument();
  });

  it("clears a field's error as soon as the user edits it", async () => {
    setSession({ id: 1 });
    mockFetchJson({ "/api/membership": state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }) });
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Your household");

    fireEvent.click(screen.getByRole("button", { name: "Submit & continue" }));
    expect(await screen.findByText("Home address is required.")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("123 Main St"), { target: { value: "1 Treehouse Ln" } });

    expect(screen.queryByText("Home address is required.")).not.toBeInTheDocument();
  });

  it("stops submit and reports the error when the save step fails", async () => {
    setSession({ id: 1 });
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/membership/intake") && init?.method === "PATCH") {
        return { ok: false, json: async () => ({ error: "Save failed" }) } as Response;
      }
      if (url.includes("/api/membership/intake/submit")) return { ok: true, json: async () => ({ state: state({}) }) } as Response;
      return { ok: true, json: async () => state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Your household");

    fireEvent.change(screen.getByPlaceholderText("123 Main St"), { target: { value: "1 Treehouse Ln" } });
    fireEvent.change(screen.getByLabelText("City", { exact: false }), { target: { value: "Austin" } });
    fireEvent.change(screen.getByLabelText("State", { exact: false }), { target: { value: "TX" } });
    fireEvent.change(screen.getByLabelText("ZIP", { exact: false }), { target: { value: "78701" } });
    fireEvent.change(screen.getByLabelText(/Emergency contact name/), { target: { value: "Aunt Jo" } });
    fireEvent.change(screen.getByLabelText(/Emergency contact phone/), { target: { value: "512-555-1234" } });
    fireEvent.change(screen.getByLabelText("Full name", { exact: false }), { target: { value: "Pat Parent" } });

    fireEvent.click(screen.getByRole("button", { name: "Submit & continue" }));

    expect(await screen.findByText("Save failed")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/membership/intake/submit"))).toBe(false);
  });

  it("maps server-flagged fields to inputs when the final submit step fails", async () => {
    setSession({ id: 1 });
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/membership/intake/submit")) {
        return { ok: false, json: async () => ({ error: "Needs fixes", fields: ["address", "primaryName", "emergencyContact"] }) } as Response;
      }
      if (url.includes("/api/membership/intake") && init?.method === "PATCH") {
        // rejections omitted — exercises the `saveData.rejections ?? []` fallback
        return { ok: true, json: async () => ({ state: state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }) }) } as Response;
      }
      return { ok: true, json: async () => state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Your household");

    fireEvent.change(screen.getByPlaceholderText("123 Main St"), { target: { value: "1 Treehouse Ln" } });
    fireEvent.change(screen.getByLabelText("City", { exact: false }), { target: { value: "Austin" } });
    fireEvent.change(screen.getByLabelText("State", { exact: false }), { target: { value: "TX" } });
    fireEvent.change(screen.getByLabelText("ZIP", { exact: false }), { target: { value: "78701" } });
    fireEvent.change(screen.getByLabelText(/Emergency contact name/), { target: { value: "Aunt Jo" } });
    fireEvent.change(screen.getByLabelText(/Emergency contact phone/), { target: { value: "512-555-1234" } });
    fireEvent.change(screen.getByLabelText("Full name", { exact: false }), { target: { value: "Pat Parent" } });

    fireEvent.click(screen.getByRole("button", { name: "Submit & continue" }));

    expect(await screen.findByText("Needs fixes")).toBeInTheDocument();
    expect(screen.getByText("Home address is required.")).toBeInTheDocument();
    expect(screen.getByText("Your name is required.")).toBeInTheDocument();
    expect(screen.getAllByText("Add an emergency contact who isn't in your household.").length).toBe(2);
  });

  it("shows a network error when submit throws", async () => {
    setSession({ id: 1 });
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/membership/intake") && init?.method === "PATCH") throw new Error("down");
      return { ok: true, json: async () => state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Your household");

    fireEvent.change(screen.getByPlaceholderText("123 Main St"), { target: { value: "1 Treehouse Ln" } });
    fireEvent.change(screen.getByLabelText("City", { exact: false }), { target: { value: "Austin" } });
    fireEvent.change(screen.getByLabelText("State", { exact: false }), { target: { value: "TX" } });
    fireEvent.change(screen.getByLabelText("ZIP", { exact: false }), { target: { value: "78701" } });
    fireEvent.change(screen.getByLabelText(/Emergency contact name/), { target: { value: "Aunt Jo" } });
    fireEvent.change(screen.getByLabelText(/Emergency contact phone/), { target: { value: "512-555-1234" } });
    fireEvent.change(screen.getByLabelText("Full name", { exact: false }), { target: { value: "Pat Parent" } });

    fireEvent.click(screen.getByRole("button", { name: "Submit & continue" }));

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Network error.", autoClose: false })));
  });

  // ── renew() failures ──────────────────────────────────────────────────────
  it("shows a server error when renewal fails", async () => {
    setSession({ id: 1 });
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/membership/renew")) return { ok: false, json: async () => ({ error: "Renewal window closed" }) } as Response;
      return { ok: true, json: async () => state({ process: { id: 1, kind: "RENEWAL", status: "PENDING_RENEWAL" } }) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Time to renew");

    fireEvent.click(screen.getByRole("button", { name: "Renew now" }));

    expect(await screen.findByText("Renewal window closed")).toBeInTheDocument();
  });

  it("shows a network error when renewal throws", async () => {
    setSession({ id: 1 });
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/membership/renew")) throw new Error("down");
      return { ok: true, json: async () => state({ process: { id: 1, kind: "RENEWAL", status: "PENDING_RENEWAL" } }) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Time to renew");

    fireEvent.click(screen.getByRole("button", { name: "Renew now" }));

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Network error.", autoClose: false })));
  });

  // ── hydrate() with a prefilled secondary parent + children ───────────────
  it("hydrates prefilled secondary-parent and children data", async () => {
    setSession({ id: 1 });
    mockFetchJson({
      "/api/membership": state({
        process: { id: 1, kind: "INITIAL", status: "INTAKE" },
        prefill: {
          household: { name: null, emergencyContactName: "Aunt Jo", emergencyContactPhone: "512-555-1234", emergencyContactEmail: null, line1: "1 Treehouse Ln", line2: null, city: "Austin", state: "TX", postalCode: "78701" },
          primaryParent: { id: 1, name: "Pat Parent", email: "pat@example.com", dob: "1980-01-01", allergies: null },
          // Sam has every field null except name/id — exercises the `sec.x ?? ""`
          // fallback side of hydrate() (the "fills every second parent / guardian
          // field" test below covers the truthy side).
          secondaryParent: { id: 9, name: "Sam Secondary", email: null, dob: null, allergies: null },
          children: [
            { id: 5, name: "Kid A", email: null, dob: "2015-01-01", allergies: "peanuts" },
            // Kid B has every field null except id — exercises the `c.x ?? ""`
            // fallback side of the children map (name/dob/allergies; Kid A above
            // already covers email's fallback).
            { id: 6, name: null, email: "kidb@example.com", dob: null, allergies: null },
          ],
        },
      }),
    });
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Your household");

    expect(screen.getByLabelText("Add a second parent / guardian")).toBeChecked();
    expect(screen.getAllByLabelText("Full name", { exact: false })[1]).toHaveValue("Sam Secondary");
    expect(screen.getByDisplayValue("Kid A")).toBeInTheDocument();
    expect(screen.getByText("Child 2")).toBeInTheDocument();
    expect(screen.queryByText("No children added yet.")).not.toBeInTheDocument();
  });

  // Renders the intake step and exposes the body of the PATCH a "Save progress"
  // sends. The payload is the only place to read the filled form back: save()
  // re-hydrates every field from the response, which carries an empty prefill.
  async function renderIntakeStep() {
    setSession({ id: 1 });
    const fetchMock = mockFetchJson({
      "/api/membership/intake": { state: state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }), rejections: [] },
      "/api/membership": state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }),
    });
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Your household");

    const savedPayload = async () => {
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith("/api/membership/intake", expect.objectContaining({ method: "PATCH" })),
      );
      const call = fetchMock.mock.calls.find(([u, init]) => u === "/api/membership/intake" && (init as RequestInit)?.method === "PATCH")!;
      return JSON.parse((call[1] as RequestInit).body as string);
    };
    return { savedPayload };
  }

  // ── Every intake onChange handler + addChild/updateChild/removeChild, one
  //    form section per test ─────────────────────────────────────────────────
  it("fills every household and primary-parent intake field and saves them", async () => {
    const { savedPayload } = await renderIntakeStep();

    fireEvent.change(screen.getByPlaceholderText("123 Main St"), { target: { value: "1 Treehouse Ln" } });
    fireEvent.change(screen.getByPlaceholderText("Apt 4B"), { target: { value: "Unit 2" } });
    fireEvent.change(screen.getByLabelText("City", { exact: false }), { target: { value: "Austin" } });
    fireEvent.change(screen.getByLabelText("State", { exact: false }), { target: { value: "TX" } });
    fireEvent.change(screen.getByPlaceholderText("78701"), { target: { value: "78701" } });
    fireEvent.change(screen.getByLabelText(/Emergency contact name/), { target: { value: "Aunt Jo" } });
    fireEvent.change(screen.getByLabelText(/Emergency contact phone/), { target: { value: "512-555-1234" } });
    fireEvent.change(screen.getByLabelText("Emergency contact email (optional)"), { target: { value: "jo@example.com" } });
    fireEvent.change(screen.getByLabelText("Full name", { exact: false }), { target: { value: "Pat Parent" } });
    fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1980-01-01" } });
    fireEvent.change(screen.getByLabelText("Allergies (optional)"), { target: { value: "none" } });

    fireEvent.click(screen.getByRole("button", { name: "Save progress" }));

    const body = await savedPayload();
    expect(body.household).toMatchObject({
      line1: "1 Treehouse Ln", line2: "Unit 2", city: "Austin", state: "TX", postalCode: "78701",
      emergencyContactName: "Aunt Jo", emergencyContactPhone: "512-555-1234", emergencyContactEmail: "jo@example.com",
    });
    expect(body.primaryParent).toMatchObject({ name: "Pat Parent", dob: "1980-01-01", allergies: "none" });
    expect(body.secondaryParent).toBeNull();
  });

  it("fills every second parent / guardian field and saves them", async () => {
    const { savedPayload } = await renderIntakeStep();

    fireEvent.click(screen.getByLabelText("Add a second parent / guardian"));
    fireEvent.change(screen.getAllByLabelText("Full name", { exact: false })[1], { target: { value: "Sam Secondary" } });
    fireEvent.change(screen.getByLabelText("Email (optional)"), { target: { value: "sam@example.com" } });
    fireEvent.change(screen.getAllByLabelText("Date of birth")[1], { target: { value: "1982-02-02" } });
    fireEvent.change(screen.getAllByLabelText("Allergies (optional)")[1], { target: { value: "peanuts" } });

    fireEvent.click(screen.getByRole("button", { name: "Save progress" }));

    const body = await savedPayload();
    expect(body.secondaryParent).toMatchObject({ name: "Sam Secondary", email: "sam@example.com", dob: "1982-02-02", allergies: "peanuts" });
  });

  it("adds and removes children, saving only the ones left", async () => {
    const { savedPayload } = await renderIntakeStep();

    fireEvent.click(screen.getByRole("button", { name: "+ Add child" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add child" }));
    expect(screen.getByText("Child 1")).toBeInTheDocument();
    expect(screen.getByText("Child 2")).toBeInTheDocument();

    fireEvent.change(screen.getAllByLabelText("Full name", { exact: false })[1], { target: { value: "Kid One" } });
    fireEvent.change(screen.getAllByLabelText("Date of birth")[1], { target: { value: "2015-01-01" } });
    fireEvent.change(screen.getAllByLabelText("Email (optional)")[0], { target: { value: "kid1@example.com" } });
    fireEvent.change(screen.getAllByLabelText("Allergies (optional)")[1], { target: { value: "bees" } });
    fireEvent.change(screen.getAllByLabelText("Full name", { exact: false })[2], { target: { value: "Kid Two" } });

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    expect(screen.queryByText("Child 2")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save progress" }));

    const body = await savedPayload();
    expect(body.children).toHaveLength(1);
    expect(body.children[0]).toMatchObject({ name: "Kid One", dob: "2015-01-01", email: "kid1@example.com", allergies: "bees" });
  });

  it("leaves the Home link's navigation unblocked", async () => {
    await renderIntakeStep();

    // onNavigate on the Home link — no UnsavedChangesProvider is mounted in this
    // harness, so confirmNav() is the always-true no-op and preventDefault is skipped.
    const home = screen.getByRole("link", { name: "← Home" });
    expect(fireEvent.click(home)).toBe(true);
  });

  it("omits blank secondary-parent and child fields from the saved payload", async () => {
    setSession({ id: 1 });
    const fetchMock = mockFetchJson({
      "/api/membership/intake": { state: state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }), rejections: [] },
      "/api/membership": state({ process: { id: 1, kind: "INITIAL", status: "INTAKE" } }),
    });
    renderWithProviders(<MembershipPage />);
    await screen.findByText("Your household");

    // Only the secondary parent's name and a child's name are filled — leaves
    // email/dob/allergies blank on both, exercising the `|| undefined`/`|| null`
    // fallback side of buildPayload() (the "fills every second parent /
    // guardian field" and "adds and removes children" tests above cover the
    // truthy side).
    fireEvent.click(screen.getByLabelText("Add a second parent / guardian"));
    fireEvent.change(screen.getAllByLabelText("Full name", { exact: false })[1], { target: { value: "Sam Secondary" } });

    fireEvent.click(screen.getByRole("button", { name: "+ Add child" }));
    fireEvent.change(screen.getAllByLabelText("Full name", { exact: false })[2], { target: { value: "Kid One" } });

    fireEvent.click(screen.getByRole("button", { name: "Save progress" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/membership/intake", expect.objectContaining({ method: "PATCH" })),
    );
    const call = fetchMock.mock.calls.find(([u, init]) => u === "/api/membership/intake" && (init as RequestInit)?.method === "PATCH")!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.secondaryParent.email).toBeUndefined();
    expect(body.secondaryParent.dob).toBeNull();
    expect(body.secondaryParent.allergies).toBeNull();
    expect(body.children[0].email).toBeNull();
    expect(body.children[0].dob).toBeNull();
    expect(body.children[0].allergies).toBeNull();
  });
});

describe("payment holdoff visibility refetch", () => {
  it("refetches state when the tab becomes visible while awaiting payment", async () => {
    setSession({ id: 1 });
    sessionStorage.setItem("membership_awaiting_payment_1", String(Date.now()));
    const fetchMock = mockFetchJson({
      "/api/membership/payment": { amountCents: 12500, checkoutUrl: "https://shop.example/checkout" },
      "/api/membership": state({
        process: { id: 1, kind: "INITIAL", status: "PENDING_PAYMENT" },
        external: { contractSigned: true, contractStarted: true, bgConsented: true, bgCleared: true, deepLinkUrl: null },
      }),
    });
    renderWithProviders(<MembershipPage />);
    expect(await screen.findByText(/update your status here when we receive your payment/i)).toBeInTheDocument();

    const stateCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/membership").length;
    const before = stateCalls();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(stateCalls()).toBeGreaterThan(before));
  });
});

describe("scholarship / payment-plan request", () => {
  const pendingPayment = (extra: Record<string, unknown> = {}) => ({
    "/api/membership/payment": { amountCents: 12500, checkoutUrl: "https://shop.example/checkout" },
    "/api/membership": state({
      process: { id: 1, kind: "INITIAL", status: "PENDING_PAYMENT", ...extra },
      external: { contractSigned: true, contractStarted: true, bgConsented: true, bgCleared: true, deepLinkUrl: null },
    }),
  });

  it("asks for confirmation before sending — cancel fires nothing", async () => {
    setSession({ id: 1 });
    const fetchMock = mockFetchJson(pendingPayment());
    renderWithProviders(<MembershipPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Request a scholarship or payment plan/ }));
    expect(await screen.findByText(/This sends your request to the board/)).toBeInTheDocument();
    const requestCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("request-payment-plan")).length;
    expect(requestCalls()).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(requestCalls()).toBe(0);
    expect(screen.getByRole("button", { name: /Request a scholarship or payment plan/ })).toBeInTheDocument();
  });

  it("confirm sends the request and swaps the button for the received state", async () => {
    setSession({ id: 1 });
    const fetchMock = mockFetchJson({ ...pendingPayment(), "/api/membership/request-payment-plan": { ok: true } });
    renderWithProviders(<MembershipPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Request a scholarship or payment plan/ }));
    // The kind is required — "Send request" is disabled until one is picked.
    expect(await screen.findByRole("button", { name: "Send request" })).toBeDisabled();
    fireEvent.click(await screen.findByRole("radio", { name: /^Payment plan$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Send request" }));
    expect(await screen.findByText(/requested — the Scholarship Review Team will follow up/)).toBeInTheDocument();
    const planCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("request-payment-plan"));
    expect(planCalls.length).toBe(1);
    expect(JSON.parse(String((planCalls[0][1] as RequestInit).body))).toEqual(
      expect.objectContaining({ kind: "PAYMENT_PLAN" }),
    );
    expect(screen.queryByRole("button", { name: /Request a scholarship or payment plan/ })).not.toBeInTheDocument();
  });

  it("a reload after requesting still shows the received state (server flag)", async () => {
    setSession({ id: 1 });
    mockFetchJson(pendingPayment({ isPaymentPlanRequested: true }));
    renderWithProviders(<MembershipPage />);
    expect(await screen.findByText(/requested — the Scholarship Review Team will follow up/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Request a scholarship or payment plan/ })).not.toBeInTheDocument();
  });

  it("a state refetch with isPaymentPlanRequested:false reverts the button to requestable", async () => {
    setSession({ id: 1 });
    // Piggyback on the payment-holdoff visibility refetch (already exercised
    // above) as the lever to force a second /api/membership load — the
    // PENDING_PAYMENT card has no other user-facing refresh trigger.
    sessionStorage.setItem("membership_awaiting_payment_1", String(Date.now()));
    let requested = true;
    mockFetchJson({
      "/api/membership/payment": { amountCents: 12500, checkoutUrl: "https://shop.example/checkout" },
      "/api/membership": () => state({
        process: { id: 1, kind: "INITIAL", status: "PENDING_PAYMENT", isPaymentPlanRequested: requested },
        external: { contractSigned: true, contractStarted: true, bgConsented: true, bgCleared: true, deepLinkUrl: null },
      }),
    });
    renderWithProviders(<MembershipPage />);
    expect(await screen.findByText(/requested — the Scholarship Review Team will follow up/)).toBeInTheDocument();

    requested = false;
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(await screen.findByRole("button", { name: /Request a scholarship or payment plan/ })).toBeInTheDocument();
  });
});
