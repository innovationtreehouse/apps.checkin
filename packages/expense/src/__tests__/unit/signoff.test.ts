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
const base: SignoffFacts = {
  kind: "reimbursement",
  submitterId: 1,
  approvers: [2],
  orgLevel: false,
  totalCents: 4000,
  noteInLieuOfReceipt: false,
  noteInLieuLimitCents: 5000,
  purchaserIsMember: true,
  finance: [3],
  board: [5, 6],
  conflicted: [1, 8],
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

describe("boardFillsProgramSeat — F2 exceptions", () => {
  it("a note in lieu of a receipt under $50 in a program bucket keeps the normal seats", () => {
    const facts = { ...base, noteInLieuOfReceipt: true, totalCents: 4999 };
    expect(boardFillsProgramSeat(facts)).toBe(false);
    expect(signoffRefusal(facts, [], "PROGRAM_APPROVER", 2)).toBeNull();
  });

  it("a note in lieu at $50 or more takes a Board member in the program seat; the Treasurer still signs", () => {
    const facts = { ...base, noteInLieuOfReceipt: true, totalCents: 5000 };
    expect(signoffRefusal(facts, [], "PROGRAM_APPROVER", 2)).toMatch(/not a Board member/);
    expect(signoffRefusal(facts, [], "PROGRAM_APPROVER", 5)).toBeNull();
    expect(missingSeats(facts, seats(["SUBMITTER", 1], ["PROGRAM_APPROVER", 5]))).toEqual(["TREASURER"]);
  });

  it("a non-member purchaser takes a Board member in the program seat", () => {
    const facts = { ...base, purchaserIsMember: false };
    expect(signoffRefusal(facts, [], "PROGRAM_APPROVER", 2)).toMatch(/not a Board member/);
    expect(signoffRefusal(facts, [], "PROGRAM_APPROVER", 5)).toBeNull();
  });
});

describe("missingSeats", () => {
  it("a line is held until submitter, program approver and Treasurer have all signed", () => {
    expect(missingSeats(base, seats(["SUBMITTER", 1], ["PROGRAM_APPROVER", 2]))).toEqual(["TREASURER"]);
    expect(missingSeats(base, seats(["SUBMITTER", 1], ["PROGRAM_APPROVER", 2], ["TREASURER", 3]))).toEqual([]);
  });
});
