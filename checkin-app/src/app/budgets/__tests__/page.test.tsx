type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), hide: jest.fn() } }));

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { renderWithProviders, setSession, resetRtl } from "@/test-helpers/rtl";
import BudgetsPage from "../page";

const programBucket = {
  id: 7,
  name: "Robotics",
  isOrgLevel: false,
  archivedAt: null,
  quickBooksClassId: null,
};

type Reply = () => Promise<Response>;
type Reads = Partial<Record<"buckets" | "classes" | "approvers" | "approverOptions", Reply>>;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function htmlResponse(status: number): Response {
  return { ok: false, status, json: async () => { throw new SyntaxError("Unexpected token <"); } } as unknown as Response;
}

// GETs serve the page's lists, unless `reads` overrides one; every other method answers with `write`.
function mockServer(write: Reply, reads: Reads = {}) {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (init?.method) return write();
    if (url.includes("/quickbooks-classes")) return reads.classes ? reads.classes() : jsonResponse(200, []);
    if (url.includes("/approver-options")) {
      return reads.approverOptions ? reads.approverOptions() : jsonResponse(200, [{ id: 9, name: "Tess Treasurer" }]);
    }
    if (url.includes("/approvers")) {
      if (reads.approvers) return reads.approvers();
      return jsonResponse(200, [{ budgetOwnerId: 7, personId: 9, name: "Tess Treasurer", role: "TREASURER" }]);
    }
    if (reads.buckets) return reads.buckets();
    return jsonResponse(200, [programBucket]);
  }) as unknown as typeof fetch;
}

const ok: Reply = async () => jsonResponse(200, {});

async function createBucket() {
  renderWithProviders(<BudgetsPage />);
  fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Shop" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
}

beforeEach(() => {
  resetRtl();
  (notifications.show as jest.Mock).mockClear();
  (notifications.hide as jest.Mock).mockClear();
  setSession({ id: 1, isFinance: true, isBoardMember: true });
});

describe("budgets page write errors", () => {
  it("shows the server's error and status in a red chip that stays up", async () => {
    mockServer(async () => jsonResponse(409, { error: "That QuickBooks Class is already mapped to another bucket." }));
    await createBucket();

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
      color: "red",
      title: "Bucket not created",
      message: "That QuickBooks Class is already mapped to another bucket. (409)",
      autoClose: false,
    })));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("names the status when the reply carries no JSON error", async () => {
    mockServer(async () => htmlResponse(500));
    await createBucket();

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
      color: "red",
      message: "The server returned an unexpected error (500).",
    })));
  });

  it.each([502, 503, 504])("says the server is unavailable on a bare %i", async (status) => {
    mockServer(async () => htmlResponse(status));
    await createBucket();

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
      color: "red",
      message: `The server is unavailable (${status}). Try again in a minute.`,
    })));
  });

  it("says the server is unreachable when the request never lands", async () => {
    mockServer(async () => { throw new TypeError("Failed to fetch"); });
    await createBucket();

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
      color: "red",
      message: "Couldn't reach the server. Check your connection and try again.",
    })));
  });

  it("keeps the form filled when the create fails", async () => {
    mockServer(async () => jsonResponse(400, { error: "name is required" }));
    await createBucket();

    await waitFor(() => expect(notifications.show).toHaveBeenCalled());
    expect(screen.getByLabelText("Name")).toHaveValue("Shop");
  });

  it("shows a save failure in a red chip", async () => {
    mockServer(async () => jsonResponse(400, { error: "name is required" }));
    renderWithProviders(<BudgetsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
      color: "red",
      title: "Bucket not saved",
      message: "name is required (400)",
      autoClose: false,
    })));
  });

  it("shows an archive failure in a red chip", async () => {
    jest.spyOn(window, "confirm").mockReturnValue(true);
    mockServer(async () => htmlResponse(503));
    renderWithProviders(<BudgetsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
      color: "red",
      title: "Bucket not archived",
      message: "The server is unavailable (503). Try again in a minute.",
      autoClose: false,
    })));
  });

  it("shows a red chip when the reload after a write fails", async () => {
    let reloads = 0;
    mockServer(ok, {
      buckets: async () => (reloads++ === 0 ? jsonResponse(200, [programBucket]) : htmlResponse(502)),
    });
    await createBucket();

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
      color: "red",
      title: "Buckets not loaded",
      message: "The server is unavailable (502). Try again in a minute.",
      autoClose: false,
    })));
    expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Bucket created." }));
  });

  it("replaces the failure chip on a retry and clears it on success", async () => {
    const replies = [jsonResponse(400, { error: "name is required" }), jsonResponse(400, { error: "name is required" }), jsonResponse(200, {})];
    mockServer(async () => replies.shift() ?? jsonResponse(200, {}));
    await createBucket();
    await waitFor(() => expect(notifications.show).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(notifications.show).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Bucket created." })));
    const failures = (notifications.show as jest.Mock).mock.calls.filter(([n]) => n.title === "Bucket not created");
    expect(failures).toHaveLength(2);
    expect(failures.every(([n]) => n.id === "Bucket not created")).toBe(true);
    expect((notifications.hide as jest.Mock).mock.calls.filter(([id]) => id === "Bucket not created").length).toBeGreaterThanOrEqual(3);
  });

  it("shows a red chip when the QuickBooks Class list fails", async () => {
    mockServer(ok, { classes: async () => jsonResponse(502, { error: "QuickBooks is not connected" }) });
    renderWithProviders(<BudgetsPage />);

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
      color: "red",
      title: "QuickBooks Classes unavailable",
      message: "QuickBooks is not connected (502)",
      autoClose: false,
    })));
  });

  it("shows an approver change failure in a red chip", async () => {
    mockServer(async () => jsonResponse(403, { error: "You can't set a role or flag on yourself or anyone in your own household." }));
    renderWithProviders(<BudgetsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Approvers" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
      color: "red",
      title: "Approvers not changed",
      message: "You can't set a role or flag on yourself or anyone in your own household. (403)",
      autoClose: false,
    })));
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("says the approvers couldn't be loaded instead of spinning", async () => {
    mockServer(ok, { approvers: async () => { throw new TypeError("Failed to fetch"); } });
    renderWithProviders(<BudgetsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Approvers" }));

    expect(await screen.findByText("Approvers couldn't be loaded.")).toBeInTheDocument();
    expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
      color: "red",
      title: "Approvers not loaded",
      message: "Couldn't reach the server. Check your connection and try again.",
      autoClose: false,
    }));
  });

  it("shows a red chip when the people for the approver pickers fail to load", async () => {
    mockServer(ok, { approverOptions: async () => htmlResponse(504) });
    renderWithProviders(<BudgetsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Approvers" }));

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
      color: "red",
      title: "People not loaded",
      message: "The server is unavailable (504). Try again in a minute.",
      autoClose: false,
    })));
    expect(await screen.findByRole("button", { name: "Remove" })).toBeInTheDocument();
  });
});

describe("budgets approvers owner", () => {
  const people = async () => jsonResponse(200, [{ id: 9, name: "Tess Treasurer" }, { id: 11, name: "Olive Owner" }]);
  const writes = () => (global.fetch as jest.Mock).mock.calls.filter(([, init]) => init?.method);

  async function pickOwner(name: string) {
    renderWithProviders(<BudgetsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Approvers" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("textbox", { name: "Owner" }));
    fireEvent.click(await screen.findByRole("option", { name }));
    return dialog;
  }

  it("sends nothing when a name is picked", async () => {
    mockServer(ok, { approverOptions: people });
    const dialog = await pickOwner("Olive Owner");

    expect(within(dialog).getByRole("textbox", { name: "Owner" })).toHaveValue("Olive Owner");
    expect(writes()).toHaveLength(0);
  });

  it("disables Save until the pick differs from the saved owner", async () => {
    mockServer(ok, { approverOptions: people });
    renderWithProviders(<BudgetsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Approvers" }));
    const dialog = await screen.findByRole("dialog");

    expect(await within(dialog).findByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("saves the picked owner with one PUT and shows the saved owner", async () => {
    mockServer(async () => jsonResponse(200, [
      { budgetOwnerId: 7, personId: 11, name: "Olive Owner", role: "OWNER" },
      { budgetOwnerId: 7, personId: 9, name: "Tess Treasurer", role: "TREASURER" },
    ]), { approverOptions: people });
    const dialog = await pickOwner("Olive Owner");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled());
    expect(writes()).toEqual([[
      "/api/budget-owners/7/owner",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ personId: 11 }) }),
    ]]);
    expect(within(dialog).getByRole("textbox", { name: "Owner" })).toHaveValue("Olive Owner");
  });

  it("keeps the pick and shows a red chip when the save fails", async () => {
    mockServer(async () => jsonResponse(403, { error: "You can't set a role or flag on yourself or anyone in your own household." }), {
      approverOptions: people,
    });
    const dialog = await pickOwner("Olive Owner");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
      color: "red",
      title: "Approvers not changed",
      message: "You can't set a role or flag on yourself or anyone in your own household. (403)",
      autoClose: false,
    })));
    expect(within(dialog).getByRole("textbox", { name: "Owner" })).toHaveValue("Olive Owner");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled());
  });
});
