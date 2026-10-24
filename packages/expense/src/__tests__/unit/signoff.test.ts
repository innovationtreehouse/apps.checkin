/** Sign-off seat and approval rules (F2 / F2-COI, the C′ decisions of #2503), pure — no database. */
import { describe, it, expect } from "vitest";
import {
  approvalOrderRefusal,
  approvalRefusal,
  approvesAsStandIn,
  blockedSeats,
  missingSeats,
  signoffRefusal,
  takesBoardSeat,
  type FilledSeat,
  type SignoffFacts,
} from "../../lib/signoff";

// 1 submitter · 2 bucket owner · 3 the FINANCE holder · 5,6 Board · 8 submitter's spouse
// seatedHouseholds: household members of people already seated on the expense
const pending: SignoffFacts = {
  kind: "reimbursement",
  submitterId: 1,
  approvers: [2],
  orgLevel: false,
  reimburseeIsMember: true,
  finance: [3],
  board: [5, 6],
  conflicted: [1, 8],
  ownerHousehold: [],
  reimburseeSetter: null,
  seatedHouseholds: [],
  boardSeat: false,
  approved: false,
  approver: null,
};
/** The line approved by its bucket owner. */
const base: SignoffFacts = { ...pending, approved: true, approver: 2 };
const seats = (...s: Array<[FilledSeat["seat"], number]>): FilledSeat[] => s.map(([seat, signerUserId]) => ({ seat, signerUserId }));

describe("the submitter seat", () => {
  it("a reimbursement takes it; a card charge does not, and refuses it", () => {
    expect(missingSeats(base, [])).toContain("SUBMITTER");
    const card = { ...base, kind: "card_charge" as const };
    expect(missingSeats(card, [])).not.toContain("SUBMITTER");
    expect(signoffRefusal(card, [], "SUBMITTER", 1)).toMatch(/card charge takes no submitter seat/);
  });

  it("a reimbursement's line is approved only after the submitter seat is signed; a card charge's needs none", () => {
    expect(approvalOrderRefusal(pending, [])).toMatch(/not confirmed yet/);
    expect(approvalOrderRefusal(pending, seats(["SUBMITTER", 1]))).toBeNull();
    expect(approvalOrderRefusal({ ...pending, kind: "card_charge" }, [])).toBeNull();
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
    expect(approvalRefusal(pending, [], 2)).toBeNull();
    expect(approvesAsStandIn(pending, 2)).toBe(false);
  });

  it("refuses the submitter, the reimbursee and their households", () => {
    expect(approvalRefusal({ ...pending, approvers: [8] }, [], 8)).toMatch(/household submitted/);
  });

  it("refuses an approver whose household already holds a seat on the expense", () => {
    expect(approvalRefusal({ ...pending, seatedHouseholds: [2] }, [], 2)).toMatch(/household already holds a seat/);
  });

  it("refuses an approver who signs another seat on the line", () => {
    const facts = { ...pending, approvers: [2, 3] };
    expect(approvalRefusal(facts, seats(["TREASURER", 3]), 3)).toMatch(/another seat/);
  });

  it("refuses anyone who is neither a bucket approver nor on the Board, FINANCE included", () => {
    expect(approvalRefusal(pending, [], 3)).toMatch(/not in a bucket you approve/);
  });
});

describe("a Board stand-in (C′.3)", () => {
  it("a Board member may approve any line, even while its approvers can act", () => {
    expect(approvalRefusal(pending, [], 5)).toBeNull();
    expect(approvesAsStandIn(pending, 5)).toBe(true);
  });

  it("a Board member who approves the bucket is not a stand-in", () => {
    expect(approvesAsStandIn({ ...pending, approvers: [2, 5] }, 5)).toBe(false);
  });

  it("takes every approval refusal", () => {
    expect(approvalRefusal({ ...pending, conflicted: [1, 5] }, [], 5)).toMatch(/household submitted/);
    expect(approvalRefusal({ ...pending, seatedHouseholds: [5] }, [], 5)).toMatch(/household already holds a seat/);
  });

  it("counts as a substitution: on a card charge it leaves none for the Treasurer seat", () => {
    const facts: SignoffFacts = { ...pending, kind: "card_charge", conflicted: [1, 8, 3], approved: true, approver: 5 };
    expect(signoffRefusal(facts, [], "TREASURER", 6)).toMatch(/no Board substitution left/);
    expect(blockedSeats(facts, [])).toEqual(["TREASURER"]);
  });

  it("on a reimbursement it leaves one for the Treasurer seat", () => {
    const facts: SignoffFacts = { ...pending, conflicted: [1, 8, 3], approved: true, approver: 5 };
    expect(signoffRefusal(facts, [], "TREASURER", 6)).toBeNull();
    expect(signoffRefusal(facts, [], "TREASURER", 5)).toMatch(/approved the line/);
  });

  it("an org-level line takes a Board member's approval", () => {
    const facts = { ...pending, approvers: [], orgLevel: true };
    expect(approvalRefusal(facts, [], 2)).toMatch(/not in a bucket you approve/);
    expect(approvalRefusal(facts, [], 5)).toBeNull();
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

describe("a non-member reimbursement (C′.6)", () => {
  const nonMember = { ...base, reimburseeIsMember: false };

  it("keeps the bucket approver and adds a Board seat", () => {
    expect(takesBoardSeat(nonMember)).toBe(true);
    expect(approvalRefusal({ ...nonMember, approved: false, approver: null }, [], 2)).toBeNull();
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
    expect(signoffRefusal(base, [], "SUBMITTER", 8)).toMatch(/only the submitter/);
    expect(signoffRefusal(base, [], "SUBMITTER", 1)).toBeNull();
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
    expect(signoffRefusal({ ...base, seatedHouseholds: [3] }, [], "TREASURER", 3)).toMatch(/household already holds a seat/);
  });

  it("a Board member whose household already holds a seat cannot substitute", () => {
    const facts = { ...base, conflicted: [1, 8, 3], seatedHouseholds: [5] };
    expect(signoffRefusal(facts, [], "TREASURER", 5)).toMatch(/household already holds a seat/);
    expect(signoffRefusal(facts, [], "TREASURER", 6)).toBeNull();
  });
});

describe("Board substitution (F2-COI)", () => {
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

  it("a card charge with a bucket approver keeps its one substitution for the Treasurer seat", () => {
    const facts: SignoffFacts = { ...base, kind: "card_charge", conflicted: [1, 8, 3] };
    expect(signoffRefusal(facts, [], "TREASURER", 5)).toBeNull();
    expect(blockedSeats(facts, [])).toEqual([]);
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
    expect(approvalRefusal({ ...pending, approvers: [3], reimburseeSetter: 3 }, [], 3)).toBeNull();
  });
});
