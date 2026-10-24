/** Card-charge rules (Financial Policy §XII.4, owner rulings of 2026-10-16), pure — no database. */
import { describe, it, expect } from "vitest";
import {
  blockedSeats,
  boardAuthorizationRefusal,
  isEveryday,
  missingSeats,
  needsBoardApproval,
  needsBoardSeat,
  signoffRefusal,
  withinEverydayLimits,
  type EverydayAmounts,
  type EverydayFacts,
  type SignoffFacts,
} from "../../lib/signoff";
import { DEFAULT_EXPENSE_SETTINGS } from "../../services/settingsService";

const limits = DEFAULT_EXPENSE_SETTINGS;
const amounts: EverydayAmounts = { receiptTotalCents: 10_000, unitPricesCents: [10_000] };
const plain: EverydayFacts = { withinLimits: true };

describe("Everyday", () => {
  it("defaults to under $500 in total and no item over $250", () => {
    expect(limits).toMatchObject({ everydayTotalLimitCents: 50_000, everydayItemLimitCents: 25_000 });
  });

  it("a total of $499.99 is within the limits; $500.00 is not", () => {
    expect(withinEverydayLimits({ ...amounts, receiptTotalCents: 49_999 }, limits)).toBe(true);
    expect(withinEverydayLimits({ ...amounts, receiptTotalCents: 50_000 }, limits)).toBe(false);
  });

  it("an item at $250.00 is within the limits; one at $250.01 is not", () => {
    expect(withinEverydayLimits({ ...amounts, unitPricesCents: [100, 25_000] }, limits)).toBe(true);
    expect(withinEverydayLimits({ ...amounts, unitPricesCents: [100, 25_001] }, limits)).toBe(false);
  });

  it("the item limit reads unit prices: a 3 × $100 line under $500 is within the limits", () => {
    expect(withinEverydayLimits({ receiptTotalCents: 30_000, unitPricesCents: [10_000] }, limits)).toBe(true);
  });

  it("follows the Board's limits, not the defaults", () => {
    const tighter = { everydayTotalLimitCents: 20_000, everydayItemLimitCents: 5_000 };
    expect(withinEverydayLimits(amounts, tighter)).toBe(false);
  });

  it("the amounts alone decide it: within the limits is Everyday, outside them is not", () => {
    expect(isEveryday(plain)).toBe(true);
    expect(isEveryday({ ...plain, withinLimits: false })).toBe(false);
  });
});

describe("which lines take the Board seat", () => {
  it("a non-Everyday card-charge line outside a program bucket takes it until an authorization is recorded", () => {
    expect(needsBoardSeat("card_charge", false, false, null)).toBe(true);
    expect(needsBoardSeat("card_charge", false, false, "Board vote 2026-10-01: laser cutter tube")).toBe(false);
  });

  it("a program bucket's approved budget is written authorization", () => {
    expect(needsBoardSeat("card_charge", false, true, null)).toBe(false);
  });

  it("a blank authorization counts as none", () => {
    expect(needsBoardSeat("card_charge", false, false, "")).toBe(true);
    expect(needsBoardSeat("card_charge", false, false, "   ")).toBe(true);
  });

  it("an Everyday card charge and any reimbursement take none", () => {
    expect(needsBoardSeat("card_charge", true, false, null)).toBe(false);
    expect(needsBoardSeat("reimbursement", false, false, null)).toBe(false);
  });
});

// 1 purchaser · 2 bucket owner · 3,4 FINANCE · 5,6 Board · 8 purchaser's spouse
const card: SignoffFacts = {
  kind: "card_charge",
  submitterId: 1,
  approvers: [2],
  orgLevel: false,
  reimburseeIsMember: true,
  finance: [3, 4],
  board: [5, 6],
  conflicted: [1, 8],
  ownerHousehold: [],
  reimburseeSetter: null,
  seatedHouseholds: [],
  boardSeat: true,
  approved: true,
  approver: 2,
};
const treasurer = [{ seat: "TREASURER" as const, signerUserId: 3 }];

describe("who records the Board authorization", () => {
  it("a FINANCE holder without a conflict records it; nobody else does while one exists", () => {
    expect(boardAuthorizationRefusal([card], 3)).toBeNull();
    expect(boardAuthorizationRefusal([card], 5)).toMatch(/FINANCE/);
    expect(boardAuthorizationRefusal([card], 2)).toMatch(/FINANCE/);
  });

  it("a FINANCE holder who made the purchase, or is in the purchaser's household, is refused", () => {
    const self = { ...card, conflicted: [3, 8] };
    expect(boardAuthorizationRefusal([self], 3)).toMatch(/conflicted/);
    expect(boardAuthorizationRefusal([self], 4)).toBeNull();
  });

  it("recording is not an approval: the Treasurer seat's bucket owner conflict does not apply", () => {
    const led = { ...card, ownerHousehold: [2, 4] };
    expect(boardAuthorizationRefusal([card, led], 4)).toBeNull();
  });

  it("with every FINANCE holder conflicted, a Board member without a conflict records it", () => {
    const allConflicted = { ...card, conflicted: [1, 3, 4, 8] };
    expect(boardAuthorizationRefusal([allConflicted], 5)).toBeNull();
    expect(boardAuthorizationRefusal([{ ...allConflicted, conflicted: [1, 3, 4, 5, 8] }], 5)).toMatch(/conflicted/);
    expect(boardAuthorizationRefusal([allConflicted], 2)).toMatch(/Board member/);
  });
});

describe("the Treasurer seat on a card charge", () => {
  it("a conflicted Treasurer is replaced by another FINANCE holder", () => {
    const self = { ...card, conflicted: [3, 8] };
    expect(signoffRefusal(self, [], "TREASURER", 3)).toMatch(/submitter/);
    expect(signoffRefusal(self, [], "TREASURER", 4)).toBeNull();
    expect(signoffRefusal(self, [], "TREASURER", 5)).toMatch(/FINANCE/);
  });

  it("with no FINANCE holder free, a Board member without a conflict signs", () => {
    const none = { ...card, conflicted: [1, 3, 8], ownerHousehold: [2, 4] };
    expect(signoffRefusal(none, [], "TREASURER", 5)).toBeNull();
  });
});

describe("the Board seat on a card charge", () => {
  it("is missing on a line that takes it, and absent otherwise", () => {
    expect(missingSeats(card, [])).toEqual(["TREASURER", "BOARD"]);
    expect(missingSeats({ ...card, boardSeat: false }, [])).toEqual(["TREASURER"]);
  });

  it("a Board member without a conflict with the purchaser signs it, alongside the Treasurer", () => {
    expect(signoffRefusal(card, treasurer, "BOARD", 5)).toBeNull();
    expect(signoffRefusal(card, treasurer, "BOARD", 3)).toMatch(/another seat/);
    expect(signoffRefusal(card, treasurer, "BOARD", 4)).toMatch(/Board member/);
  });

  it("a Board member in the purchaser's household is refused", () => {
    expect(signoffRefusal({ ...card, conflicted: [1, 5, 8] }, treasurer, "BOARD", 5)).toMatch(/household/);
  });

  it("the bucket owner's household conflict is the Treasurer seat's, not the Board seat's", () => {
    expect(signoffRefusal({ ...card, ownerHousehold: [2, 5] }, treasurer, "BOARD", 5)).toBeNull();
  });

  it("a line that takes no Board seat refuses it", () => {
    expect(signoffRefusal({ ...card, boardSeat: false }, [], "BOARD", 5)).toMatch(/no Board seat/);
  });

  it("is not a Board substitution: an org-level line approved by a Board member still takes the Board seat", () => {
    const org = { ...card, orgLevel: true, approvers: [], approver: 6 };
    expect(signoffRefusal(org, treasurer, "BOARD", 5)).toBeNull();
    expect(blockedSeats(org, treasurer)).toEqual([]);
  });

  it("is blocked when no Board member without a conflict is free", () => {
    expect(blockedSeats({ ...card, conflicted: [1, 5, 6, 8] }, [])).toEqual(["BOARD"]);
  });
});

describe("a purchase of $2,000 or more", () => {
  it("is held until the Board's approval is recorded, whatever its kind or bucket", () => {
    expect(needsBoardApproval(199_999, 200_000, null)).toBe(false);
    expect(needsBoardApproval(200_000, 200_000, null)).toBe(true);
    expect(needsBoardApproval(200_000, 200_000, "FY27 robotics budget, line 12: competition kit")).toBe(false);
  });

  it("follows the Board-review total setting, not a fixed $2,000", () => {
    expect(needsBoardApproval(150_000, 100_000, null)).toBe(true);
    expect(needsBoardApproval(200_000, 250_000, null)).toBe(false);
  });

  it("a blank record counts as none", () => {
    expect(needsBoardApproval(200_000, 200_000, "  ")).toBe(true);
  });
});
