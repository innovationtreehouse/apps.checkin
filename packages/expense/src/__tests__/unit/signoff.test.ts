/** Sign-off seat and approval rules (F2 / F2-COI, the C′ decisions of #2503), pure — no database. */
import { describe, it, expect } from "vitest";
import {
  approvalRefusal,
  approvesAsStandIn,
  availableSigners,
  blockedSeats,
  missingSeats,
  signoffRefusal,
  submitterSeatRefusal,
  takesBoardSeat,
  type FilledSeat,
  type SignoffFacts,
} from "../../lib/signoff";

// 1 submitter · 2 bucket owner · 3 the FINANCE holder · 5,6 Board · 8 submitter's spouse
// seatedHouseholds: household members of people already seated on the expense
const pending: SignoffFacts = {
  kind: "reimbursement",
  submitterId: 1,
  reimburseeId: 1,
  approvers: [2],
  orgLevel: false,
  reimburseeIsMember: true,
  reimburseeUnknown: false,
  finance: [3],
  board: [5, 6],
  conflicted: [1, 8],
  ownerHousehold: [],
  reimburseeSetter: null,
  seatedHouseholds: [],
  boardSeat: false,
  approved: false,
  approver: null,
  expenseSigners: [],
};
/** The line approved by its bucket owner. */
const base: SignoffFacts = { ...pending, approved: true, approver: 2 };
const seats = (...s: Array<[FilledSeat["seat"], number]>): FilledSeat[] => s.map(([seat, signerUserId]) => ({ seat, signerUserId }));
/** The submitter has confirmed the reimbursement: the approval may follow. */
const CONFIRMED = seats(["SUBMITTER", 1]);

describe("the submitter seat", () => {
  it("a reimbursement takes it; a card charge does not, and refuses it", () => {
    expect(missingSeats(base, [])).toContain("SUBMITTER");
    const card = { ...base, kind: "card_charge" as const };
    expect(missingSeats(card, [])).not.toContain("SUBMITTER");
    expect(signoffRefusal(card, [], "SUBMITTER", 1)).toMatch(/card charge takes no submitter seat/);
  });

  it("the person reimbursed fills it, not the submitter, when they differ", () => {
    const forSomeoneElse = { ...base, reimburseeId: 9, conflicted: [1, 8, 9] };
    expect(signoffRefusal(forSomeoneElse, [], "SUBMITTER", 9)).toBeNull();
    expect(signoffRefusal(forSomeoneElse, [], "SUBMITTER", 1)).toMatch(/only the person reimbursed/);
  });

  it("a reimbursement's line is approved only after the submitter seat is signed; a card charge's needs none", () => {
    expect(approvalRefusal(pending, [], 2)).toMatch(/not confirmed this reimbursement yet/);
    expect(approvalRefusal(pending, seats(["SUBMITTER", 1]), 2)).toBeNull();
    expect(approvalRefusal({ ...pending, kind: "card_charge" }, [], 2)).toBeNull();
  });
});

describe("the approval is the program approver's sign-off", () => {
  it("a line needs no program-approver seat: submitter and Treasurer only", () => {
    expect(missingSeats(base, [])).toEqual(["SUBMITTER", "TREASURER"]);
    expect(missingSeats(base, seats(["SUBMITTER", 1], ["TREASURER", 3]))).toEqual([]);
  });

  it("whoever approved the line does not sign its Treasurer seat", () => {
    const facts = { ...base, approvers: [3], approver: 3, finance: [3, 4] };
    expect(signoffRefusal(facts, [], "TREASURER", 3)).toMatch(/approved the line/);
    expect(signoffRefusal(facts, [], "TREASURER", 4)).toBeNull();
  });

  it("the approver alone holding FINANCE leaves the Treasurer seat to a Board member", () => {
    const facts = { ...base, approvers: [3], approver: 3 };
    expect(signoffRefusal(facts, [], "TREASURER", 5)).toBeNull();
  });
});

describe("approvalRefusal (C′.2)", () => {
  it("a bucket approver without a conflict approves", () => {
    expect(approvalRefusal(pending, CONFIRMED, 2)).toBeNull();
    expect(approvesAsStandIn(pending, 2)).toBe(false);
  });

  it("refuses the submitter, the reimbursee and their households", () => {
    expect(approvalRefusal({ ...pending, approvers: [8] }, CONFIRMED, 8)).toMatch(/household submitted/);
  });

  it("refuses an approver whose household already holds a seat on the expense", () => {
    expect(approvalRefusal({ ...pending, seatedHouseholds: [2] }, CONFIRMED, 2)).toMatch(/household already signs off/);
  });

  it("refuses an approver who signs another seat on the line", () => {
    const facts = { ...pending, approvers: [2, 3] };
    expect(approvalRefusal(facts, seats(["SUBMITTER", 1], ["TREASURER", 3]), 3)).toMatch(/another seat/);
  });

  it("refuses anyone who is neither a bucket approver nor on the Board, FINANCE included", () => {
    expect(approvalRefusal(pending, CONFIRMED, 3)).toMatch(/not in a bucket you approve/);
  });
});

describe("the submitter's confirmation comes first (C′.9)", () => {
  it("a reimbursement line is approved only once its submitter has signed", () => {
    expect(approvalRefusal(pending, [], 2)).toMatch(/not confirmed/);
    expect(approvalRefusal(pending, [], 5)).toMatch(/not confirmed/);
    expect(approvalRefusal(pending, CONFIRMED, 2)).toBeNull();
  });

  it("a card charge takes the approval without it", () => {
    expect(approvalRefusal({ ...pending, kind: "card_charge" }, [], 2)).toBeNull();
  });
});

describe("a Board stand-in (C′.3)", () => {
  it("a Board member may approve any line, even while its approvers can act", () => {
    expect(approvalRefusal(pending, CONFIRMED, 5)).toBeNull();
    expect(approvesAsStandIn(pending, 5)).toBe(true);
  });

  it("a Board member who approves the bucket is not a stand-in", () => {
    expect(approvesAsStandIn({ ...pending, approvers: [2, 5] }, 5)).toBe(false);
  });

  it("takes every approval refusal", () => {
    expect(approvalRefusal({ ...pending, conflicted: [1, 5] }, CONFIRMED, 5)).toMatch(/household submitted/);
    expect(approvalRefusal({ ...pending, seatedHouseholds: [5] }, CONFIRMED, 5)).toMatch(/household already signs off/);
  });

  it("on a card charge another Board member still signs the Treasurer seat", () => {
    const facts: SignoffFacts = { ...pending, kind: "card_charge", conflicted: [1, 8, 3], approved: true, approver: 5 };
    expect(signoffRefusal(facts, [], "TREASURER", 6)).toBeNull();
    expect(blockedSeats(facts, [])).toEqual([]);
  });

  it("on a reimbursement another Board member signs the Treasurer seat", () => {
    const facts: SignoffFacts = { ...pending, conflicted: [1, 8, 3], approved: true, approver: 5 };
    expect(signoffRefusal(facts, [], "TREASURER", 6)).toBeNull();
    expect(signoffRefusal(facts, [], "TREASURER", 5)).toMatch(/approved the line/);
  });

  it("an org-level line takes a Board member's approval", () => {
    const facts = { ...pending, approvers: [], orgLevel: true };
    expect(approvalRefusal(facts, CONFIRMED, 2)).toMatch(/not in a bucket you approve/);
    expect(approvalRefusal(facts, CONFIRMED, 5)).toBeNull();
  });
});

describe("signatures in order (C′.9)", () => {
  it("the Treasurer signs only once the line is approved", () => {
    expect(signoffRefusal(pending, [], "TREASURER", 3)).toMatch(/not approved yet/);
    expect(signoffRefusal(base, [], "TREASURER", 3)).toBeNull();
  });

  it("the Board signs only after the Treasurer", () => {
    const facts = { ...base, kind: "card_charge" as const, boardSeat: true };
    expect(signoffRefusal({ ...facts, approved: false, approver: null }, [], "BOARD", 5)).toMatch(/not approved yet/);
    expect(signoffRefusal(facts, [], "BOARD", 5)).toMatch(/the Board signs after the Treasurer/);
    expect(signoffRefusal(facts, seats(["TREASURER", 3]), "BOARD", 5)).toBeNull();
  });

  it("the submitter seat is signed at any time", () => {
    expect(signoffRefusal(pending, [], "SUBMITTER", 1)).toBeNull();
  });
});

describe("the reimbursee is known before any sign-off", () => {
  const unknown = { ...pending, reimburseeUnknown: true };

  it("refuses the approval to a bucket approver and a Board member alike", () => {
    expect(approvalRefusal(unknown, CONFIRMED, 2)).toMatch(/reimbursee is unknown/);
    expect(approvalRefusal(unknown, CONFIRMED, 5)).toMatch(/reimbursee is unknown/);
  });

  it("refuses every seat, the submitter's included", () => {
    const approved = { ...base, reimburseeUnknown: true, kind: "card_charge" as const, boardSeat: true };
    expect(signoffRefusal(unknown, [], "SUBMITTER", 1)).toMatch(/reimbursee is unknown/);
    expect(signoffRefusal(approved, [], "TREASURER", 3)).toMatch(/reimbursee is unknown/);
    expect(signoffRefusal(approved, seats(["TREASURER", 3]), "BOARD", 5)).toMatch(/reimbursee is unknown/);
  });
});

describe("a non-member reimbursement (C′.6)", () => {
  const nonMember = { ...base, reimburseeIsMember: false };

  it("keeps the bucket approver and adds a Board seat", () => {
    expect(takesBoardSeat(nonMember)).toBe(true);
    expect(approvalRefusal({ ...nonMember, approved: false, approver: null }, CONFIRMED, 2)).toBeNull();
    expect(missingSeats(nonMember, seats(["SUBMITTER", 1], ["TREASURER", 3]))).toEqual(["BOARD"]);
  });

  it("the Board seat waits for the approval, then the Treasurer", () => {
    expect(signoffRefusal({ ...nonMember, approved: false, approver: null }, [], "BOARD", 5)).toMatch(/not approved yet/);
    expect(signoffRefusal(nonMember, [], "BOARD", 5)).toMatch(/after the Treasurer/);
    expect(signoffRefusal(nonMember, seats(["TREASURER", 3]), "BOARD", 5)).toBeNull();
  });

  it("the Board signer is a fourth person: not the approver", () => {
    const facts = { ...nonMember, approvers: [2, 5], approver: 5 };
    expect(signoffRefusal(facts, seats(["TREASURER", 3]), "BOARD", 5)).toMatch(/approved the line/);
    expect(signoffRefusal(facts, seats(["TREASURER", 3]), "BOARD", 6)).toBeNull();
  });

  it("a card charge takes no Board seat for the membership fact", () => {
    expect(takesBoardSeat({ ...base, kind: "card_charge", reimburseeIsMember: false })).toBe(false);
  });
});

describe("independence", () => {
  it("one person cannot fill two seats on a line", () => {
    expect(signoffRefusal({ ...base, board: [3], boardSeat: true, kind: "card_charge" }, seats(["TREASURER", 3]), "BOARD", 3)).toMatch(/another seat/);
  });

  it("a signer in the reimbursee's household is refused for every seat but the submitter's own", () => {
    const facts = { ...base, finance: [8], board: [8] };
    expect(signoffRefusal(facts, [], "TREASURER", 8)).toMatch(/household/);
    expect(signoffRefusal(base, [], "SUBMITTER", 8)).toMatch(/only the person reimbursed/);
    expect(signoffRefusal(base, [], "SUBMITTER", 1)).toBeNull();
  });

  it("the person reimbursed is refused the submitter seat while someone in their household holds a seat on the expense", () => {
    expect(signoffRefusal({ ...base, seatedHouseholds: [1] }, seats(["TREASURER", 3]), "SUBMITTER", 1)).toMatch(/signer's household already signs off/);
  });

  it("a seat is filled once", () => {
    expect(signoffRefusal(base, seats(["TREASURER", 3]), "TREASURER", 5)).toMatch(/already filled/);
  });

  it("while an eligible signer is available, a Board member cannot take the Treasurer seat", () => {
    expect(signoffRefusal(base, [], "TREASURER", 5)).toMatch(/FINANCE/);
  });
});

describe("one seat per household on an expense", () => {
  it("a FINANCE holder whose spouse approved a line cannot sign the Treasurer seat", () => {
    expect(signoffRefusal({ ...base, seatedHouseholds: [3] }, [], "TREASURER", 3)).toMatch(/household already signs off/);
  });

  it("a Board member whose household already holds a seat cannot substitute", () => {
    const facts = { ...base, conflicted: [1, 8, 3], seatedHouseholds: [5] };
    expect(signoffRefusal(facts, [], "TREASURER", 5)).toMatch(/household already signs off/);
    expect(signoffRefusal(facts, [], "TREASURER", 6)).toBeNull();
  });
});

describe("a Board member standing in for the Treasurer (F2-COI)", () => {
  it("the only FINANCE holder conflicted: a Board member takes the Treasurer seat", () => {
    const facts = { ...base, conflicted: [1, 3] };
    expect(signoffRefusal(facts, [], "TREASURER", 3)).toMatch(/household/);
    expect(signoffRefusal(facts, [], "TREASURER", 5)).toBeNull();
  });

  it("two FINANCE holders, one conflicted: the other signs and no Board member is needed", () => {
    const facts = { ...base, finance: [3, 4], conflicted: [1, 3] };
    expect(signoffRefusal(facts, [], "TREASURER", 5)).toMatch(/FINANCE/);
    expect(signoffRefusal(facts, [], "TREASURER", 4)).toBeNull();
  });

  it("a card charge with a bucket approver takes a Board member in the Treasurer seat", () => {
    const facts: SignoffFacts = { ...base, kind: "card_charge", conflicted: [1, 8, 3] };
    expect(signoffRefusal(facts, [], "TREASURER", 5)).toBeNull();
    expect(blockedSeats(facts, [])).toEqual([]);
  });
});

describe("an org-level line has no cap on Board stand-ins", () => {
  // 7 is the org-level bucket's owner; it has no bucket approvers
  const org: SignoffFacts = { ...pending, kind: "card_charge", approvers: [], orgLevel: true };

  it("the only FINANCE holder conflicted: one Board member approves, another signs as Treasurer", () => {
    const facts: SignoffFacts = { ...org, conflicted: [1, 8, 3] };
    expect(approvalRefusal(facts, [], 5)).toBeNull();
    const approved: SignoffFacts = { ...facts, approved: true, approver: 5, expenseSigners: [{ step: "APPROVAL", userId: 5 }] };
    expect(signoffRefusal(approved, [], "TREASURER", 3)).toMatch(/submitter/);
    expect(signoffRefusal(approved, [], "TREASURER", 5)).toMatch(/approved the line/);
    expect(signoffRefusal(approved, [], "TREASURER", 6)).toBeNull();
    expect(blockedSeats(approved, [])).toEqual([]);
    expect(missingSeats(approved, seats(["TREASURER", 6]))).toEqual([]);
  });

  it("a Board member holding FINANCE approves; a different FINANCE holder signs as Treasurer", () => {
    const facts: SignoffFacts = { ...org, finance: [3, 5] };
    expect(approvalRefusal(facts, [], 5)).toBeNull();
    const approved: SignoffFacts = { ...facts, approved: true, approver: 5, expenseSigners: [{ step: "APPROVAL", userId: 5 }] };
    expect(signoffRefusal(approved, [], "TREASURER", 5)).toMatch(/approved the line/);
    expect(signoffRefusal(approved, [], "TREASURER", 3)).toBeNull();
    expect(availableSigners(approved, [], "TREASURER")).toEqual([3]);
  });

  it("is held only when nobody independent is left to sign the Treasurer seat", () => {
    const approved: SignoffFacts = { ...org, conflicted: [1, 8, 3], approved: true, approver: 5, expenseSigners: [{ step: "APPROVAL", userId: 5 }] };
    expect(blockedSeats({ ...approved, seatedHouseholds: [6] }, [])).toEqual(["TREASURER"]);
    expect(blockedSeats({ ...approved, board: [5, 6, 9], seatedHouseholds: [6] }, [])).toEqual([]);
  });
});

describe("the bucket owner's household and the Treasurer seat", () => {
  // 2 leads the program; 4 is 2's spouse and holds FINANCE alongside 3.
  const led = { ...base, finance: [3, 4], ownerHousehold: [2, 4] };

  it("a FINANCE holder in the owner's household cannot fill the Treasurer seat; another FINANCE holder can", () => {
    expect(signoffRefusal(led, [], "TREASURER", 4)).toMatch(/bucket owner/);
    expect(signoffRefusal(led, [], "TREASURER", 3)).toBeNull();
  });

  it("the owner holding FINANCE cannot fill the Treasurer seat even when a treasurer approved the line", () => {
    const facts = { ...base, approvers: [2, 7], approver: 7, finance: [2], ownerHousehold: [2] };
    expect(signoffRefusal(facts, [], "TREASURER", 2)).toMatch(/bucket owner/);
    expect(signoffRefusal(facts, [], "TREASURER", 5)).toBeNull();
  });

  it("a Board member in the owner's household cannot replace the Treasurer", () => {
    const facts = { ...led, finance: [4], board: [4, 5] };
    expect(signoffRefusal(facts, [], "TREASURER", 4)).toMatch(/bucket owner/);
    expect(signoffRefusal(facts, [], "TREASURER", 5)).toBeNull();
  });
});

describe("the reimbursee's setter", () => {
  it("cannot fill the Treasurer seat; another FINANCE holder can", () => {
    const facts = { ...base, finance: [3, 4], reimburseeSetter: 3 };
    expect(signoffRefusal(facts, [], "TREASURER", 3)).toMatch(/set the reimbursee/);
    expect(signoffRefusal(facts, [], "TREASURER", 4)).toBeNull();
  });

  it("as the only FINANCE holder, leaves the Treasurer seat to the Board, and cannot take it as a Board member", () => {
    const facts = { ...base, board: [3, 5], reimburseeSetter: 3 };
    expect(signoffRefusal(facts, [], "TREASURER", 3)).toMatch(/set the reimbursee/);
    expect(signoffRefusal(facts, [], "TREASURER", 5)).toBeNull();
  });

  it("may still approve the line", () => {
    expect(approvalRefusal({ ...pending, approvers: [3], reimburseeSetter: 3 }, CONFIRMED, 3)).toBeNull();
  });
});

describe("one person signs one step of an expense", () => {
  // 4 approved another line of the expense; 7 shares a household with them; 9 signs the Treasurer seat on another line.
  const approvedElsewhere: SignoffFacts = {
    ...base,
    finance: [3, 4, 7],
    board: [4, 5, 6, 7, 9],
    expenseSigners: [{ step: "APPROVAL", userId: 2 }, { step: "APPROVAL", userId: 4 }],
    seatedHouseholds: [7],
  };

  it("the Treasurer seat refuses whoever approved any line of the expense, and their household", () => {
    expect(signoffRefusal(approvedElsewhere, [], "TREASURER", 4)).toMatch(/another step/);
    expect(signoffRefusal(approvedElsewhere, [], "TREASURER", 7)).toMatch(/household already signs off/);
    expect(signoffRefusal(approvedElsewhere, [], "TREASURER", 3)).toBeNull();
    expect(availableSigners(approvedElsewhere, [], "TREASURER")).toEqual([3]);
  });

  it("the Board seat refuses every earlier signer on the expense, and their households", () => {
    const facts: SignoffFacts = { ...approvedElsewhere, boardSeat: true, kind: "card_charge", expenseSigners: [...approvedElsewhere.expenseSigners, { step: "TREASURER", userId: 9 }] };
    const filled = seats(["TREASURER", 3]);
    expect(signoffRefusal(facts, filled, "BOARD", 4)).toMatch(/another step/);
    expect(signoffRefusal(facts, filled, "BOARD", 9)).toMatch(/another step/);
    expect(signoffRefusal(facts, filled, "BOARD", 7)).toMatch(/household already signs off/);
    expect(signoffRefusal(facts, filled, "BOARD", 5)).toBeNull();
  });

  it("a reimbursement's Board seat follows the same rule", () => {
    const facts: SignoffFacts = { ...approvedElsewhere, reimburseeIsMember: false };
    expect(signoffRefusal(facts, seats(["SUBMITTER", 1], ["TREASURER", 3]), "BOARD", 4)).toMatch(/another step/);
    expect(signoffRefusal(facts, seats(["SUBMITTER", 1], ["TREASURER", 3]), "BOARD", 5)).toBeNull();
  });

  it("a line's approval refuses whoever signs a Treasurer or Board seat on the expense", () => {
    const facts: SignoffFacts = { ...pending, approvers: [2, 3, 5], expenseSigners: [{ step: "TREASURER", userId: 3 }, { step: "BOARD", userId: 5 }] };
    expect(approvalRefusal(facts, CONFIRMED, 3)).toMatch(/later step/);
    expect(approvalRefusal(facts, CONFIRMED, 5)).toMatch(/later step/);
    expect(approvalRefusal(facts, CONFIRMED, 2)).toBeNull();
  });

  it("the same person may approve several lines, or sign the same seat on several", () => {
    const facts: SignoffFacts = { ...pending, expenseSigners: [{ step: "APPROVAL", userId: 2 }] };
    expect(approvalRefusal(facts, CONFIRMED, 2)).toBeNull();
    expect(signoffRefusal({ ...base, expenseSigners: [{ step: "TREASURER", userId: 3 }] }, [], "TREASURER", 3)).toBeNull();
  });
});

describe("submitterSeatRefusal", () => {
  it("the person reimbursed signs it", () => {
    expect(submitterSeatRefusal(base, [], 1)).toBeNull();
  });

  it("a Board member without a conflict signs on their behalf; anyone else off the Board does not", () => {
    expect(submitterSeatRefusal(base, [], 5)).toBeNull();
    expect(submitterSeatRefusal(base, [], 2)).toMatch(/only the person reimbursed, or a Board member on their behalf/);
    expect(submitterSeatRefusal({ ...base, conflicted: [1, 5, 8] }, [], 5)).toMatch(/submitter, the reimbursee, or in their household/);
  });

  it("a Board member on the reimbursee's behalf takes no other step on the expense", () => {
    const facts = { ...base, expenseSigners: [{ step: "BOARD" as const, userId: 5 }] };
    expect(submitterSeatRefusal(facts, [], 5)).toMatch(/another step/);
  });

  it("nobody in the signer's household may hold another seat on the expense", () => {
    expect(submitterSeatRefusal({ ...base, seatedHouseholds: [5] }, [], 5)).toMatch(/signer's household already signs off/);
  });

  it("a card charge takes none, and a filled seat is filled once", () => {
    expect(submitterSeatRefusal({ ...base, kind: "card_charge" }, [], 1)).toMatch(/card charge takes no submitter seat/);
    expect(submitterSeatRefusal(base, seats(["SUBMITTER", 1]), 5)).toMatch(/already filled/);
  });
});
