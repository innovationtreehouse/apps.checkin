/** Provisional-item proposal route factories. */
import { mapServiceErrors, parseBody, parseId, query } from "@checkin/component-kit";
import { z } from "zod";
import { createProposalRepository } from "../repositories/proposal";
import { createCatalogRepository } from "../repositories/catalog";
import {
  approveProvisionalProposal,
  rejectProvisionalProposal,
  mapProvisionalToExisting,
} from "../services/provisionalGtinService";
import { getDb, getPrincipal } from "../runtime";
import type { CatalogRouteHandler } from "../contract";

const proposalRepo = () => createProposalRepository(getDb());
const catalogRepo = () => createCatalogRepository(getDb());

const approveSchema = z
  .object({
    name: z.string().min(1).optional(),
    categoryId: z.number().int().positive().optional(),
    subcategoryId: z.number().int().positive().optional(),
    usageBehavior: z.string().optional(),
  })
  .strict();
const rejectSchema = z.object({ rejectionReason: z.string().min(1) });
const mapSchema = z.object({ realGtin13: z.string().min(1) });

export const list: CatalogRouteHandler = async ({ req }) => {
  const sp = query(req);
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const limit = Math.min(200, Math.max(1, Number.parseInt(sp.get("limit") ?? "50", 10) || 50));
  const { rows } = await proposalRepo().listProvisionalItemsPaginated(page, limit);
  return { ProvisionalItem: rows };
};

// The approved provisional gets a real GTIN; return the resulting Item so the
// client learns the new gtin13 from a real field.
export const approve: CatalogRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const overrides = await parseBody(req, approveSchema);
  const principal = await getPrincipal();
  const result = await mapServiceErrors(() => approveProvisionalProposal(id, principal.id, overrides));
  return { Item: await catalogRepo().findItemByGtin13WithIncludes(result.realGtin13) };
};

export const reject: CatalogRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const { rejectionReason } = await parseBody(req, rejectSchema);
  const principal = await getPrincipal();
  await mapServiceErrors(() => rejectProvisionalProposal(id, principal.id, rejectionReason));
  return {};
};

export const mapToExisting: CatalogRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const { realGtin13 } = await parseBody(req, mapSchema);
  const principal = await getPrincipal();
  await mapServiceErrors(() => mapProvisionalToExisting(id, principal.id, realGtin13));
  return {};
};
