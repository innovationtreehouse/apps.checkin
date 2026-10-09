/** Gifts: the lists and detail (each audited as a donor read) and the two owner decisions. */
import { z } from "zod";
import { transactionService } from "../services/transactionService";
import { donationError, getOrgId, mapServiceErrors } from "../runtime";
import type { DonationRouteHandler } from "../contract";
import { auditContext, donorReader, parseBody, parseId } from "./_shared";

const ownerSchema = z.object({
  ownerId: z.number().int().positive("ownerId is required"),
  assignFutureMatchingComment: z.boolean().optional(),
});

export const list: DonationRouteHandler = async ({ req }) => {
  const raw = new URL(req.url).searchParams.get("assigned");
  if (raw !== null && raw !== "true" && raw !== "false") throw donationError(400, "assigned must be true or false");
  const reader = await donorReader(req, "GET /api/donations/transactions");
  return { Transaction: await transactionService.listTransactions(await getOrgId(), reader, raw ?? undefined) };
};

export const unassigned: DonationRouteHandler = async ({ req }) => {
  const reader = await donorReader(req, "GET /api/donations/transactions/unassigned");
  return { Transaction: await transactionService.listUnassignedTransactions(await getOrgId(), reader) };
};

export const detail: DonationRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const reader = await donorReader(req, "GET /api/donations/transactions/[id]");
  const row = await transactionService.getTransaction(await getOrgId(), id, reader);
  if (!row) throw donationError(404, "Transaction not found");
  return { Transaction: row };
};

export const assignOwner: DonationRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const { ownerId, assignFutureMatchingComment } = await parseBody(req, ownerSchema);
  const orgId = await getOrgId();
  const audit = await auditContext(req);
  return {
    Transaction: await mapServiceErrors(() =>
      transactionService.assignOwner(orgId, id, ownerId, assignFutureMatchingComment ?? false, audit),
    ),
  };
};

export const markOrganizationalLevel: DonationRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const orgId = await getOrgId();
  const audit = await auditContext(req);
  return { Transaction: await mapServiceErrors(() => transactionService.markOrganizationalLevel(orgId, id, audit)) };
};
