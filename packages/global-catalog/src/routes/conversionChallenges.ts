/** Conversion-challenge route factories. */
import { mapServiceErrors, parseId, query } from "@checkin/component-kit";
import { createConversionChallengeRepository } from "../repositories/conversionChallenge";
import { acceptChallenge, rejectChallenge } from "../services/conversionChallengeService";
import { getDb, getPrincipal } from "../runtime";
import type { CatalogRouteHandler } from "../contract";

const repo = () => createConversionChallengeRepository(getDb());

export const list: CatalogRouteHandler = async ({ req }) => {
  const sp = query(req);
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const limit = Math.min(200, Math.max(1, Number.parseInt(sp.get("limit") ?? "50", 10) || 50));
  const { rows } = await repo().listPendingPaginated(page, limit);
  return { ConversionChallenge: rows };
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
