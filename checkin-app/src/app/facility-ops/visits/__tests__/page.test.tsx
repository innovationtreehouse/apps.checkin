// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl, router } from "@/test-helpers/rtl";
import { notifications } from "@mantine/notifications";
import AdminVisitsPage from "../page";

beforeEach(() => { resetRtl(); (notifications.show as jest.Mock).mockClear(); });

const visits = [
  { id: 1, arrivedAt: "2026-01-01T14:00:00.000Z", departedAt: "2026-01-01T16:00:00.000Z", arrivedVia: "SCANNER", departedVia: "WEB", person: { name: "Val Volunteer" }, event: { name: "Open Gym" } },
  { id: 2, arrivedAt: "2026-01-02T14:00:00.000Z", departedAt: null, arrivedVia: "WEB", person: { name: "Stu Student" }, event: null },
];

describe("facility-ops/visits page", () => {
  it("says the list failed and keeps the controls", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({}); // every fetch 404s
    renderWithProviders(<AdminVisitsPage />);

    expect(await screen.findByText("Couldn't load the visits")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Closed out by a close" })).toBeInTheDocument();
  });

  it("the closed-out filter asks the server for it and labels a nightly sweep Nightly", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/facility/visits?closedOut=true": { visits: [{ ...visits[0], departedVia: "AUTO_CLOSE", facilityCloseId: 7, facilityClose: { closedBy: { name: "Kim Keyholder" } } }] },
      "/api/facility/visits": { visits },
    });
    renderWithProviders(<AdminVisitsPage />);
    await screen.findByText("Val Volunteer");

    fireEvent.click(screen.getByRole("switch", { name: "Closed out by a close" }));

    expect(await screen.findByText("#7 · Nightly")).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain("/api/facility/visits?closedOut=true");
  });

  it("the closed-out filter names who closed for a keyholder close", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/facility/visits?closedOut=true": { visits: [
        { ...visits[0], departedVia: "FACILITY_CLOSE", facilityCloseId: 8, facilityClose: { closedBy: { name: "Kim Keyholder" } } },
        { ...visits[0], id: 3, departedVia: "FACILITY_CLOSE", facilityCloseId: 9, facilityClose: { closedBy: null } },
      ] },
      "/api/facility/visits": { visits },
    });
    renderWithProviders(<AdminVisitsPage />);
    await screen.findByText("Val Volunteer");

    fireEvent.click(screen.getByRole("switch", { name: "Closed out by a close" }));

    expect(await screen.findByText("#8 · Kim Keyholder")).toBeInTheDocument();
    expect(screen.getByText("#9 · Closer deleted")).toBeInTheDocument();
  });

  it("loads and renders visit rows", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/facility/visits": { visits } });
    renderWithProviders(<AdminVisitsPage />);

    expect(await screen.findByText("Val Volunteer")).toBeInTheDocument();
    expect(screen.getByText("Stu Student")).toBeInTheDocument();
    expect(screen.getByText("Open Gym")).toBeInTheDocument();
    expect(screen.getByText("Open Facility")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  // The page must gate on the same roles the PATCH/DELETE /api/facility/visits
  // route allows (['isSysadmin', 'isBoardMember']) — UI and API agree on who
  // may edit/delete a visit.
  it("admits a board member (matches the API's edit/delete grant)", async () => {
    setSession({ id: 3, isBoardMember: true });
    mockFetchJson({ "/api/facility/visits": { visits } });
    renderWithProviders(<AdminVisitsPage />);

    expect(await screen.findByText("Val Volunteer")).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  // Operations reaches attendance in aggregate only — one person's visit
  // record is outside that reach, on the page as on the API.
  it("redirects an operations user", async () => {
    setSession({ id: 5, isOperations: true });
    mockFetchJson({ "/api/facility/visits": { visits } });
    renderWithProviders(<AdminVisitsPage />);

    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/"));
  });

  it("redirects a non-privileged user (denied like the API)", async () => {
    setSession({ id: 4 });
    mockFetchJson({ "/api/facility/visits": { visits } });
    renderWithProviders(<AdminVisitsPage />);

    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/"));
    expect(screen.queryByText("Val Volunteer")).not.toBeInTheDocument();
  });

  it("re-sorts rows when a sortable header is clicked", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/facility/visits": { visits } });
    renderWithProviders(<AdminVisitsPage />);
    await screen.findByText("Val Volunteer");

    fireEvent.click(screen.getByRole("button", { name: /Participant/ }));

    const rows = screen.getAllByRole("row").slice(1); // drop header row
    expect(rows[0]).toHaveTextContent("Stu Student");
  });

  it("filters rows by participant or event", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/facility/visits": { visits } });
    renderWithProviders(<AdminVisitsPage />);
    await screen.findByText("Val Volunteer");

    const input = screen.getByPlaceholderText(/Filter by/);
    fireEvent.change(input, { target: { value: "open facility" } });
    expect(screen.queryByText("Val Volunteer")).not.toBeInTheDocument();
    expect(screen.getByText("Stu Student")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "VAL" } });
    expect(screen.getByText("Val Volunteer")).toBeInTheDocument();
    expect(screen.queryByText("Stu Student")).not.toBeInTheDocument();
  });

  it("edits and saves a visit's arrival/departure", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/facility/visits": { visits } });
    renderWithProviders(<AdminVisitsPage />);
    await screen.findByText("Val Volunteer");

    // The open row offers no Edit or Delete, so the closed row (id 1) holds the only ones.
    // Both times are set, so the save passes the client pre-check and fires the PATCH.
    expect(screen.getByText(/^Still checked in/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const confirmModal = await screen.findByRole("dialog", { name: "Edit Past Visit Record" });
    fireEvent.click(within(confirmModal).getByRole("button", { name: "Continue" }));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/facility/visits",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Visit updated successfully." })));
  });

  it("flags a departure before arrival on the edited row's input and does not save", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/facility/visits": { visits } });
    renderWithProviders(<AdminVisitsPage />);
    await screen.findByText("Val Volunteer");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const confirmModal = await screen.findByRole("dialog", { name: "Edit Past Visit Record" });
    fireEvent.click(within(confirmModal).getByRole("button", { name: "Continue" }));
    const departed = screen.getByLabelText("Departed");
    fireEvent.change(departed, { target: { value: "2000-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(departed).toHaveAttribute("aria-invalid", "true");
    expect(departed).toHaveFocus();
    expect(screen.getByText("Departure time must be after arrival time")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/facility/visits", expect.objectContaining({ method: "PATCH" }));
  });

  it("clears the edited row's departure error once the arrival it was checked against changes", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/facility/visits": { visits } });
    renderWithProviders(<AdminVisitsPage />);
    await screen.findByText("Val Volunteer");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const confirmModal = await screen.findByRole("dialog", { name: "Edit Past Visit Record" });
    fireEvent.click(within(confirmModal).getByRole("button", { name: "Continue" }));
    const departed = screen.getByLabelText("Departed");
    fireEvent.change(departed, { target: { value: "2000-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(departed).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(screen.getByLabelText("Arrived"), { target: { value: "1999-12-31T23:00" } });

    expect(departed).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("Departure time must be after arrival time")).not.toBeInTheDocument();
  });

  it("clears Add Past Visit's departure error once the arrival changes", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/facility/visits": { visits }, "/api/people/search": { people: [] } });
    renderWithProviders(<AdminVisitsPage />);
    await screen.findByText("Val Volunteer");

    fireEvent.click(screen.getByRole("button", { name: "Add Visit" }));
    const dialog = await screen.findByRole("dialog", { name: "Add Past Visit" });
    fireEvent.change(within(dialog).getByLabelText("Arrived"), { target: { value: "2026-01-01T12:00" } });
    fireEvent.change(within(dialog).getByLabelText("Departed"), { target: { value: "2026-01-01T10:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Visit" }));
    expect(within(dialog).getByText("Departure time must be after arrival time")).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("Arrived"), { target: { value: "2026-01-01T09:00" } });

    expect(within(dialog).getByLabelText("Departed")).not.toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).queryByText("Departure time must be after arrival time")).not.toBeInTheDocument();
  });

  it("flags each missing field in Add Past Visit on its input and does not post", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/facility/visits": { visits }, "/api/people/search": { people: [] } });
    renderWithProviders(<AdminVisitsPage />);
    await screen.findByText("Val Volunteer");

    fireEvent.click(screen.getByRole("button", { name: "Add Visit" }));
    const dialog = await screen.findByRole("dialog", { name: "Add Past Visit" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Visit" }));

    const person = within(dialog).getByRole("textbox", { name: "Person" });
    expect(person).toHaveAttribute("aria-invalid", "true");
    expect(person).toHaveFocus();
    expect(within(dialog).getByLabelText("Arrived")).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByLabelText("Departed")).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/insert"))).toBe(false);
    expect(notifications.show).not.toHaveBeenCalled();
  });
  it("show removed lists removed visits beside live ones, naming who removed each", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/facility/visits/restore": {},
      "/api/facility/visits?removed=true": { visits: {
        Visit: [{ ...visits[0], id: 9, person: { name: "Rae Removed" }, deletedAt: "2026-01-03T10:00:00.000Z", deletedById: 4 }],
        Person: [{ id: 4, name: "Bo Board" }],
      } },
      "/api/facility/visits": { visits },
    });
    renderWithProviders(<AdminVisitsPage />);
    await screen.findByText("Val Volunteer");
    expect(screen.queryByText("Rae Removed")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Show removed" }));

    const row = (await screen.findByText("Rae Removed")).closest("tr") as HTMLElement;
    expect(screen.getByText("Val Volunteer")).toBeInTheDocument();
    expect(row).toHaveTextContent(/Bo Board · /);
    expect(within(row).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "Restore" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/facility/visits/restore",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ visitId: 9 }) }),
      ),
    );
    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Visit restored." })));
    // The write re-reads both lists, so the restored visit moves to the live list.
    const removedReads = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("?removed=true")).length;
    await waitFor(() => expect(removedReads()).toBeGreaterThan(1));
  });

  it("the closed-out view lists no removed visits while show removed is on, and keeps the server's close order", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/facility/visits?closedOut=true": { visits: [
        { ...visits[0], id: 5, person: { name: "Cal Close9" }, departedVia: "FACILITY_CLOSE", facilityCloseId: 9, facilityClose: { closedBy: { name: "Kim Keyholder" } } },
        { ...visits[0], id: 6, person: { name: "Cy Close8" }, departedVia: "FACILITY_CLOSE", facilityCloseId: 8, facilityClose: { closedBy: { name: "Kim Keyholder" } } },
      ] },
      "/api/facility/visits?removed=true": { visits: {
        Visit: [{ ...visits[0], id: 7, person: { name: "Rae Removed" }, departedVia: "FACILITY_CLOSE", facilityCloseId: 9, deletedAt: "2026-01-03T10:00:00.000Z", deletedById: 4 }],
        Person: [{ id: 4, name: "Bo Board" }],
      } },
      "/api/facility/visits": { visits },
    });
    renderWithProviders(<AdminVisitsPage />);
    await screen.findByText("Val Volunteer");
    fireEvent.click(screen.getByRole("switch", { name: "Show removed" }));
    expect(await screen.findByText("Rae Removed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Closed out by a close" }));

    await screen.findByText("Cal Close9");
    expect(screen.queryByText("Rae Removed")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Removed" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Show removed" })).toBeDisabled();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual(["5", "6"]);

    fireEvent.click(screen.getByRole("switch", { name: "Closed out by a close" }));

    expect(await screen.findByText("Rae Removed")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Removed" })).toBeInTheDocument();
  });
});
