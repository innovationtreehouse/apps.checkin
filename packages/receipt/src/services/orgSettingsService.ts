import { db } from "../db";
import { getOrgSettings } from "../lib/receipt-flow";
import { OrgSettingsSchema } from "../lib/schemas";
import { getOrg, requireActor } from "../runtime";
import { ServiceError } from "./serviceError";

/** The org's tax-exempt and age-limit settings (FINANCE; the host route gates). */
export const orgSettingsService = {
  async get() {
    await requireActor();
    return getOrgSettings((await getOrg()).id);
  },

  async update(rawUpdates: unknown) {
    await requireActor();
    const parsed = OrgSettingsSchema.safeParse(rawUpdates);
    if (!parsed.success) throw new ServiceError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const orgId = (await getOrg()).id;
    return db.receiptOrgSettings.upsert({ where: { orgId }, create: { orgId, ...parsed.data }, update: parsed.data });
  },
};
