/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */
import { act, fireEvent, screen } from "@testing-library/react";
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
import { notifications, notificationsStore } from "@mantine/notifications";
import { renderWithProviders, mockFetchJson, resetRtl, setSearchParams } from "@/test-helpers/rtl";
import { jsonBody } from "@/test-helpers/jsonBody";
import { pinTimezone } from "@/test-helpers/tz";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import KioskCertificationsDisplay from "../page";

beforeEach(() => resetRtl());

const answer = (status: number, body: unknown) => ({ ok: status < 400, status, ...jsonBody(body) }) as Response;
const noContent = () => ({ ok: true, status: 204, json: async () => Promise.reject(new SyntaxError("no body")), text: async () => "" }) as unknown as Response;

const tools = [{ id: 1, name: "3D Printer" }, { id: 2, name: "Laser Cutter" }];
// `name` is what the route sends: the kiosk label, already resolved server-side.
const participants = [
    { id: 1, name: "Alex", toolStatuses: [{ toolId: 1, level: "CERTIFIED" }] },
    { id: 2, name: "Sam", toolStatuses: [] },
];

const shortened = [
    { id: 1, name: "Sarah Mi.", toolStatuses: [{ toolId: 1, level: "CERTIFIED" }] },
    { id: 2, name: "John S. Jr.", toolStatuses: [] },
];

describe("KioskCertificationsDisplay", () => {
    it("loads and renders the live certifications grid", async () => {
        mockFetchJson({ "/api/kioskdisplay/certifications": { participants, tools, building: { reachable: true, lastSeenAt: null } } });
        renderWithProviders(<KioskCertificationsDisplay />);

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

    it("shows the label the server sent, shortened surname and suffix intact", async () => {
        mockFetchJson({ "/api/kioskdisplay/certifications": { participants: shortened, tools } });
        renderWithProviders(<KioskCertificationsDisplay />);

        expect(await screen.findByText("Sarah Mi.")).toBeInTheDocument();
        expect(await screen.findByText("John S. Jr.")).toBeInTheDocument();
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

    describe("in an org whose zone is not the browser's", () => {
        pinTimezone("America/Chicago");

        it("shows the clock in the org's zone", async () => {
            jest.useFakeTimers({ now: new Date("2026-10-10T15:04:30Z"), doNotFake: ["nextTick", "setImmediate"] });
            try {
                mockFetchJson({ "/api/kioskdisplay/certifications": { participants, tools } });
                renderWithProviders(<KioskCertificationsDisplay />, {
                    wrapper: ({ children }) => <TimezoneProvider value="Asia/Tokyo">{children}</TimezoneProvider>,
                });
                expect(await screen.findByText("12:04 AM")).toBeInTheDocument();
            } finally {
                jest.useRealTimers();
            }
        });
    });

    it("says the kiosk is resting, not that nobody was found, on a 204 with no grid yet", async () => {
        global.fetch = jest.fn(async () => noContent()) as unknown as typeof fetch;
        renderWithProviders(<KioskCertificationsDisplay />);

        expect(await screen.findByText("Kiosk resting — zzz. Badge in to wake it.")).toBeInTheDocument();
        expect(screen.queryByText("No active people found.")).not.toBeInTheDocument();
    });

    it("clears an earlier error once the kiosk answers 204", async () => {
        setSearchParams("mode=kiosk");
        let calls = 0;
        global.fetch = jest.fn(async () => (++calls === 1 ? answer(400, { error: "Kiosk not ready" }) : noContent())) as unknown as typeof fetch;
        jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
        try {
            renderWithProviders(<KioskCertificationsDisplay />);
            expect(await screen.findByText("Kiosk not ready")).toBeInTheDocument();
            await act(async () => { jest.advanceTimersByTime(10_000); });
            expect(screen.getByText("Kiosk resting — zzz. Badge in to wake it.")).toBeInTheDocument();
            expect(screen.queryByText("Kiosk not ready")).not.toBeInTheDocument();
        } finally {
            jest.useRealTimers();
        }
    });

    it("keeps the grid it has when the kiosk answers 204", async () => {
        let calls = 0;
        global.fetch = jest.fn(async () => {
            calls += 1;
            return calls === 1 ? answer(200, { participants, tools }) : noContent();
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

    describe("when the server can't be reached on a later poll", () => {
        function answerOnceThenFail() {
            let calls = 0;
            global.fetch = jest.fn(async () => {
                calls += 1;
                if (calls === 1) return answer(200, { participants, tools });
                throw new TypeError("fetch failed");
            }) as unknown as typeof fetch;
        }

        async function pollTwice() {
            jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
            try {
                renderWithProviders(<KioskCertificationsDisplay />);
                expect(await screen.findByText("Alex")).toBeInTheDocument();
                await act(async () => { jest.advanceTimersByTime(10_000); });
                await act(async () => { jest.advanceTimersByTime(10_000); });
            } finally {
                jest.useRealTimers();
            }
        }

        afterEach(() => act(() => notifications.clean()));

        it("on the kiosk, keeps the grid, says it is not up to date, and raises nothing that waits", async () => {
            setSearchParams("mode=kiosk");
            answerOnceThenFail();
            await pollTwice();
            expect(screen.getByText("Alex")).toBeInTheDocument();
            expect(screen.getByText("Not up to date")).toBeInTheDocument();
            expect(notificationsStore.getState().notifications).toHaveLength(0);
        });

        it("off the kiosk, keeps the grid marked not up to date while it retries, with no toast", async () => {
            answerOnceThenFail();
            await pollTwice();
            expect(screen.getByText("Alex")).toBeInTheDocument();
            expect(screen.getByText("Not up to date")).toBeInTheDocument();
            expect(notificationsStore.getState().notifications).toHaveLength(0);
        });
    });

    it("on the kiosk, says the server can't be reached once the first load's retries run out", async () => {
        const unreachable = "Couldn't reach the server. Check your connection and try again.";
        global.fetch = jest.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
        setSearchParams("mode=kiosk");
        jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
        try {
            renderWithProviders(<KioskCertificationsDisplay />);
            for (let i = 0; i < 60 && !screen.queryByText(unreachable); i++) {
                await act(async () => { jest.advanceTimersByTime(1000); });
            }
            expect(screen.getByText(unreachable)).toBeInTheDocument();
            expect(screen.queryByText(/No active people found/)).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
            expect(notificationsStore.getState().notifications).toHaveLength(0);
        } finally {
            jest.useRealTimers();
        }
    });

    it("off the kiosk, shows a failed load in place of the grid, and Retry reads it again", async () => {
        let refuse = true;
        global.fetch = jest.fn(async () => (refuse ? answer(400, { error: "Refused" }) : answer(200, { participants, tools }))) as unknown as typeof fetch;
        renderWithProviders(<KioskCertificationsDisplay />);
        expect(await screen.findByText("Couldn't load certifications")).toBeInTheDocument();
        expect(screen.getByText("Refused")).toBeInTheDocument();

        refuse = false;
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(await screen.findByText("Alex")).toBeInTheDocument();
        expect(screen.queryByText("Couldn't load certifications")).not.toBeInTheDocument();
    });

    it("sends the kiosk-signature headers from the URL", async () => {
        setSearchParams("sig=abc&ts=123&nonce=xyz");
        const fetchMock = mockFetchJson({ "/api/kioskdisplay/certifications": { participants, tools } });
        renderWithProviders(<KioskCertificationsDisplay />);
        expect(await screen.findByText("Alex")).toBeInTheDocument();
        expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ "x-kiosk-signature": "abc", "x-kiosk-timestamp": "123", "x-kiosk-nonce": "xyz" });
    });
});
