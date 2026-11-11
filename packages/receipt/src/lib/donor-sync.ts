import { kindOf } from "@checkin/component-kit";
import { db } from "../db";
import { InKindDonorSchema } from "../contract";
import { audit, CLEARED, recordFailure, type Actor } from "../repositories/receipt";
import { getOrgId, ports } from "../runtime";

const MAX_SENDS = 3;

/**
 * X13: tell donations the receipt's current in-kind state. Which call is made comes from the
 * receipt's state, not a stored operation: in-kind sends the donor, otherwise a withdrawal. A
 * `none` receipt (never in-kind) sends nothing. The receipt flips to `synced` only if what was
 * sent is still current; a change made during the call is sent again. Each call carries the
 * receipt's donorSyncSeq, and the callee drops one older than it has seen, so a slow send can
 * never overwrite a newer one. After MAX_SENDS it stays `pending`. Never throws: a failure is
 * audited as `donor_sync_failed` with its kind in `valueBefore`, and the receipt is marked stuck.
 * A send that settles clears that mark: a donor send runs only while nothing else holds the
 * receipt stuck (before the flow, in an editable state, or ahead of a push).
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
        data: { donorSync: "synced", ...CLEARED },
      });
      if (settled.count === 1) return true;
    }
    const changing = "donor kept changing during send";
    await audit(db, receiptId, actor, { action: "donor_sync_failed", valueAfter: changing });
    await recordFailure(db, receiptId, changing);
    return false;
  } catch (err) {
    await audit(db, receiptId, actor, {
      action: "donor_sync_failed",
      valueBefore: kindOf(err),
      valueAfter: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    await recordFailure(db, receiptId, err).catch(() => undefined);
    return false;
  }
}
