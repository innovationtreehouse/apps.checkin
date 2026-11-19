import { LINE_ACCOUNT_TYPES, accountTypeRefusal, type QboAccountSummary } from "@checkin/quickbooks";
import { db } from "../db";
import { getOrgId } from "../runtime";
import { QB_MATCH_STATE } from "../lib/qb-match";

/** A gift in one of these is in QuickBooks, or settled outside the app: its lines' accounts aren't re-checked. */
const BOOKED: readonly string[] = [QB_MATCH_STATE.MATCHED, QB_MATCH_STATE.CREATED, QB_MATCH_STATE.POSTING, QB_MATCH_STATE.DISMISSED];

const withPlace = (place: string, refusal: string | null) => refusal && `${place}: ${refusal}`;

/**
 * Each stored QuickBooks pick that `accounts` lacks, shows as inactive, or lists under a type it doesn't accept, one line per pick
 * naming the screen where finance re-picks it, for System Status. Stored values stay as they are.
 */
export async function misTypedQuickBooksPicks(accounts: readonly QboAccountSummary[]): Promise<string[]> {
  const orgId = await getOrgId();
  const hasAccount = { quickBooksAccountId: { not: null } };
  const select = { id: true, donationId: true, quickBooksAccountId: true, isCapital: true };
  const [maps, receiptLines, manualLines, booked] = await Promise.all([
    db.accountMap.findMany({
      where: { orgId, OR: [{ donationAccountId: { not: null } }, { matchAccountId: { not: null } }] },
      select: { companyName: true, corporatePeerCampaign: true, donationAccountId: true, matchAccountId: true },
      orderBy: { id: "asc" },
    }),
    db.inKindDonationLine.findMany({ where: { ...hasAccount, donation: { orgId } }, select, orderBy: { id: "asc" } }),
    db.manualInKindDonationLine.findMany({ where: { ...hasAccount, donation: { orgId } }, select, orderBy: { id: "asc" } }),
    db.inKindPosting.findMany({ where: { orgId, matchState: { in: [...BOOKED] } }, select: { source: true, giftId: true } }),
  ]);
  const refusal = (id: string, allowed: readonly string[], what: string) => accountTypeRefusal(accounts, id, allowed, what);
  const out: (string | null)[] = maps.flatMap((m) => {
    const place = `Donation account map, ${m.companyName} / ${m.corporatePeerCampaign}`;
    return [
      m.donationAccountId && withPlace(`${place}, donation account`, refusal(m.donationAccountId, LINE_ACCOUNT_TYPES.givingGift, "A rule's donation account")),
      m.matchAccountId && withPlace(`${place}, match account`, refusal(m.matchAccountId, LINE_ACCOUNT_TYPES.givingGift, "A rule's match account")),
    ];
  });
  const isBooked = new Set(booked.map((p) => `${p.source}:${p.giftId}`));
  for (const [source, lines] of [["receipt", receiptLines], ["manual", manualLines]] as const) {
    for (const line of lines) {
      if (isBooked.has(`${source}:${line.donationId}`) || !line.quickBooksAccountId) continue;
      const isAsset = line.isCapital === true;
      out.push(
        withPlace(
          `Gifts of goods, ${source} gift ${line.donationId}, line ${line.id}`,
          refusal(line.quickBooksAccountId, isAsset ? LINE_ACCOUNT_TYPES.donatedCapital : LINE_ACCOUNT_TYPES.donatedGoods, isAsset ? "Donated equipment" : "A donated item"),
        ),
      );
    }
  }
  return out.filter((line): line is string => typeof line === "string");
}
