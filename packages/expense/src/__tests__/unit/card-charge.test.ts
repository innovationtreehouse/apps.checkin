/** Card-charge rules (Financial Policy §XII.4, owner rulings of 2026-10-16), pure — no database. */
import { describe, it, expect } from "vitest";
import {
  boardAuthorizationRefusal,
  isEveryday,
  needsBoardAuthorization,
  signoffRefusal,
  withinEverydayLimits,
  type EverydayAmounts,
  type EverydayFacts,
  type SignoffFacts,
} from "../../lib/signoff";
import { DEFAULT_EXPENSE_SETTINGS } from "../../services/settingsService";

const limits = DEFAULT_EXPENSE_SETTINGS;
const amounts: EverydayAmounts = { receiptTotalCents: 10_000, unitPricesCents: [10_000] };
const plain: EverydayFacts = { withinLimits: true, singleSource: false, financeNotEveryday: false };

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

  it("within the limits and unmarked is Everyday; outside them is not", () => {
    expect(isEveryday(plain)).toBe(true);
    expect(isEveryday({ ...plain, withinLimits: false })).toBe(false);
  });

  it("a single-source purchase is never Everyday", () => {
    expect(isEveryday({ ...plain, singleSource: true })).toBe(false);
  });

  it("FINANCE's not-Everyday mark overrides the limits", () => {
    expect(isEveryday({ ...plain, financeNotEveryday: true })).toBe(false);
  });
});

describe("Board authorization", () => {
  it("a non-Everyday card charge needs it until recorded", () => {
    expect(needsBoardAuthorization("card_charge", false, null)).toBe(true);
    expect(needsBoardAuthorization("card_charge", false, "Board vote 2026-10-01: laser cutter tube")).toBe(false);
  });

  it("a blank authorization counts as none", () => {
    expect(needsBoardAuthorization("card_charge", false, "")).toBe(true);
    expect(needsBoardAuthorization("card_charge", false, "   ")).toBe(true);
  });

  it("an Everyday card charge and any reimbursement need none", () => {
    expect(needsBoardAuthorization("card_charge", true, null)).toBe(false);
    expect(needsBoardAuthorization("reimbursement", false, null)).toBe(false);
  });
});

// 1 purchaser · 2 program leader · 3,4 FINANCE · 5,6 Board · 8 purchaser's spouse
const card: SignoffFacts = {
  kind: "card_charge",
  submitterId: 1,
  approvers: [2],
  orgLevel: false,
  reimburseeIsMember: true,
  finance: [3, 4],
  board: [5, 6],
  conflicted: [1, 8],
  leaderHousehold: [],
  reimburseeSetter: null,
  seatedHouseholds: [],
  needsBoardAuthorization: true,
};

describe("who records the Board authorization", () => {
  it("a FINANCE holder without a conflict records it; nobody else does while one exists", () => {
    expect(boardAuthorizationRefusal([card], 3)).toBeNull();
    expect(boardAuthorizationRefusal([card], 5)).toMatch(/FINANCE/);
    expect(boardAuthorizationRefusal([card], 2)).toMatch(/FINANCE/);
  });

  it("a FINANCE holder who made the purchase, or is in the purchaser's household, is refused", () => {
    const self = { ...card, conflicted: [3, 8] };
    expect(boardAuthorizationRefusal([self], 3)).toMatch(/conflicted Treasurer/);
    expect(boardAuthorizationRefusal([self], 4)).toBeNull();
  });

  it("a FINANCE holder in any line's Program Leader household is refused", () => {
    const led = { ...card, leaderHousehold: [2, 4] };
    expect(boardAuthorizationRefusal([card, led], 4)).toMatch(/conflicted Treasurer/);
    expect(boardAuthorizationRefusal([card, led], 3)).toBeNull();
  });

  it("with every FINANCE holder conflicted, a Board member without a conflict records it", () => {
    const allConflicted = { ...card, conflicted: [1, 3, 8], leaderHousehold: [2, 4] };
    expect(boardAuthorizationRefusal([allConflicted], 5)).toBeNull();
    expect(boardAuthorizationRefusal([{ ...allConflicted, conflicted: [1, 3, 5, 8] }], 5)).toMatch(/conflicted Treasurer/);
    expect(boardAuthorizationRefusal([allConflicted], 2)).toMatch(/conflicted Treasurer/);
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
    const none = { ...card, conflicted: [1, 3, 8], leaderHousehold: [2, 4] };
    expect(signoffRefusal(none, [], "TREASURER", 5)).toBeNull();
  });
});
