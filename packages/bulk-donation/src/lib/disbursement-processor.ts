import type { DbOrTx } from "../db";
import { determineAccountsFromMap, type AccountConflictReason } from "./account-map-lookup";
import { ownerRequiredWhere } from "./domain-rules";
import { sumCents } from "@checkin/money";
import { DisbursementPayloadV1 } from "@checkin/donations";

export type ConflictRecord = {
  txId: number;
  reason: AccountConflictReason;
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

  type Resolved = { tx: typeof txs[number]; rule: typeof rules[number] };

  const resolved: Resolved[] = [];
  const conflicts: ConflictRecord[] = [];

  for (const tx of txs) {
    const lookup = determineAccountsFromMap(rules, {
      companyName: tx.companyName,
      corporatePeerCampaign: tx.corporatePeerCampaign,
      donationMethod: tx.donationMethod,
      donationType: tx.donationType,
      donationAmountCents: tx.donationAmountCents,
      matchAmountCents: tx.matchAmountCents,
    });

    if ("conflict" in lookup) {
      conflicts.push({ txId: tx.id, reason: lookup.conflict.reason, matchedRows: lookup.conflict.matchedRows });
    } else {
      resolved.push({ tx, rule: lookup.result });
    }
  }

  if (conflicts.length > 0) {
    return { type: "ACCOUNT_UNRESOLVED", conflicts };
  }

  const firstTx = resolved[0]?.tx;
  const disbursementDate = firstTx?.disbursementDate ?? null;
  const disbursementFrom = firstTx?.disbursementFrom ?? null;

  const items: DisbursementPayloadV1["items"] = [];
  for (const { tx, rule } of resolved) {
    if (tx.donationAmountCents !== 0 && rule.donationAccountId) {
      items.push({ type: "donation", account: rule.donationAccount, accountId: rule.donationAccountId, amountCents: tx.donationAmountCents, transactionId: tx.transactionId });
    }
    if (tx.matchAmountCents !== 0 && rule.matchAccountId) {
      items.push({ type: "match", account: rule.matchAccount, accountId: rule.matchAccountId, amountCents: tx.matchAmountCents, transactionId: tx.transactionId });
    }
    const fees = sumCents(tx.causeSupportFeeCents ?? 0, tx.merchantFeeCents ?? 0, tx.checkFeeCents ?? 0);
    if (fees !== 0) {
      items.push({ type: "fees", account: rule.feesAccount, amountCents: fees, transactionId: tx.transactionId });
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
