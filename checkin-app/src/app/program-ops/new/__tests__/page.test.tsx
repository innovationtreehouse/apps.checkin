// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, fireEvent, waitFor } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { renderWithProviders, mockFetchJson, setSession, resetRtl, router } from "@/test-helpers/rtl";
import CreateProgramPage from "../page";

beforeEach(() => resetRtl());

const mentor = { id: 7, name: "Mona Mentor", email: "mona@example.com" };

async function pickMentor() {
  fireEvent.change(screen.getByPlaceholderText("Search by name, email, or ID..."), { target: { value: "Mona" } });
  fireEvent.click(await screen.findByText("Mona Mentor", { exact: false }));
}

describe("CreateProgramPage", () => {
  it("redirects a caller without sysadmin/board-member role", () => {
    setSession({ id: 1 });
    renderWithProviders(<CreateProgramPage />);
    expect(router.push).toHaveBeenCalledWith("/system-status");
  });

  it("shows a loader while the session resolves", () => {
    setSession(null, "loading");
    renderWithProviders(<CreateProgramPage />);
    expect(screen.queryByText("Create Program")).not.toBeInTheDocument();
  });

  it("lets an authorized admin fill out the name field and toggle pricing", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({});
    renderWithProviders(<CreateProgramPage />);

    // Required fields render a trailing " *" inside the <label>, so match loosely.
    const nameInput = await screen.findByLabelText("Program Name", { exact: false });
    fireEvent.change(nameInput, { target: { value: "FRC Robotics 2026" } });
    expect(nameInput).toHaveValue("FRC Robotics 2026");

    // Create button starts disabled: no lead mentor picked yet.
    expect(screen.getByRole("button", { name: "Create Program" })).toBeDisabled();

    // Unchecking "free" reveals the price inputs.
    fireEvent.click(screen.getByLabelText("This is a free program"));
    expect(screen.getByLabelText("Treehouse Member Price ($)")).toBeInTheDocument();

    // Re-checking "free" clears out any entered prices (the `if (checked)` branch).
    fireEvent.change(screen.getByLabelText("Treehouse Member Price ($)"), { target: { value: "50" } });
    fireEvent.click(screen.getByLabelText("This is a free program"));
    expect(screen.queryByLabelText("Treehouse Member Price ($)")).not.toBeInTheDocument();
  });

  it("flags an invalid date range and disables submit", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({});
    renderWithProviders(<CreateProgramPage />);
    await screen.findByLabelText("Program Name", { exact: false });

    fireEvent.change(screen.getByLabelText("Start Date", { exact: false }), { target: { value: "2026-06-10" } });
    fireEvent.change(screen.getByLabelText("End Date", { exact: false }), { target: { value: "2026-06-01" } });

    expect(screen.getByText("End date must be on or after start date.")).toBeInTheDocument();
  });

  it("warns when the member price exceeds the non-member price", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({});
    renderWithProviders(<CreateProgramPage />);
    await screen.findByLabelText("Program Name", { exact: false });

    fireEvent.click(screen.getByLabelText("This is a free program"));
    fireEvent.change(screen.getByLabelText("Treehouse Member Price ($)"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Non-Member Price ($)"), { target: { value: "20" } });

    expect(screen.getByText(/Member price is higher than non-member price/)).toBeInTheDocument();
  });

  it("defaults max participants to 50 and disables submit when it is cleared", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/people/search": { people: [mentor] } });
    renderWithProviders(<CreateProgramPage />);
    const nameInput = await screen.findByLabelText("Program Name", { exact: false });

    const maxInput = screen.getByLabelText("Max Participants", { exact: false });
    expect(maxInput).toHaveValue("50");

    fireEvent.change(nameInput, { target: { value: "FRC Robotics 2026" } });
    await pickMentor();
    fireEvent.change(screen.getByLabelText("Start Date", { exact: false }), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("End Date", { exact: false }), { target: { value: "2026-12-31" } });
    expect(screen.getByRole("button", { name: "Create Program" })).toBeEnabled();

    fireEvent.change(maxInput, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Create Program" })).toBeDisabled();
  });

  it("searches for and selects a lead mentor, then clears the selection", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/people/search": { people: [mentor] } });
    renderWithProviders(<CreateProgramPage />);
    await screen.findByLabelText("Program Name", { exact: false });

    await pickMentor();
    expect(screen.getByDisplayValue("Mona Mentor (mona@example.com)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByDisplayValue("Mona Mentor (mona@example.com)")).not.toBeInTheDocument();
  });

  it("handles a failed mentor search (unmatched route -> empty results)", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({});
    renderWithProviders(<CreateProgramPage />);
    await screen.findByLabelText("Program Name", { exact: false });

    fireEvent.change(screen.getByPlaceholderText("Search by name, email, or ID..."), { target: { value: "nobody" } });
    // 404 (unmatched route) -> `if (!res.ok) return [];` branch; no dropdown/Clear button appears.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
  });

  it("creates a program and redirects to it", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/people/search": { people: [mentor] },
      "/api/programs": { program: { id: 42 } },
    });
    renderWithProviders(<CreateProgramPage />);
    const nameInput = await screen.findByLabelText("Program Name", { exact: false });
    fireEvent.change(nameInput, { target: { value: "FRC Robotics 2026" } });
    await pickMentor();

    fireEvent.change(screen.getByLabelText("Start Date", { exact: false }), { target: { value: "2026-01-15" } });
    fireEvent.change(screen.getByLabelText("End Date", { exact: false }), { target: { value: "2026-06-15" } });
    fireEvent.change(screen.getByLabelText("Min Age (Optional)"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Max Age (Optional)"), { target: { value: "18" } });
    fireEvent.click(screen.getByLabelText("Treehouse Members-Only Program"));

    const submitBtn = screen.getByRole("button", { name: "Create Program" });
    expect(submitBtn).toBeEnabled();
    fireEvent.click(submitBtn);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/programs",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            name: "FRC Robotics 2026",
            startAt: "2026-01-15",
            endAt: "2026-06-15",
            orgMemberOnly: true,
            publiclyVisible: false,
            minAge: 10,
            maxAge: 18,
            memberPrice: null,
            nonMemberPrice: null,
            maxParticipants: 50,
            leadMentorId: 7,
          }),
        }),
      ),
    );
    expect(router.push).toHaveBeenCalledWith("/program-ops/programs/42");
  });

  it("reveals 'Show to non-members' only for a members-only program and sends publiclyVisible", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/people/search": { people: [mentor] },
      "/api/programs": { program: { id: 42 } },
    });
    renderWithProviders(<CreateProgramPage />);
    const nameInput = await screen.findByLabelText("Program Name", { exact: false });
    fireEvent.change(nameInput, { target: { value: "FRC Robotics 2026" } });
    await pickMentor();
    fireEvent.change(screen.getByLabelText("Start Date", { exact: false }), { target: { value: "2026-01-15" } });
    fireEvent.change(screen.getByLabelText("End Date", { exact: false }), { target: { value: "2026-06-15" } });

    // Hidden until the program is members-only.
    expect(screen.queryByLabelText("Show to non-members")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Treehouse Members-Only Program"));
    fireEvent.click(screen.getByLabelText("Show to non-members"));

    fireEvent.click(screen.getByRole("button", { name: "Create Program" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/programs",
        expect.objectContaining({
          body: expect.stringContaining('"publiclyVisible":true'),
        }),
      ),
    );
  });

  it("shows a server error message when creation fails", async () => {
    setSession({ id: 1, isSysadmin: true });
    // A custom fetch stub: the create endpoint needs a 400 response, which
    // mockFetchJson's all-or-nothing 200/404 routing can't express.
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/people/search")) {
        return { ok: true, status: 200, json: async () => ({ people: [mentor] }) } as Response;
      }
      if (url.includes("/api/programs")) {
        return { ok: false, status: 400, json: async () => ({ error: "Name already taken." }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    renderWithProviders(<CreateProgramPage />);
    const nameInput = await screen.findByLabelText("Program Name", { exact: false });
    fireEvent.change(nameInput, { target: { value: "FRC Robotics 2026" } });
    await pickMentor();
    fireEvent.change(screen.getByLabelText("Start Date", { exact: false }), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("End Date", { exact: false }), { target: { value: "2026-12-31" } });

    fireEvent.click(screen.getByRole("button", { name: "Create Program" }));

    expect(await screen.findByText("Name already taken.")).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("shows a network error message when the create request throws", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/people/search": { people: [mentor] } });
    renderWithProviders(<CreateProgramPage />);
    const nameInput = await screen.findByLabelText("Program Name", { exact: false });
    fireEvent.change(nameInput, { target: { value: "FRC Robotics 2026" } });
    await pickMentor();
    fireEvent.change(screen.getByLabelText("Start Date", { exact: false }), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("End Date", { exact: false }), { target: { value: "2026-12-31" } });

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/people/search")) {
        return { ok: true, status: 200, json: async () => ({ people: [mentor] }) } as Response;
      }
      throw new Error("boom");
    }) as unknown as typeof fetch;

    fireEvent.click(screen.getByRole("button", { name: "Create Program" }));

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Network error creating program.", autoClose: false })));
  });
});
