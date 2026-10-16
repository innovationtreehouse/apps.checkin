import { randomUUID } from "node:crypto";
import type { Person } from "@/generated/prisma/client";
import { apiJson } from "@/lib/api-response";
import { resolveDisplayTimezone } from "@/lib/appSettings";
import { getKioskDisplayName, getKioskDisplayNames } from "@/lib/kiosk-names";
import { FORCE_CLOSE_CONFIRM_SECONDS, SUPERVISION_CONFIRM_MS, presentLabels, type CloseGuardResult, type CloseOffer, type ScanOutcome } from "@/lib/scan-service";
import { MIN_SUPERVISING_ADULTS } from "@/lib/supervision";
import { formatTime } from "@/lib/time";

/** A scan's result: a service outcome, or one the route reaches on its own. */
export type ScanResult =
    | ScanOutcome
    /** This event id was already recorded. */
    | { kind: "duplicate" }
    /** A repeat read of the same badge within the debounce window. */
    | { kind: "debounced" }
    /** A replayed departure pulled a machine departure back to its scan time. */
    | { kind: "departure_pulled_back" }
    /** The web last-keyholder guard asks for, or refuses, a close choice. */
    | { kind: "close_guard"; guard: Exclude<CloseGuardResult, { action: "proceed" }> };

export type WireContext = {
    /** The request came from a signed kiosk. */
    signedRequest: boolean;
    /** A live close from a badge that is not a keyholder: the scan went through as itself. */
    closeRefused?: boolean;
};

/**
 * Who scanned, as a scan response may say it: an id and the same
 * nickname-else-first-name label the kiosk roster shows. The kiosk renders this on
 * an unattended public screen and forwards it into an iframe with a wildcard
 * postMessage origin (client/client.py), so the raw Person — email, phone, date of
 * birth — never ships (docs/rules/attendance-checkin.md, "The kiosk").
 */
function scanParticipant(person: Person) {
    return { id: person.id, name: getKioskDisplayName(person) };
}

function leftInBuilding(remaining: number) {
    return remaining === 1 ? "only 1 supervising adult" : "NO supervising adult";
}

function departureWarning(remaining: number | undefined) {
    if (remaining === undefined) return undefined;
    return remaining === MIN_SUPERVISING_ADULTS
        ? `Warning: only ${MIN_SUPERVISING_ADULTS} supervising adults remain in the building.`
        : `Warning: checking out leaves ${leftInBuilding(remaining)} in the building.`;
}

async function closeOfferFields(offer: CloseOffer | undefined) {
    if (!offer) return {};
    if (offer.reason === "unseen_checkins") {
        const timeZone = await resolveDisplayTimezone();
        const labels = getKioskDisplayNames(offer.unseen.map(v => ({ ...v.person, id: v.id })));
        const who = offer.unseen.map(v => `${labels.get(v.id) || "Someone"} checked in at ${formatTime(v.arrivedAt, { timeZone })}`).join("; ");
        return { closePrompt: `${who}. Badge again to close the building.` };
    }
    const closePrompt = offer.reason === "keyholders_remain"
        ? `Others are still recorded inside. Badge again within ${FORCE_CLOSE_CONFIRM_SECONDS} seconds to close the building and check everyone out.`
        : `No other keyholder is checked in${offer.othersInside.length > 0
            ? `, and others are still recorded inside: ${presentLabels(offer.othersInside).join(", ")}.`
            : "."} Badge again within ${FORCE_CLOSE_CONFIRM_SECONDS} seconds to close the building and check everyone out.`;
    // An older kiosk echoes this token on the same badge's second scan; the
    // route reads any echo as a confirmed close, so nothing stores it.
    return { closePrompt, forceCloseToken: randomUUID(), confirmSeconds: FORCE_CLOSE_CONFIRM_SECONDS };
}

async function wireBody(result: ScanResult, ctx: WireContext): Promise<{ body: Record<string, unknown>; status: number }> {
    switch (result.kind) {
        case "checkin":
            if (result.departedAtClose) {
                return { body: { type: "checkin", message: "Checked in; departed at the close that followed", visit: result.visit }, status: 200 };
            }
            return {
                body: {
                    message: "Checked in successfully",
                    type: "checkin",
                    warning: result.supervisionShort
                        ? `Warning: fewer than ${MIN_SUPERVISING_ADULTS} supervising adults are in the building.`
                        : undefined,
                    participant: scanParticipant(result.person),
                    visit: result.visit,
                    signedRequest: ctx.signedRequest,
                },
                status: 200,
            };
        case "checkout":
            return {
                body: {
                    message: result.closed ? "Checked out and Facility closed" : "Checked out successfully",
                    type: "checkout",
                    warning: departureWarning(result.supervisorsRemaining),
                    participant: scanParticipant(result.person),
                    visit: result.visit,
                    facilityClosed: result.closed,
                    ...await closeOfferFields(result.closeOffer),
                    signedRequest: ctx.signedRequest,
                },
                status: 200,
            };
        case "confirm_departure":
            return {
                body: {
                    error: `Warning! Checking out leaves ${leftInBuilding(result.supervisorsRemaining)} in the building.\n\nBadge again within ${SUPERVISION_CONFIRM_MS / 1000} seconds to confirm.`,
                    type: "warning",
                },
                status: 400,
            };
        case "parked":
            return {
                body: result.reason === "double_in"
                    ? { type: "parked", reason: "double_in", message: "Recorded for review." }
                    : { type: "parked", message: "Recorded for review." },
                status: 200,
            };
        case "refused":
            return { body: { error: "Facility is closed. A keyholder must badge in at the door first." }, status: 403 };
        case "duplicate":
            return { body: { type: "duplicate_ignored", message: "Event already recorded." }, status: 200 };
        case "debounced":
            return { body: { type: "ignored_debounce", message: "Scan ignored due to debounce." }, status: 200 };
        case "departure_pulled_back":
            return { body: { type: "checkout", message: "Checked out successfully", facilityClosed: false }, status: 200 };
        case "close_guard":
            return result.guard.action === "warn"
                ? { body: result.guard.warning, status: 400 }
                : { body: { error: result.guard.error }, status: result.guard.status };
    }
}

/** The kiosk and web wire for a scan's result: the only place its statuses, messages and flags are decided. */
export async function toResponse(result: ScanResult, ctx: WireContext): Promise<Response> {
    const { body, status } = await wireBody(result, ctx);
    return apiJson(ctx.closeRefused
        ? { ...body, facilityClosed: false, closeRefused: true, message: "Only a keyholder can close the building." }
        : body, status);
}
