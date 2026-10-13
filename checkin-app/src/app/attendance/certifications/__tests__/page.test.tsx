/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */
import { act, screen } from "@testing-library/react";
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
        mockFetchJson({ "/api/kioskdisplay/certifications": { participants, tools, building: { reachable: true, lastSeenAt: null } } });
        renderWithProviders(<KioskCertificationsDisplay />);

        // Kiosk display names are privacy-trimmed to first name only when unique (see getKioskDisplayNames).
        // The second row lands after useAutoCycle's layout-measurement effect flushes one tick
        // after mount, so both names are awaited rather than asserted synchronously.
        expect(await screen.findByText("Alex")).toBeInTheDocument();
        expect(await screen.findByText("Sam")).toBeInTheDocument();
        expect(screen.getByText("3D Printer")).toBeInTheDocument();
        expect(screen.getByText("2 People Present")).toBeInTheDocument();
    });

    it("labels the present count unconfirmed when the kiosk is unreachable", async () => {
        mockFetchJson({ "/api/kioskdisplay/certifications": { participants, tools, building: { reachable: false, lastSeenAt: null } } });
        renderWithProviders(<KioskCertificationsDisplay />);

        expect(await screen.findByText("2 Checked In (unconfirmed)")).toBeInTheDocument();
        expect(screen.queryByText("2 People Present")).not.toBeInTheDocument();
    });

    it("labels rows with the nickname the person goes by", async () => {
        mockFetchJson({ "/api/kioskdisplay/certifications": { participants: nicknamed, tools } });
        renderWithProviders(<KioskCertificationsDisplay />);

        expect(await screen.findByText("Alex")).toBeInTheDocument();
        expect(await screen.findByText("Sam")).toBeInTheDocument();
        expect(screen.queryByText("Alexander")).not.toBeInTheDocument();
        expect(screen.queryByText("Samantha")).not.toBeInTheDocument();
    });

    it("shows the Chicago wall-clock time and advances it on the minute", async () => {
        jest.useFakeTimers({ now: new Date("2026-10-10T15:04:30Z"), doNotFake: ["nextTick", "setImmediate"] });
        try {
            mockFetchJson({ "/api/kioskdisplay/certifications": { participants, tools } });
            renderWithProviders(<KioskCertificationsDisplay />);
            expect(await screen.findByText("10:04 AM")).toBeInTheDocument();

            await act(async () => { jest.advanceTimersByTime(30_000); });
            expect(screen.getByText("10:05 AM")).toBeInTheDocument();
        } finally {
            jest.useRealTimers();
        }
    });

    it("says the kiosk is resting, not that nobody was found, on a 204 with no grid yet", async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 204,
            json: async () => Promise.reject(new SyntaxError("no body")),
        } as unknown as Response)) as unknown as typeof fetch;
        renderWithProviders(<KioskCertificationsDisplay />);

        expect(await screen.findByText("Kiosk resting — zzz. Badge in to wake it.")).toBeInTheDocument();
        expect(screen.queryByText("No active people found.")).not.toBeInTheDocument();
    });

    it("keeps the grid it has when the kiosk answers 204", async () => {
        let calls = 0;
        global.fetch = jest.fn(async () => {
            calls += 1;
            if (calls === 1) {
                return { ok: true, status: 200, json: async () => ({ participants, tools }) } as unknown as Response;
            }
            return {
                ok: true,
                status: 204,
                json: async () => Promise.reject(new SyntaxError("no body")),
            } as unknown as Response;
        }) as unknown as typeof fetch;
        jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
        try {
            renderWithProviders(<KioskCertificationsDisplay />);
            expect(await screen.findByText("Alex")).toBeInTheDocument();
            await act(async () => { jest.advanceTimersByTime(10_000); });
            expect(global.fetch).toHaveBeenCalledTimes(2);
            expect(screen.getByText("Alex")).toBeInTheDocument();
            expect(screen.queryByText("Kiosk resting — zzz. Badge in to wake it.")).not.toBeInTheDocument();
        } finally {
            jest.useRealTimers();
        }
    });

    it("shows an error message when the fetch fails", async () => {
        mockFetchJson({});
        renderWithProviders(<KioskCertificationsDisplay />);
        expect(await screen.findByText("Failed to load certifications data")).toBeInTheDocument();
    });
});
