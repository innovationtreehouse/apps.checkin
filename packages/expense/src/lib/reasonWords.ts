// Each queue reason in plain words, and the place on the expense page that answers it.
import { formatCents } from "@checkin/money";
import type { QueueReason, ReasonCode } from "./reasons";

const DRIFT_WORDS: Record<string, string> = { missing: "removed", amount: "amount", key: "app key", accounts: "account", vendor: "vendor" };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The reason in plain words; no kind code, state name or id. */
export function reasonText(r: QueueReason, currency: string): string {
  const money = (cents: number | null) => formatCents(cents ?? 0, currency);
  switch (r.code) {
    case "BUCKET_TO_ASSIGN": return "Bucket to assign";
    case "BUCKET_UNKNOWN": return "Bucket unknown";
    case "OWNER_EXCEPTION": return "Exception raised by a budget owner";
    case "CAPITAL_REVIEW": return "Capital review";
    case "DEPRECIATION_CYCLE": return "Depreciation cycle";
    case "REIMBURSEE_TO_NAME": return "Reimbursee to name";
    case "TAX_NOT_REVIEWED": return `Tax ${money(r.amountCents)} not reviewed on the receipt`;
    case "ACCOUNT_HOLD": return `${plural(r.count ?? 0, "line has", "lines have")} no account rule`;
    case "QB_POST_FAILED": return `Posting failed ${plural(r.count ?? 0, "time", "times")}${r.detail ? `: ${r.detail}` : ""}`;
    case "QB_AWAITING_MATCH": return "Several QuickBooks entries match; pick one";
    case "QB_VENDOR_MISSING": return "The reimbursee has no QuickBooks vendor yet; link one";
    case "QB_UNBOOKED": return "Not in QuickBooks, and the app does not book it on its own; book it or match it";
    case "QB_NO_CLASS": return r.detail ? `Budget bucket ${r.detail} has no QuickBooks class` : "A line has no budget bucket, so it has no QuickBooks class";
    case "QB_DUPLICATE_TO_VOID": return "Duplicate entry in QuickBooks needs voiding";
    case "QB_DRIFT": {
      const fields = (r.detail ?? "").split(", ").filter(Boolean).map((f) => DRIFT_WORDS[f] ?? f);
      return `Changed in QuickBooks after posting${fields.length ? `: ${fields.join(", ")}` : ""}`;
    }
    case "QB_POST_HELD": return r.detail ? capitalized(r.detail) : "Closed but not posted";
    case "BOARD_APPROVAL": return `Board approval of a ${money(r.amountCents)} purchase not recorded`;
    case "SIGNER_HELD": return "No Board member without a conflict can sign; held";
  }
}

/** Where on the expense page the reason is answered. */
export const REASON_PLACE: Record<ReasonCode, string> = {
  BUCKET_TO_ASSIGN: "Assign bucket, in the lines",
  BUCKET_UNKNOWN: "Resolve bucket, in the lines",
  OWNER_EXCEPTION: "Reject exception or Assign bucket, in the lines",
  CAPITAL_REVIEW: "Capital review panel",
  DEPRECIATION_CYCLE: "Depreciation cycle panel",
  REIMBURSEE_TO_NAME: "Reimbursee panel",
  TAX_NOT_REVIEWED: "Approve tax, beside the tax",
  ACCOUNT_HOLD: "Account holds panel",
  QB_POST_FAILED: "QuickBooks panel",
  QB_AWAITING_MATCH: "QuickBooks panel",
  QB_VENDOR_MISSING: "Reimbursee panel",
  QB_UNBOOKED: "QuickBooks panel",
  QB_NO_CLASS: "the bucket's QuickBooks class on the Budgets page",
  QB_DUPLICATE_TO_VOID: "Reviews panel",
  QB_DRIFT: "Reviews panel",
  QB_POST_HELD: "Reviews panel",
  BOARD_APPROVAL: "Board authorization panel",
  SIGNER_HELD: "Sign-off column",
};
