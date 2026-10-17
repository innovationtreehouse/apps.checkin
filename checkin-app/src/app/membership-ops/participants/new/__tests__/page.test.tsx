// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, setSearchParams, resetRtl, router } from "@/test-helpers/rtl";
import { notifications } from "@mantine/notifications";
import NewParticipantPage from "../page";

beforeEach(() => { resetRtl(); (notifications.show as jest.Mock).mockClear(); });

const household = { id: 9, name: "The Does", householdMembers: [{ id: 1, name: "Jane Doe", email: null }, { id: 2, name: null, email: "john@example.com" }] };
const emptyHousehold = { id: 8, name: "", householdMembers: [] };

describe("membership-ops/participants/new page", () => {
  it("renders the registration form", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({});
    renderWithProviders(<NewParticipantPage />);

    expect(await screen.findByText("Register New User")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Participant" })).toBeDisabled();
    expect(screen.getByText(/Printed on name badges exactly as typed/)).toBeInTheDocument();
  });

  it("submits a new adult participant", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/membership-ops/participants": { participant: { email: "jane@example.com" } },
    });
    renderWithProviders(<NewParticipantPage />);
    await screen.findByText("Register New User");

    fireEvent.change(screen.getByPlaceholderText("e.g. Jane Doe"), { target: { value: "Jane Doe" } });
    fireEvent.change(screen.getByPlaceholderText("jane.doe@example.com"), { target: { value: "jane@example.com" } });

    const submitBtn = screen.getByRole("button", { name: "Create Participant" });
    expect(submitBtn).toBeEnabled();
    fireEvent.click(submitBtn);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/membership-ops/participants",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            name: "Jane Doe",
            email: "jane@example.com",
            parentEmail: null,
            parentName: null,
            dob: null,
            householdId: null,
          }),
        }),
      ),
    );
    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Participant Jane Doe successfully!" })));
  });

  it("requires a parent email once a student DOB is entered", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({});
    renderWithProviders(<NewParticipantPage />);
    await screen.findByText("Register New User");

    fireEvent.change(screen.getByLabelText("Date of Birth"), { target: { value: "2015-01-01" } });

    expect(await screen.findByText("Student Detected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Participant" })).toBeDisabled();
  });

  it("prefills the household from a deep-linked householdId", async () => {
    setSession({ id: 1, isSysadmin: true });
    setSearchParams("householdId=5");
    mockFetchJson({
      "/api/membership-ops/households?id=5": { household: { id: 5, name: "The Smiths" } },
    });
    renderWithProviders(<NewParticipantPage />);

    expect(await screen.findByDisplayValue("The Smiths")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← Households" })).toHaveAttribute("href", "/membership-ops/households");
  });

  it("keeps the generic back link when not deep-linked from a household", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({});
    renderWithProviders(<NewParticipantPage />);

    await screen.findByText("Register New User");
    expect(screen.getByRole("link", { name: "← Membership Ops" })).toHaveAttribute("href", "/membership-ops");
  });

  it("redirects a caller without sysadmin/board-member role, and shows a loader while resolving", () => {
    setSession(null, "loading");
    renderWithProviders(<NewParticipantPage />);
    expect(screen.queryByText("Register New User")).not.toBeInTheDocument();

    setSession({ id: 1 });
    renderWithProviders(<NewParticipantPage />);
    expect(router.push).toHaveBeenCalledWith("/");
  });

  it("falls back to a numbered household label when the deep-linked household has no name", async () => {
    setSession({ id: 1, isSysadmin: true });
    setSearchParams("householdId=8");
    mockFetchJson({ "/api/membership-ops/households?id=8": { household: emptyHousehold } });
    renderWithProviders(<NewParticipantPage />);

    expect(await screen.findByDisplayValue("Household #8")).toBeInTheDocument();
  });

  it("leaves the household unset when the deep-link lookup fails", async () => {
    setSession({ id: 1, isSysadmin: true });
    setSearchParams("householdId=404");
    mockFetchJson({}); // unmatched -> 404, res.ok false
    renderWithProviders(<NewParticipantPage />);
    await screen.findByText("Register New User");
    expect(screen.getByPlaceholderText("Search households...")).toHaveValue("");
  });

  it("leaves the household unset when the deep-link lookup returns no household", async () => {
    setSession({ id: 1, isSysadmin: true });
    setSearchParams("householdId=204");
    mockFetchJson({ "/api/membership-ops/households?id=204": {} }); // ok, but no `household`
    renderWithProviders(<NewParticipantPage />);
    await screen.findByText("Register New User");
    expect(screen.getByPlaceholderText("Search households...")).toHaveValue("");
  });

  it("logs and recovers when the deep-link lookup throws", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    setSession({ id: 1, isSysadmin: true });
    setSearchParams("householdId=9");
    global.fetch = jest.fn(() => Promise.reject(new Error("net"))) as unknown as typeof fetch;
    renderWithProviders(<NewParticipantPage />);
    await screen.findByText("Register New User");

    await waitFor(() => expect(consoleError).toHaveBeenCalledWith("Failed to fetch deep linked household:", expect.any(Error)));
    consoleError.mockRestore();
  });

  it("searches, selects, and clears a household", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/membership-ops/households": { households: [household] } });
    renderWithProviders(<NewParticipantPage />);
    await screen.findByText("Register New User");

    fireEvent.change(screen.getByPlaceholderText("Search households..."), { target: { value: "Does" } });
    fireEvent.click(await screen.findByText("The Does", { exact: false }));
    expect(screen.getByDisplayValue("The Does")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByDisplayValue("The Does")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/already a paid member/)).not.toBeInTheDocument();
  });

  it("requires a name before allowing submit", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({});
    renderWithProviders(<NewParticipantPage />);
    await screen.findByText("Register New User");

    fireEvent.change(screen.getByPlaceholderText("jane.doe@example.com"), { target: { value: "jane@example.com" } });
    expect(screen.getByRole("button", { name: "Create Participant" })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("e.g. Jane Doe"), { target: { value: "  " } });
    expect(screen.getByRole("button", { name: "Create Participant" })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("e.g. Jane Doe"), { target: { value: "Jane Doe" } });
    expect(screen.getByRole("button", { name: "Create Participant" })).toBeEnabled();
  });

  it("submits an adult assigned to a household", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/membership-ops/households": { households: [household] },
      "/api/membership-ops/participants": { participant: { email: "member@example.com" } },
    });
    renderWithProviders(<NewParticipantPage />);
    await screen.findByText("Register New User");

    fireEvent.change(screen.getByPlaceholderText("e.g. Jane Doe"), { target: { value: "Household Member" } });
    fireEvent.change(screen.getByPlaceholderText("Search households..."), { target: { value: "Does" } });
    fireEvent.click(await screen.findByText("The Does", { exact: false }));

    fireEvent.click(screen.getByRole("button", { name: "Create Participant" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/membership-ops/participants",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            name: "Household Member", email: null, parentEmail: null, parentName: null, dob: null, householdId: 9,
          }),
        }),
      ),
    );
    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Participant Household Member successfully!" })));
  });

  it("submits a student with a parent email and no household", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/membership-ops/participants": { participant: { email: "kid@example.com" } },
    });
    renderWithProviders(<NewParticipantPage />);
    await screen.findByText("Register New User");

    fireEvent.change(screen.getByPlaceholderText("e.g. Jane Doe"), { target: { value: "Kid Name" } });
    fireEvent.change(screen.getByLabelText("Date of Birth"), { target: { value: "2015-01-01" } });
    await screen.findByText("Student Detected");
    fireEvent.change(screen.getByLabelText(/Parent \/ Guardian Google Email/), { target: { value: "parent@example.com" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. John Doe"), { target: { value: "Parent Name" } });
    expect(screen.queryByLabelText(/already a paid member/)).not.toBeInTheDocument();

    const submitBtn = screen.getByRole("button", { name: "Create Participant" });
    expect(submitBtn).toBeEnabled();
    fireEvent.click(submitBtn);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/membership-ops/participants",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            name: "Kid Name", email: null, parentEmail: "parent@example.com", parentName: "Parent Name", dob: "2015-01-01", householdId: null,
          }),
        }),
      ),
    );
  });

  it("shows a server error message, then a network-error message, on submit failure", async () => {
    setSession({ id: 1, isSysadmin: true });
    renderWithProviders(<NewParticipantPage />);
    await screen.findByText("Register New User");
    fireEvent.change(screen.getByPlaceholderText("e.g. Jane Doe"), { target: { value: "Jane Doe" } });
    fireEvent.change(screen.getByPlaceholderText("jane.doe@example.com"), { target: { value: "jane@example.com" } });

    global.fetch = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "Email taken." }) })) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Create Participant" }));
    expect(await screen.findByText("Email taken.")).toBeInTheDocument();

    global.fetch = jest.fn(() => Promise.reject(new Error("net"))) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Create Participant" }));
    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ color: "red", message: "Network error", autoClose: false })));
  });
});
