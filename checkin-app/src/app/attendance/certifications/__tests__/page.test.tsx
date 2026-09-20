/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */
import { screen } from "@testing-library/react";
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import KioskCertificationsDisplay from "../page";

beforeEach(() => resetRtl());

const tools = [{ id: 1, name: "3D Printer" }, { id: 2, name: "Laser Cutter" }];
const participants = [
    { id: 1, name: "Alex Smith", toolStatuses: [{ toolId: 1, level: "CERTIFIED" }] },
    { id: 2, name: "Sam Jones", toolStatuses: [] },
];

const nicknamed = [
    { id: 1, name: "Alexander Smith", nickname: "Alex", toolStatuses: [{ toolId: 1, level: "CERTIFIED" }] },
    { id: 2, name: "Samantha Jones", nickname: "Sam", toolStatuses: [] },
];

describe("KioskCertificationsDisplay", () => {
    it("loads and renders the live certifications grid", async () => {
        mockFetchJson({ "/api/kioskdisplay/certifications": { participants, tools } });
        renderWithProviders(<KioskCertificationsDisplay />);

        // Kiosk display names are privacy-trimmed to first name only when unique (see getKioskDisplayNames).
        // The second row lands after useAutoCycle's layout-measurement effect flushes one tick
        // after mount, so both names are awaited rather than asserted synchronously.
        expect(await screen.findByText("Alex")).toBeInTheDocument();
        expect(await screen.findByText("Sam")).toBeInTheDocument();
        expect(screen.getByText("3D Printer")).toBeInTheDocument();
        expect(screen.getByText("2 People Present")).toBeInTheDocument();
    });

    it("labels rows with the nickname the person goes by", async () => {
        mockFetchJson({ "/api/kioskdisplay/certifications": { participants: nicknamed, tools } });
        renderWithProviders(<KioskCertificationsDisplay />);

        expect(await screen.findByText("Alex")).toBeInTheDocument();
        expect(await screen.findByText("Sam")).toBeInTheDocument();
        expect(screen.queryByText("Alexander")).not.toBeInTheDocument();
        expect(screen.queryByText("Samantha")).not.toBeInTheDocument();
    });

    it("shows an error message when the fetch fails", async () => {
        mockFetchJson({});
        renderWithProviders(<KioskCertificationsDisplay />);
        expect(await screen.findByText("Failed to load certifications data")).toBeInTheDocument();
    });
});
