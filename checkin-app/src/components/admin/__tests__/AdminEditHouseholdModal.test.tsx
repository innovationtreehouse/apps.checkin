jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
jest.mock("@mantine/modals", () => ({ modals: { openConfirmModal: jest.fn() } }));

import { screen, fireEvent, waitFor } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { modals } from "@mantine/modals";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import { AdminEditHouseholdModal, isFormDirty } from "../AdminEditHouseholdModal";

const base = { name: "Smith", line1: "1 Main", line2: "", city: "Austin", state: "TX", postalCode: "78701", emergencyContactName: "Jo", emergencyContactPhone: "5550000", memberSince: "2020-01-15", isVolunteerFamily: false };

describe("isFormDirty", () => {
  it("is false when snapshots match", () => {
    expect(isFormDirty(base, { ...base })).toBe(false);
  });

  it("is true when any field differs", () => {
    expect(isFormDirty(base, { ...base, name: "Jones" })).toBe(true);
    expect(isFormDirty(base, { ...base, emergencyContactPhone: "5551111" })).toBe(true);
    expect(isFormDirty(base, { ...base, memberSince: "2021-06-01" })).toBe(true);
    expect(isFormDirty(base, { ...base, isVolunteerFamily: true })).toBe(true);
  });
});

const household = {
  id: 55,
  name: "Smith Family",
  line1: "1 Main St",
  line2: "Apt 2",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  emergencyContactName: "Jo Smith",
  emergencyContactPhone: "555-123-4567",
  householdMembers: [
    { id: 1, name: "Kid A", email: "kid@example.com" },
    { id: 2, name: null, email: null },
  ],
  householdLeads: [{ personId: 1 }, { personId: 2 }],
};

beforeEach(() => {
  resetRtl();
  (notifications.show as jest.Mock).mockClear();
});

describe("AdminEditHouseholdModal", () => {
  it("does nothing while closed or without a household id", () => {
    const fetchMock = mockFetchJson({});
    renderWithProviders(<AdminEditHouseholdModal householdId={null} opened={true} onClose={jest.fn()} />);
    renderWithProviders(<AdminEditHouseholdModal householdId={55} opened={false} onClose={jest.fn()} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a loading spinner while the household is in flight", async () => {
    let resolveFetch!: (v: unknown) => void;
    global.fetch = jest.fn(() => new Promise((resolve) => { resolveFetch = resolve; })) as unknown as typeof fetch;
    renderWithProviders(<AdminEditHouseholdModal householdId={55} opened={true} onClose={jest.fn()} />);

    // Modal content renders into a portal (outside the render() container), and
    // mounts on a transition tick, not synchronously.
    await waitFor(() => expect(document.querySelector(".mantine-Loader-root")).toBeInTheDocument());
    expect(screen.queryByLabelText("Household Name")).not.toBeInTheDocument();

    resolveFetch({ ok: true, json: async () => ({ household }) });
    expect(await screen.findByDisplayValue("Smith Family")).toBeInTheDocument();
  });

  it("loads and lets every field be edited, then saves as admin", async () => {
    const onSaved = jest.fn();
    const onClose = jest.fn();
    const fetchMock = mockFetchJson({
      "/api/membership-ops/households?id=55": { household },
      "/api/membership-ops/households/55": { household: { ...household, name: "Smith Fam" } },
    });
    renderWithProviders(<AdminEditHouseholdModal householdId={55} opened={true} onClose={onClose} onSaved={onSaved} />);

    expect(await screen.findByDisplayValue("Smith Family")).toBeInTheDocument();
    expect(screen.getByText("Edit Household Info — Smith Family")).toBeInTheDocument();
    expect(screen.getByText("Kid A")).toBeInTheDocument();
    expect(screen.getByText("kid@example.com")).toBeInTheDocument();
    expect(screen.getByText("#2")).toBeInTheDocument(); // name fallback for the null-named lead

    fireEvent.change(screen.getByLabelText("Household Name"), { target: { value: "Smith Fam" } });
    fireEvent.change(screen.getByLabelText("Street Address"), { target: { value: "2 Main St" } });
    fireEvent.change(screen.getByLabelText("Apt / Suite (optional)"), { target: { value: "Apt 3" } });
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Round Rock" } });
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "TX" } });
    fireEvent.change(screen.getByLabelText("ZIP"), { target: { value: "78664" } });
    fireEvent.change(screen.getByLabelText("Emergency Contact Name"), { target: { value: "Jo S." } });
    fireEvent.change(screen.getByLabelText("Emergency Contact Phone"), { target: { value: "5559999999" } });

    // Admin-power notice is inline; save is a single orange button.
    expect(screen.getByText(/editing/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes — As Admin" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/membership-ops/households/55", expect.objectContaining({ method: "PATCH" })),
    );
    const [, patchOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PATCH")!;
    expect(JSON.parse(patchOpts!.body as string)).toEqual(
      expect.objectContaining({ name: "Smith Fam", line1: "2 Main St", city: "Round Rock", postalCode: "78664" }),
    );

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Household updated." })));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: "Smith Fam" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows an inline phone error and blocks save until fixed", async () => {
    const fetchMock = mockFetchJson({ "/api/membership-ops/households?id=55": { household } });
    renderWithProviders(<AdminEditHouseholdModal householdId={55} opened={true} onClose={jest.fn()} />);
    await screen.findByDisplayValue("Smith Family");

    fetchMock.mockClear();
    fireEvent.change(screen.getByLabelText("Emergency Contact Phone"), { target: { value: "555" } });
    expect(screen.getByText("Enter a valid 10-digit US phone number.")).toBeInTheDocument();

    const save = screen.getByRole("button", { name: "Save Changes — As Admin" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(fetchMock).not.toHaveBeenCalledWith("/api/membership-ops/households/55", expect.anything());
  });

  it("prompts before discarding unsaved edits, and closes directly when nothing changed", async () => {
    const onClose = jest.fn();
    mockFetchJson({ "/api/membership-ops/households?id=55": { household } });
    renderWithProviders(<AdminEditHouseholdModal householdId={55} opened={true} onClose={onClose} />);
    await screen.findByDisplayValue("Smith Family");

    const openConfirmModal = modals.openConfirmModal as jest.Mock;

    // Not dirty -> closes without prompting.
    openConfirmModal.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(openConfirmModal).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Household Name"), { target: { value: "Changed" } });

    // Dirty -> confirm modal opens; cancelling ("Keep editing") never fires onConfirm.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(openConfirmModal).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1); // still just the earlier call — no confirm yet

    // Confirming ("Discard") invokes the modal's onConfirm, which calls onClose.
    openConfirmModal.mock.calls[0][0].onConfirm();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("shows an error notification when the household fails to load", async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error("net"))) as unknown as typeof fetch;
    renderWithProviders(<AdminEditHouseholdModal householdId={55} opened={true} onClose={jest.fn()} />);

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Failed to load household." })),
    );
    expect(screen.getByLabelText("Household Name")).toHaveValue("");
  });

  it("shows a server error message, then a network-error message, when saving fails", async () => {
    mockFetchJson({ "/api/membership-ops/households?id=55": { household } });
    renderWithProviders(<AdminEditHouseholdModal householdId={55} opened={true} onClose={jest.fn()} />);
    await screen.findByDisplayValue("Smith Family");

    global.fetch = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "Name taken." }) })) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Save Changes — As Admin" }));
    // Failure routes to a modal-local Alert next to the form, not a corner toast.
    expect(await screen.findByText("Name taken.")).toBeInTheDocument();
    // The modal stays open on failure (only success calls onClose).
    expect(screen.getByText(/Edit Household Info/)).toBeInTheDocument();

    global.fetch = jest.fn(() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Save Changes — As Admin" }));
    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Network error.", autoClose: false })));
  });

  it("removes a lead (reloading after success) and blocks removing the last lead", async () => {
    mockFetchJson({
      "/api/membership-ops/households?id=55": { household },
      "/api/household/lead": { ok: true },
    });
    renderWithProviders(<AdminEditHouseholdModal householdId={55} opened={true} onClose={jest.fn()} />);
    await screen.findByDisplayValue("Smith Family");

    const removeButtons = screen.getAllByRole("button", { name: "Remove lead" });
    expect(removeButtons).toHaveLength(2);
    expect(removeButtons[0]).toBeEnabled();

    const reduced = { ...household, householdLeads: [{ personId: 2 }] };
    const fetchMock = mockFetchJson({
      "/api/household/lead": { ok: true },
      "/api/membership-ops/households?id=55": { household: reduced },
    });
    fireEvent.click(removeButtons[0]);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/household/lead",
        expect.objectContaining({ method: "DELETE", body: JSON.stringify({ participantId: 1 }) }),
      ),
    );
    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Lead removed." })));

    // Now down to a single lead: the last remaining Remove-lead button is disabled
    // and the "must keep at least one lead" copy shows.
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Remove lead" })).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Remove lead" })).toBeDisabled();
    expect(screen.getByText("A household must keep at least one lead.")).toBeInTheDocument();
  });

  it("promotes a non-lead adult to lead, excluding youth and existing leads", async () => {
    // One lead (adult), one promotable adult, one youth. Only the promotable
    // adult gets a Make-lead button; youth is excluded, the lead has Remove.
    const oneLady = {
      ...household,
      householdLeads: [{ personId: 1 }],
      householdMembers: [
        { id: 1, name: "Lead Adult", email: "lead@example.com", dateOfBirth: "1985-01-01" },
        { id: 2, name: "Other Adult", email: "adult@example.com", dateOfBirth: "1990-01-01" },
        { id: 3, name: "A Kid", email: null, dateOfBirth: "2015-01-01" },
      ],
    };
    const promoted = { ...oneLady, householdLeads: [{ personId: 1 }, { personId: 2 }] };
    mockFetchJson({
      "/api/membership-ops/households?id=55": { household: oneLady },
      "/api/household/lead": { ok: true },
    });
    renderWithProviders(<AdminEditHouseholdModal householdId={55} opened={true} onClose={jest.fn()} />);
    await screen.findByDisplayValue("Smith Family");

    const makeLeadButtons = screen.getAllByRole("button", { name: "Make lead" });
    expect(makeLeadButtons).toHaveLength(1); // Other Adult only — not the youth, not the lead
    expect(screen.getByText("Other Adult")).toBeInTheDocument();
    expect(screen.queryByText("A Kid")).not.toBeInTheDocument();

    // After a successful promote the reload shows both leads and no Make-lead button (cap of 2).
    const fetchMock = mockFetchJson({
      "/api/household/lead": { ok: true },
      "/api/membership-ops/households?id=55": { household: promoted },
    });
    fireEvent.click(makeLeadButtons[0]);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/household/lead",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ participantId: 2 }) }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Make lead" })).not.toBeInTheDocument());
  });

  it("shows a failure notification, and a network-error notification, when removing a lead", async () => {
    mockFetchJson({ "/api/membership-ops/households?id=55": { household } });
    renderWithProviders(<AdminEditHouseholdModal householdId={55} opened={true} onClose={jest.fn()} />);
    await screen.findByDisplayValue("Smith Family");

    global.fetch = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "Cannot remove." }) })) as unknown as typeof fetch;
    fireEvent.click(screen.getAllByRole("button", { name: "Remove lead" })[0]);
    expect(await screen.findByText("Cannot remove.")).toBeInTheDocument();

    global.fetch = jest.fn(() => Promise.reject(new Error("net"))) as unknown as typeof fetch;
    fireEvent.click(screen.getAllByRole("button", { name: "Remove lead" })[0]);
    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Network error.", autoClose: false })));
  });

  it("toggles the volunteer-only flag and sends isVolunteerFamily in the PATCH body", async () => {
    const withMembership = { ...household, orgMembership: { memberSince: "2024-01-15T00:00:00.000Z", isVolunteerFamily: false } };
    const fetchMock = mockFetchJson({
      "/api/membership-ops/households?id=55": { household: withMembership },
      "/api/membership-ops/households/55": { household: withMembership },
    });
    renderWithProviders(<AdminEditHouseholdModal householdId={55} opened={true} onClose={jest.fn()} onSaved={jest.fn()} />);
    await screen.findByDisplayValue("Smith Family");

    fireEvent.click(screen.getByText("Volunteer-only household"));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes — As Admin" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/membership-ops/households/55", expect.objectContaining({ method: "PATCH" })),
    );
    const [, patchOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PATCH")!;
    expect(JSON.parse(patchOpts!.body as string)).toEqual(expect.objectContaining({ isVolunteerFamily: true }));
  });

  it("omits the membership fields from the PATCH body for a membership-less household", async () => {
    const fetchMock = mockFetchJson({
      "/api/membership-ops/households?id=55": { household },
      "/api/membership-ops/households/55": { household },
    });
    renderWithProviders(<AdminEditHouseholdModal householdId={55} opened={true} onClose={jest.fn()} onSaved={jest.fn()} />);
    await screen.findByDisplayValue("Smith Family");

    fireEvent.change(screen.getByLabelText("Household Name"), { target: { value: "Smith Fam" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes — As Admin" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/membership-ops/households/55", expect.objectContaining({ method: "PATCH" })),
    );
    const [, patchOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PATCH")!;
    const body = JSON.parse(patchOpts!.body as string);
    expect(body).toEqual(expect.objectContaining({ name: "Smith Fam" }));
    expect(body).not.toHaveProperty("isVolunteerFamily");
    expect(body).not.toHaveProperty("memberSince");
  });

  it("shows the no-leads state for a household with no household leads", async () => {
    const noLeads = { ...household, householdLeads: undefined, name: null };
    mockFetchJson({ "/api/membership-ops/households?id=55": { household: noLeads } });
    renderWithProviders(<AdminEditHouseholdModal householdId={55} opened={true} onClose={jest.fn()} />);

    expect(await screen.findByText("No leads on this household.")).toBeInTheDocument();
    expect(screen.getByText("Edit Household Info — Household #55")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove lead" })).not.toBeInTheDocument();
  });
});
