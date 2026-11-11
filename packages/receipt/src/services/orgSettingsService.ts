import type { z } from "zod";
import { db } from "../db";
import { getOrgSettings } from "../lib/receipt-flow";
import { OcrSwitchSchema, OrgSettingsSchema } from "../lib/schemas";
import { getOrgId, requireActor } from "../runtime";
import { ServiceError } from "@checkin/component-kit";

type SettingsUpdate = z.output<typeof OrgSettingsSchema> | z.output<typeof OcrSwitchSchema>;

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

/** Every changed setting writes an audit row (who, before, after): these switch financial review and reading. */
async function write(updates: SettingsUpdate) {
  const actor = await requireActor();
  const orgId = await getOrgId();
  return db.$transaction(async (tx) => {
    const before = await getOrgSettings(orgId, tx);
    const after = await tx.receiptOrgSettings.update({ where: { orgId }, data: updates });
    for (const field of Object.keys(updates) as (keyof SettingsUpdate)[]) {
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
}

/** The org's receipt settings (the host route gates who may call each). */
export const orgSettingsService = {
  async get() {
    await requireActor();
    return getOrgSettings(await getOrgId());
  },

  /** Tax-exempt and age-limit settings. */
  async update(rawUpdates: unknown) {
    return write(parse(OrgSettingsSchema, rawUpdates));
  },

  /** Whether automatic reading is on; anyone who may upload may ask. */
  async ocrSwitch() {
    await requireActor();
    const { ocrEnabled } = await getOrgSettings(await getOrgId());
    return { ocrEnabled };
  },

  /** Turn automatic reading off for a known fault, or back on. */
  async setOcrSwitch(raw: unknown) {
    const { ocrEnabled } = await write(parse(OcrSwitchSchema, raw));
    return { ocrEnabled };
  },
};
