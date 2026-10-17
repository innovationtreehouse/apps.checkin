// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, setSearchParams, resetRtl, router } from "@/test-helpers/rtl";
import NewEventPage from "../page";

beforeEach(() => resetRtl());

const programs = [{ id: 1, name: "Robotics Club" }];

describe("NewEventPage", () => {
  it("loads programs and creates a one-off event", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/programs": programs, "/api/events": { id: 99 } });
    renderWithProviders(<NewEventPage />);

    expect(await screen.findByText("Schedule Event")).toBeInTheDocument();

    // Required fields render a trailing " *" inside the <label>, so match loosely.
    fireEvent.change(screen.getByLabelText("Event Name", { exact: false }), { target: { value: "Session 1" } });
    fireEvent.change(screen.getByLabelText("Date", { exact: false }), { target: { value: "2026-02-01" } });
    fireEvent.change(screen.getByLabelText("Start Time", { exact: false }), { target: { value: "18:00" } });
    fireEvent.change(screen.getByLabelText("End Time", { exact: false }), { target: { value: "20:00" } });

    fireEvent.click(screen.getByRole("button", { name: "Create Event(s)" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/events",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(router.push).toHaveBeenCalledWith("/program-ops/events");
  });

  it("redirects to the program page when programId is set", async () => {
    setSession({ id: 1, isSysadmin: true });
    setSearchParams("programId=5");
    const fetchMock = mockFetchJson({ "/api/programs": programs, "/api/events": { id: 100 } });
    renderWithProviders(<NewEventPage />);

    await screen.findByText("Schedule Event");

    fireEvent.change(screen.getByLabelText("Event Name", { exact: false }), { target: { value: "Session 2" } });
    fireEvent.change(screen.getByLabelText("Date", { exact: false }), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("Start Time", { exact: false }), { target: { value: "10:00" } });
    fireEvent.change(screen.getByLabelText("End Time", { exact: false }), { target: { value: "12:00" } });

    fireEvent.click(screen.getByRole("button", { name: "Create Event(s)" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/events",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(router.push).toHaveBeenCalledWith("/program-ops/programs/5");
  });

  it("flags an end time before the start time", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/programs": programs });
    renderWithProviders(<NewEventPage />);
    await screen.findByText("Schedule Event");

    fireEvent.change(screen.getByLabelText("Start Time", { exact: false }), { target: { value: "18:00" } });
    fireEvent.change(screen.getByLabelText("End Time", { exact: false }), { target: { value: "17:00" } });
    expect(screen.getByText("End time must be after start time")).toBeInTheDocument();
  });
});
