// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), update: jest.fn(), hide: jest.fn() } }));

import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { renderWithProviders, setSession, resetRtl } from "@/test-helpers/rtl";
import OutreachSettingsPage from "../page";

const SETTINGS = {
  outreachOpeningSubject: "Time to {{actionWord}}",
  outreachOpeningBody: "Hi {{name}}, please {{actionWord}} by {{deadline}} at {{actionLink}}.",
  outreachReminderSubject: "Reminder: {{actionWord}}",
  outreachReminderBody: "Hi {{name}}, a reminder.",
};
const EMPTY_STATUS = { inFlight: null, lastCompleted: null };

type Route = { status?: number; body: unknown };
function router(routes: Record<string, Partial<Record<string, Route>> | Route>) {
  const fn = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const key = Object.keys(routes).find((k) => url.includes(k));
    let entry = key !== undefined ? routes[key] : undefined;
    if (entry && "body" in entry === false) entry = (entry as Partial<Record<string, Route>>)[method];
    const route = entry as Route | undefined;
    const body = route?.body ?? {};
    const status = route?.status ?? (route ? 200 : 404);
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  resetRtl();
  setSession({ id: 1, isBoardMember: true });
});

describe("OutreachSettingsPage", () => {
  it("loads the four fields and renders a live preview", async () => {
    router({
      "/api/settings/outreach": { body: { settings: SETTINGS, nextDeadline: "2026-08-01" } },
      "/api/outreach/status": { body: EMPTY_STATUS },
    });
    renderWithProviders(<OutreachSettingsPage />);

    await screen.findByDisplayValue("Time to {{actionWord}}");
    expect(screen.getAllByDisplayValue(/Hi \{\{name\}\}/)).toHaveLength(2);

    // The body renders in a scriptless sandboxed iframe (XSS hardening), so assert against its srcDoc.
    expect(screen.getByTitle("Opening of renewals: preview").getAttribute("srcdoc")).toMatch(/please renew by 2026-08-01/);
  });

  it("live preview updates as the board types", async () => {
    router({
      "/api/settings/outreach": { body: { settings: SETTINGS, nextDeadline: "2026-08-01" } },
      "/api/outreach/status": { body: EMPTY_STATUS },
    });
    renderWithProviders(<OutreachSettingsPage />);
    await screen.findByDisplayValue("Time to {{actionWord}}");

    const subjectInputs = screen.getAllByLabelText("Subject");
    fireEvent.change(subjectInputs[0], { target: { value: "Brand new subject {{actionWord}}" } });

    expect(await screen.findByText("Brand new subject renew")).toBeInTheDocument();
  });

  it("sends a test email for a template", async () => {
    const fetchMock = router({
      "/api/settings/outreach": { body: { settings: SETTINGS, nextDeadline: "2026-08-01" } },
      "/api/outreach/status": { body: EMPTY_STATUS },
      "/api/outreach/test-send": { body: { success: true } },
    });
    renderWithProviders(<OutreachSettingsPage />);
    await screen.findByDisplayValue("Time to {{actionWord}}");

    fireEvent.click(screen.getAllByRole("button", { name: /Send test to me/ })[0]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/outreach/test-send", expect.objectContaining({ method: "POST" })));
  });

  it("rejects saving an unknown token with a visible error", async () => {
    router({
      "/api/settings/outreach": { GET: { body: { settings: SETTINGS, nextDeadline: "2026-08-01" } }, PUT: { status: 400, body: { error: "Unknown token {{bogus}} in outreachOpeningSubject" } } },
      "/api/outreach/status": { body: EMPTY_STATUS },
    });
    renderWithProviders(<OutreachSettingsPage />);
    await screen.findByDisplayValue("Time to {{actionWord}}");

    const subjectInputs = screen.getAllByLabelText("Subject");
    fireEvent.change(subjectInputs[0], { target: { value: "{{bogus}}" } });
    fireEvent.click(screen.getByRole("button", { name: "Save templates" }));

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "Unknown token {{bogus}} in outreachOpeningSubject", autoClose: false }),
      ),
    );
  });

  it("send panel: confirm dialog shows counts, then draining reaches 100%", async () => {
    router({
      "/api/settings/outreach": { body: { settings: SETTINGS, nextDeadline: "2026-08-01" } },
      "/api/outreach/status": { body: EMPTY_STATUS },
      "/api/outreach/send": { body: { bulkSend: { id: 1 }, counts: { queued: 10, leadsWithoutEmail: 1, total: 10 } } },
      "/api/outreach/process-batch": { body: { bulkSendId: 1, processed: 10, remaining: 0 } },
    });
    renderWithProviders(<OutreachSettingsPage />);
    await screen.findByDisplayValue("Time to {{actionWord}}");

    fireEvent.click(screen.getByRole("button", { name: "Send Opening-of-renewals campaign" }));

    const modal = await screen.findByRole("dialog", { name: "Confirm send" });
    expect(within(modal).getByText(/10/)).toBeInTheDocument();
    expect(within(modal).getByText(/1 household lead\(s\) have no email/)).toBeInTheDocument();

    fireEvent.click(within(modal).getByRole("button", { name: "Send now" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm send" })).not.toBeInTheDocument());
  });

  it("send panel has no audience picker; each email type sends only its type", async () => {
    const fetchMock = router({
      "/api/settings/outreach": { body: { settings: SETTINGS, nextDeadline: "2026-08-01" } },
      "/api/outreach/status": { body: EMPTY_STATUS },
      "/api/outreach/send": { body: { bulkSend: { id: 2 }, counts: { queued: 0, leadsWithoutEmail: 0, total: 0 } } },
    });
    renderWithProviders(<OutreachSettingsPage />);
    await screen.findByDisplayValue("Time to {{actionWord}}");

    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send Reminder campaign" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/outreach/send", expect.objectContaining({ body: JSON.stringify({ emailType: "reminder" }) })),
    );
  });

  it("offers Resume for an in-flight send reported by status", async () => {
    router({
      "/api/settings/outreach": { body: { settings: SETTINGS, nextDeadline: "2026-08-01" } },
      "/api/outreach/status": {
        body: {
          inFlight: { id: 5, emailType: "opening", startedAt: new Date().toISOString(), completedAt: null, counts: { queued: 3, sent: 7, failed: 0, skipped_denied: 0, skipped_not_member: 0, sending: 0, total: 10 } },
          lastCompleted: null,
        },
      },
    });
    renderWithProviders(<OutreachSettingsPage />);

    expect(await screen.findByRole("button", { name: "Resume send" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send Opening-of-renewals campaign/ })).not.toBeInTheDocument();
  });

  it("shows a Retry-failed button when the last completed send had failures", async () => {
    router({
      "/api/settings/outreach": { body: { settings: SETTINGS, nextDeadline: "2026-08-01" } },
      "/api/outreach/status": {
        body: {
          inFlight: null,
          lastCompleted: { id: 9, emailType: "reminder", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), counts: { queued: 0, sent: 8, failed: 2, skipped_denied: 0, skipped_not_member: 0, sending: 0, total: 10 } },
        },
      },
    });
    renderWithProviders(<OutreachSettingsPage />);

    expect(await screen.findByRole("button", { name: /Retry 2 failed/ })).toBeInTheDocument();
  });
});

describe("failed loads", () => {
  it("shows the templates error with Retry, and no form or Save, until the templates load", async () => {
    router({ "/api/outreach/status": { body: EMPTY_STATUS } });
    renderWithProviders(<OutreachSettingsPage />);

    expect(await screen.findByText("Couldn't load the outreach templates")).toBeInTheDocument();
    expect(screen.queryByLabelText("Subject")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save templates" })).not.toBeInTheDocument();

    router({
      "/api/settings/outreach": { body: { settings: SETTINGS, nextDeadline: "2026-08-01" } },
      "/api/outreach/status": { body: EMPTY_STATUS },
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByDisplayValue("Time to {{actionWord}}")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save templates" })).toBeInTheDocument();
  });

  it("offers no new send while the send status is unknown, and Retry recovers", async () => {
    router({ "/api/settings/outreach": { body: { settings: SETTINGS, nextDeadline: "2026-08-01" } } });
    renderWithProviders(<OutreachSettingsPage />);

    expect(await screen.findByText("Couldn't load the send status")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send Opening-of-renewals campaign" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send Reminder campaign" })).not.toBeInTheDocument();

    router({
      "/api/settings/outreach": { body: { settings: SETTINGS, nextDeadline: "2026-08-01" } },
      "/api/outreach/status": { body: EMPTY_STATUS },
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Send Opening-of-renewals campaign" })).toBeInTheDocument();
  });

  it("holds the form and the send buttons until this visit's own reads answer, even with older reads cached", async () => {
    router({
      "/api/settings/outreach": { body: { settings: SETTINGS, nextDeadline: "2026-08-01" } },
      "/api/outreach/status": { body: EMPTY_STATUS },
    });
    const earlier = renderWithProviders(<OutreachSettingsPage />);
    await screen.findByDisplayValue("Time to {{actionWord}}");
    earlier.unmount();

    const answer = router({
      "/api/settings/outreach": { body: { settings: { ...SETTINGS, outreachOpeningSubject: "Newer subject" }, nextDeadline: "2026-08-01" } },
      "/api/outreach/status": { body: EMPTY_STATUS },
    });
    const held: Array<() => void> = [];
    let released = false;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => released
      ? answer(input, init)
      : new Promise<Response>((resolve) => { held.push(() => resolve(answer(input, init))); })) as unknown as typeof fetch;
    renderWithProviders(<OutreachSettingsPage />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByDisplayValue("Time to {{actionWord}}")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save templates" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send Opening-of-renewals campaign" })).not.toBeInTheDocument();

    released = true;
    held.forEach((release) => release());
    expect(await screen.findByDisplayValue("Newer subject")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Send Opening-of-renewals campaign" })).toBeInTheDocument();
  });
});
