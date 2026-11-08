import type { OpsIncident } from "@/generated/prisma/client";
import { evaluateIncidents, purgeClosedIncidents, type Delivery, type RunFailure, type RunReport } from "../opsIncidents";

type Stamp = "notifiedAt" | "lastRemindedAt" | "escalatedAt" | "recoveryNotifiedAt";
type Where = { closedAt?: null | { gte?: Date; lt?: Date }; OR?: Where[]; AND?: Where; id?: number; openKey?: string | null } & { [K in Stamp]?: Date | null };
const STAMPS: Stamp[] = ["notifiedAt", "lastRemindedAt", "escalatedAt", "recoveryNotifiedAt"];

const rows: OpsIncident[] = [];
let nextId = 1;

function matches(row: OpsIncident, where: Where = {}): boolean {
    if (where.OR) return where.OR.some((w) => matches(row, w));
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.AND && !matches(row, where.AND)) return false;
    if ("openKey" in where && row.openKey !== where.openKey) return false;
    for (const f of STAMPS) if (f in where && row[f]?.getTime() !== where[f]?.getTime()) return false;
    if (where.closedAt === null) return row.closedAt === null;
    if (where.closedAt) {
        if (!row.closedAt) return false;
        if (where.closedAt.gte && row.closedAt < where.closedAt.gte) return false;
        if (where.closedAt.lt && row.closedAt >= where.closedAt.lt) return false;
    }
    return true;
}

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        opsIncident: {
            findMany: jest.fn(async ({ where }: { where: Where }) => rows.filter((r) => matches(r, where)).map((r) => ({ ...r }))),
            create: jest.fn(async ({ data }: { data: Partial<OpsIncident> }) => {
                if (data.openKey && rows.some((r) => r.openKey === data.openKey)) throw Object.assign(new Error("unique"), { code: "P2002" });
                const row = {
                    id: nextId++, openKey: null, lanes: [], firstSeenAt: new Date(), lastSeenAt: new Date(), notifiedAt: null,
                    lastRemindedAt: null, escalatedAt: null, closedAt: null, recoveryNotifiedAt: null, runsSeen: 1, itemsAffected: 0, detail: null,
                    ...data,
                } as OpsIncident;
                rows.push(row);
                return { ...row };
            }),
            update: jest.fn(async ({ where, data }: { where: Where; data: Partial<OpsIncident> }) => {
                const row = rows.find((r) => matches(r, where));
                if (!row) throw Object.assign(new Error("no row"), { code: "P2025" });
                const { runsSeen, ...rest } = data as Omit<Partial<OpsIncident>, "runsSeen"> & { runsSeen?: number | { increment: number } };
                Object.assign(row, rest);
                if (runsSeen !== undefined) row.runsSeen = typeof runsSeen === "number" ? runsSeen : row.runsSeen + runsSeen.increment;
                return { ...row };
            }),
            updateMany: jest.fn(async ({ where, data }: { where: Where; data: Partial<OpsIncident> }) => {
                const hit = rows.filter((r) => matches(r, where));
                for (const r of hit) Object.assign(r, data);
                return { count: hit.length };
            }),
            deleteMany: jest.fn(async ({ where }: { where: Where }) => {
                const gone = rows.filter((r) => matches(r, where));
                for (const g of gone) rows.splice(rows.indexOf(g), 1);
                return { count: gone.length };
            }),
        },
    },
}));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date("2026-11-01T02:00:00Z").getTime();
const at = (days: number, hours = 0) => new Date(T0 + days * DAY + hours * HOUR);

const sent: { to: string; template: string; ctx: Record<string, string> }[] = [];
let sendOk = true;
let sendRejects = false;
const send = jest.fn(async (to: string, template: string, ctx: Record<string, string>) => {
    if (sendRejects) throw new Error("mail service down");
    if (sendOk) sent.push({ to, template, ctx });
    return sendOk;
});

const delivery = (now: Date, over: Partial<Delivery> = {}): Delivery => ({
    send, alertTo: ["alerts@example.org"], boardTo: ["board@example.org"], timeZone: "UTC", now, ...over,
});

const qbSystem = (lane: string, extra: Partial<RunFailure> = {}): RunFailure => ({ lane, cause: "quickbooks", kind: "system", code: "QB_TIMEOUT", count: 2, ...extra });
const run = (failures: RunFailure[], lanes = ["expense", "gift", "income"], extra: Partial<RunReport> = {}): RunReport => ({ lanes, failures, ...extra });

beforeEach(() => {
    rows.length = 0;
    nextId = 1;
    sent.length = 0;
    sendOk = true;
    sendRejects = false;
    send.mockClear();
    jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("evaluateIncidents", () => {
    it("records a first system failure as watching, with no email", async () => {
        await evaluateIncidents(run([qbSystem("expense")]), delivery(at(0)));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ key: "quickbooks:system", openKey: "quickbooks:system", notifiedAt: null, runsSeen: 1 });
        expect(sent).toEqual([]);
    });

    it("closes a quiet blip on the next clean run without any email", async () => {
        await evaluateIncidents(run([qbSystem("expense")]), delivery(at(0)));
        await evaluateIncidents(run([]), delivery(at(1)));
        expect(rows[0]).toMatchObject({ openKey: null, closedAt: at(1) });
        expect(sent).toEqual([]);
    });

    it("opens a system incident on the second run in a row and sends one notice", async () => {
        await evaluateIncidents(run([qbSystem("expense")]), delivery(at(0)));
        const events = await evaluateIncidents(run([qbSystem("expense")]), delivery(at(1)));
        expect(events).toEqual([{ key: "quickbooks:system", event: "opened", sent: true }]);
        expect(rows[0]).toMatchObject({ notifiedAt: at(1), runsSeen: 2 });
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ to: "alerts@example.org", template: "ops.incidentOpened" });
        expect(sent[0].ctx).toMatchObject({ kind: "system", cause: "QuickBooks", lanes: "expense", status: "needs attention", runsSeen: "2" });
    });

    it("opens a system incident at once when a lane stopped", async () => {
        await evaluateIncidents(run([qbSystem("gift", { stopped: true })]), delivery(at(0)));
        expect(rows[0].notifiedAt).toEqual(at(0));
        expect(sent).toHaveLength(1);
    });

    it("groups lanes failing on the same cause and kind into one incident", async () => {
        await evaluateIncidents(run([qbSystem("expense"), qbSystem("gift", { count: 3 }), qbSystem("income", { stopped: true })]), delivery(at(0)));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ lanes: ["expense", "gift", "income"], itemsAffected: 7 });
        expect(sent).toHaveLength(1);
        expect(sent[0].ctx).toMatchObject({ lanes: "expense, gift, income", items: "7" });
    });

    it("opens connection and settings incidents on the first run", async () => {
        await evaluateIncidents(
            run([
                { lane: "expense", cause: "quickbooks", kind: "connection", code: "QB_AUTH", count: 1 },
                { lane: "gift", cause: "booksmap", kind: "settings", code: "LANE_UNCONFIGURED", count: 4 },
            ]),
            delivery(at(0)),
        );
        expect(rows.map((r) => r.key)).toEqual(["quickbooks:connection", "booksmap:settings"]);
        expect(sent.map((s) => s.ctx.status)).toEqual(["needs reconnecting", "needs attention"]);
    });

    it("ignores a settings failure with no work waiting", async () => {
        await evaluateIncidents(run([{ lane: "gift", cause: "booksmap", kind: "settings", code: "LANE_UNCONFIGURED", count: 0 }]), delivery(at(0)));
        expect(rows).toEqual([]);
        expect(sent).toEqual([]);
    });

    it("keys a bug by lane and code, and opens it on the first run", async () => {
        await evaluateIncidents(run([{ lane: "receipt", cause: "ocr", kind: "bug", code: "PARSE_CRASH", count: 1 }]), delivery(at(0)));
        expect(rows[0]).toMatchObject({ key: "receipt:PARSE_CRASH", kind: "bug", lanes: ["receipt"] });
        expect(sent).toHaveLength(1);
    });

    it("never opens an incident for data failures", async () => {
        await evaluateIncidents(run([{ lane: "expense", cause: "quickbooks", kind: "data", code: "QB_VALIDATION", count: 5 }]), delivery(at(0)));
        expect(rows).toEqual([]);
    });

    it("opens a stopped-job incident under cron:<job>:stale and closes it when the job is fresh again", async () => {
        await evaluateIncidents(run([], [], { staleJobs: ["qbo-posting"] }), delivery(at(0)));
        expect(rows[0]).toMatchObject({ key: "cron:qbo-posting:stale", notifiedAt: at(0) });
        expect(sent[0].ctx.todo).toMatch(/Scheduled Jobs/);
        await evaluateIncidents(run([]), delivery(at(1)));
        expect(rows[0].closedAt).toBeNull();
        await evaluateIncidents(run([], [], { staleJobs: [] }), delivery(at(2)));
        expect(rows[0].closedAt).toEqual(at(2));
        expect(sent.map((s) => s.template)).toEqual(["ops.incidentOpened", "ops.incidentRecovered"]);
    });

    it("leaves an incident open while a run covers none of its lanes", async () => {
        await evaluateIncidents(run([qbSystem("expense", { stopped: true })]), delivery(at(0)));
        await evaluateIncidents(run([], ["receipt"]), delivery(at(1)));
        expect(rows[0].closedAt).toBeNull();
    });

    it("does not close a cross-lane incident on a run that covers only some of its lanes", async () => {
        await evaluateIncidents(run([qbSystem("expense", { stopped: true }), qbSystem("gift")]), delivery(at(0)));
        await evaluateIncidents(run([], ["expense"]), delivery(at(0, 6)));
        await evaluateIncidents(run([qbSystem("gift")], ["gift"]), delivery(at(1)));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ closedAt: null, lanes: ["expense", "gift"] });
        expect(sent.map((s) => s.template)).toEqual(["ops.incidentOpened"]);

        await evaluateIncidents(run([], ["expense", "gift"]), delivery(at(2)));
        expect(rows[0].closedAt).toEqual(at(2));
        expect(sent.map((s) => s.template)).toEqual(["ops.incidentOpened", "ops.incidentRecovered"]);
    });

    describe("a failed send", () => {
        it("does not mark the incident notified and retries on the next run", async () => {
            sendOk = false;
            const events = await evaluateIncidents(run([qbSystem("gift", { stopped: true })]), delivery(at(0)));
            expect(events).toEqual([{ key: "quickbooks:system", event: "opened", sent: false }]);
            expect(rows[0].notifiedAt).toBeNull();
            sendOk = true;
            await evaluateIncidents(run([qbSystem("gift")]), delivery(at(1)));
            expect(rows[0].notifiedAt).toEqual(at(1));
            expect(sent).toHaveLength(1);
        });

        it("counts as sent when one of several addresses is reached", async () => {
            send.mockImplementationOnce(async () => false);
            await evaluateIncidents(run([qbSystem("gift", { stopped: true })]), delivery(at(0), { alertTo: ["a@example.org", "b@example.org"] }));
            expect(rows[0].notifiedAt).toEqual(at(0));
        });

        it("counts a rejected send as not sent and still tries the other addresses", async () => {
            send.mockImplementationOnce(async () => {
                throw new Error("mail service down");
            });
            await evaluateIncidents(run([qbSystem("gift", { stopped: true })]), delivery(at(0), { alertTo: ["a@example.org", "b@example.org"] }));
            expect(sent.map((s) => s.to)).toEqual(["b@example.org"]);
            expect(rows[0].notifiedAt).toEqual(at(0));
        });

        it("keeps evaluating when every send rejects, and retries on the next run", async () => {
            const qbAuth: RunFailure = { lane: "expense", cause: "quickbooks", kind: "connection", code: "QB_AUTH", count: 1 };
            sendRejects = true;
            const events = await evaluateIncidents(run([qbSystem("gift", { stopped: true }), qbAuth]), delivery(at(0)));
            expect(events.map((e) => e.sent)).toEqual([false, false]);
            expect(rows.map((r) => r.notifiedAt)).toEqual([null, null]);
            sendRejects = false;
            await evaluateIncidents(run([qbSystem("gift"), qbAuth]), delivery(at(1)));
            expect(rows.map((r) => r.notifiedAt)).toEqual([at(1), at(1)]);
        });

        it("records not sent when no address is passed", async () => {
            const events = await evaluateIncidents(run([qbSystem("gift", { stopped: true })]), delivery(at(0), { alertTo: [] }));
            expect(events).toEqual([{ key: "quickbooks:system", event: "opened", sent: false }]);
            expect(send).not.toHaveBeenCalled();
            expect(rows[0].notifiedAt).toBeNull();
        });
    });

    describe("reminders and escalation", () => {
        const failing = run([qbSystem("gift", { stopped: true })]);

        it("reminds on day 3, then weekly, with the running count", async () => {
            for (let d = 0; d <= 17; d++) await evaluateIncidents(failing, delivery(at(d)));
            const reminders = sent.filter((s) => s.template === "ops.incidentReminder");
            expect(reminders.map((s) => s.ctx.runsSeen)).toEqual(["4", "11", "18"]);
            expect(reminders[0].ctx.status).toBe("still open after 3 days");
        });

        it("reminds on schedule when the daily run starts a little early", async () => {
            await evaluateIncidents(failing, delivery(at(0)));
            await evaluateIncidents(failing, delivery(at(3, -0.1)));
            expect(sent.map((s) => s.template)).toEqual(["ops.incidentOpened", "ops.incidentReminder"]);
        });

        it("reminds and escalates on schedule when a 23-hour spring-forward day makes the run early", async () => {
            const early = -1 - 1 / 60;
            await evaluateIncidents(failing, delivery(at(0)));
            for (let d = 3; d <= 14; d++) await evaluateIncidents(failing, delivery(at(d, early)));
            expect(sent.map((s) => s.template)).toEqual([
                "ops.incidentOpened", "ops.incidentReminder", "ops.incidentReminder", "ops.incidentEscalated",
            ]);
            expect(rows[0].escalatedAt).toEqual(at(14, early));
        });

        it("reminds and escalates on schedule when a 25-hour fall-back day makes the run late", async () => {
            await evaluateIncidents(failing, delivery(at(0)));
            for (let d = 3; d <= 14; d++) await evaluateIncidents(failing, delivery(at(d, 1)));
            expect(sent.map((s) => s.template)).toEqual([
                "ops.incidentOpened", "ops.incidentReminder", "ops.incidentReminder", "ops.incidentEscalated",
            ]);
            expect(rows[0].escalatedAt).toEqual(at(14, 1));
        });

        it("does not remind or escalate a run that comes hours before the day is up", async () => {
            await evaluateIncidents(failing, delivery(at(0)));
            await evaluateIncidents(failing, delivery(at(3, -3)));
            expect(sent.map((s) => s.template)).toEqual(["ops.incidentOpened"]);
            await evaluateIncidents(failing, delivery(at(3)));
            for (let d = 4; d < 14; d++) await evaluateIncidents(failing, delivery(at(d)));
            sent.length = 0;
            await evaluateIncidents(failing, delivery(at(14, -3)));
            expect(sent.map((s) => s.template)).toEqual([]);
            await evaluateIncidents(failing, delivery(at(14)));
            expect(sent.map((s) => s.template)).toEqual(["ops.incidentEscalated"]);
        });

        it("retries a reminder whose send failed on the next run", async () => {
            await evaluateIncidents(failing, delivery(at(0)));
            sendOk = false;
            await evaluateIncidents(failing, delivery(at(3)));
            expect(rows[0].lastRemindedAt).toBeNull();
            sendOk = true;
            await evaluateIncidents(failing, delivery(at(4)));
            expect(rows[0].lastRemindedAt).toEqual(at(4));
            expect(sent.map((s) => s.template)).toEqual(["ops.incidentOpened", "ops.incidentReminder"]);
        });

        it("escalates once to the Board address after two weeks open", async () => {
            for (let d = 0; d <= 20; d++) await evaluateIncidents(failing, delivery(at(d)));
            const escalations = sent.filter((s) => s.template === "ops.incidentEscalated");
            expect(escalations).toHaveLength(1);
            expect(escalations[0].to).toBe("board@example.org");
            expect(rows[0].escalatedAt).toEqual(at(14));
        });

        it("retries an escalation whose send failed", async () => {
            for (let d = 0; d < 14; d++) await evaluateIncidents(failing, delivery(at(d)));
            await evaluateIncidents(failing, delivery(at(14), { boardTo: [] }));
            expect(rows[0].escalatedAt).toBeNull();
            await evaluateIncidents(failing, delivery(at(15)));
            expect(rows[0].escalatedAt).toEqual(at(15));
        });
    });

    describe("recovery", () => {
        it("sends a recovery email when an opening notice went out", async () => {
            await evaluateIncidents(run([qbSystem("gift", { stopped: true })]), delivery(at(0)));
            const events = await evaluateIncidents(run([]), delivery(at(1)));
            expect(events).toEqual([{ key: "quickbooks:system", event: "recovered", sent: true }]);
            expect(rows[0]).toMatchObject({ closedAt: at(1), recoveryNotifiedAt: at(1), openKey: null });
            expect(sent[1]).toMatchObject({ template: "ops.incidentRecovered", ctx: expect.objectContaining({ status: "recovered" }) });
        });

        it("sends no recovery email when the opening notice never went out", async () => {
            sendOk = false;
            await evaluateIncidents(run([qbSystem("gift", { stopped: true })]), delivery(at(0)));
            sendOk = true;
            await evaluateIncidents(run([]), delivery(at(1)));
            expect(rows[0].closedAt).toEqual(at(1));
            expect(sent).toEqual([]);
        });

        it("retries a failed recovery email on the next run", async () => {
            await evaluateIncidents(run([qbSystem("gift", { stopped: true })]), delivery(at(0)));
            sendOk = false;
            await evaluateIncidents(run([]), delivery(at(1)));
            sendOk = true;
            await evaluateIncidents(run([]), delivery(at(1, 6)));
            expect(rows[0].recoveryNotifiedAt).toEqual(at(1, 6));
            expect(sent.map((s) => s.template)).toEqual(["ops.incidentOpened", "ops.incidentRecovered"]);
        });

        it("stops retrying a failed recovery email 24 hours after closing", async () => {
            await evaluateIncidents(run([qbSystem("gift", { stopped: true })]), delivery(at(0)));
            sendOk = false;
            await evaluateIncidents(run([]), delivery(at(1)));
            sendOk = true;
            await evaluateIncidents(run([]), delivery(at(2, 1)));
            expect(rows[0].recoveryNotifiedAt).toBeNull();
            expect(sent.map((s) => s.template)).toEqual(["ops.incidentOpened"]);
        });
    });

    describe("back again", () => {
        it("reopens the same incident within 24 hours of closing and says it is back", async () => {
            await evaluateIncidents(run([qbSystem("gift", { stopped: true })]), delivery(at(0)));
            await evaluateIncidents(run([]), delivery(at(1)));
            await evaluateIncidents(run([qbSystem("gift")]), delivery(at(1, 20)));
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ openKey: "quickbooks:system", closedAt: null, firstSeenAt: at(0), runsSeen: 2 });
            expect(sent.map((s) => s.ctx.status)).toEqual(["needs attention", "recovered", "back again"]);
        });

        it("starts a new incident when the key returns more than 24 hours after closing", async () => {
            await evaluateIncidents(run([qbSystem("gift", { stopped: true })]), delivery(at(0)));
            await evaluateIncidents(run([]), delivery(at(1)));
            await evaluateIncidents(run([qbSystem("gift", { stopped: true })]), delivery(at(3)));
            expect(rows).toHaveLength(2);
            expect(sent.at(-1)?.ctx.status).toBe("needs attention");
        });

        it("does not count a blip, a clean run and another blip as two runs in a row", async () => {
            await evaluateIncidents(run([qbSystem("gift")]), delivery(at(0)));
            await evaluateIncidents(run([]), delivery(at(0, 6)));
            await evaluateIncidents(run([qbSystem("gift")]), delivery(at(0, 12)));
            expect(rows[0]).toMatchObject({ closedAt: null, runsSeen: 1, notifiedAt: null });
            expect(sent).toEqual([]);
        });
    });

    describe("overlapping runs", () => {
        const failing = run([qbSystem("gift")]);
        const twice = (report: RunReport, now: Date) => Promise.all([evaluateIncidents(report, delivery(now)), evaluateIncidents(report, delivery(now))]);

        it("count every run on an open incident", async () => {
            await evaluateIncidents(failing, delivery(at(0)));
            await twice(failing, at(1));
            expect(rows[0].runsSeen).toBe(3);
        });

        it("send the opening notice once", async () => {
            await evaluateIncidents(failing, delivery(at(0)));
            await twice(failing, at(1));
            expect(sent.map((s) => s.template)).toEqual(["ops.incidentOpened"]);
        });

        it("send a reminder once", async () => {
            for (let d = 0; d < 4; d++) await evaluateIncidents(failing, delivery(at(d)));
            await twice(failing, at(4));
            expect(sent.map((s) => s.template)).toEqual(["ops.incidentOpened", "ops.incidentReminder"]);
        });

        it("send the escalation once", async () => {
            for (let d = 0; d < 14; d++) await evaluateIncidents(failing, delivery(at(d)));
            sent.length = 0;
            await twice(failing, at(14));
            expect(sent.map((s) => s.template)).toEqual(["ops.incidentEscalated"]);
        });

        it("send the recovery notice once", async () => {
            await evaluateIncidents(run([qbSystem("gift", { stopped: true })]), delivery(at(0)));
            await twice(run([]), at(1));
            expect(sent.map((s) => s.template)).toEqual(["ops.incidentOpened", "ops.incidentRecovered"]);
        });

        it("reopen a recent incident once and send one back-again notice", async () => {
            await evaluateIncidents(run([qbSystem("gift", { stopped: true })]), delivery(at(0)));
            await evaluateIncidents(run([]), delivery(at(1)));
            await twice(run([qbSystem("gift", { stopped: true })]), at(1, 6));
            expect(rows).toHaveLength(1);
            expect(sent.map((s) => s.ctx.status)).toEqual(["needs attention", "recovered", "back again"]);
        });
    });

    it("keeps amounts, names and memo text out of the email: only codes and counts", async () => {
        await evaluateIncidents(run([{ lane: "expense", cause: "quickbooks", kind: "bug", code: "QB_PARSE", count: 1 }]), delivery(at(0)));
        expect(rows[0].detail).toBe("QB_PARSE");
        expect(Object.keys(sent[0].ctx).sort()).toEqual(["actionLink", "cause", "firstSeen", "items", "kind", "lanes", "runsSeen", "status", "summary", "todo"]);
    });
});

describe("purgeClosedIncidents", () => {
    it("deletes closed incidents older than 90 days and keeps the rest", async () => {
        await evaluateIncidents(run([qbSystem("gift")]), delivery(at(0)));
        await evaluateIncidents(run([]), delivery(at(1)));
        await evaluateIncidents(run([{ lane: "gift", cause: "quickbooks", kind: "connection", code: "QB_AUTH", count: 1 }]), delivery(at(1)));
        expect(await purgeClosedIncidents(at(90))).toBe(0);
        expect(await purgeClosedIncidents(at(92))).toBe(1);
        expect(rows.map((r) => r.key)).toEqual(["quickbooks:connection"]);
    });
});
