import prisma from "@/lib/prisma";
import { isYouth } from "@/lib/time";
import { LIVE_PERSON } from "@/lib/person/filters";
import { PresenceClass } from "@/lib/presence/events";
import { MIN_SUPERVISING_ADULTS, supervisingAdultCount, supervisingAdultVisits } from "@/lib/supervision";

/**
 * Current-attendance feed.
 *
 * Two payload shapes, chosen by caller type:
 *
 * - Default (a signed-in privileged human — keyholder/board/sysadmin): the full
 *   roster including `dateOfBirth`, `phone` and the household's emergency
 *   contacts. That is the deliberate pickup/safety grant behind the keyholder
 *   view (`registry.ts` grants `keyholders:personal`), rendered by the
 *   emergency-contact modal on /attendance/current.
 *
 * - `{ kiosk: true }` (a signature-verified kiosk): a display-only roster —
 *   id, display name, nickname, isKeyholder, isYouth, arrival time and the
 *   program badge.
 *   The kiosk is an UNATTENDED device in a public room, and it forwards whatever
 *   it receives into an iframe with a wildcard postMessage origin
 *   (`client/client.py`), so no `personal`/`pii` field may reach it. It renders
 *   none of them: phone and the emergency-contact modal are both gated on
 *   `!isKioskMode` in /attendance/current/page.tsx. Emergency contacts aren't
 *   even fetched on this path. Same minimization as the sibling kiosk
 *   certifications grid (#329).
 *
 * `counts`/`safety` are identical either way — they are aggregates.
 *
 * `held` is the PARKED_CLOSED backlog: non-keyholder scans accepted while the
 * facility is closed, captured as PresenceEvents but not yet projected into a
 * Visit ({@link flushParkedClosed} does that once a keyholder arrives). We show
 * them so the room reflects who has actually badged in — trust what we see — but
 * they stay OUT of `counts`/`safety`: held scans exist ONLY when no keyholder is
 * present, so the supervision math is already failing, and folding unsupervised
 * bodies into it would mask that rather than expose it. The held DTO carries only
 * id/name/time — no `personal`/`pii` field — so it is safe on the kiosk path
 * without a separate projection.
 */
export async function getFullAttendance(opts: { kiosk?: boolean } = {}) {
    const kiosk = opts.kiosk === true;

    const activeVisits = await prisma.visit.findMany({
        where: { departedAt: null, deletedAt: null, person: LIVE_PERSON },
        include: {
            person: {
                select: {
                    id: true,
                    // email is read only to resolve the name fallback below and never
                    // leaves this function (M1) — same pattern as the certifications
                    // grid (#329). googleId/isSysadmin aren't rendered anywhere downstream.
                    email: true,
                    name: true,
                    // Worn on the badge and shown on the kiosk in place of the first
                    // name; 'public' tier, same as name.
                    nickname: true,
                    isKeyholder: true,
                    // dateOfBirth is read on both paths (it computes isYouth / the
                    // counts) but only SHIPS on the privileged path.
                    dateOfBirth: true,
                    // Adults 26+ have their DoB deliberately stripped (#1165) and
                    // carry this flag instead — the safety calc must honor it.
                    isDeclaredAdult: true,
                    householdId: true,
                    phone: true,
                    household: kiosk ? false : {
                        select: {
                            id: true,
                            // Only valid (non-member, complete) contacts, primary first.
                            emergencyContacts: {
                                where: { conflictParticipantId: null, name: { not: "" }, phone: { not: "" } },
                                orderBy: [{ priority: "asc" }, { id: "asc" }],
                                select: { id: true, name: true, phone: true, relationship: true },
                            },
                        }
                    }
                },
            },
            event: {
                include: {
                    program: true
                }
            }
        },
        orderBy: { arrivedAt: "desc" },
    });

    // Pre-compute isYouth once per visit to avoid repeated calculations.
    // This map feeds the two-deep safety calc: a declared adult (null DoB is
    // the NORMAL state for 26+, #1165) counts as an adult; only a truly
    // unknown person — no DoB, not declared — fails closed as youth (#300),
    // never as a supervising adult.
    const youthMap = new Map<number, boolean>();
    for (const v of activeVisits) {
        youthMap.set(v.id, v.person.isDeclaredAdult
            ? false
            : isYouth(v.person.dateOfBirth, { unknownIs: 'youth' }));
    }

    const keyholderVisits = activeVisits.filter(v => v.person.isKeyholder);
    const youthVisits = activeVisits.filter(v => youthMap.get(v.id)!);
    const volunteerVisits = activeVisits.filter(v => !v.person.isKeyholder && !youthMap.get(v.id));

    const counts = {
        keyholders: keyholderVisits.length,
        volunteers: volunteerVisits.length,
        youth: youthVisits.length,
        total: activeVisits.length,
    };

    const adultVisits = activeVisits.filter(v => !youthMap.get(v.id));
    const unaccompaniedYouth = youthVisits.filter(sv => {
        if (!sv.person.householdId) return true;
        return !adultVisits.some(av => av.person.householdId === sv.person.householdId);
    });
    // Two deep is two SUPERVISING adults, not two bodies over 18 (#1550) — the
    // same test the departure interrupt uses. ponytail: its own query rather than
    // widening the select above, so both surfaces run one shared rule. Asked only
    // when a youth is unaccompanied — the only case the flag can be true — so an
    // adult-only room costs this poll no extra queries, as processCheckin does.
    const safety = {
        isLastKeyholder: keyholderVisits.length === 1,
        isTwoDeepViolation: unaccompaniedYouth.length > 0
            && supervisingAdultCount(await supervisingAdultVisits()) < MIN_SUPERVISING_ADULTS,
    };

    // Drop email/googleId from the wire (M1): resolve the same name-or-email-prefix
    // fallback the UI already falls back to (`name || email.split("@")[0]`) here,
    // server-side, so `name` is always populated and the raw address never ships.
    // Strip the raw included `person` (carries email) out of the spread and re-emit
    // a sanitized DTO under the unchanged wire key `participant` (API contract).
    const attendance = activeVisits.map(({ person, ...v }) => {
        const displayName = person.name?.trim() || person.email?.split("@")[0] || null;

        if (kiosk) {
            // Display-only projection — see the header comment. The visit row itself
            // is rebuilt field by field rather than spread, so nothing new added to
            // Visit/Program later leaks onto the kiosk by default.
            return {
                id: v.id,
                arrivedAt: v.arrivedAt,
                participant: {
                    id: person.id,
                    name: displayName,
                    nickname: person.nickname,
                    isKeyholder: person.isKeyholder,
                    // The kiosk splits the board into keyholder/volunteer/youth
                    // columns. It gets the classification, not the birth date.
                    isYouth: youthMap.get(v.id)!,
                },
                event: v.event ? { program: v.event.program ? { id: v.event.program.id, name: v.event.program.name } : null } : null,
            };
        }

        return {
            ...v,
            participant: {
                id: person.id,
                name: displayName,
                nickname: person.nickname,
                isKeyholder: person.isKeyholder,
                isYouth: youthMap.get(v.id)!,
                dateOfBirth: person.dateOfBirth,
                householdId: person.householdId,
                phone: person.phone,
                household: person.household,
            },
        };
    });

    // Held scans: badged IN while the facility was closed, awaiting a keyholder.
    // Ordered as they occurred (the order the flush will project them). Only the
    // display name resolves out — email is read for the same fallback the roster
    // uses and never ships. nickname rides along so the kiosk shows the name the
    // person goes by, same as the roster (#1813). LIVE_PERSON drops tombstones.
    const heldEvents = await prisma.presenceEvent.findMany({
        where: { classification: PresenceClass.PARKED_CLOSED, direction: "IN", person: LIVE_PERSON },
        orderBy: { occurredAt: "asc" },
        include: { person: { select: { name: true, nickname: true, email: true } } },
    });
    const held = heldEvents.map((ev) => ({
        id: ev.id,
        occurredAt: ev.occurredAt,
        name: ev.person.name?.trim() || ev.person.email?.split("@")[0] || null,
        nickname: ev.person.nickname,
    }));

    return { attendance, held, counts, safety };
}
