// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), update: jest.fn(), hide: jest.fn() } }));

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

const OLD_START = "2026-07-15T09:00:00.000Z";
const NEW_START = "2026-07-16T09:00:00.000Z";

const run = (status: string, startedAt = NEW_START) => ({
    run: { status, kind: "INCREMENTAL", startedAt, finishedAt: null, error: null },
});

/** Yesterday's finished run: what the mirror holds when the button is clicked. */
const previousRun = run("COMPLETED", OLD_START);

const CHECKED = { configured: true, ordersScanned: 3, reversalsRaised: 1, failed: 0 };

/**
 * POST always succeeds (the sync really did start). A GET before the POST replies
 * `before`; each GET after it replies per `gets`, last repeating. The payment check
 * replies `check`, and the last-sync status replies `status`.
 */
function mockSync(
    gets: GetReply[],
    before: GetReply = { status: 200, body: previousRun },
    check: GetReply = { status: 200, body: CHECKED },
    status: GetReply = { status: 200, body: { scheduled: null, laterRepair: null } },
) {
    let i = 0;
    let posted = false;
    const fn = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        const reply = (status: number, body: unknown) =>
            ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

        if (url.includes("/api/finance-ops/s-read/sync/status")) return reply(status.status, status.body ?? {});
        if (url.includes("/api/finance-ops/s-read/sync")) {
            if (method === "POST") {
                posted = true;
                return reply(200, { success: true });
            }
            const g = posted ? gets[Math.min(i++, gets.length - 1)] : before;
            return reply(g.status, g.body ?? {});
        }
        if (url.includes("/api/finance-ops/payments/reconcile")) return reply(check.status, check.body ?? {});
        if (url.includes("/api/finance-ops/payments")) return reply(200, []);
        return reply(404, {});
    });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

/** Click "Sync Shopify now" and let the poll interval (6s) elapse `polls` times. */
async function syncAndPoll(polls: number) {
    fireEvent.click(await screen.findByRole("button", { name: /Sync Shopify now/ }));
    await act(async () => {
        await jest.advanceTimersByTimeAsync(6_000 * polls + 500);
    });
}

const lastShown = () => shown.mock.calls[shown.mock.calls.length - 1][0];
const messages = () => shown.mock.calls.map(([c]) => c.message as string);

/** Each call's URL and method, in order. */
const calls = (fetchMock: jest.Mock) =>
    fetchMock.mock.calls.map(([u, init]: [RequestInfo | URL, RequestInit | undefined]) => ({ url: String(u), method: init?.method ?? "GET" }));
const isCheck = (c: { url: string; method: string }) => c.url.includes("/api/finance-ops/payments/reconcile") && c.method === "POST";
const isQueueRead = (c: { url: string; method: string }) => c.url.endsWith("/api/finance-ops/payments") && c.method === "GET";
const lastMessage = () => lastShown().message as string;

beforeEach(() => {
    resetRtl();
    shown.mockClear();
    setSession({ id: 1, isSysadmin: true, isBoardMember: true });
});

const HOUR = 3_600_000;
const finished = (kind: string, status: string, hoursAgo: number) => {
    const at = new Date(Date.now() - hoursAgo * HOUR).toISOString();
    return { status, kind, startedAt: at, finishedAt: at, error: null };
};

/** Load the page with the status route replying `body`; returns once the daily-read line shows. */
async function loadWithStatus(body: unknown) {
    mockSync([{ status: 200, body: previousRun }], { status: 200, body: previousRun }, undefined, { status: 200, body });
    renderWithProviders(<PaymentProblemsPage />);
    return screen.findByText(/Last daily Shopify read:/);
}

describe("finance-ops/payments — last-sync line", () => {
    it("shows a failing daily read and the completed repair after it", async () => {
        const line = await loadWithStatus({ scheduled: finished("INCREMENTAL", "FAILED", 5), laterRepair: finished("ADMIN", "COMPLETED", 2) });

        expect(line).toHaveTextContent("Last daily Shopify read: 5 hr ago (failed).");
        expect(screen.getByText("Repaired by a sysadmin 2 hr ago (completed).")).toBeInTheDocument();
    });

    it("shows one line for a completed daily read with no later repair", async () => {
        const line = await loadWithStatus({ scheduled: finished("INCREMENTAL", "COMPLETED", 3), laterRepair: null });

        expect(line).toHaveTextContent("Last daily Shopify read: 3 hr ago (completed).");
        expect(screen.queryByText(/Repaired by|Backfilled/)).not.toBeInTheDocument();
    });

    it("says never when no daily read has finished", async () => {
        const line = await loadWithStatus({ scheduled: null, laterRepair: null });

        expect(line).toHaveTextContent("Last daily Shopify read: never.");
    });

    it("names a later backfill as a backfill", async () => {
        await loadWithStatus({ scheduled: finished("INCREMENTAL", "ABANDONED", 30), laterRepair: finished("BACKFILL", "COMPLETED", 1) });

        expect(screen.getByText("Backfilled 1 hr ago (completed).")).toBeInTheDocument();
    });

    it("says nothing about freshness when the status can't be read", async () => {
        // A 503/500 must not render a status line at all — better silent than wrong.
        const notWired = { status: 503, body: { error: "not wired" } };
        mockSync([notWired], notWired, undefined, notWired);
        renderWithProviders(<PaymentProblemsPage />);

        await screen.findByRole("button", { name: /Sync Shopify now/ });
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        expect(screen.queryByText(/Last daily Shopify read:/)).not.toBeInTheDocument();
    });
});

describe("finance-ops/payments — sync status", () => {

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
            // Nothing went wrong — the sync is proceeding, the page just stopped watching.
            expect(lastShown().color).toBe("green");
            expect(lastShown().autoClose).not.toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });

    it("ignores the run that was already in the mirror at click time", async () => {
        jest.useFakeTimers();
        try {
            // Yesterday's COMPLETED run is still the latest for the first polls; its
            // result is not this click's and must not be announced.
            mockSync([{ status: 200, body: previousRun }, { status: 200, body: previousRun }, { status: 200, body: run("COMPLETED") }]);
            renderWithProviders(<PaymentProblemsPage />);
            await syncAndPoll(2);

            expect(shown.mock.calls.map(([c]) => c.message)).not.toContainEqual(expect.stringMatching(/sync finished/i));

            await act(async () => {
                await jest.advanceTimersByTimeAsync(6_000);
            });
            expect(lastMessage()).toMatch(/sync finished/i);
        } finally {
            jest.useRealTimers();
        }
    });

    it("says the sync hasn't started when no new run appears within the poll window", async () => {
        jest.useFakeTimers();
        try {
            mockSync([{ status: 200, body: previousRun }]);
            renderWithProviders(<PaymentProblemsPage />);
            await syncAndPoll(21); // past the 20-attempt cap

            expect(lastMessage()).toMatch(/requested but hasn't started yet/i);
            expect(lastShown()).toMatchObject({ color: "red", autoClose: false });
            expect(shown.mock.calls.map(([c]) => c.message)).not.toContainEqual(expect.stringMatching(/sync finished|still running/i));
        } finally {
            jest.useRealTimers();
        }
    });

    it("reports a new run that fails as failed", async () => {
        jest.useFakeTimers();
        try {
            mockSync([{ status: 200, body: run("RUNNING") }, { status: 200, body: run("FAILED") }]);
            renderWithProviders(<PaymentProblemsPage />);
            await syncAndPoll(2);

            expect(lastMessage()).toMatch(/sync failed/i);
            expect(lastShown()).toMatchObject({ color: "red", autoClose: false });
        } finally {
            jest.useRealTimers();
        }
    });

    it("reports an unreadable mirror at click time without polling for a run it can't tell apart", async () => {
        jest.useFakeTimers();
        try {
            const fetchMock = mockSync([{ status: 200, body: previousRun }], { status: 500, body: {} });
            renderWithProviders(<PaymentProblemsPage />);
            await syncAndPoll(1);

            expect(lastMessage()).toMatch(/status can't be read/i);
            expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });

    it("follows a run already running at click time and reports how it ended", async () => {
        jest.useFakeTimers();
        try {
            // s-read's lock skips the new request, so the in-flight run is the one to watch.
            const inFlight = run("RUNNING", OLD_START);
            mockSync([{ status: 200, body: inFlight }, { status: 200, body: run("COMPLETED", OLD_START) }], { status: 200, body: inFlight });
            renderWithProviders(<PaymentProblemsPage />);
            await syncAndPoll(2);

            expect(lastMessage()).toMatch(/^A sync was already running; it finished/);
            expect(shown.mock.calls.map(([c]) => c.message)).not.toContainEqual(expect.stringMatching(/hasn't started yet/i));
        } finally {
            jest.useRealTimers();
        }
    });

    it("reports an already-running run that fails as failed", async () => {
        jest.useFakeTimers();
        try {
            const inFlight = run("RUNNING", OLD_START);
            mockSync([{ status: 200, body: run("FAILED", OLD_START) }], { status: 200, body: inFlight });
            renderWithProviders(<PaymentProblemsPage />);
            await syncAndPoll(1);

            expect(lastMessage()).toMatch(/^A sync was already running; it failed/);
            expect(lastShown()).toMatchObject({ color: "red", autoClose: false });
        } finally {
            jest.useRealTimers();
        }
    });

    it("says a still-running followed run is still running, not that it hasn't started", async () => {
        jest.useFakeTimers();
        try {
            const inFlight = run("RUNNING", OLD_START);
            mockSync([{ status: 200, body: inFlight }], { status: 200, body: inFlight });
            renderWithProviders(<PaymentProblemsPage />);
            await syncAndPoll(21);

            expect(lastMessage()).toMatch(/still running/i);
        } finally {
            jest.useRealTimers();
        }
    });

    it("only ever speaks the kit's red/green notification vocabulary", async () => {
        // Payment problems speak only showError (red) or showSuccess (green).
        jest.useFakeTimers();
        try {
            mockSync([{ status: 500, body: {} }]);
            renderWithProviders(<PaymentProblemsPage />);
            await syncAndPoll(1);

            const colors = shown.mock.calls.map(([c]) => c.color);
            expect(colors.length).toBeGreaterThan(0);
            expect(colors.every((c) => c === "red" || c === "green")).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });
});

describe("finance-ops/payments — payment check after a sync", () => {
    async function afterSync(gets: GetReply[], check?: GetReply) {
        const fetchMock = mockSync(gets, undefined, check);
        renderWithProviders(<PaymentProblemsPage />);
        await syncAndPoll(gets.length);
        return fetchMock;
    }

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("runs the check once a sync completes, then reloads the problem rows", async () => {
        const fetchMock = await afterSync([{ status: 200, body: run("COMPLETED") }]);

        const log = calls(fetchMock);
        const checkAt = log.findIndex(isCheck);
        expect(log.filter(isCheck)).toHaveLength(1);
        expect(log.slice(checkAt + 1).some(isQueueRead)).toBe(true);
        expect(lastMessage()).toMatch(/sync finished/i);
    });

    it.each(["FAILED", "ABANDONED"])("does not run the check when the sync ends %s", async (status) => {
        const fetchMock = await afterSync([{ status: 200, body: run(status) }]);

        expect(calls(fetchMock).some(isCheck)).toBe(false);
    });

    it("does not run the check while the sync is still running at the poll cap", async () => {
        const fetchMock = mockSync([{ status: 200, body: run("RUNNING") }]);
        renderWithProviders(<PaymentProblemsPage />);
        await syncAndPoll(21);

        expect(calls(fetchMock).some(isCheck)).toBe(false);
    });

    it("keeps the sync's success and adds a red chip that stays when the check fails", async () => {
        const fetchMock = await afterSync([{ status: 200, body: run("COMPLETED") }], { status: 500, body: { error: "Failed to refresh the payment problems" } });

        expect(messages()).toContainEqual(expect.stringMatching(/sync finished/i));
        expect(lastMessage()).toMatch(/Shopify data is fresh, but the payment problems couldn't be refreshed/);
        expect(lastShown()).toMatchObject({ color: "red", autoClose: false });
        const log = calls(fetchMock);
        expect(log.slice(log.findIndex(isCheck) + 1).some(isQueueRead)).toBe(true);
    });

    it("says the daily check is running when it holds the lease", async () => {
        await afterSync([{ status: 200, body: run("COMPLETED") }], { status: 409, body: { error: "The daily payment check is running now" } });

        expect(lastMessage()).toMatch(/daily payment check is running now/i);
        expect(lastShown()).toMatchObject({ color: "red", autoClose: false });
    });

    it("says how many orders the check couldn't read", async () => {
        await afterSync([{ status: 200, body: run("COMPLETED") }], { status: 200, body: { ...CHECKED, failed: 2 } });

        expect(lastMessage()).toMatch(/2 order\(s\) couldn't be checked/);
        expect(lastShown()).toMatchObject({ color: "red", autoClose: false });
    });
});
