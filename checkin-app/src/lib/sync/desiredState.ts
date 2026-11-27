import type { ListTargetKind } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";
import { canonicalizeEmail } from "@/lib/emailNormalize";
import { IN_LIVE_HOUSEHOLD } from "@/lib/household/archived";
import { settledThisCycleWhere } from "@/lib/membership/lifecycle";
import { coveredThrough, membershipYearCycle } from "@/lib/membership/renewal";
import { calculateAge } from "@/lib/time";

export type DesiredMember = { personId: number | null; email: string; reasons: string[] };
export type DesiredTarget = { targetKind: ListTargetKind; targetRef: string; members: DesiredMember[] };

const MIN_AGE = 13;
const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** A list address's identity: trimmed and lower-cased; blank means no list. */
export function listRef(address: string | null | undefined): string | null {
    return address?.trim().toLowerCase() || null;
}

/**
 * Who should be on every app-managed Google list right now (design section 2.1).
 * Pure read: keeps no bookkeeping. A list exists only while its address is set.
 */
export async function computeDesiredState(db: DbClient, now: Date): Promise<DesiredTarget[]> {
    const people = await db.person.findMany({
        where: IN_LIVE_HOUSEHOLD,
        select: { id: true, email: true, dateOfBirth: true, isDeclaredAdult: true, isHouseholdLead: true, householdId: true },
    });
    // Under 13 never; an unknown DOB counts only for a lead or a declared adult.
    const listable = (p: (typeof people)[number]) =>
        p.dateOfBirth ? calculateAge(p.dateOfBirth, now) >= MIN_AGE : p.isHouseholdLead || p.isDeclaredAdult;
    const byId = new Map(people.map((p) => [p.id, p]));
    const leadsOf = new Map<number, number[]>();
    for (const p of people) if (p.isHouseholdLead) leadsOf.set(p.householdId, [...(leadsOf.get(p.householdId) ?? []), p.id]);

    const targets = new Map<string, DesiredTarget & { byKey: Map<string, DesiredMember> }>();
    const put = (kind: ListTargetKind, address: string | null | undefined, personId: number | null, email: string | null, reason: string) => {
        const ref = listRef(address);
        const addr = email?.trim();
        if (!ref) return;
        const t = targets.get(`${kind}|${ref}`) ?? { targetKind: kind, targetRef: ref, members: [] as DesiredMember[], byKey: new Map<string, DesiredMember>() };
        targets.set(`${kind}|${ref}`, t);
        if (!addr) return;
        const k = personId === null ? canonicalizeEmail(addr) : `p${personId}`;
        const m = t.byKey.get(k);
        if (m) m.reasons.push(reason);
        else {
            const created = { personId, email: addr, reasons: [reason] };
            t.byKey.set(k, created);
            t.members.push(created);
        }
    };
    const putPerson = (kind: ListTargetKind, address: string | null | undefined, personId: number | null, reason: string) => {
        const p = personId === null ? undefined : byId.get(personId);
        if (!p) return;
        // The target exists even when nobody qualifies, so the engine can empty it.
        put(kind, address, listable(p) ? p.id : null, listable(p) ? p.email : null, reason);
    };

    const settings = await db.boardSettings.findUnique({
        where: { id: 1 },
        select: { membersGoogleGroupEmail: true, newsletterGoogleGroupEmail: true, orgMembershipYearBoundary: true },
    });
    const today = day(now);
    if (listRef(settings?.membersGoogleGroupEmail)) {
        // membershipValidThrough's rule in one query. No boundary set: ACTIVE alone, as coversThrough does.
        const boundary = settings?.orgMembershipYearBoundary;
        const cycle = boundary ? membershipYearCycle(boundary, now) : null;
        const active = await db.household.findMany({
            where: { archivedAt: null, orgMembership: { status: "ACTIVE" } },
            select: {
                id: true,
                orgMembership: { select: { processes: { where: settledThisCycleWhere(cycle?.cycleStart.getUTCFullYear() ?? null), select: { id: true }, take: 1 } } },
            },
        });
        const current = new Set<number>();
        for (const h of active) {
            if (!cycle || day(coveredThrough(cycle, (h.orgMembership?.processes.length ?? 0) > 0)) >= today) current.add(h.id);
        }
        put("MEMBERS", settings?.membersGoogleGroupEmail, null, null, "members");
        for (const p of people) if (current.has(p.householdId)) putPerson("MEMBERS", settings?.membersGoogleGroupEmail, p.id, "members");
    }
    if (listRef(settings?.newsletterGoogleGroupEmail)) {
        put("NEWSLETTER", settings?.newsletterGoogleGroupEmail, null, null, "newsletter");
        for (const p of people) putPerson("NEWSLETTER", settings?.newsletterGoogleGroupEmail, p.id, "newsletter");
    }

    const programs = await db.program.findMany({
        where: {
            OR: [
                { participantsGoogleGroupEmail: { not: null } },
                { parentsGoogleGroupEmail: { not: null } },
                { mentorsGoogleGroupEmail: { not: null } },
                { externalGoogleGroupEmail: { not: null } },
            ],
        },
        select: {
            id: true, phase: true, leadMentorId: true,
            participantsGoogleGroupEmail: true, parentsGoogleGroupEmail: true, mentorsGoogleGroupEmail: true, externalGoogleGroupEmail: true,
            volunteers: { where: { isCore: true }, select: { personId: true } },
            participants: { where: { status: "ACTIVE" }, select: { personId: true } },
            externalContacts: { where: { removedAt: null }, select: { email: true } },
        },
    });
    for (const g of programs) {
        // Current = not FINISHED; a finished program's lists are desired empty.
        const live = g.phase !== "FINISHED";
        const enrolled = live ? g.participants.map((x) => x.personId) : [];
        const scope = `program:${g.id}`;
        put("PROGRAM_PARTICIPANTS", g.participantsGoogleGroupEmail, null, null, "");
        put("PROGRAM_PARENTS", g.parentsGoogleGroupEmail, null, null, "");
        put("PROGRAM_MENTORS", g.mentorsGoogleGroupEmail, null, null, "");
        for (const id of enrolled) {
            putPerson("PROGRAM_PARTICIPANTS", g.participantsGoogleGroupEmail, id, `${scope}:participant`);
            const home = byId.get(id)?.householdId;
            for (const lead of home === undefined ? [] : leadsOf.get(home) ?? []) putPerson("PROGRAM_PARENTS", g.parentsGoogleGroupEmail, lead, `${scope}:parent`);
        }
        if (live) {
            putPerson("PROGRAM_MENTORS", g.mentorsGoogleGroupEmail, g.leadMentorId, `${scope}:leader`);
            for (const v of g.volunteers) putPerson("PROGRAM_MENTORS", g.mentorsGoogleGroupEmail, v.personId, `${scope}:core`);
        }
        put("PROGRAM_EXTERNAL", g.externalGoogleGroupEmail, null, null, "");
        for (const c of g.externalContacts) put("PROGRAM_EXTERNAL", g.externalGoogleGroupEmail, null, c.email, `${scope}:external`);
    }

    return [...targets.values()].map(({ targetKind, targetRef, members }) => ({ targetKind, targetRef, members }));
}
