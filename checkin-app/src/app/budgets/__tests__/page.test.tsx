type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { renderWithProviders, setSession, resetRtl } from "@/test-helpers/rtl";
import BudgetsPage from "../page";

const programBucket = {
  id: 7,
  name: "Robotics",
  programId: 3,
  archivedAt: null,
  quickBooksClassId: null,
  program: { id: 3, name: "Robotics Team" },
};

type Reply = () => Promise<Response>;
type Reads = Partial<Record<"buckets" | "treasurers", Reply>>;

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
    if (url.includes("/program-options")) return jsonResponse(200, []);
    if (url.includes("/treasurers")) {
      if (reads.treasurers) return reads.treasurers();
      return jsonResponse(200, [{ programId: 3, personId: 9, isTreasurer: false, person: { id: 9, name: "Tess Treasurer" } }]);
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

  it("shows a treasurer change failure in a red chip", async () => {
    mockServer(async () => jsonResponse(403, { error: "You can't set a role or flag on yourself or anyone in your own household." }));
    renderWithProviders(<BudgetsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Treasurers" }));
    fireEvent.click(await screen.findByLabelText("Tess Treasurer"));

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
      color: "red",
      title: "Treasurer not updated",
      message: "You can't set a role or flag on yourself or anyone in your own household. (403)",
      autoClose: false,
    })));
  });

  it("says the treasurers couldn't be loaded instead of spinning", async () => {
    mockServer(ok, { treasurers: async () => { throw new TypeError("Failed to fetch"); } });
    renderWithProviders(<BudgetsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Treasurers" }));

    expect(await screen.findByText("Treasurers couldn't be loaded.")).toBeInTheDocument();
    expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
      color: "red",
      title: "Treasurers not loaded",
      message: "Couldn't reach the server. Check your connection and try again.",
      autoClose: false,
    }));
  });
});
