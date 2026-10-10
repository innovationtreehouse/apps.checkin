/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */
import { screen, fireEvent, waitFor } from "@testing-library/react";
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import { notifications } from "@mantine/notifications";
import ProfilePage from "../page";

beforeEach(() => { resetRtl(); (notifications.show as jest.Mock).mockClear(); });

describe("ProfilePage", () => {
    it("loads an adult's profile and saves an edit", async () => {
        setSession({ id: 1 });
        const fetchMock = mockFetchJson({
            "/api/profile": { profile: { name: "Jamie Adult", email: "jamie@example.com", phone: "555-1111", dateOfBirth: "1990-01-01" } },
        });
        renderWithProviders(<ProfilePage />);

        // "required" adds a visually-hidden "*" to the label text, so match by substring.
        const nameInput = await screen.findByLabelText(/Full Name/);
        expect(nameInput).toHaveValue("Jamie Adult");
        expect(nameInput).not.toBeDisabled();
        expect(screen.getByText(/Printed on name badges exactly as typed/)).toBeInTheDocument();

        fireEvent.change(nameInput, { target: { value: "Jamie Updated" } });
        fireEvent.click(screen.getByRole("button", { name: "Save Profile" }));

        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Profile updated successfully!" })));
        expect(fetchMock).toHaveBeenCalledWith("/api/profile", expect.objectContaining({ method: "PATCH" }));
    });

    // The nickname an admin set while printing has to be visible and editable here —
    // it is the member's own name, not a back-office label.
    it("shows the nickname on file and saves an edit to it", async () => {
        setSession({ id: 1 });
        const fetchMock = mockFetchJson({
            "/api/profile": { profile: { name: "David Smith", nickname: "Dave", email: "d@example.com", phone: "555-1111", dateOfBirth: "1990-01-01" } },
        });
        renderWithProviders(<ProfilePage />);

        const nicknameInput = await screen.findByLabelText(/Nickname/);
        expect(nicknameInput).toHaveValue("Dave");

        fireEvent.change(nicknameInput, { target: { value: "Davey" } });
        fireEvent.click(screen.getByRole("button", { name: "Save Profile" }));

        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Profile updated successfully!" })));
        const [, patchOpts] = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
        expect(JSON.parse(patchOpts!.body as string)).toMatchObject({ nickname: "Davey" });
    });

    it("prefills the over-25 attestation and posts it without a DoB", async () => {
        setSession({ id: 3 });
        const fetchMock = mockFetchJson({
            "/api/profile": { profile: { name: "Pat Declared", email: "pat@example.com", phone: "555-3333", dateOfBirth: null, isDeclaredAdult: true } },
        });
        renderWithProviders(<ProfilePage />);

        const over25 = await screen.findByLabelText("I am over 25");
        expect(over25).toBeChecked();
        // With the attestation on, the DoB field is hidden entirely.
        expect(screen.queryByLabelText("Date of Birth")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Save Profile" }));

        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Profile updated successfully!" })));
        const [, patchOpts] = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
        expect(JSON.parse(patchOpts!.body as string)).toMatchObject({ over25: true, dob: null });
    });

    it("checking over-25 clears and hides the DoB field", async () => {
        setSession({ id: 4 });
        const fetchMock = mockFetchJson({
            "/api/profile": { profile: { name: "Sam Adult", email: "sam@example.com", phone: "555-4444", dateOfBirth: "1990-01-01" } },
        });
        renderWithProviders(<ProfilePage />);

        expect(await screen.findByLabelText("Date of Birth")).toHaveValue("1990-01-01");
        fireEvent.click(screen.getByLabelText("I am over 25"));
        expect(screen.queryByLabelText("Date of Birth")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Save Profile" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Profile updated successfully!" })));
        const [, patchOpts] = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
        expect(JSON.parse(patchOpts!.body as string)).toMatchObject({ over25: true, dob: null });
    });

    it("locks the form as read-only for a youth", async () => {
        setSession({ id: 2 });
        mockFetchJson({
            "/api/profile": { profile: { name: "Kid One", email: "kid@example.com", phone: "555-2222", dateOfBirth: "2020-01-01" } },
        });
        renderWithProviders(<ProfilePage />);

        expect(await screen.findByLabelText(/Full Name/)).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Save Profile" })).not.toBeInTheDocument();
    });

    it.each([
        ["Board <board@example.org>", "This is the address you sign in with. To change it, email the board at board@example.org."],
        [null, "This is the address you sign in with. To change it, contact the board."],
    ])("locks the email with how-to-change help (reply-to %p)", async (boardReplyTo, help) => {
        setSession({ id: 1 });
        mockFetchJson({
            "/api/profile": { profile: { name: "Jamie Adult", email: "jamie@example.com", phone: "555-1111", dateOfBirth: "1990-01-01" } },
            "/api/household": { household: null, boardReplyTo },
        });
        renderWithProviders(<ProfilePage />);

        expect(await screen.findByLabelText("Email Address")).toBeDisabled();
        expect(await screen.findByText(help)).toBeInTheDocument();
    });
});
