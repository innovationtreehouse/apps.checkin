// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { renderWithProviders, setSession, resetRtl } from "@/test-helpers/rtl";
import PaymentProblemsPage from "../page";

/**
 * What the board is told after "Sync Shopify now".
 *
 * The POST only STARTS a sync; everything the user then sees comes from polling GET
 * /api/finance-ops/s-read/sync. So each distinct thing that can happen to that poll
 * has to produce a distinct claim. A failed status READ must not be reported as "sync
 * is still running", a status the page never saw: that hides a real fault (such as the
 * mirror's SELECT grant not being in place) behind a plausible message.
 *
 * mockFetchJson can't express this: it keys on URL only, so it can't give the POST and
 * the GET on this one path different answers, nor return a non-200 for a known route.
 */
const shown = notifications.show as jest.Mock;

type GetReply = { status: number; body?: unknown };

/** POST always succeeds (the sync really did start); the GET replies per `gets`, last repeating. */
function mockSync(gets: GetReply[]) {
    let i = 0;
    const fn = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        const reply = (status: number, body: unknown) =>
            ({ ok: status < 400, status, json: async () => body }) as Response;

        if (url.includes("/api/finance-ops/s-read/sync")) {
            if (method === "POST") return reply(200, { success: true });
            const g = gets[Math.min(i++, gets.length - 1)];
            return reply(g.status, g.body ?? {});
        }
        if (url.includes("/api/finance-ops/payments")) return reply(200, []);
        return reply(404, {});
    });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

const run = (status: string) => ({
    run: { status, kind: "INCREMENTAL", startedAt: "2026-07-16T09:00:00.000Z", finishedAt: null, error: null },
});

/** Click "Sync Shopify now" and let the poll interval (6s) elapse `polls` times. */
async function syncAndPoll(polls: number) {
    fireEvent.click(await screen.findByRole("button", { name: /Sync Shopify now/ }));
    await act(async () => {
        await jest.advanceTimersByTimeAsync(6_000 * polls + 500);
    });
}

const lastShown = () => shown.mock.calls[shown.mock.calls.length - 1][0];
const lastMessage = () => lastShown().message as string;

beforeEach(() => {
    resetRtl();
    shown.mockClear();
    setSession({ id: 1, isSysadmin: true, isBoardMember: true });
});

describe("finance-ops/payments — sync status", () => {
    it("shows how fresh the mirror is once loaded", async () => {
        mockSync([{ status: 200, body: run("COMPLETED") }]);
        renderWithProviders(<PaymentProblemsPage />);

        expect(await screen.findByText(/Last Shopify sync:/)).toBeInTheDocument();
    });

    it("says nothing about freshness when the mirror can't be read", async () => {
        // A 503/500 must not render a status line at all — better silent than wrong.
        mockSync([{ status: 503, body: { error: "not wired" } }]);
        renderWithProviders(<PaymentProblemsPage />);

        await screen.findByRole("button", { name: /Sync Shopify now/ });
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        expect(screen.queryByText(/Last Shopify sync:/)).not.toBeInTheDocument();
    });

    it("reports an unreadable mirror as unreadable — NOT as 'still running'", async () => {
        // The sync did start, so the message must own that AND admit it
        // can't see the status; it must not invent one.
        jest.useFakeTimers();
        try {
            mockSync([{ status: 500, body: { error: "Failed to read the Shopify sync status" } }]);
            renderWithProviders(<PaymentProblemsPage />);
            await syncAndPoll(1);

            expect(lastMessage()).toMatch(/status can't be read/i);
            expect(lastMessage()).not.toMatch(/still running/i);
            // House shape for a real error: red, and it does not auto-dismiss. This one
            // stands in for a broken mirror — it must not scroll past unread.
            expect(lastShown()).toMatchObject({ color: "red", autoClose: false });
        } finally {
            jest.useRealTimers();
        }
    });

    it("reports a 503 (mirror not wired here) the same way, without claiming a status", async () => {
        jest.useFakeTimers();
        try {
            mockSync([{ status: 503, body: { error: "The Shopify mirror is not wired in this environment" } }]);
            renderWithProviders(<PaymentProblemsPage />);
            await syncAndPoll(1);

            expect(lastMessage()).toMatch(/status can't be read/i);
        } finally {
            jest.useRealTimers();
        }
    });

    it("announces completion and refetches the queue once the run lands", async () => {
        jest.useFakeTimers();
        try {
            // RUNNING, then COMPLETED — the poll has to keep going through the first.
            const fetchMock = mockSync([{ status: 200, body: run("RUNNING") }, { status: 200, body: run("COMPLETED") }]);
            renderWithProviders(<PaymentProblemsPage />);
            await syncAndPoll(2);

            expect(lastMessage()).toMatch(/sync finished/i);
            // Live payment reads the mirror, so the table must be re-read after a sync.
            const queueReads = fetchMock.mock.calls.filter(([u]) => String(u).includes("/api/finance-ops/payments"));
            expect(queueReads.length).toBeGreaterThan(1);
        } finally {
            jest.useRealTimers();
        }
    });

    it("surfaces ABANDONED distinctly and stops polling — 'not COMPLETED' is not 'keep waiting'", async () => {
        jest.useFakeTimers();
        try {
            // s-read's reaper relabels a killed run ABANDONED. Treating it as in-flight
            // would burn the entire poll budget on a run that is already over.
            const fetchMock = mockSync([{ status: 200, body: run("ABANDONED") }]);
            renderWithProviders(<PaymentProblemsPage />);
            await syncAndPoll(1);

            expect(lastMessage()).toMatch(/abandoned/i);
            expect(lastShown()).toMatchObject({ color: "red", autoClose: false });

            const after = fetchMock.mock.calls.length;
            await act(async () => {
                await jest.advanceTimersByTimeAsync(6_000 * 5);
            });
            expect(fetchMock.mock.calls.length).toBe(after);
        } finally {
            jest.useRealTimers();
        }
    });

    it("keeps waiting while the mirror reports no run yet", async () => {
        jest.useFakeTimers();
        try {
            // Readable mirror, no sync_run row yet: s-read stamps one at start, so this
            // is "not yet", not "broken" — and must not end the poll.
            mockSync([{ status: 200, body: { run: null } }, { status: 200, body: run("COMPLETED") }]);
            renderWithProviders(<PaymentProblemsPage />);
            await syncAndPoll(2);

            expect(lastMessage()).toMatch(/sync finished/i);
        } finally {
            jest.useRealTimers();
        }
    });

    it("admits it stopped watching when the run outlives the poll budget", async () => {
        jest.useFakeTimers();
        try {
            mockSync([{ status: 200, body: run("RUNNING") }]);
            renderWithProviders(<PaymentProblemsPage />);
            await syncAndPoll(21); // past the 20-attempt cap

            expect(lastMessage()).toMatch(/still running/i);
            // Nothing went wrong — the sync started and is proceeding, we just stopped
            // watching. Plain success shape: no color override, so it inherits the
            // theme's treehouseGreen (Mantine's Notification falls back to
            // --mantine-primary-color-filled when no color is passed).
            expect(lastShown().color).toBeUndefined();
            expect(lastShown().autoClose).not.toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });

    it("only ever speaks the app's red/theme-primary notification vocabulary", async () => {
        // The app has no warning tier: every notifications.show() in checkin-app is red
        // (error, explicit) or the theme's treehouseGreen (success — implicit, no color
        // override). This page briefly invented `yellow` for the two ambiguous
        // outcomes, which read as a new severity that nothing else
        // uses — and the two disagreed with each other on whether they persisted.
        jest.useFakeTimers();
        try {
            mockSync([{ status: 500, body: {} }]);
            renderWithProviders(<PaymentProblemsPage />);
            await syncAndPoll(1);

            const colors = shown.mock.calls.map(([c]) => c.color);
            expect(colors.length).toBeGreaterThan(0);
            expect(colors.every((c) => c === "red" || c === undefined)).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });
});
