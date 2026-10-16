/**
 * @jest-environment node
 */
/**
 * Golden wire output of POST /api/scan for every scan outcome: status, content
 * type and the exact body text, plus the writes and notifications each outcome
 * drives. The route and the scan services run for real; only the database, the
 * clock, token minting and the supervision math are faked. The snapshot is the
 * kiosk and web wire contract, so a change to it is a protocol change.
 */
import { POST } from "../route";
import { authenticateRequest } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { processVisitCheckout } from "@/lib/attendanceTransitions";
import { supervisingAdultCount, youthIsPresent } from "@/lib/supervision";
import { sendCheckinNotifications } from "@/lib/notifications";

const NOW = new Date("2026-10-16T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

jest.mock("node:crypto", () => ({ ...jest.requireActual("node:crypto"), randomUUID: () => "token-fixed" }));
jest.mock("@/lib/auth", () => ({ authenticateRequest: jest.fn() }));
jest.mock("@/lib/logger", () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    logBackendError: jest.fn(),
}));
jest.mock("@/lib/getFullAttendance", () => ({ invalidateAttendanceCache: jest.fn() }));
jest.mock("@/lib/appSettings", () => ({ resolveDisplayTimezone: jest.fn().mockResolvedValue("America/Los_Angeles") }));
jest.mock("@/lib/notifications", () => ({ sendCheckinNotifications: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/email", () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/attendanceTransitions", () => ({
    findAssociatedEventAt: jest.fn().mockResolvedValue(null),
    processVisitCheckout: jest.fn(),
}));
jest.mock("@/lib/supervision", () => ({
    MIN_SUPERVISING_ADULTS: 2,
    supervisingAdultVisits: jest.fn().mockResolvedValue([]),
    supervisingAdultCount: jest.fn().mockReturnValue(0),
    youthIsPresent: jest.fn().mockResolvedValue(false),
}));
jest.mock("@/lib/prisma", () => {
    const fn = () => jest.fn();
    const mock = {
        person: { findUnique: fn(), findMany: fn(), findFirst: fn() },
        personMerge: { findUnique: fn() },
        rawBadgeLog: { create: fn(), findFirst: fn(), findUnique: fn(), update: fn(), updateMany: fn() },
        visit: { findFirst: fn(), findMany: fn(), findUnique: fn(), count: fn(), aggregate: fn(), create: fn(), update: fn(), updateMany: fn() },
        presenceEvent: { create: fn(), update: fn(), updateMany: fn() },
        facilityClose: { findFirst: fn(), findMany: fn(), create: fn() },
        auditLog: { create: fn() },
        systemMetricLog: { create: fn() },
        $executeRaw: fn(),
        $transaction: fn(),
    };
    return { __esModule: true, default: mock };
});

type Who = { name: string | null; nickname?: string | null; email: string | null };
type World = {
    auth: { type: "kiosk" } | { type: "session"; user: Record<string, unknown> };
    person?: Partial<Record<string, unknown>>;
    /** The scanner's own open visit, as the route and services read it. */
    openVisit?: boolean;
    /** processCheckin's re-read under the facility lock finds an open visit the route did not. */
    racedOpenVisit?: boolean;
    keyholdersIn?: number;
    others?: Who[];
    /** Check-ins after the kiosk's roster, for a close request. */
    unseen?: (Who & { arrivedAt: Date })[];
    fence?: boolean;
    seen?: boolean;
    recentScan?: boolean;
    /** Latest activity on the person's record, for a replay. */
    latestActivity?: Date;
    /** The visit a behind-replay lands in. */
    visitAtScan?: { departedAt: Date | null; departedVia: string | null };
    /** Supervising adults before and after this departure; youth present. */
    supervision?: { before: number; remaining: number; youth: boolean };
    /** The checkout departs no row. */
    noDeparted?: boolean;
    /** The web close-choice token on the scanner's visit. */
    token?: { value: string; actorId: number; warnedAt: Date };
    consumed?: number;
};

const OPEN_VISIT = { id: 42, personId: 1, arrivedAt: ago(3_600_000), departedAt: null, departedVia: null, arrivedVia: "SCANNER", deletedAt: null };

function setWorld(w: World) {
    const p = jest.mocked(prisma);
    const person = { id: 1, name: "Pat Doe", nickname: null, email: "pat@example.com", isKeyholder: false, isDeclaredAdult: true, dateOfBirth: null, mergedIntoId: null, householdId: null, ...w.person };
    jest.mocked(authenticateRequest).mockResolvedValue(w.auth as never);
    p.$transaction.mockImplementation(((cb: (tx: unknown) => unknown) => cb(p)) as never);
    p.$executeRaw.mockResolvedValue(1 as never);
    p.person.findUnique.mockResolvedValue(person as never);
    p.person.findMany.mockResolvedValue([] as never);
    p.personMerge.findUnique.mockResolvedValue(null as never);
    p.systemMetricLog.create.mockResolvedValue({} as never);
    p.rawBadgeLog.findUnique.mockResolvedValue((w.seen ? { id: 3 } : null) as never);
    p.rawBadgeLog.findFirst.mockImplementation((({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve("reviewReason" in where ? { id: 9 } : w.recentScan ? { id: 8 } : null)) as never);
    p.rawBadgeLog.create.mockResolvedValue({ id: 10 } as never);
    p.rawBadgeLog.update.mockResolvedValue({} as never);
    p.rawBadgeLog.updateMany.mockResolvedValue({ count: 1 } as never);
    p.presenceEvent.create.mockResolvedValue({ id: 77 } as never);
    p.presenceEvent.update.mockResolvedValue({} as never);
    p.presenceEvent.updateMany.mockResolvedValue({ count: 1 } as never);
    p.facilityClose.findFirst.mockResolvedValue((w.fence ? { id: 6, closedAt: ago(30_000) } : null) as never);
    p.facilityClose.findMany.mockResolvedValue([] as never);
    p.facilityClose.create.mockResolvedValue({ id: 5 } as never);
    p.auditLog.create.mockResolvedValue({} as never);
    p.visit.aggregate.mockResolvedValue({ _max: { arrivedAt: w.latestActivity ?? null, departedAt: null } } as never);
    p.visit.findFirst.mockImplementation((({ where, select, orderBy }: { where: Record<string, unknown>; select?: Record<string, unknown>; orderBy?: unknown }) => {
        if (select?.departedVia) return Promise.resolve(w.visitAtScan ? { id: 41, ...w.visitAtScan } : null);
        if (w.racedOpenVisit && select && !orderBy && where.personId === person.id) return Promise.resolve({ id: 43 });
        if (where.personId !== undefined && where.personId === person.id) return Promise.resolve(w.openVisit ? OPEN_VISIT : null);
        return Promise.resolve(null);
    }) as never);
    const others = (w.others ?? []).map((o, i) => ({ id: 100 + i, personId: 200 + i, person: { id: 200 + i, nickname: null, ...o } }));
    const unseen = (w.unseen ?? []).map((o, i) => ({ id: 300 + i, personId: 400 + i, arrivedAt: o.arrivedAt, person: { id: 400 + i, nickname: null, ...o } }));
    p.visit.findMany.mockImplementation((({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve("arrivedAt" in where ? unseen : others)) as never);
    p.visit.count.mockImplementation((({ where }: { where: Record<string, unknown> }) => {
        if ("person" in where) return Promise.resolve(w.keyholdersIn ?? 0);
        if ("forceCloseToken" in where || "supervisionWarnedAt" in where) return Promise.resolve(0);
        return Promise.resolve(others.length);
    }) as never);
    p.visit.findUnique.mockResolvedValue({
        supervisionWarnedAt: null,
        forceCloseToken: w.token?.value ?? null,
        forceCloseActorId: w.token?.actorId ?? null,
        forceCloseWarnedAt: w.token?.warnedAt ?? null,
    } as never);
    p.visit.create.mockImplementation((({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 500, ...data })) as never);
    p.visit.update.mockResolvedValue({} as never);
    p.visit.updateMany.mockResolvedValue({ count: w.consumed ?? 1 } as never);
    jest.mocked(processVisitCheckout).mockResolvedValue(
        (w.noDeparted ? [] : [{ ...OPEN_VISIT, departedAt: NOW, departedVia: "SCANNER" }]) as never);
    const sup = w.supervision ?? { before: 0, remaining: 0, youth: false };
    jest.mocked(supervisingAdultCount).mockImplementation(((_v: unknown, exclude?: number) =>
        exclude === undefined ? sup.before : sup.remaining) as never);
    jest.mocked(youthIsPresent).mockResolvedValue(sup.youth);
}

/** What one scan put on the wire and what it caused. */
async function scan(w: World, body: Record<string, unknown>) {
    jest.clearAllMocks();
    setWorld(w);
    const res = await POST(new Request("http://localhost/api/scan", { method: "POST", body: JSON.stringify(body) }) as unknown as import("next/server").NextRequest);
    const p = jest.mocked(prisma);
    const calls = (m: jest.Mock) => m.mock.calls.map(c => c[0]);
    return {
        status: res.status,
        contentType: res.headers.get("content-type"),
        body: await res.text(),
        effects: JSON.parse(JSON.stringify({
            presenceCreate: calls(p.presenceEvent.create as jest.Mock),
            presenceUpdate: calls(p.presenceEvent.update as jest.Mock),
            badgeFlag: [...calls(p.rawBadgeLog.update as jest.Mock), ...calls(p.rawBadgeLog.updateMany as jest.Mock)],
            facilityCloseCreate: calls(p.facilityClose.create as jest.Mock),
            audit: calls(p.auditLog.create as jest.Mock),
            notify: jest.mocked(sendCheckinNotifications).mock.calls,
        })),
    };
}

const kiosk = { type: "kiosk" } as const;
const sysadmin = { type: "session", user: { id: "1", isSysadmin: true } } as const;
const selfKeyholder = { type: "session", user: { id: "1", isKeyholder: true } } as const;
const keyholder = { isKeyholder: true };
const inside: Who[] = [{ name: "Alex Rivera", email: "a@example.com" }, { name: null, email: "jane.doe@example.com" }];
const replayAt = ago(60_000).toISOString();

const CASES: [string, World, Record<string, unknown>][] = [
    // Check-in
    ["kiosk IN, adult", { auth: kiosk }, { participantId: 1, intent: "IN", protocolVersion: 7 }],
    ["kiosk IN, youth into a room short of supervision", { auth: kiosk, person: { isDeclaredAdult: false }, supervision: { before: 1, remaining: 1, youth: true } }, { participantId: 1, intent: "IN", protocolVersion: 7 }],
    ["kiosk toggle IN, no protocol", { auth: kiosk }, { participantId: 1 }],
    ["kiosk toggle IN, open visit raced in under the facility lock", { auth: kiosk, racedOpenVisit: true }, { participantId: 1 }],
    ["kiosk IN, open visit raced in under the facility lock", { auth: kiosk, racedOpenVisit: true }, { participantId: 1, intent: "IN", protocolVersion: 7 }],
    ["kiosk IN with a visit already open", { auth: kiosk, openVisit: true }, { participantId: 1, intent: "IN", protocolVersion: 7 }],
    ["web check-in, keyholder inside", { auth: sysadmin, keyholdersIn: 1 }, { participantId: 1 }],
    ["web check-in, facility closed", { auth: sysadmin }, { participantId: 1 }],
    ["web IN intent, facility closed", { auth: sysadmin }, { participantId: 1, intent: "IN" }],
    ["trusted replay IN fenced by a later close", { auth: kiosk, fence: true }, { participantId: 1, intent: "IN", replay: true, clientEventId: "evt-f", scannedAt: replayAt, protocolVersion: 7 }],
    ["trusted replay IN, no fence", { auth: kiosk }, { participantId: 1, intent: "IN", replay: true, clientEventId: "evt-g", scannedAt: replayAt, protocolVersion: 7 }],
    // Check-out
    ["kiosk OUT, adult", { auth: kiosk, openVisit: true }, { participantId: 1, intent: "OUT", protocolVersion: 7 }],
    ["kiosk OUT with no visit open", { auth: kiosk }, { participantId: 1, intent: "OUT", protocolVersion: 7 }],
    ["kiosk OUT leaving two supervising adults", { auth: kiosk, openVisit: true, supervision: { before: 3, remaining: 2, youth: true } }, { participantId: 1, intent: "OUT", protocolVersion: 7 }],
    ["kiosk OUT leaving one, no youth", { auth: kiosk, openVisit: true, supervision: { before: 2, remaining: 1, youth: false } }, { participantId: 1, intent: "OUT", protocolVersion: 7 }],
    ["kiosk OUT leaving none, no youth", { auth: kiosk, openVisit: true, supervision: { before: 1, remaining: 0, youth: false } }, { participantId: 1, intent: "OUT", protocolVersion: 7 }],
    ["kiosk OUT leaving one with youth: confirm", { auth: kiosk, openVisit: true, supervision: { before: 2, remaining: 1, youth: true } }, { participantId: 1, intent: "OUT", protocolVersion: 7 }],
    ["kiosk toggle OUT leaving none with youth: confirm", { auth: kiosk, openVisit: true, supervision: { before: 1, remaining: 0, youth: true } }, { participantId: 1 }],
    ["kiosk OUT departing no row", { auth: kiosk, openVisit: true, noDeparted: true }, { participantId: 1, intent: "OUT", protocolVersion: 7 }],
    ["kiosk OUT, last keyholder, others inside", { auth: kiosk, openVisit: true, person: keyholder, others: inside }, { participantId: 1, intent: "OUT", protocolVersion: 7 }],
    ["web checkout, adult", { auth: sysadmin, openVisit: true }, { participantId: 1 }],
    // Older kiosks: the keyholder checkout decides the close
    ["protocol 2 keyholder OUT, others inside: offer", { auth: kiosk, openVisit: true, person: keyholder, others: inside }, { participantId: 1, intent: "OUT", protocolVersion: 2 }],
    ["protocol 2 keyholder OUT, nobody inside, offer shown none", { auth: kiosk, openVisit: true, person: keyholder }, { participantId: 1, intent: "OUT", protocolVersion: 2, shownEmpty: false }],
    ["protocol 2 keyholder OUT, other keyholders in: offer", { auth: kiosk, openVisit: true, person: keyholder, keyholdersIn: 1, others: inside }, { participantId: 1, intent: "OUT", protocolVersion: 2 }],
    ["protocol 2 keyholder OUT alone: closes", { auth: kiosk, openVisit: true, person: keyholder }, { participantId: 1, intent: "OUT", protocolVersion: 2 }],
    ["no-protocol keyholder toggle OUT, others inside: offer", { auth: kiosk, openVisit: true, person: keyholder, others: inside }, { participantId: 1 }],
    ["protocol 5 keyholder replay OUT, others inside: leave flagged", { auth: kiosk, openVisit: true, person: keyholder, others: inside }, { participantId: 1, intent: "OUT", protocolVersion: 5, replay: true, clientEventId: "evt-l", scannedAt: replayAt }],
    ["protocol 2 keyholder token echo: close confirmed", { auth: kiosk, openVisit: true, person: keyholder, others: inside }, { participantId: 1, intent: "OUT", protocolVersion: 2, forceCloseToken: "token-fixed" }],
    // Close requests
    ["close alone", { auth: kiosk, openVisit: true, person: keyholder }, { participantId: 1, intent: "OUT", close: "alone", clientEventId: "evt-c", protocolVersion: 7 }],
    ["close confirmed with others inside", { auth: kiosk, openVisit: true, person: keyholder, others: inside }, { participantId: 1, intent: "OUT", close: "confirmed", clientEventId: "evt-c2", protocolVersion: 7 }],
    ["close alone held: check-ins after the roster", { auth: kiosk, openVisit: true, person: keyholder, others: inside, unseen: [{ name: "Sam Lee", email: null, arrivedAt: ago(120_000) }, { name: null, email: "kim@example.com", arrivedAt: ago(60_000) }] }, { participantId: 1, intent: "OUT", close: "alone", clientEventId: "evt-h", rosterAsOf: ago(300_000).toISOString(), protocolVersion: 7 }],
    ["held close resent from the queue: applied, flagged", { auth: kiosk, openVisit: true, person: keyholder, unseen: [{ name: "Sam Lee", email: null, arrivedAt: ago(120_000) }] }, { participantId: 1, intent: "OUT", close: "alone", replay: true, clientEventId: "evt-h", scannedAt: replayAt, rosterAsOf: ago(300_000).toISOString(), protocolVersion: 7 }],
    ["queued close, keyholder already out", { auth: kiosk, person: keyholder }, { participantId: 1, intent: "OUT", close: "confirmed", replay: true, clientEventId: "evt-q", scannedAt: replayAt, protocolVersion: 7 }],
    ["queued close from someone no longer a keyholder", { auth: kiosk, openVisit: true }, { participantId: 1, intent: "OUT", close: "confirmed", replay: true, clientEventId: "evt-nk", scannedAt: replayAt, protocolVersion: 7 }],
    ["legacy shownEmpty close", { auth: kiosk, openVisit: true, person: keyholder }, { participantId: 1, shownEmpty: true, protocolVersion: 2 }],
    ["live close from a non-keyholder: refused, checked out", { auth: kiosk, openVisit: true }, { participantId: 1, intent: "OUT", close: "alone", clientEventId: "evt-r", protocolVersion: 7 }],
    ["live close from a non-keyholder with no visit open: refused, parked", { auth: kiosk }, { participantId: 1, intent: "OUT", close: "alone", clientEventId: "evt-r2", protocolVersion: 7 }],
    ["live close from a non-keyholder, debounced: refused", { auth: kiosk, openVisit: true, recentScan: true }, { participantId: 1, close: "alone" }],
    ["live close from a non-keyholder at the supervision confirm: refused", { auth: kiosk, openVisit: true, supervision: { before: 2, remaining: 1, youth: true } }, { participantId: 1, intent: "OUT", close: "alone", protocolVersion: 7 }],
    // Route-only outcomes
    ["duplicate event id", { auth: kiosk, seen: true }, { participantId: 1, intent: "IN", clientEventId: "evt-d", protocolVersion: 7 }],
    ["debounced repeat read", { auth: kiosk, recentScan: true }, { participantId: 1 }],
    ["stale replay from an untrusting kiosk: parked", { auth: kiosk, openVisit: true }, { participantId: 1, intent: "OUT", replay: true, clientEventId: "evt-s", scannedAt: ago(20 * 60_000).toISOString(), protocolVersion: 4 }],
    ["dead-lettered scan: parked", { auth: kiosk }, { participantId: 1, dead: true, deadStatus: 500, clientEventId: "evt-x", scannedAt: replayAt, intent: "IN", protocolVersion: 7 }],
    ["replay OUT behind a sweep: departure pulled back", { auth: kiosk, latestActivity: NOW, visitAtScan: { departedAt: NOW, departedVia: "AUTO_CLOSE" } }, { participantId: 1, intent: "OUT", replay: true, clientEventId: "evt-p", scannedAt: replayAt, protocolVersion: 7 }],
    ["replay OUT behind a typed departure: held", { auth: kiosk, latestActivity: NOW, visitAtScan: { departedAt: NOW, departedVia: "TYPED" } }, { participantId: 1, intent: "OUT", replay: true, clientEventId: "evt-p2", scannedAt: replayAt, protocolVersion: 7 }],
    // Web last-keyholder choice
    ["web keyholder self checkout, others inside: choice", { auth: selfKeyholder, openVisit: true, person: keyholder, others: inside }, { participantId: 1 }],
    ["web keyholder chooses close", { auth: selfKeyholder, openVisit: true, person: keyholder, others: inside, token: { value: "tok", actorId: 1, warnedAt: ago(10_000) } }, { participantId: 1, forceCloseToken: "tok", closeChoice: "close" }],
    ["web keyholder chooses leave naming nobody", { auth: selfKeyholder, openVisit: true, person: keyholder, others: inside, token: { value: "tok", actorId: 1, warnedAt: ago(10_000) } }, { participantId: 1, forceCloseToken: "tok", closeChoice: "leave" }],
    ["web keyholder answers a spent choice", { auth: selfKeyholder, openVisit: true, person: keyholder, others: inside, token: { value: "tok", actorId: 1, warnedAt: ago(10_000) }, consumed: 0 }, { participantId: 1, forceCloseToken: "tok", closeChoice: "close" }],
    ["web keyholder alone: closes", { auth: selfKeyholder, openVisit: true, person: keyholder }, { participantId: 1 }],
];

beforeAll(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "hrtime", "performance"] });
});
afterAll(() => jest.useRealTimers());

describe("POST /api/scan wire output", () => {
    it.each(CASES)("%s", async (_name, world, body) => {
        expect(await scan(world, body)).toMatchSnapshot();
    });
});
