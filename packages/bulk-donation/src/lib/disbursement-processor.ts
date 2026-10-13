import type { DbOrTx } from "../db";
import { determineAccountsFromMap } from "./account-map-lookup";
import { ownerRequiredWhere } from "./domain-rules";
import { sumCents } from "@inventory/money";
import { DisbursementPayloadV1 } from "@inventory/donations";

type ConflictRecord = {
  txId: number;
  reason: "NO_MATCH" | "MULTIPLE_MATCHES";
  matchedRows: unknown[];
};

export type AccountDeterminationResult =
  | { type: "PROCESS_SUCCEEDED"; payload: DisbursementPayloadV1 }
  | { type: "ACCOUNT_UNRESOLVED"; conflicts: ConflictRecord[] };

/**
 * True when no transaction in the disbursement still requires an owner.
 * Runs inside the same transaction as the workflow advance so readiness is
 * computed against a consistent snapshot (the single authoritative site).
 */
export async function isAllOwnersReady(handle: DbOrTx, orgId: string, disbursementId: string): Promise<boolean> {
  const n = await handle.transaction.count({
    where: { ...ownerRequiredWhere(orgId), disbursementId },
  });
  return n === 0;
}

/**
 * Determine GL accounts for every transaction in the disbursement.
 * The success payload is validated against the shared Zod schema before being
 * returned (cross-service contract enforcement). Monetary amounts are integer
 * cents end to end.
 */
export async function runAccountDetermination(handle: DbOrTx, orgId: string, disbursementId: string): Promise<AccountDeterminationResult> {
  const txs = await handle.transaction.findMany({
    where: { orgId, disbursementId },
  });

  const rules = await handle.accountMap.findMany({ where: { orgId } });

  type Resolved = {
    tx: typeof txs[number];
    donationAccount: string;
    matchAccount: string;
    feesAccount: string;
  };

  const resolved: Resolved[] = [];
  const conflicts: ConflictRecord[] = [];

  for (const tx of txs) {
    const lookup = determineAccountsFromMap(rules, {
      companyName: tx.companyName,
      corporatePeerCampaign: tx.corporatePeerCampaign,
      donationMethod: tx.donationMethod,
      donationType: tx.donationType,
    });

    if ("conflict" in lookup) {
      conflicts.push({ txId: tx.id, reason: lookup.conflict.reason, matchedRows: lookup.conflict.matchedRows });
    } else {
      resolved.push({
        tx,
        donationAccount: lookup.result.donationAccount,
        matchAccount: lookup.result.matchAccount,
        feesAccount: lookup.result.feesAccount,
      });
    }
  }

  if (conflicts.length > 0) {
    return { type: "ACCOUNT_UNRESOLVED", conflicts };
  }

  const firstTx = resolved[0]?.tx;
  const disbursementDate = firstTx?.disbursementDate ?? null;
  const disbursementFrom = firstTx?.disbursementFrom ?? null;

  const items: Array<{ type: "match" | "donation" | "fees"; account: string; amountCents: number; transactionId: string }> = [];
  for (const r of resolved) {
    if (r.tx.donationAmountCents !== 0) {
      items.push({ type: "donation", account: r.donationAccount, amountCents: r.tx.donationAmountCents, transactionId: r.tx.transactionId });
    }
    if (r.tx.matchAmountCents !== 0) {
      items.push({ type: "match", account: r.matchAccount, amountCents: r.tx.matchAmountCents, transactionId: r.tx.transactionId });
    }
    const fees = sumCents(r.tx.causeSupportFeeCents ?? 0, r.tx.merchantFeeCents ?? 0, r.tx.checkFeeCents ?? 0);
    if (fees !== 0) {
      items.push({ type: "fees", account: r.feesAccount, amountCents: fees, transactionId: r.tx.transactionId });
    }
  }

  const payload = DisbursementPayloadV1.parse({
    version: 1 as const,
    orgId,
    disbursementId,
    disbursementDate,
    disbursementFrom,
    items,
  });
  return { type: "PROCESS_SUCCEEDED", payload };
}
