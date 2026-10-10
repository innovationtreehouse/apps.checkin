import prisma from "@/lib/prisma";
import { isYouth } from "@/lib/time";
import { LIVE_PERSON } from "@/lib/person/filters";
import { LIVE_VISIT } from "@/lib/visit/filters";
import { MIN_SUPERVISING_ADULTS, supervisingAdultCount, supervisingAdultVisits } from "@/lib/supervision";
import { invalidateKioskCertificationsCache } from "@/lib/getKioskCertifications";
import { invalidatableCache } from "@/lib/invalidatableCache";
import { getKioskDisplayNames } from "@/lib/kiosk-names";

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
 *   id, kiosk label, isKeyholder, isYouth, arrival time and the program badge.
 *   The label is resolved here (getKioskDisplayNames: nickname, else first name,
 *   a last initial only to tell two apart), so no last name reaches the device.
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
 * `safety.facilityOpen` is the one answer to "is the building open": a keyholder
 * is present. Never infer it from `counts.total` — a kiosk badge checks in with
 * no keyholder present, so people can be inside a closed building. Each row's
 * `noKeyholder` marks such a visit (see {@link visitHadNoKeyholder}).
 *
 * Per-process cache (see {@link invalidatableCache}): a GET hits the DB on a cold
 * miss, or after 60s while anyone is present. Writes that change the roster or a
 * present person's fields call `invalidateAttendanceCache` after commit. One ECS
 * task; a scale-to-zero relaunch starts empty.
 */
const occupied = (p: Awaited<ReturnType<typeof computeFullAttendance>>) => p.counts.total > 0;
const kioskCache = invalidatableCache(() => computeFullAttendance(true), occupied);
const fullCache = invalidatableCache(() => computeFullAttendance(false), occupied);

export function invalidateAttendanceCache(): void {
    kioskCache.invalidate();
    fullCache.invalidate();
    // Present-limited cert grid is occupancy; a check-in/out must refresh it too.
    invalidateKioskCertificationsCache();
}

export async function getFullAttendance(opts: { kiosk?: boolean } = {}) {
    return (opts.kiosk === true ? kioskCache : fullCache).get();
}

/** A keyholder arriving this soon after someone else still covers them. */
export const NO_KEYHOLDER_GRACE_MS = 10 * 60_000;

type Span = { arrivedAt: Date; departedAt: Date | null };

/**
 * A non-keyholder visit is "no keyholder" when no keyholder was in the building
 * at any moment from its arrival to {@link NO_KEYHOLDER_GRACE_MS} after it.
 * Derived from the visit record, so a keyholder visit added, edited or removed
 * later re-decides the mark.
 */
export function visitHadNoKeyholder(arrivedAt: Date, keyholderVisits: Span[]): boolean {
    const until = arrivedAt.getTime() + NO_KEYHOLDER_GRACE_MS;
    return !keyholderVisits.some(k =>
        k.arrivedAt.getTime() <= until && (k.departedAt === null || k.departedAt >= arrivedAt));
}

async function computeFullAttendance(kiosk: boolean) {
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
    // Keyholder visits that could cover any present non-keyholder's arrival
    // window. Asked only when a non-keyholder is present.
    const otherArrivals = activeVisits.filter(v => !v.person.isKeyholder).map(v => v.arrivedAt.getTime());
    const keyholderCover: Span[] = otherArrivals.length === 0 ? [] : await prisma.visit.findMany({
        where: {
            ...LIVE_VISIT,
            person: { isKeyholder: true, ...LIVE_PERSON },
            arrivedAt: { lte: new Date(Math.max(...otherArrivals) + NO_KEYHOLDER_GRACE_MS) },
            OR: [{ departedAt: null }, { departedAt: { gte: new Date(Math.min(...otherArrivals)) } }],
        },
        select: { arrivedAt: true, departedAt: true },
    });
    const noKeyholder = (isKeyholder: boolean, arrivedAt: Date) =>
        !isKeyholder && visitHadNoKeyholder(arrivedAt, keyholderCover);

    const safety = {
        facilityOpen: keyholderVisits.length > 0,
        isLastKeyholder: keyholderVisits.length === 1,
        isTwoDeepViolation: unaccompaniedYouth.length > 0
            && supervisingAdultCount(await supervisingAdultVisits()) < MIN_SUPERVISING_ADULTS,
    };

    // Drop email/googleId from the wire (M1): resolve the same name-or-email-prefix
    // fallback the UI already falls back to (`name || email.split("@")[0]`) here,
    // server-side, so `name` is always populated and the raw address never ships.
    // Strip the raw included `person` (carries email) out of the spread and re-emit
    // a sanitized DTO under the unchanged wire key `participant` (API contract).
    const kioskLabels = kiosk ? getKioskDisplayNames(activeVisits.map(v => v.person)) : null;
    const attendance = activeVisits.map(({ person, ...v }) => {
        const displayName = person.name?.trim() || person.email?.split("@")[0] || null;

        if (kioskLabels) {
            // Display-only projection — see the header comment. The visit row itself
            // is rebuilt field by field rather than spread, so nothing new added to
            // Visit/Program later leaks onto the kiosk by default.
            return {
                id: v.id,
                arrivedAt: v.arrivedAt,
                noKeyholder: noKeyholder(person.isKeyholder, v.arrivedAt),
                participant: {
                    id: person.id,
                    name: kioskLabels.get(person.id) || null,
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
            noKeyholder: noKeyholder(person.isKeyholder, v.arrivedAt),
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

    return { attendance, counts, safety };
}
