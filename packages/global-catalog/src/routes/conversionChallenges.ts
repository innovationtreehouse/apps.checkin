/** Conversion-challenge route factories. */
import { mapServiceErrors, parseBody, parseId, query } from "@checkin/component-kit";
import { z } from "zod";
import { createConversionChallengeRepository } from "../repositories/conversionChallenge";
import { acceptChallenge, rejectChallenge, submitChallenge } from "../services/conversionChallengeService";
import { catalogRuntime, getDb, getPrincipal } from "../runtime";
import type { CatalogRouteHandler } from "../contract";

const repo = () => createConversionChallengeRepository(getDb());

export const list: CatalogRouteHandler = async ({ req }) => {
  const sp = query(req);
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const limit = Math.min(200, Math.max(1, Number.parseInt(sp.get("limit") ?? "50", 10) || 50));
  const { rows } = await repo().listPendingPaginated(page, limit);
  return { ConversionChallenge: rows };
};

const createSchema = z.object({
  itemReferenceId: z.number().int().positive(),
  proposedFactor: z.number().int("proposedFactor must be a whole number").min(1, "proposedFactor must be at least 1"),
  reason: z.string().trim().min(1, "reason is required").max(500, "reason must be 500 characters or fewer"),
});

export const create: CatalogRouteHandler = async ({ req }) => {
  const body = await parseBody(req, createSchema);
  const principal = await getPrincipal();
  const org = await catalogRuntime.require().org();
  const created = await mapServiceErrors(() =>
    submitChallenge({ ...body, orgId: org.id, orgName: org.name, localUserId: principal.id }),
  );
  return { ConversionChallenge: created };
};

export const accept: CatalogRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const principal = await getPrincipal();
  await mapServiceErrors(() => acceptChallenge(id, principal.id));
  return {};
};

export const reject: CatalogRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const principal = await getPrincipal();
  await mapServiceErrors(() => rejectChallenge(id, principal.id));
  return {};
};
