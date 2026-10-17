// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, setPathname, resetRtl, router } from "@/test-helpers/rtl";
import { notifications } from "@mantine/notifications";
import MyVisits from "../page";

beforeEach(() => {
  resetRtl();
  setPathname("/attendance/my-visits");
  (notifications.show as jest.Mock).mockClear();
});

const visits = [
  { id: 1, arrivedAt: "2026-01-01T14:00:00.000Z", departedAt: "2026-01-01T16:00:00.000Z", event: { name: "Open Gym" } },
  { id: 2, arrivedAt: "2026-01-02T14:00:00.000Z", departedAt: null, event: null },
];

/** Both the listing and the correction endpoints, so a PATCH/DELETE resolves 200. */
function mockRoutes() {
  return mockFetchJson({ "/api/profile/visits": { visits }, "/api/attendance/manual/": { flagged: false } });
}

describe("attendance/my-visits page", () => {
  it("renders the member's own visits", async () => {
    setSession({ id: 1 });
    mockRoutes();
    renderWithProviders(<MyVisits />);

    expect(await screen.findByText("Open Gym")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Edit visit" })).toHaveLength(2);
    expect(router.push).not.toHaveBeenCalled();
  });

  // The gate is a plain sign-in check — no role: correcting your own record is
  // not an admin action.
  it("redirects a signed-out visitor", async () => {
    setSession(null);
    mockRoutes();
    renderWithProviders(<MyVisits />);

    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/"));
  });

  it("saves an edited arrival through the self-correction route", async () => {
    setSession({ id: 1 });
    const fetchMock = mockRoutes();
    renderWithProviders(<MyVisits />);
    await screen.findByText("Open Gym");

    fireEvent.click(screen.getAllByRole("button", { name: "Edit visit" })[0]);
    fireEvent.change(screen.getByLabelText("Arrival time"), { target: { value: "2026-01-01T09:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/attendance/manual/1", expect.objectContaining({ method: "PATCH" })),
    );
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Visit updated." })),
    );
  });

  // A closed visit stays closed: the server ignores a cleared departure, so the
  // page must not offer a save that would toast success over a no-op.
  it("blocks saving a closed visit with the departure cleared", async () => {
    setSession({ id: 1 });
    const fetchMock = mockRoutes();
    renderWithProviders(<MyVisits />);
    await screen.findByText("Open Gym");

    fireEvent.click(screen.getAllByRole("button", { name: "Edit visit" })[0]); // the closed row
    fireEvent.change(screen.getByLabelText("Departure time"), { target: { value: "" } });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/attendance/manual/1", expect.objectContaining({ method: "PATCH" }));
  });

  it("deletes a visit after confirmation", async () => {
    setSession({ id: 1 });
    const fetchMock = mockRoutes();
    window.confirm = jest.fn().mockReturnValue(true);
    renderWithProviders(<MyVisits />);
    await screen.findByText("Open Gym");

    fireEvent.click(screen.getAllByRole("button", { name: "Delete visit" })[0]);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/attendance/manual/1", expect.objectContaining({ method: "DELETE" })),
    );
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Visit deleted." })),
    );
  });

  it("does not delete when the confirmation is dismissed", async () => {
    setSession({ id: 1 });
    const fetchMock = mockRoutes();
    window.confirm = jest.fn().mockReturnValue(false);
    renderWithProviders(<MyVisits />);
    await screen.findByText("Open Gym");

    fireEvent.click(screen.getAllByRole("button", { name: "Delete visit" })[0]);

    expect(fetchMock).not.toHaveBeenCalledWith("/api/attendance/manual/1", expect.objectContaining({ method: "DELETE" }));
  });
});
