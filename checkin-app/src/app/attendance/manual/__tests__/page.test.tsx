/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */
import { screen, fireEvent, waitFor } from "@testing-library/react";
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), update: jest.fn(), hide: jest.fn() } }));
import { notifications } from "@mantine/notifications";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import ManualAttendance from "../page";

beforeEach(() => {
    resetRtl();
    (notifications.show as jest.Mock).mockClear();
});

describe("ManualAttendance", () => {
    it("records a manual visit and shows a success message", async () => {
        setSession({ id: 1 });
        mockFetchJson({ "/api/attendance/manual": { ok: true } });
        renderWithProviders(<ManualAttendance />);

        const submit = screen.getByRole("button", { name: "Record Time Entry" });
        expect(submit).toBeDisabled();

        // "required" adds a visually-hidden "*" to the label text, so match by substring.
        // Supply a departure after arrival so client-side validation passes for a past date.
        fireEvent.change(screen.getByLabelText(/Arrival Time/), { target: { value: "2026-06-01T10:00" } });
        fireEvent.change(screen.getByLabelText(/Departure Time/), { target: { value: "2026-06-01T11:00" } });
        fireEvent.click(submit);

        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Visit recorded successfully." })),
        );
    });

    it("shows the server's refusal in the lower right", async () => {
        setSession({ id: 1 });
        global.fetch = jest.fn(async () =>
            new Response(JSON.stringify({ error: "That visit overlaps another one." }), { status: 400 }),
        ) as unknown as typeof fetch;
        renderWithProviders(<ManualAttendance />);

        // "required" adds a visually-hidden "*" to the label text, so match by substring.
        // Supply a departure after arrival so client-side validation passes for a past date.
        fireEvent.change(screen.getByLabelText(/Arrival Time/), { target: { value: "2026-06-01T10:00" } });
        fireEvent.change(screen.getByLabelText(/Departure Time/), { target: { value: "2026-06-01T11:00" } });
        fireEvent.click(screen.getByRole("button", { name: "Record Time Entry" }));

        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(
                expect.objectContaining({ color: "red", message: "That visit overlaps another one.", autoClose: false }),
            ),
        );
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
});
