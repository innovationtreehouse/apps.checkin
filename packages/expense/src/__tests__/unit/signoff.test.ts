/** Sign-off seat rules (F2 / F2-COI, owner rulings of 2026-10-06), pure — no database. */
import { describe, it, expect } from "vitest";
import {
  blockedSeats,
  boardFillsProgramSeat,
  missingSeats,
  signoffRefusal,
  type FilledSeat,
  type SignoffFacts,
} from "../../lib/signoff";

// 1 submitter · 2 program leader · 3 the FINANCE holder · 5,6 Board · 8 submitter's spouse
// seatedHouseholds: household members of people already seated on the expense
const base: SignoffFacts = {
  kind: "reimbursement",
  submitterId: 1,
  approvers: [2],
  orgLevel: false,
  reimburseeIsMember: true,
  finance: [3],
  board: [5, 6],
  conflicted: [1, 8],
  leaderHousehold: [],
  reimburseeSetter: null,
  seatedHouseholds: [],
  needsBoardAuthorization: false,
};
const seats = (...s: Array<[FilledSeat["seat"], number]>): FilledSeat[] => s.map(([seat, signerUserId]) => ({ seat, signerUserId }));

describe("independence", () => {
  it("one person cannot fill two seats on a line", () => {
    expect(signoffRefusal({ ...base, finance: [2] }, seats(["PROGRAM_APPROVER", 2]), "TREASURER", 2)).toMatch(/another seat/);
  });

  it("a signer in the reimbursee's household is refused for every seat but the submitter's own", () => {
    const facts = { ...base, approvers: [8], finance: [8], board: [8] };
    for (const seat of ["PROGRAM_APPROVER", "TREASURER"] as const) expect(signoffRefusal(facts, [], seat, 8)).toMatch(/household/);
    expect(signoffRefusal(base, [], "SUBMITTER", 8)).toMatch(/only the submitter/);
    expect(signoffRefusal(base, [], "SUBMITTER", 1)).toBeNull();
  });

  it("a seat is filled once", () => {
    expect(signoffRefusal(base, seats(["TREASURER", 3]), "TREASURER", 5)).toMatch(/already filled/);
  });

  it("while an eligible signer is available, a Board member cannot take the seat", () => {
    expect(signoffRefusal(base, [], "TREASURER", 5)).toMatch(/FINANCE/);
    expect(signoffRefusal(base, [], "PROGRAM_APPROVER", 5)).toMatch(/not an approver/);
  });
});

describe("one seat per household on an expense", () => {
  // 3 holds FINANCE; 2, the program leader, is 3's spouse.
  const spouses = { ...base, seatedHouseholds: [2] };

  it("a FINANCE holder's spouse cannot take the program-approver seat after the FINANCE holder signed", () => {
    expect(signoffRefusal(spouses, seats(["TREASURER", 3]), "PROGRAM_APPROVER", 2)).toMatch(/household already holds a seat/);
  });

  it("the household check spans the expense, not just the line", () => {
    expect(signoffRefusal(spouses, [], "PROGRAM_APPROVER", 2)).toMatch(/household already holds a seat/);
  });

  it("a Board member whose household already holds a seat cannot substitute", () => {
    const facts = { ...base, approvers: [], seatedHouseholds: [5] };
    expect(signoffRefusal(facts, seats(["TREASURER", 3]), "PROGRAM_APPROVER", 5)).toMatch(/household already holds a seat/);
    expect(signoffRefusal(facts, seats(["TREASURER", 3]), "PROGRAM_APPROVER", 6)).toBeNull();
  });

  it("the only approver blocked by household: a Board member takes the seat", () => {
    expect(signoffRefusal(spouses, seats(["TREASURER", 3]), "PROGRAM_APPROVER", 5)).toBeNull();
  });

  it("signers from different households are fine", () => {
    expect(signoffRefusal(base, seats(["TREASURER", 3]), "PROGRAM_APPROVER", 2)).toBeNull();
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

  it("the only FINANCE holder approved as the program leader: a Board member takes the Treasurer seat", () => {
    const facts = { ...base, approvers: [3] };
    const filled = seats(["PROGRAM_APPROVER", 3]);
    expect(signoffRefusal(facts, filled, "TREASURER", 5)).toBeNull();
  });

  it("both seats unfillable on a reimbursement: two Board members", () => {
    const facts = { ...base, approvers: [8], conflicted: [1, 8, 3] };
    const filled = seats(["SUBMITTER", 1], ["PROGRAM_APPROVER", 5]);
    expect(signoffRefusal(facts, filled, "TREASURER", 6)).toBeNull();
    expect(missingSeats(facts, [...filled, ...seats(["TREASURER", 6])])).toEqual([]);
  });

  it("a card charge needing two substitutions takes one, then the line is blocked", () => {
    const facts: SignoffFacts = { ...base, kind: "card_charge", approvers: [8], conflicted: [1, 8, 3] };
    expect(blockedSeats(facts, [])).toEqual(["TREASURER"]);
    const filled = seats(["PROGRAM_APPROVER", 5]);
    expect(signoffRefusal(facts, filled, "TREASURER", 6)).toMatch(/no Board substitution left/);
    expect(blockedSeats(facts, filled)).toEqual(["TREASURER"]);
  });

  it("a program bucket with no available approver takes a Board member", () => {
    expect(signoffRefusal({ ...base, approvers: [] }, [], "PROGRAM_APPROVER", 5)).toBeNull();
  });

  it("an org-level bucket always takes a Board member, never the Treasurer-seat signer", () => {
    const facts = { ...base, orgLevel: true, finance: [3, 5] };
    expect(signoffRefusal(facts, [], "PROGRAM_APPROVER", 2)).toMatch(/not a Board member/);
    expect(signoffRefusal(facts, seats(["TREASURER", 5]), "PROGRAM_APPROVER", 5)).toMatch(/another seat/);
    expect(signoffRefusal(facts, seats(["TREASURER", 5]), "PROGRAM_APPROVER", 6)).toBeNull();
  });
});

describe("the Program Leader's household and the Treasurer seat", () => {
  // 2 leads the program; 4 is 2's spouse and holds FINANCE alongside 3.
  const led = { ...base, finance: [3, 4], leaderHousehold: [2, 4] };

  it("a FINANCE holder in the leader's household cannot fill the Treasurer seat; another FINANCE holder can", () => {
    expect(signoffRefusal(led, [], "TREASURER", 4)).toMatch(/Program Leader/);
    expect(signoffRefusal(led, [], "TREASURER", 3)).toBeNull();
  });

  it("the leader holding FINANCE cannot fill the Treasurer seat even when a treasurer approved the line", () => {
    const facts = { ...base, approvers: [2, 7], finance: [2], board: [5, 6], leaderHousehold: [2] };
    const filled = seats(["PROGRAM_APPROVER", 7]);
    expect(signoffRefusal(facts, filled, "TREASURER", 2)).toMatch(/Program Leader/);
    expect(signoffRefusal(facts, filled, "TREASURER", 5)).toBeNull();
  });

  it("every FINANCE holder in the leader's household: a non-conflicted Board member replaces them", () => {
    const facts = { ...led, finance: [4] };
    expect(signoffRefusal(facts, [], "TREASURER", 5)).toBeNull();
  });

  it("a Board member in the leader's household cannot replace the Treasurer", () => {
    const facts = { ...led, finance: [4], board: [4, 5] };
    expect(signoffRefusal(facts, [], "TREASURER", 4)).toMatch(/Program Leader/);
    expect(signoffRefusal(facts, [], "TREASURER", 5)).toBeNull();
  });

  it("the leader's household still fills the program-approver seat", () => {
    expect(signoffRefusal(led, [], "PROGRAM_APPROVER", 2)).toBeNull();
  });

  it("the FINANCE holder who signed as program treasurer cannot also fill the Treasurer seat", () => {
    const facts = { ...base, approvers: [3], finance: [3, 4] };
    expect(signoffRefusal(facts, seats(["PROGRAM_APPROVER", 3]), "TREASURER", 3)).toMatch(/another seat/);
    expect(signoffRefusal(facts, seats(["PROGRAM_APPROVER", 3]), "TREASURER", 4)).toBeNull();
  });
});

describe("boardFillsProgramSeat", () => {
  it("a member reimbursee in a program bucket keeps the normal seats", () => {
    expect(boardFillsProgramSeat(base)).toBe(false);
    expect(signoffRefusal(base, [], "PROGRAM_APPROVER", 2)).toBeNull();
  });

  it("a non-member reimbursee takes a Board member in the program seat; the Treasurer still signs", () => {
    const facts = { ...base, reimburseeIsMember: false };
    expect(signoffRefusal(facts, [], "PROGRAM_APPROVER", 2)).toMatch(/not a Board member/);
    expect(signoffRefusal(facts, [], "PROGRAM_APPROVER", 5)).toBeNull();
    expect(missingSeats(facts, seats(["SUBMITTER", 1], ["PROGRAM_APPROVER", 5]))).toEqual(["TREASURER"]);
  });

  it("a card charge keeps the program approver whatever the membership fact", () => {
    expect(boardFillsProgramSeat({ ...base, kind: "card_charge", reimburseeIsMember: false })).toBe(false);
  });
});

describe("missingSeats", () => {
  it("a line is held until submitter, program approver and Treasurer have all signed", () => {
    expect(missingSeats(base, seats(["SUBMITTER", 1], ["PROGRAM_APPROVER", 2]))).toEqual(["TREASURER"]);
    expect(missingSeats(base, seats(["SUBMITTER", 1], ["PROGRAM_APPROVER", 2], ["TREASURER", 3]))).toEqual([]);
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

  it("may still fill the program-approver seat", () => {
    expect(signoffRefusal({ ...base, approvers: [3], reimburseeSetter: 3 }, [], "PROGRAM_APPROVER", 3)).toBeNull();
  });
});
