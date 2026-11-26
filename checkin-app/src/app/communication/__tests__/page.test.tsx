/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */
import { act, screen, fireEvent, waitFor } from "@testing-library/react";
import { notifications, notificationsStore } from "@mantine/notifications";
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import CommunicationPage from "../page";

beforeEach(() => resetRtl());
afterEach(() => act(() => notifications.clean()));

describe("CommunicationPage", () => {
    it("loads current settings and persists a toggle", async () => {
        setSession({ id: 1, email: "a@example.com" });
        const fetchMock = mockFetchJson({
            "/api/profile": { profile: { notificationSettings: { emailCheckinReceipts: true } } },
        });
        renderWithProviders(<CommunicationPage />);

        const receipts = await screen.findByLabelText("Email me when I check in or out");
        expect(receipts).toBeChecked();

        fireEvent.click(receipts);
        await waitFor(() => expect(receipts).not.toBeChecked());
        expect(fetchMock).toHaveBeenCalledWith("/api/profile", expect.objectContaining({ method: "PATCH" }));
    });

    it("disables every toggle when the user has no email on file", async () => {
        setSession({ id: 1, email: null });
        mockFetchJson({ "/api/profile": { profile: { notificationSettings: {} } } });
        renderWithProviders(<CommunicationPage />);

        expect(await screen.findByLabelText("Email me when I check in or out")).toBeDisabled();
    });

    it("shows the receipts preference on by default and saves it with the others", async () => {
        setSession({ id: 1, email: "a@example.com" });
        const fetchMock = mockFetchJson({
            "/api/profile": { profile: { notificationSettings: { emailCheckinReceipts: true } } },
        });
        renderWithProviders(<CommunicationPage />);

        const outcomes = await screen.findByLabelText("Email me about my receipts and reimbursements");
        expect(outcomes).toBeChecked();

        fireEvent.click(screen.getByLabelText("Email me when I check in or out"));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/profile", expect.objectContaining({ method: "PATCH" })));
        const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
        expect(JSON.parse(String(patch?.[1]?.body)).notificationSettings).toMatchObject({ emailPurchaseOutcomes: true });
    });

    it("sends every setting on a toggle, since the PATCH replaces them all", async () => {
        setSession({ id: 1, email: "a@example.com" });
        const fetchMock = mockFetchJson({
            "/api/profile": { profile: { notificationSettings: { emailCheckinReceipts: false, emailDependentCheckins: true, notifyNewPrograms: false, emailPurchaseOutcomes: false } } },
        });
        renderWithProviders(<CommunicationPage />);

        fireEvent.click(await screen.findByLabelText("Email me when I check in or out"));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/profile", expect.objectContaining({ method: "PATCH" })));
        const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
        expect(JSON.parse(String(patch?.[1]?.body)).notificationSettings).toEqual({
            emailCheckinReceipts: true,
            emailDependentCheckins: true,
            notifyNewPrograms: false,
            emailPurchaseOutcomes: false,
        });
    });

    it("loads the receipts preference when it is off", async () => {
        setSession({ id: 1, email: "a@example.com" });
        mockFetchJson({ "/api/profile": { profile: { notificationSettings: { emailPurchaseOutcomes: false } } } });
        renderWithProviders(<CommunicationPage />);

        expect(await screen.findByLabelText("Email me about my receipts and reimbursements")).not.toBeChecked();
    });

    it("reverts a toggle if the save fails", async () => {
        setSession({ id: 1, email: "a@example.com" });
        mockFetchJson({ "/api/profile": { profile: { notificationSettings: {} } } });
        renderWithProviders(<CommunicationPage />);

        const receipts = await screen.findByLabelText("Email me when I check in or out");
        expect(receipts).not.toBeChecked();

        global.fetch = jest.fn(() => Promise.reject(new Error("net"))) as unknown as typeof fetch;
        fireEvent.click(receipts);
        expect(receipts).toBeChecked(); // optimistic flip

        await waitFor(() => expect(receipts).not.toBeChecked()); // reverted
        expect(notificationsStore.getState().notifications).toEqual([
            expect.objectContaining({ color: "red", message: "Couldn't reach the server. Check your connection and try again.", autoClose: false }),
        ]);
    });

    it("shows the failure, not default toggles, when the load fails", async () => {
        setSession({ id: 1, email: "a@example.com" });
        mockFetchJson({});
        renderWithProviders(<CommunicationPage />);

        expect(await screen.findByText("Couldn't load your settings")).toBeInTheDocument();
        expect(screen.queryByLabelText("Email me when I check in or out")).not.toBeInTheDocument();
    });
});
