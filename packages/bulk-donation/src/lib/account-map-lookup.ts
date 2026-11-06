import { type AccountMap as AccountMapRule } from "../generated/prisma/client";

export type AccountConflictReason = "NO_MATCH" | "MULTIPLE_MATCHES" | "NO_ACCOUNT" | "FEES_ONLY";

export type AccountConflict = {
  reason: AccountConflictReason;
  matchedRows: AccountMapRule[];
};

type TxFields = {
  companyName: string | null;
  corporatePeerCampaign: string | null;
  donationMethod: string | null;
  donationType: string | null;
  donationAmountCents: number;
  matchAmountCents: number;
  /** The row's fee columns, summed. */
  feeCents: number;
};

function matchesTransaction(rule: AccountMapRule, tx: TxFields): boolean {
  if (rule.companyName !== "*" && rule.companyName !== tx.companyName) return false;
  if (rule.corporatePeerCampaign !== "*" && rule.corporatePeerCampaign !== tx.corporatePeerCampaign) return false;
  if (rule.donationMethod !== tx.donationMethod) return false;
  if (rule.donationType !== tx.donationType) return false;
  return true;
}

export function determineAccountsFromMap(
  rules: AccountMapRule[],
  tx: TxFields,
): { result: AccountMapRule } | { conflict: AccountConflict } {
  // A fee needs an amount to net into; one with none goes to finance.
  if (tx.feeCents !== 0 && tx.donationAmountCents === 0 && tx.matchAmountCents === 0) {
    return { conflict: { reason: "FEES_ONLY", matchedRows: [] } };
  }
  const matches = rules.filter((rule) => matchesTransaction(rule, tx));

  if (matches.length === 0) {
    return { conflict: { reason: "NO_MATCH", matchedRows: [] } };
  }
  if (matches.length > 1) {
    return { conflict: { reason: "MULTIPLE_MATCHES", matchedRows: matches } };
  }

  // The rule needs an account for each amount the gift carries.
  const [rule] = matches;
  if ((tx.donationAmountCents !== 0 && !rule.donationAccountId) || (tx.matchAmountCents !== 0 && !rule.matchAccountId)) {
    return { conflict: { reason: "NO_ACCOUNT", matchedRows: matches } };
  }
  return { result: rule };
}
