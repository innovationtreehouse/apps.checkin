/**
 * Item-reference proposal route factories (#1286). Action routes (approve /
 * reject) return an empty bag: the services return void, so the response is a
 * bare 200 and the client refetches the list (track 5 owns that UI).
 */
import { z } from "zod";
import { createProposalRepository } from "../repositories/proposal";
import { approveItemReferenceProposal, rejectItemReferenceProposal } from "../services/proposalService";
import { getDb, getPrincipal, mapServiceErrors } from "../runtime";
import type { CatalogRouteHandler } from "../contract";
import { parseId, readJson, parseBody, query } from "./_shared";

const repo = () => createProposalRepository(getDb());
const rejectSchema = z.object({ rejectionReason: z.string().min(1, "rejectionReason is required") });

export const list: CatalogRouteHandler = async ({ req }) => {
  const sp = query(req);
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const limit = Math.min(200, Math.max(1, Number.parseInt(sp.get("limit") ?? "50", 10) || 50));
  const { rows } = await repo().listPendingItemReferenceProposalsPaginated(page, limit);
  return { ItemReferenceProposal: rows };
};

export const approve: CatalogRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const principal = await getPrincipal();
  await mapServiceErrors(() => approveItemReferenceProposal(id, principal.id, principal.name ?? undefined));
  return {};
};

export const reject: CatalogRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const { rejectionReason } = parseBody(rejectSchema, await readJson(req));
  const principal = await getPrincipal();
  await mapServiceErrors(() => rejectItemReferenceProposal(id, principal.id, rejectionReason));
  return {};
};
