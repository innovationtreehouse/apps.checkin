import { type AccountMap as AccountMapRule } from "../generated/prisma/client";

export type AccountDetermination = {
  donationAccount: string;
  matchAccount: string;
  feesAccount: string;
};

export type AccountConflict = {
  reason: "NO_MATCH" | "MULTIPLE_MATCHES";
  matchedRows: AccountMapRule[];
};

type TxFields = {
  companyName: string | null;
  corporatePeerCampaign: string | null;
  donationMethod: string | null;
  donationType: string | null;
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
): { result: AccountDetermination } | { conflict: AccountConflict } {
  const matches = rules.filter((rule) => matchesTransaction(rule, tx));

  if (matches.length === 0) {
    return { conflict: { reason: "NO_MATCH", matchedRows: [] } };
  }
  if (matches.length > 1) {
    return { conflict: { reason: "MULTIPLE_MATCHES", matchedRows: matches } };
  }

  return {
    result: {
      donationAccount: matches[0].donationAccount,
      matchAccount: matches[0].matchAccount,
      feesAccount: matches[0].feesAccount,
    },
  };
}
