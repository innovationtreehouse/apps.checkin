jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import KeyVolunteerAgreementPanel from "../KeyVolunteerAgreementPanel";

beforeEach(() => resetRtl());

const status = { personId: 7, owesSignature: true, agreementVersion: 2, requestStarted: false, documentConfigured: true };

describe("KeyVolunteerAgreementPanel", () => {
    it("offers signing while the caller owes a signature", async () => {
        mockFetchJson({ "/api/membership/key-volunteer": status });
        renderWithProviders(<KeyVolunteerAgreementPanel />);
        expect(await screen.findByRole("button", { name: /Sign Key Volunteer Agreement/ })).toBeInTheDocument();
        expect(screen.getByText(/version 2/)).toBeInTheDocument();
    });

    it("says the agreement is not ready when its document is missing", async () => {
        mockFetchJson({ "/api/membership/key-volunteer": { ...status, documentConfigured: false } });
        renderWithProviders(<KeyVolunteerAgreementPanel />);
        expect(await screen.findByText(/isn't ready to sign yet/)).toBeInTheDocument();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("renders nothing when nothing is owed", async () => {
        const fetchMock = mockFetchJson({ "/api/membership/key-volunteer": { ...status, owesSignature: false } });
        renderWithProviders(<KeyVolunteerAgreementPanel />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(screen.queryByText(/Key Volunteer Agreement/)).toBeNull();
    });
});
