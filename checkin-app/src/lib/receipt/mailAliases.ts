/**
 * The back-office list of extra addresses a person's receipt mail may come from
 * (1265_RECEIPT_MAIL_ALIASES.md). Routes gate on finance-or-board. Audit rows carry no address.
 */
import { mailQueueService } from "@checkin/receipt";
import { z } from "zod";
import { personActor } from "@/lib/auditActor";
import prisma from "@/lib/prisma";
import { canonicalizeEmail } from "@/lib/emailNormalize";
import { isValidEmail } from "@/lib/emergencyContacts/identity";
import { findSelfGrantRefusal, recordSelfGrantRefusal, SELF_GRANT_REFUSAL_MESSAGE } from "@/lib/membership/selfGrantGuard";
import { LIVE_PERSON } from "@/lib/person/filters";
import { lockMailAliasKey } from "@/lib/person/mailAliases";
import { ApiResponseError, badRequest, forbidden, notFound } from "@/security/handler";

/** Refused for a reason other than the own-household rule, which has its own table. */
export const MAIL_ALIAS_REFUSAL_TABLE = "PersonMailAliasRefusal";

const ALIAS_FIELDS = {
  id: true,
  personId: true,
  address: true,
  addedById: true,
  createdAt: true,
  approvedAt: true,
  approvedById: true,
  person: { select: { id: true, name: true, email: true } },
} as const;

const AddSchema = z.object({ personEmail: z.string(), address: z.string() });

const ADD_REFUSALS = {
  mailbox: "That is the receipt mailbox's own address.",
  sign_in: "That address is already a sign-in address.",
  alias: "That address is already an alias.",
} as const;

export function listMailAliases() {
  return prisma.personMailAlias.findMany({ select: ALIAS_FIELDS, orderBy: { address: "asc" } });
}

export async function addMailAlias(actorId: number, input: unknown) {
  const body = AddSchema.safeParse(input);
  if (!body.success) throw badRequest("Give the person's sign-in email and the address to add");
  const address = body.data.address.trim().toLowerCase();
  if (!isValidEmail(address)) throw badRequest("Invalid email format");

  const person = await prisma.person.findFirst({
    where: { ...LIVE_PERSON, email: { equals: body.data.personEmail.trim(), mode: "insensitive" } },
    select: { id: true, householdId: true, email: true },
  });
  if (!person) throw notFound("Nobody signs in with that email");

  const conflict = await findSelfGrantRefusal(prisma, actorId, { personId: person.id, householdId: person.householdId }, { table: "PersonMailAlias", attempted: { personId: person.id } });
  if (conflict) {
    await recordSelfGrantRefusal(prisma, conflict);
    throw forbidden(SELF_GRANT_REFUSAL_MESSAGE);
  }

  const canonicalKey = canonicalizeEmail(address);
  const added = await prisma.$transaction(async (tx) => {
    await lockMailAliasKey(tx, canonicalKey);
    const refused = await addRefusal(tx, person, address, canonicalKey);
    if (refused) {
      await tx.auditLog.create({
        data: { ...personActor(actorId), action: "EDIT", tableName: MAIL_ALIAS_REFUSAL_TABLE, affectedEntityId: person.id, newData: { attempted: "add", reason: refused } },
      });
      return refused;
    }
    const alias = await tx.personMailAlias.create({ data: { personId: person.id, address, canonicalKey, addedById: actorId }, select: ALIAS_FIELDS });
    await tx.auditLog.create({
      data: { ...personActor(actorId), action: "CREATE", tableName: "PersonMailAlias", affectedEntityId: alias.id, secondaryAffectedEntity: person.id, newData: { personId: person.id } },
    });
    return alias;
  });
  if (typeof added === "string") throw new ApiResponseError(409, ADD_REFUSALS[added]);
  return added;
}

/** Why this address cannot be added. The same person's dot and plus variants are allowed: each is its own exact address. */
async function addRefusal(
  tx: Parameters<typeof lockMailAliasKey>[0],
  person: { id: number; email: string | null },
  address: string,
  canonicalKey: string,
): Promise<keyof typeof ADD_REFUSALS | null> {
  const mailbox = process.env.RECEIPT_MAILBOX_ADDRESS;
  if (mailbox && canonicalizeEmail(mailbox) === canonicalKey) return "mailbox";
  if (person.email?.toLowerCase() === address) return "sign_in";
  // ponytail: scans every email, as canonical keys are not stored on Person; a rare finance action.
  const people = await tx.person.findMany({ where: { ...LIVE_PERSON, email: { not: null }, id: { not: person.id } }, select: { email: true } });
  if (people.some((p) => p.email && canonicalizeEmail(p.email) === canonicalKey)) return "sign_in";
  const aliases = await tx.personMailAlias.findMany({ where: { canonicalKey }, select: { personId: true, address: true } });
  return aliases.some((a) => a.personId !== person.id || a.address === address) ? "alias" : null;
}

export async function removeMailAlias(actorId: number, id: number) {
  return prisma.$transaction(async (tx) => {
    const alias = await tx.personMailAlias.findUnique({ where: { id }, select: ALIAS_FIELDS });
    if (!alias) throw notFound("Alias not found");
    await tx.personMailAlias.delete({ where: { id } });
    await tx.auditLog.create({
      data: {
        ...personActor(actorId),
        action: "DELETE",
        tableName: "PersonMailAlias",
        affectedEntityId: id,
        secondaryAffectedEntity: alias.personId,
        oldData: { personId: alias.personId, addedById: alias.addedById, approvedById: alias.approvedById },
      },
    });
    return alias;
  });
}

/**
 * Counts an alias once a receipt from exactly its address, with a passing sender check, is this
 * person's, and the approver is outside their household. A merge moves an alias with its
 * approvedAt and approvedById: the approval judged the address, which is still the same person's.
 */
export async function approveMailAlias(actorId: number, id: number) {
  const alias = await prisma.personMailAlias.findUnique({
    where: { id },
    select: { id: true, personId: true, address: true, approvedAt: true, person: { select: { householdId: true } } },
  });
  if (!alias) throw notFound("Alias not found");
  if (alias.approvedAt) throw new ApiResponseError(409, "That alias is already approved.");

  const conflict = await findSelfGrantRefusal(prisma, actorId, { personId: alias.personId, householdId: alias.person.householdId }, { table: "PersonMailAlias", attempted: { approveAliasId: id } });
  if (conflict) {
    await recordSelfGrantRefusal(prisma, conflict);
    throw forbidden(SELF_GRANT_REFUSAL_MESSAGE);
  }

  const item = await mailQueueService.assignedPassingItem(alias.address, alias.personId);
  if (!item) {
    await prisma.auditLog.create({
      data: {
        ...personActor(actorId),
        action: "EDIT",
        tableName: MAIL_ALIAS_REFUSAL_TABLE,
        affectedEntityId: id,
        secondaryAffectedEntity: alias.personId,
        newData: { attempted: "approve", reason: "no_assigned_passing_item" },
      },
    });
    throw new ApiResponseError(409, "No mail from that address with a passing sender check has been assigned to this person.");
  }

  return prisma.$transaction(async (tx) => {
    const done = await tx.personMailAlias.updateMany({ where: { id, approvedAt: null }, data: { approvedAt: new Date(), approvedById: actorId } });
    if (done.count !== 1) throw notFound("Alias not found");
    await tx.auditLog.create({
      data: {
        ...personActor(actorId),
        action: "EDIT",
        tableName: "PersonMailAlias",
        affectedEntityId: id,
        secondaryAffectedEntity: alias.personId,
        newData: { approved: true, mailItemId: item.id },
      },
    });
    return tx.personMailAlias.findUniqueOrThrow({ where: { id }, select: ALIAS_FIELDS });
  });
}

export function aliasId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("Invalid alias id");
  return id;
}
