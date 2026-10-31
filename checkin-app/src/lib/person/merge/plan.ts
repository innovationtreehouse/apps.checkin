import type { Person, PersonRoleKind, Prisma } from "@/generated/prisma/client";
import type { AuthenticatedUser } from "@/types/auth";
import { KIND_TO_MIRROR } from "@/lib/roles";
import { bgSubjectKey, householdMembershipStatus, membershipMergeBlock, roleMergeBlock } from "./guard";

// Fields eligible for a per-field conflict radio: both sides non-null and different.
// `image` auto-backfills only (never a radio) so it's a separate list below.
// The login identity (email + googleId + emailVerified) is deliberately NOT here:
// those three are minted together at sign-in and are resolved as ONE unit under
// the `identity` key (see resolveKeeperUpdate), never split field-by-field —
// splitting could seat one side's email on the other's googleId, or graft a stale
// emailVerified onto a swapped-in address nobody proved they control.
export const CONFLICT_FIELDS = ['name', 'phone', 'dateOfBirth'] as const;
// Single-sided auto-backfill fields — the 3 conflict fields plus image.
const AUTO_BACKFILL_FIELDS = [...CONFLICT_FIELDS, 'image'] as const;
// The wholesale-choice key the client sends for the login identity conflict.
export const IDENTITY_CHOICE_KEY = 'identity';
// Every valid fieldChoices key: the per-field radios plus the identity unit.
const VALID_CHOICE_KEYS: readonly string[] = [...CONFLICT_FIELDS, IDENTITY_CHOICE_KEY];

/** The Person fields the keeper-update decisions read. */
export type MergeFields = Pick<Person, "name" | "phone" | "dateOfBirth" | "image" | "email" | "googleId" | "emailVerified" | "emailSuppressed" | "lastBackgroundCheck" | "lastWaiverSign">;
export type FieldChoices = Partial<Record<string, 'keep' | 'merge'>>;
export type Collision = { type: string; message: string };
export type MergeRefusal = { status: 400 | 403 | 404 | 409; error: string; collisions?: Collision[] };

const SUBJECT_INCLUDE = {
    programParticipants: { include: { program: { select: { name: true } } } },
    programVolunteers: true,
    rsvps: { include: { event: { select: { name: true, startAt: true } } } },
    toolStatuses: { include: { tool: { select: { name: true } } } },
    bgAttestations: true,
    bgAttestationsAsSubject: true,
    corporationLeads: true,
    corporationMembers: true,
    roles: true,
} as const;

export const KEEP_INCLUDE = {
    ...SUBJECT_INCLUDE,
    household: { include: { orgMembership: true } },
} as const;

export const MERGE_INCLUDE = {
    ...SUBJECT_INCLUDE,
    household: {
        include: {
            householdMembers: true,
            orgMembership: true,
        },
    },
} as const;

export type KeepSubject = Prisma.PersonGetPayload<{ include: typeof KEEP_INCLUDE }>;
export type MergeSubject = Prisma.PersonGetPayload<{ include: typeof MERGE_INCLUDE }>;

export function isEmpty(v: unknown): boolean {
    return v === null || v === undefined || v === '';
}

/** True conflict: both sides non-null/non-empty AND different. */
export function valuesConflict(a: unknown, b: unknown): boolean {
    if (isEmpty(a) || isEmpty(b)) return false;
    if (a instanceof Date && b instanceof Date) return a.getTime() !== b.getTime();
    return a !== b;
}

/** A login identity is present iff email OR googleId is non-empty. */
export function hasIdentity(p: { email: string | null; googleId: string | null }): boolean {
    return !isEmpty(p.email) || !isEmpty(p.googleId);
}

/**
 * Pre-image of every field a merge can rewrite on EITHER side — the tombstone's
 * mangled identity and the keeper's overwritten name/email/DOB alike. Captured
 * before the updates run, because afterwards neither is readable.
 *
 * The four legacy role mirrors are in here because the merge rewrites them on
 * both sides too (zeroed on the tombstone, re-derived on the keeper). Nothing is
 * deleted by a merge, so this audit row is the only forensic record of what
 * authority the merged-away record held — an un-merge that could not restore it
 * would be restoring a different person.
 */
export function personPreImage(p: Person) {
    return {
        id: p.id,
        googleId: p.googleId,
        email: p.email,
        emailVerified: p.emailVerified,
        emailSuppressed: p.emailSuppressed,
        phone: p.phone,
        name: p.name,
        dateOfBirth: p.dateOfBirth,
        image: p.image,
        lastWaiverSign: p.lastWaiverSign,
        lastBackgroundCheck: p.lastBackgroundCheck,
        isHouseholdLead: p.isHouseholdLead,
        householdId: p.householdId,
        isSysadmin: p.isSysadmin,
        isBoardMember: p.isBoardMember,
        isKeyholder: p.isKeyholder,
        isBackgroundCheckReviewer: p.isBackgroundCheckReviewer,
    };
}

/**
 * The `PersonMerge.snapshot` payload: identity as it stood at merge time, for the
 * readers that outlive the tombstone Person row. Narrower than `personPreImage`,
 * which is forensic and lands in AuditLog; this is a live data source —
 * compliance reads name/lastBackgroundCheck, audit names read email.
 *
 * NO dateOfBirth: a Json blob is classified as one field, so it would re-tier
 * the column from `pii` to `personal` for no reader. Dates are ISO strings
 * because Prisma's Json input rejects a Date.
 */
export function mergeSnapshot(p: Person) {
    return {
        name: p.name,
        email: p.email,
        lastBackgroundCheck: p.lastBackgroundCheck?.toISOString() ?? null,
        isSysadmin: p.isSysadmin,
        isBoardMember: p.isBoardMember,
        isKeyholder: p.isKeyholder,
        isBackgroundCheckReviewer: p.isBackgroundCheckReviewer,
    };
}

/**
 * Person's legacy boolean role mirrors for a set of held roles, as `applyRoleFlag`
 * (lib/roles.ts) dual-writes them. Derived from KIND_TO_MIRROR so a new mirrored
 * role is covered the day it exists.
 */
export function roleMirrors(held: Set<PersonRoleKind>): Record<string, boolean> {
    return Object.fromEntries(
        Object.entries(KIND_TO_MIRROR).map(([kind, flag]) => [flag, [...held].some(role => role === kind)]),
    );
}

/**
 * Build the keeper's `person.update` data from: single-sided auto-backfill,
 * radio-resolved true conflicts (name/phone/dateOfBirth), the login identity
 * resolved as ONE unit (email + googleId + emailVerified), and the newer-date
 * auto-pick for the two compliance dates (never a radio).
 */
export function resolveKeeperUpdate(keep: MergeFields, merge: MergeFields, choices: FieldChoices): Record<string, unknown> {
    const data: Record<string, unknown> = {};

    for (const field of AUTO_BACKFILL_FIELDS) {
        const keepVal = keep[field];
        const mergeVal = merge[field];
        if (field !== 'image' && valuesConflict(keepVal, mergeVal)) {
            const choice = choices[field] ?? 'keep';
            if (choice === 'merge') data[field] = mergeVal;
            // 'keep' -> no write, keeper's existing value stands.
        } else if (isEmpty(keepVal) && !isEmpty(mergeVal)) {
            data[field] = mergeVal;
        }
    }

    // Login identity — email/googleId/emailVerified are minted together at
    // sign-in, so they move together or not at all. A record holds only one of
    // each (all @unique), so the only coherent outcomes are "keep the keeper's
    // whole identity" or "adopt the merge side's" — never a cross-side split
    // that would seat an address nobody proved they control.
    const keepHasIdentity = hasIdentity(keep);
    const mergeHasIdentity = hasIdentity(merge);
    const adoptMergeIdentity =
        // Both sides have one (always a true conflict — unique constraints):
        // client picks via the `identity` radio.
        (keepHasIdentity && mergeHasIdentity && choices[IDENTITY_CHOICE_KEY] === 'merge') ||
        // Empty keeper, merge side has one: adopt it (single-sided backfill).
        (!keepHasIdentity && mergeHasIdentity);
    if (adoptMergeIdentity) {
        data.email = merge.email;
        data.googleId = merge.googleId;
        data.emailVerified = merge.emailVerified;
        // Suppression is tied to the address, so it rides in with it.
        data.emailSuppressed = merge.emailSuppressed;
    }
    // Only-keeper-has-identity (or 'keep' choice, or neither side) -> no write:
    // the keeper's address stands, and so does its own emailSuppressed.

    // Compliance dates: always take the newer one. Same human — an older check
    // is never the right survivor. Never a radio.
    for (const field of ['lastBackgroundCheck', 'lastWaiverSign'] as const) {
        const carried = carriedComplianceDate(keep[field], merge[field]);
        if (carried) data[field] = carried;
    }

    return data;
}

/** The merge side's compliance date when the keeper would adopt it, else null. */
export function carriedComplianceDate(keepVal: Date | null, mergeVal: Date | null): Date | null {
    return mergeVal != null && (keepVal == null || mergeVal.getTime() > keepVal.getTime()) ? mergeVal : null;
}

/** The household-lead, membership and role refusals, in that order, or null. */
export function subjectRefusal(keep: KeepSubject, merge: MergeSubject, actor: AuthenticatedUser | null): MergeRefusal | null {
    const householdOthersCount = merge.household?.householdMembers.filter(p => p.id !== merge.id).length || 0;

    if (merge.isHouseholdLead && householdOthersCount > 0) {
        return { status: 400, error: "Cannot merge: the to-be-deleted participant is the lead of a household with other members." };
    }

    // The count of people who would still be left to use the household's membership.
    const membershipBlock = membershipMergeBlock(
        { status: householdMembershipStatus(keep.household) },
        { status: householdMembershipStatus(merge.household), liveOthers: householdOthersCount },
    );
    if (membershipBlock) return { status: 400, error: membershipBlock };

    return roleMergeBlock(
        actor,
        merge.roles.map(r => r.role),
        keep.roles.map(r => r.role),
        householdMembershipStatus(keep.household),
    );
}

/**
 * Decision-bearing collisions that refuse the merge. Both sides having an open
 * visit is one; `openVisits` carries that read in.
 */
export function findCollisions(
    keep: KeepSubject,
    merge: MergeSubject,
    openVisits: { keep: boolean; merge: boolean },
    now: Date,
): Collision[] {
    const collisions: Collision[] = [];

    // ProgramParticipant — seat, payment, downstream RSVPs
    const ppCollisions = merge.programParticipants.filter(pp =>
        keep.programParticipants.some(k => k.programId === pp.programId)
    );
    for (const pp of ppCollisions) {
        collisions.push({ type: 'programParticipant', message: `Both enrolled in ${pp.program.name}. Unenroll one first.` });
    }

    // ToolStatus — certification levels
    const tsCollisions = merge.toolStatuses.filter(ts =>
        keep.toolStatuses.some(k => k.toolId === ts.toolId)
    );
    for (const ts of tsCollisions) {
        collisions.push({ type: 'toolStatus', message: `Both hold a ${ts.tool.name} certification. Remove one first.` });
    }

    // BackgroundCheckAttestation — same human reviewed under two identities
    const keepAttestProcesses = new Set(keep.bgAttestations.map(a => a.processId));
    const bgCollisions = merge.bgAttestations.filter(a => keepAttestProcesses.has(a.processId));
    if (bgCollisions.length > 0) {
        collisions.push({
            type: 'bgAttestation',
            message: `Both attested the same background check (${bgCollisions.length} shared review${bgCollisions.length > 1 ? 's' : ''}). This indicates review under two identities — investigate before merging.`,
        });
    }

    // Cross-role: one record REVIEWED an attestation naming the other as its
    // SUBJECT. No unique constraint fires — there is only one row — so the
    // repoint silently collapses it into reviewerId === subjectPersonId, and
    // approvalsForSubject (lib/membership/review.ts) has no self-exclusion, so
    // that self-approval counts toward REQUIRED_APPROVALS. attest()'s
    // same-household gate is create-time only and never sees this.
    const bgCrossRoleCollisions = [
        ...keep.bgAttestations.filter(a => a.subjectPersonId === merge.id),
        ...merge.bgAttestations.filter(a => a.subjectPersonId === keep.id),
    ];
    if (bgCrossRoleCollisions.length > 0) {
        collisions.push({
            type: 'bgAttestationCrossRole',
            message: `One record reviewed a background check naming the other as its subject (${bgCrossRoleCollisions.length} attestation${bgCrossRoleCollisions.length > 1 ? 's' : ''}). Merging would make the survivor the reviewer of their own background check — investigate before merging.`,
        });
    }

    // Subject side of the same unique triple. Repointing subjectPersonId
    // collides when ONE reviewer attested both identities under the same
    // process — i.e. read the same human off a PDF twice. Two DIFFERENT
    // reviewers naming the two identities is an ordinary 2-of-N review and
    // merges cleanly.
    const keepSubjectKeys = new Set(keep.bgAttestationsAsSubject.map(bgSubjectKey));
    const bgSubjectCollisions = merge.bgAttestationsAsSubject.filter(a => keepSubjectKeys.has(bgSubjectKey(a)));
    if (bgSubjectCollisions.length > 0) {
        collisions.push({
            type: 'bgAttestationSubject',
            message: `One reviewer attested both records as the subject of the same background check (${bgSubjectCollisions.length} shared attestation${bgSubjectCollisions.length > 1 ? 's' : ''}). This indicates the same adult named under two identities — investigate before merging.`,
        });
    }

    // RSVP — future events only; past events auto-dedupe in the transaction
    const futureRsvpCollisions = merge.rsvps.filter(r =>
        r.event.startAt > now && keep.rsvps.some(k => k.eventId === r.eventId)
    );
    for (const r of futureRsvpCollisions) {
        collisions.push({ type: 'rsvp', message: `Both RSVP'd to ${r.event.name}. Remove one RSVP first.` });
    }

    if (openVisits.keep && openVisits.merge) {
        collisions.push({ type: 'openVisit', message: 'Both have an open building visit. Close one visit first.' });
    }

    return collisions;
}

/**
 * Validate the client's fieldChoices against conflicts recomputed here — the
 * client's view of what conflicts is never trusted.
 */
export function parseFieldChoices(keep: MergeFields, merge: MergeFields, raw: unknown): { choices: FieldChoices } | { error: string } {
    const rawChoices = raw ?? {};
    if (typeof rawChoices !== 'object' || Array.isArray(rawChoices)) {
        return { error: "Invalid fieldChoices" };
    }
    const choices: FieldChoices = {};
    for (const [key, value] of Object.entries(rawChoices)) {
        if (!VALID_CHOICE_KEYS.includes(key)) {
            return { error: `Unknown field choice: ${key}` };
        }
        if (value !== 'keep' && value !== 'merge') {
            return { error: `Invalid choice for ${key}: must be 'keep' or 'merge'` };
        }
        choices[key] = value;
    }
    for (const field of CONFLICT_FIELDS) {
        if (valuesConflict(keep[field], merge[field]) && !choices[field]) {
            return { error: `Choose a value for ${field}` };
        }
    }
    // Both sides carry a login identity => an unavoidable conflict (unique
    // constraints guarantee they differ); the client must pick which whole
    // identity survives.
    if (hasIdentity(keep) && hasIdentity(merge) && !choices[IDENTITY_CHOICE_KEY]) {
        return { error: `Choose a value for ${IDENTITY_CHOICE_KEY}` };
    }
    return { choices };
}

/** The keeper's update, refused when it would leave the survivor with no way to sign in. */
export function planKeeperUpdate(keep: MergeFields, merge: MergeFields, choices: FieldChoices): { data: Record<string, unknown> } | { error: string } {
    const data = resolveKeeperUpdate(keep, merge, choices);
    const finalEmail = 'email' in data ? data.email : keep.email;
    const finalGoogleId = 'googleId' in data ? data.googleId : keep.googleId;
    const hadLoginIdentity = !!(keep.email || keep.googleId || merge.email || merge.googleId);
    if (hadLoginIdentity && !finalEmail && !finalGoogleId) {
        return { error: "Merge would strand the login identity: choose a field value that keeps an email or Google account." };
    }
    return { data };
}
