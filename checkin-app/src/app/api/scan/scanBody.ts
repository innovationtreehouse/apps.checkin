import { createHash } from "node:crypto";
import type { CloseKind } from "@/lib/attendance/close";

// Far beyond any honest kiosk figure (about a second online, some seconds after
// a night offline). A wider one means the kiosk does not know the time.
const MAX_SCAN_TIME_UNCERTAINTY_MS = 60 * 60 * 1000;

// Bounded to Postgres int4 (see lib/searchId.ts): a larger id makes the
// lookup throw instead of matching nothing.
const isPersonId = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 2147483647;

const isProtocolVersion = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1;

const isTimestamp = (v: unknown): Date | null => {
    const parsed = typeof v === 'string' ? new Date(v) : null;
    return parsed && !isNaN(parsed.getTime()) ? parsed : null;
};

/** Why a dead-lettered scan failed: the kiosk's HTTP status, 400 for a replay
 *  the server could not read, or no usable scan time. */
export type DeadStatus = number | "no_scan_time" | "unknown";

/** A scan happening now at the kiosk. */
type LiveDelivery = { slot: "live"; personId: number };

/** A queued scan the kiosk's outbox redelivers, applied at its own scan time. */
type ReplayDelivery = { slot: "replay"; clientEventId: string; scannedAt: Date; uncertaintyMs: number };

/** A scan that only parks for review: dead-lettered by the kiosk, or a replay
 *  the server cannot apply. A replay with no id of its own is keyed by its body. */
type DeadDelivery = { slot: "dead"; clientEventId: string; scannedAt: Date | null; status: DeadStatus };

type Delivery = LiveDelivery | ReplayDelivery | DeadDelivery;

type ScanFields = {
    /** The badge value as sent. */
    rawId: unknown;
    /** Null only on a queued scan, which parks as unresolvable. */
    personId: number | null;
    clientEventId: string | null;
    scannedAt: Date | null;
    /** The direction the kiosk displayed; null for a legacy live-state toggle. */
    intent: "IN" | "OUT" | null;
    clockSuspect: boolean;
    /** Server time of the kiosk's last roster. */
    rosterAsOf: Date | null;
    /** What an older kiosk showed inside; null when it did not say. */
    shownEmpty: boolean | null;
    /** The kiosk's protocol generation: 1 when it sent no number. */
    protocolVersion: number;
    /** The version to record for the kiosk key; null when the one sent is invalid. */
    recordedVersion: number | null;
};

/** A parsed `POST /api/scan` body. A keyholder's close arrives in any slot. */
export type ScanBody =
    | (ScanFields & LiveDelivery & { kind: "live" })
    | (ScanFields & ReplayDelivery & { kind: "replay" })
    | (ScanFields & DeadDelivery & { kind: "dead" })
    | (ScanFields & Delivery & { kind: "close"; close: CloseKind });

export type ParsedScanBody = { ok: true; scan: ScanBody } | { ok: false; error: string };

const refuse = (error: string): ParsedScanBody => ({ ok: false, error });

/**
 * Reads a kiosk scan body. A refusal's error is the 400 message. A replay is
 * never refused once it names itself a replay: one the server cannot apply
 * comes back as a dead letter, so the head of the kiosk's queue never blocks.
 */
export function parseScanBody(body: unknown): ParsedScanBody {
    const b: Record<string, unknown> = typeof body === 'object' && body !== null ? { ...body } : {};

    // Older kiosks name the badge participantId.
    const rawId = b.personId ?? b.participantId;
    const idConflict = b.personId != null && b.participantId != null && b.personId !== b.participantId;
    const personId = !idConflict && isPersonId(rawId) ? rawId : null;
    const badId = () => refuse(idConflict ? "personId and participantId disagree." : "A valid numeric personId is required.");
    // A queued row (dead-lettered or replayed) parks whatever id it carries, so
    // a corrupt read reaches the review queue instead of bouncing forever.
    if (personId === null && b.dead !== true && b.replay !== true) return badId();

    const sentEventId = (typeof b.clientEventId === 'string' && b.clientEventId) || null;
    const scannedAt = isTimestamp(b.scannedAt);

    // Replay-ness is explicit: only the outbox drain sets it. The try-first rule
    // puts clientEventId on the live attempt too, so it cannot be inferred.
    if (b.replay !== undefined && typeof b.replay !== 'boolean') return refuse("replay must be a boolean.");
    if (b.dead !== undefined && typeof b.dead !== 'boolean') return refuse("dead must be a boolean.");
    if (b.dead === true && b.replay === true) return refuse("dead and replay are mutually exclusive.");
    if (b.dead === true && !sentEventId) return refuse("A dead-lettered scan requires clientEventId.");
    if (b.dead === true && !scannedAt) return refuse("A dead-lettered scan requires a valid scannedAt.");

    // An older kiosk's offline confirm flag, or the token it echoes on a close's
    // second scan, is a confirmed close; its shownEmpty: true is a one-badge close.
    const confirmToken = typeof b.forceCloseToken === 'string' && b.forceCloseToken.length > 0;
    const requestedClose: CloseKind | null = b.close === 'alone' || b.close === 'confirmed'
        ? b.close
        : b.forceCloseConfirmed === true || confirmToken
            ? 'confirmed'
            : b.shownEmpty === true
                ? 'alone'
                : null;
    const rosterAsOf = isTimestamp(b.rosterAsOf);

    // A replay must carry its own id and event time: falling back to now would
    // make the freshness check pass trivially and toggle a scan that should park.
    const invalid =
        b.replay === true && !sentEventId ? "A replayed scan requires clientEventId." :
        b.replay === true && !scannedAt ? "A replayed scan requires a valid scannedAt." :
        b.intent !== undefined && b.intent !== 'IN' && b.intent !== 'OUT' ? "intent must be IN or OUT." :
        b.close !== undefined && b.close !== 'alone' && b.close !== 'confirmed' ? "close must be alone or confirmed." :
        requestedClose && b.intent === 'IN' ? "A close is a checkout; intent must be OUT." :
        b.rosterAsOf !== undefined && !rosterAsOf ? "rosterAsOf must be a timestamp." :
        b.scanTimeUncertaintyMs !== undefined && !(typeof b.scanTimeUncertaintyMs === 'number' && Number.isFinite(b.scanTimeUncertaintyMs) && b.scanTimeUncertaintyMs >= 0)
            ? "scanTimeUncertaintyMs must be a non-negative number." :
        b.clockSuspect !== undefined && typeof b.clockSuspect !== 'boolean' ? "clockSuspect must be a boolean." :
        b.shownEmpty !== undefined && typeof b.shownEmpty !== 'boolean' ? "shownEmpty must be a boolean." :
        b.protocolVersion !== undefined && !isProtocolVersion(b.protocolVersion)
            ? "protocolVersion must be a positive integer." :
        null;
    if (invalid && b.replay !== true) return refuse(invalid);

    // A replay with no usable scan time parks at server now, which only bounds it from above.
    const noScanTime = b.replay === true && !scannedAt;
    const sentUncertaintyMs = typeof b.scanTimeUncertaintyMs === 'number' ? b.scanTimeUncertaintyMs : 0;
    const uncertaintyTooWide = b.replay === true && invalid === null && sentUncertaintyMs > MAX_SCAN_TIME_UNCERTAINTY_MS;
    let delivery: Delivery;
    if (b.dead === true || (b.replay === true && invalid !== null)) {
        delivery = {
            slot: "dead",
            clientEventId: sentEventId ?? `body:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`,
            scannedAt,
            status: noScanTime ? 'no_scan_time'
                : invalid ? 400
                : typeof b.deadStatus === 'number' && Number.isFinite(b.deadStatus) ? b.deadStatus
                : 'unknown',
        };
    } else if (b.replay === true && sentEventId && scannedAt) {
        delivery = {
            slot: "replay",
            clientEventId: sentEventId,
            scannedAt,
            uncertaintyMs: uncertaintyTooWide ? 0 : sentUncertaintyMs,
        };
    } else if (personId !== null) {
        delivery = { slot: "live", personId };
    } else {
        return badId();
    }

    const fields: ScanFields = {
        rawId,
        personId,
        clientEventId: delivery.slot === "live" ? sentEventId : delivery.clientEventId,
        scannedAt,
        intent: b.intent === 'IN' || b.intent === 'OUT' ? b.intent : null,
        clockSuspect: b.clockSuspect === true || uncertaintyTooWide || noScanTime,
        rosterAsOf,
        shownEmpty: typeof b.shownEmpty === 'boolean' ? b.shownEmpty : null,
        protocolVersion: typeof b.protocolVersion === 'number' ? b.protocolVersion : 1,
        recordedVersion: b.protocolVersion === undefined ? 1
            : isProtocolVersion(b.protocolVersion) ? b.protocolVersion
            : null,
    };

    // An unreadable replay never closes: it only parks.
    if (requestedClose && !invalid) return { ok: true, scan: { ...fields, ...delivery, kind: "close", close: requestedClose } };
    switch (delivery.slot) {
        case "live": return { ok: true, scan: { ...fields, ...delivery, kind: "live" } };
        case "replay": return { ok: true, scan: { ...fields, ...delivery, kind: "replay" } };
        case "dead": return { ok: true, scan: { ...fields, ...delivery, kind: "dead" } };
    }
}
