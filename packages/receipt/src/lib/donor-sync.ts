import { db } from "../db";
import { InKindDonorSchema } from "../contract";
import { audit, receiptRepo, type Actor } from "../repositories/receipt";
import { getOrg, ports } from "../runtime";

const MAX_SENDS = 3;

/**
 * X13: tell donations the receipt's current in-kind state. Which call is made comes from the
 * receipt now, not a stored operation: in-kind sends the donor, otherwise a withdrawal. A
 * `none` receipt (never in-kind) sends nothing. The receipt flips to `synced` only if what was
 * sent is still current; a change made during the call is sent again (the callee is
 * idempotent per receipt, so the last write wins). After MAX_SENDS it stays `pending` for the
 * catch-up step. Never throws.
 */
export async function sendDonorSync(receiptId: string, actor: Actor | null): Promise<boolean> {
  try {
    const orgId = (await getOrg()).id;
    for (let attempt = 0; attempt < MAX_SENDS; attempt++) {
      const row = await receiptRepo.find(receiptId, orgId);
      if (!row || row.donorSync !== "pending") return false;
      const sent = {
        isInKind: row.isInKind,
        donorFirstName: row.donorFirstName,
        donorLastName: row.donorLastName,
        donorCompanyName: row.donorCompanyName,
      };
      if (sent.isInKind) {
        const donor = InKindDonorSchema.parse({
          firstName: sent.donorFirstName,
          lastName: sent.donorLastName,
          companyName: sent.donorCompanyName ?? null,
        });
        await ports().donorSink.recordInKindDonor(orgId, receiptId, donor);
      } else {
        await ports().donorSink.withdrawInKind(orgId, receiptId);
      }
      const settled = await db.receipt.updateMany({
        where: { id: receiptId, donorSync: "pending", ...sent },
        data: { donorSync: "synced" },
      });
      if (settled.count === 1) return true;
    }
    await audit(db, receiptId, actor, { action: "donor_sync_failed", valueAfter: "donor kept changing during send" });
    return false;
  } catch (err) {
    await audit(db, receiptId, actor, {
      action: "donor_sync_failed",
      valueAfter: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    return false;
  }
}
