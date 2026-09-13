/** Reference-conflict route factories (#1286). */
import { z } from "zod";
import { createItemReferenceRepository } from "../repositories/itemReference";
import { conflictResolutionEnum } from "../db/schema";
import { resolveConflict } from "../services/conflictResolutionService";
import { getDb, getPrincipal, mapServiceErrors } from "../runtime";
import type { CatalogRouteHandler } from "../contract";
import { parseId, readJson, parseBody, query } from "./_shared";

const repo = () => createItemReferenceRepository(getDb());
const resolveSchema = z.object({ resolution: z.enum(conflictResolutionEnum) });

export const list: CatalogRouteHandler = async ({ req }) => {
  const sp = query(req);
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const limit = Math.min(200, Math.max(1, Number.parseInt(sp.get("limit") ?? "50", 10) || 50));
  const { conflicts } = await repo().listUnresolvedConflictsPaginated(page, limit);
  return { ReferenceConflict: conflicts };
};

export const resolve: CatalogRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const { resolution } = parseBody(resolveSchema, await readJson(req));
  const principal = await getPrincipal();
  await mapServiceErrors(() => resolveConflict(id, principal.id, resolution));
  return {};
};
