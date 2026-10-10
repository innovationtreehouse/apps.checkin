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

  /** Every changed setting writes an audit row (who, before, after): these switch financial review. */
  async update(rawUpdates: unknown) {
    const actor = await requireActor();
    const parsed = OrgSettingsSchema.safeParse(rawUpdates);
    if (!parsed.success) throw new ServiceError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const orgId = (await getOrg()).id;
    return db.$transaction(async (tx) => {
      const before = await tx.receiptOrgSettings.upsert({ where: { orgId }, create: { orgId }, update: {} });
      const after = await tx.receiptOrgSettings.update({ where: { orgId }, data: parsed.data });
      for (const field of Object.keys(parsed.data) as (keyof typeof parsed.data)[]) {
        if (before[field] === after[field]) continue;
        await tx.receiptAuditLog.create({
          data: {
            receiptId: null,
            userId: actor.id,
            username: actor.name,
            action: "settings_updated",
            fieldChanged: field,
            valueBefore: String(before[field]),
            valueAfter: String(after[field]),
          },
        });
      }
      return after;
    });
  },
};
