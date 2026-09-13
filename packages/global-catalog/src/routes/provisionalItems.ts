/** Provisional-item proposal route factories (#1286). */
import { z } from "zod";
import { createProposalRepository } from "../repositories/proposal";
import { createCatalogRepository } from "../repositories/catalog";
import {
  approveProvisionalProposal,
  rejectProvisionalProposal,
  mapProvisionalToExisting,
} from "../services/provisionalGtinService";
import { getDb, getPrincipal, mapServiceErrors } from "../runtime";
import type { CatalogRouteHandler } from "../contract";
import { parseId, readJson, parseBody, query } from "./_shared";

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
// client learns the new gtin13 (the source's `realGtin13`) from a real field.
export const approve: CatalogRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const overrides = parseBody(approveSchema, await readJson(req));
  const principal = await getPrincipal();
  const result = await mapServiceErrors(() => approveProvisionalProposal(id, principal.id, overrides));
  return { Item: await catalogRepo().findItemByGtin13WithIncludes(result.realGtin13) };
};

export const reject: CatalogRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const { rejectionReason } = parseBody(rejectSchema, await readJson(req));
  const principal = await getPrincipal();
  await mapServiceErrors(() => rejectProvisionalProposal(id, principal.id, rejectionReason));
  return {};
};

export const mapToExisting: CatalogRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const { realGtin13 } = parseBody(mapSchema, await readJson(req));
  const principal = await getPrincipal();
  await mapServiceErrors(() => mapProvisionalToExisting(id, principal.id, realGtin13));
  return {};
};
