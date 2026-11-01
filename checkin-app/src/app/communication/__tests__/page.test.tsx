/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */
import { screen, fireEvent, waitFor } from "@testing-library/react";
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import CommunicationPage from "../page";

beforeEach(() => resetRtl());

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

    it("loads the receipts preference when it is off", async () => {
        setSession({ id: 1, email: "a@example.com" });
        mockFetchJson({ "/api/profile": { profile: { notificationSettings: { emailPurchaseOutcomes: false } } } });
        renderWithProviders(<CommunicationPage />);

        expect(await screen.findByLabelText("Email me about my receipts and reimbursements")).not.toBeChecked();
    });

    it("persists the outreach-suppression toggle immediately", async () => {
        setSession({ id: 1, email: "a@example.com" });
        const fetchMock = mockFetchJson({
            "/api/profile": { profile: { notificationSettings: {}, emailSuppressed: false } },
        });
        renderWithProviders(<CommunicationPage />);

        const suppress = await screen.findByLabelText("Don't email me membership join/renewal invitations");
        expect(suppress).not.toBeChecked();

        fireEvent.click(suppress);
        await waitFor(() => expect(suppress).toBeChecked());
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/profile",
            expect.objectContaining({ method: "PATCH", body: JSON.stringify({ emailSuppressed: true }) }),
        );
    });

    it("reverts the outreach-suppression toggle if the save fails", async () => {
        setSession({ id: 1, email: "a@example.com" });
        mockFetchJson({ "/api/profile": { profile: { notificationSettings: {}, emailSuppressed: false } } });
        renderWithProviders(<CommunicationPage />);

        const suppress = await screen.findByLabelText("Don't email me membership join/renewal invitations");
        expect(suppress).not.toBeChecked();

        global.fetch = jest.fn(() => Promise.reject(new Error("net"))) as unknown as typeof fetch;
        fireEvent.click(suppress);
        expect(suppress).toBeChecked(); // optimistic flip

        await waitFor(() => expect(suppress).not.toBeChecked()); // reverted
        expect(await screen.findByText("Failed to update settings.")).toBeInTheDocument();
    });
});
