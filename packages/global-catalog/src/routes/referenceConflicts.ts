/** Reference-conflict route factories. */
import { mapServiceErrors, parseBody, parseId, query } from "@checkin/component-kit";
import { z } from "zod";
import { createItemReferenceRepository } from "../repositories/itemReference";
import { conflictResolutionEnum } from "../db/schema";
import { resolveConflict } from "../services/conflictResolutionService";
import { getDb, getPrincipal } from "../runtime";
import type { CatalogRouteHandler } from "../contract";

const repo = () => createItemReferenceRepository(getDb());
const resolveSchema = z.object({ resolution: z.enum(conflictResolutionEnum), existingGtin13: z.string() });

export const list: CatalogRouteHandler = async ({ req }) => {
  const sp = query(req);
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const limit = Math.min(200, Math.max(1, Number.parseInt(sp.get("limit") ?? "50", 10) || 50));
  const { conflicts } = await repo().listUnresolvedConflictsPaginated(page, limit);
  return { ReferenceConflict: conflicts };
};

export const resolve: CatalogRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const { resolution, existingGtin13 } = await parseBody(req, resolveSchema);
  const principal = await getPrincipal();
  await mapServiceErrors(() => resolveConflict(id, principal.id, resolution, existingGtin13));
  return {};
};
