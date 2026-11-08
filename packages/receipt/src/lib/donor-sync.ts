import { kindOf } from "@checkin/component-kit";
import { db } from "../db";
import { InKindDonorSchema } from "../contract";
import { audit, type Actor } from "../repositories/receipt";
import { getOrgId, ports } from "../runtime";

const MAX_SENDS = 3;

/**
 * X13: tell donations the receipt's current in-kind state. Which call is made comes from the
 * receipt's state, not a stored operation: in-kind sends the donor, otherwise a withdrawal. A
 * `none` receipt (never in-kind) sends nothing. The receipt flips to `synced` only if what was
 * sent is still current; a change made during the call is sent again. Each call carries the
 * receipt's donorSyncSeq, and the callee drops one older than it has seen, so a slow send can
 * never overwrite a newer one. After MAX_SENDS it stays `pending` for the catch-up step. Never throws:
 * a failure is audited as `donor_sync_failed` with its kind in `valueBefore`.
 */
export async function sendDonorSync(receiptId: string, actor: Actor | null): Promise<boolean> {
  try {
    const orgId = await getOrgId();
    for (let attempt = 0; attempt < MAX_SENDS; attempt++) {
      const row = await db.receipt.findFirst({
        where: { id: receiptId, orgId },
        select: { donorSync: true, isInKind: true, donorFirstName: true, donorLastName: true, donorCompanyName: true, donorSyncSeq: true },
      });
      if (!row || row.donorSync !== "pending") return false;
      const sent = {
        isInKind: row.isInKind,
        donorFirstName: row.donorFirstName,
        donorLastName: row.donorLastName,
        donorCompanyName: row.donorCompanyName,
        donorSyncSeq: row.donorSyncSeq,
      };
      if (sent.isInKind) {
        const donor = InKindDonorSchema.safeParse({
          firstName: sent.donorFirstName,
          lastName: sent.donorLastName,
          companyName: sent.donorCompanyName ?? null,
        });
        // Upload checks the donor with the same rule, so a stored donor that fails it is a bug.
        if (!donor.success) throw new Error(`stored donor fails the donor check: ${donor.error.issues.map((i) => i.path.join(".")).join(", ")}`);
        await ports().donorSink.recordInKindDonor(orgId, receiptId, donor.data, sent.donorSyncSeq);
      } else {
        await ports().donorSink.withdrawInKind(orgId, receiptId, sent.donorSyncSeq);
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
    // Donations checks the donor with the same rule as upload, so its refusal of a stored donor is a bug.
    const kind = kindOf(err);
    await audit(db, receiptId, actor, {
      action: "donor_sync_failed",
      valueBefore: kind === "data" ? "bug" : kind,
      valueAfter: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    return false;
  }
}
