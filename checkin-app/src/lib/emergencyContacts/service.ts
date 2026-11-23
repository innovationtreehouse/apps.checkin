import prisma from "@/lib/prisma";
import type { EmergencyContact } from "@/generated/prisma/client";
import { identityKeys, sameIdentity, identityMatchReason, cleanEmail, normalizePhone } from "./identity";
import { isValidPhone, formatPhone, PHONE_ERROR } from "@/lib/phone";
import { type DbClient, withTx } from "@/lib/db-client";
import { lockLiveHouseholds } from "@/lib/household/archiveGuard";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { openProcess } from "@/lib/membership/lifecycle";
import { householdHasValidContact, isValidContact, VALID_CONTACT_WHERE } from "./valid";

/**
 * Emergency-contact write/read model. Enforces the not-a-household-member rule
 * in two directions:
 *
 *  - Direction A (hard): when a lead actively creates/edits a contact, reject a
 *    candidate that matches a current household member. See {@link assertExternal}.
 *  - Direction B (soft): when a member is added/changed under an existing valid
 *    contact, the collision can't be prevented retroactively, so we flag the
 *    contact invalid (conflictParticipantId set), keep the row for audit, and
 *    return a warning that drives the lead to add a replacement. See
 *    {@link reconcileHouseholdConflicts}.
 *
 * A contact is VALID when conflictParticipantId is null and it has both a name
 * and a phone. Households are required to keep >= 1 valid contact.
 */

export class EmergencyContactError extends Error {
    constructor(public readonly code: "is_member" | "incomplete" | "not_found" | "last_valid", message: string) {
        super(message);
        this.name = "EmergencyContactError";
    }
}

/** Accepts either the base client or a transaction client. */
type Db = DbClient;

export interface ContactInput {
    name: string;
    phone: string;
    email?: string | null;
    relationship?: string | null;
    priority?: number;
}

/** Shape a contact for the client, exposing the validity flag. The ONLY wire
 *  shape EC routes may ship: it strips the internal tier (createdAt/updatedAt,
 *  conflict bookkeeping) and the normalization columns a client never needs. */
export function present(c: { id: number; name: string; phone: string; email: string | null; relationship: string | null; priority: number; conflictParticipantId: number | null }) {
    return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        relationship: c.relationship,
        priority: c.priority,
        invalid: !isValidContact(c),
    };
}

export interface EmergencyContactWarning {
    code: "EMERGENCY_CONTACT_CONFLICT";
    householdId: number;
    /** Contacts newly flagged invalid by the change that just happened. */
    conflictedContactIds: number[];
    /** Whether the household still has at least one valid contact. */
    hasValidContact: boolean;
    message: string;
}

type MemberLike = { id: number; name: string | null; email: string | null; phone: string | null };

function loadMembers(db: Db, householdId: number): Promise<MemberLike[]> {
    return db.person.findMany({
        where: { householdId },
        select: { id: true, name: true, email: true, phone: true },
    });
}

/** The member a candidate collides with, or null. */
function matchingMember(candidate: { name?: string | null; phone?: string | null; email?: string | null }, members: MemberLike[]): MemberLike | null {
    const ck = identityKeys(candidate);
    for (const m of members) {
        if (sameIdentity(ck, identityKeys(m))) return m;
    }
    return null;
}

function cleaned(input: ContactInput) {
    return {
        name: input.name.trim(),
        phone: formatPhone(input.phone),
        email: input.email?.trim() ? input.email.trim() : null,
        relationship: input.relationship?.trim() ? input.relationship.trim() : null,
        phoneDigits: normalizePhone(input.phone),
        emailNorm: cleanEmail(input.email),
    };
}

function requireComplete(input: ContactInput) {
    if (!input.name?.trim() || !input.phone?.trim()) {
        throw new EmergencyContactError("incomplete", "An emergency contact needs both a name and a phone number.");
    }
    if (!isValidPhone(input.phone)) {
        throw new EmergencyContactError("incomplete", PHONE_ERROR);
    }
}

/**
 * Direction A: throw if the candidate is a member of this household. Use before
 * any lead-initiated create/edit of a contact.
 */
export async function assertExternal(db: Db, householdId: number, input: ContactInput): Promise<void> {
    const members = await loadMembers(db, householdId);
    const match = matchingMember(input, members);
    if (match) {
        const reason = identityMatchReason(identityKeys(input), identityKeys(match));
        const memberName = match.name?.trim() || "a household member";
        const why = reason === "phone" ? `the phone number matches ${memberName}`
            : reason === "email" ? `the email matches ${memberName}`
            : `the name matches ${memberName}`;
        throw new EmergencyContactError(
            "is_member",
            `${input.name?.trim() || "That person"} is part of this household and can't be its emergency contact — ${why}. Choose someone outside the household.`,
        );
    }
}

export async function createContact(client: Db, householdId: number, input: ContactInput): Promise<EmergencyContact> {
    const result = await withTx(client, async (db) => {
        await lockLiveHouseholds(db, [householdId]);
        requireComplete(input);
        await assertExternal(db, householdId, input);
        const c = cleaned(input);
        const created = await db.emergencyContact.create({
            data: {
                householdId,
                name: c.name,
                phone: c.phone,
                email: c.email,
                relationship: c.relationship,
                priority: input.priority ?? 0,
                phoneDigits: c.phoneDigits,
                emailNorm: c.emailNorm,
            },
        });
        return created;
    });
    // The privileged attendance roster carries contacts.
    invalidateAttendanceCache();
    return result;
}

export async function updateContact(client: Db, householdId: number, contactId: number, input: ContactInput): Promise<EmergencyContact> {
    const result = await withTx(client, async (db) => {
        await lockLiveHouseholds(db, [householdId]);
        requireComplete(input);
        const existing = await db.emergencyContact.findFirst({ where: { id: contactId, householdId } });
        if (!existing) throw new EmergencyContactError("not_found", "Emergency contact not found.");
        await assertExternal(db, householdId, input);
        const c = cleaned(input);
        // Editing re-confirms the contact: clear any stale conflict flag.
        const updated = await db.emergencyContact.update({
            where: { id: contactId },
            data: {
                name: c.name,
                phone: c.phone,
                email: c.email,
                relationship: c.relationship,
                ...(input.priority !== undefined && { priority: input.priority }),
                phoneDigits: c.phoneDigits,
                emailNorm: c.emailNorm,
                conflictParticipantId: null,
                conflictedAt: null,
            },
        });
        return updated;
    });
    // The privileged attendance roster carries contacts.
    invalidateAttendanceCache();
    return result;
}

/**
 * Removes a contact, refusing to remove the household's last valid one. An
 * invalid contact can always go: it doesn't count toward the floor.
 */
export async function deleteContact(db: Db, householdId: number, contactId: number): Promise<void> {
    await withTx(db, async (tx) => {
        // Read Committed lets two deletes each count the other's contact as the
        // survivor; the Household row lock serializes them, and refuses an archived household.
        await lockLiveHouseholds(tx, [householdId]);
        const contacts = await tx.emergencyContact.findMany({ where: { householdId } });
        const target = contacts.find((c) => c.id === contactId);
        if (!target) throw new EmergencyContactError("not_found", "Emergency contact not found.");
        if (isValidContact(target) && !contacts.some((c) => c.id !== contactId && isValidContact(c))) {
            throw new EmergencyContactError(
                "last_valid",
                "Add a second emergency contact before removing this one — your household must always have at least one valid emergency contact.",
            );
        }
        await tx.emergencyContact.delete({ where: { id: contactId } });
    });
    invalidateAttendanceCache();
}

/**
 * Compatibility helper for the single-field legacy surfaces (onboarding,
 * household settings, membership intake). Upserts the primary (lowest-priority)
 * contact.
 *
 * Tolerant of partial input so resumable forms can save a half-filled contact,
 * but never at the expense of one already stored: a field the caller omits keeps
 * its stored value, and a save that would leave a stored name+phone contact
 * without one of them is refused. Removing a contact is {@link deleteContact}.
 * Direction A is enforced only once the merged contact has BOTH name and phone
 * (a "real" contact), at which point a successful check also clears any stale
 * conflict flag. The submit-time floor ({@link householdHasValidContact}) is
 * what guarantees a complete, valid contact before a household advances.
 */
export async function upsertPrimaryContact(
    client: Db,
    householdId: number,
    fields: { name?: string | null; phone?: string | null; email?: string | null },
): Promise<EmergencyContact | null> {
    const result = await withTx(client, async (db) => {
        await lockLiveHouseholds(db, [householdId]);
        const primary = await db.emergencyContact.findFirst({
            where: { householdId },
            orderBy: [{ priority: "asc" }, { id: "asc" }],
        });

        // A field the caller never sent is not an instruction to clear it: absent
        // keys fall back to what is stored, so a form that collects a subset of the
        // contact can't blank the rest.
        const sent = (v: string | null | undefined) => (v == null ? undefined : v.trim());
        const name = sent(fields.name) ?? primary?.name.trim() ?? "";
        const phone = sent(fields.phone) ?? primary?.phone.trim() ?? "";
        const email = (sent(fields.email) ?? primary?.email ?? "") || null;
        if (!name && !phone && !email) return null;

        if (phone && !isValidPhone(phone)) {
            throw new EmergencyContactError("incomplete", PHONE_ERROR);
        }

        const complete = !!name && !!phone;
        // Blanking a field is not a delete path: refuse a save that would strip the
        // name or phone off a contact that has both.
        if (!complete && primary?.name.trim() && primary.phone.trim()) {
            throw new EmergencyContactError(
                "incomplete",
                "An emergency contact needs both a name and a phone number. To take this contact off the household, remove it instead of clearing it.",
            );
        }

        if (complete) await assertExternal(db, householdId, { name, phone, email });

        const data = {
            name,
            phone: formatPhone(phone),
            email,
            phoneDigits: normalizePhone(phone),
            emailNorm: cleanEmail(email),
            ...(complete && { conflictParticipantId: null, conflictedAt: null }),
        };

        const saved = primary
            ? await db.emergencyContact.update({ where: { id: primary.id }, data })
            : await db.emergencyContact.create({ data: { householdId, priority: 0, ...data } });
        return saved;
    });
    // The privileged attendance roster carries contacts.
    invalidateAttendanceCache();
    return result;
}

export function listContacts(db: Db, householdId: number): Promise<EmergencyContact[]> {
    return db.emergencyContact.findMany({ where: { householdId }, orderBy: [{ priority: "asc" }, { id: "asc" }] });
}

export function listValidContacts(db: Db, householdId: number): Promise<EmergencyContact[]> {
    return db.emergencyContact.findMany({
        where: { householdId, ...VALID_CONTACT_WHERE },
        orderBy: [{ priority: "asc" }, { id: "asc" }],
    });
}

export async function getPrimaryValidContact(db: Db, householdId: number): Promise<EmergencyContact | null> {
    return (await listValidContacts(db, householdId))[0] ?? null;
}

export { householdHasValidContact };

export const NO_EMERGENCY_CONTACT_TO_ENROL = "Add an emergency contact, with a name and a phone number, before enrolling.";

/** Whether a family may enrol: their household has a valid emergency contact. No household fails. */
export async function householdMayEnrol(db: Db, householdId: number | null | undefined): Promise<boolean> {
    return householdId != null && householdHasValidContact(db, householdId);
}

/**
 * Direction B: after a member is added/changed, re-evaluate every contact in the
 * household. Newly-colliding contacts are flagged invalid; contacts whose
 * collision has cleared (member left/changed) are un-flagged. Returns the
 * contacts that were freshly flagged by this pass.
 */
export async function reconcileHouseholdConflicts(db: Db, householdId: number): Promise<EmergencyContact[]> {
    const [members, contacts] = await Promise.all([loadMembers(db, householdId), listContacts(db, householdId)]);
    const memberById = new Map(members.map((m) => [m.id, m]));
    const freshlyFlagged: EmergencyContact[] = [];

    for (const ec of contacts) {
        const match = matchingMember({ name: ec.name, phone: ec.phone, email: ec.email }, members);
        const isFlagged = ec.conflictParticipantId !== null;

        if (match && !isFlagged) {
            await db.emergencyContact.update({
                where: { id: ec.id },
                data: { conflictParticipantId: match.id, conflictedAt: new Date() },
            });
            freshlyFlagged.push(ec);
        } else if (!match && isFlagged) {
            // Stale flag: the colliding member is gone or no longer matches.
            await db.emergencyContact.update({ where: { id: ec.id }, data: { conflictParticipantId: null, conflictedAt: null } });
        } else if (match && isFlagged && ec.conflictParticipantId !== match.id && !memberById.has(ec.conflictParticipantId!)) {
            // Re-point a flag whose original member is gone but a new one collides.
            await db.emergencyContact.update({ where: { id: ec.id }, data: { conflictParticipantId: match.id, conflictedAt: new Date() } });
        }
    }
    // Inside a caller's transaction this runs pre-commit; those callers
    // invalidate again after commit.
    invalidateAttendanceCache();
    return freshlyFlagged;
}

/**
 * Run reconciliation and produce a UI warning when a contact was just
 * invalidated and/or the household has dropped below one valid contact. Returns
 * null when nothing needs the lead's attention.
 */
export async function reconcileAndWarn(db: Db, householdId: number): Promise<EmergencyContactWarning | null> {
    const flagged = await reconcileHouseholdConflicts(db, householdId);
    if (flagged.length === 0) return null;
    const hasValidContact = await householdHasValidContact(db, householdId);
    return {
        code: "EMERGENCY_CONTACT_CONFLICT",
        householdId,
        conflictedContactIds: flagged.map((c) => c.id),
        hasValidContact,
        message: hasValidContact
            ? "An emergency contact is now also a household member and was marked invalid. Please review your emergency contacts."
            : "Your emergency contact is now a household member, so your household has no valid emergency contact. Please add one.",
    };
}

/**
 * The predicate behind both the notification count and the Membership Audit list
 * view: member/in-intake households with zero valid emergency contacts (the
 * "lead didn't remediate" alarm). A household is in scope when it has an ACTIVE
 * membership or an in-flight membership process. Returns the household ids so
 * callers can either count them or hydrate them.
 */
export async function findHouseholdsMissingValidContact(db: Db = prisma): Promise<number[]> {
    const scoped = await db.household.findMany({
        where: {
            orgMembership: { is: { OR: [{ status: "ACTIVE" }, { processes: { some: openProcess.where } }] } },
        },
        select: { id: true },
    });
    if (scoped.length === 0) return [];
    const withValid = await db.emergencyContact.findMany({
        where: {
            householdId: { in: scoped.map((h) => h.id) },
            ...VALID_CONTACT_WHERE,
        },
        select: { householdId: true },
        distinct: ["householdId"],
    });
    const validSet = new Set(withValid.map((c) => c.householdId));
    return scoped.filter((h) => !validSet.has(h.id)).map((h) => h.id);
}

export async function countHouseholdsMissingValidContact(db: Db = prisma): Promise<number> {
    return (await findHouseholdsMissingValidContact(db)).length;
}
