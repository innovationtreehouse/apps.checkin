/** The caller's acts on an expense line and what it waits on otherwise, pure — no database. */
import { describe, it, expect } from "vitest";
import { lineActions, mayRecordBoardAuthorization, signatureTab, type LineActionsInput } from "../../lib/line-actions";
import { lineHolds } from "../../lib/signoff-facts";
import type { FilledSeat, SignoffFacts } from "../../lib/signoff";

// 1 submitter, reimbursed · 2 bucket owner · 3 FINANCE · 5,6 Board · 8 submitter's spouse.
// A reimbursement's lines start with the reimbursee's confirmation signed, unless a case says otherwise.
const base: SignoffFacts = {
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
  ownerHousehold: [2],
  reimburseeSetter: null,
  seatedHouseholds: [],
  boardSeat: false,
  conflictedFinal: false,
  approved: false,
  approver: null,
  expenseSigners: [],
};

interface Case {
  caller: number;
  isFinance?: boolean;
  facts?: Partial<SignoffFacts>;
  filled?: FilledSeat[];
  state?: string;
  backfill?: boolean;
  reimburseeUnknown?: boolean;
  approval?: { status: string; ownerId: number | null; bucketFinal?: boolean } | null;
  /** Who approved the line when its approval is `approved`; the bucket owner unless given. */
  approver?: number;
  boardApproval?: boolean;
}

const APPROVED = { state: "qb_pending", approval: { status: "approved", ownerId: 7 } };

function run(c: Case) {
  const approval = c.approval === undefined ? { status: "pending", ownerId: 7 } : c.approval;
  const approved = approval?.status === "approved";
  const facts = { ...base, approved, approver: approved ? (c.approver ?? 2) : null, reimburseeUnknown: c.reimburseeUnknown ?? false, ...c.facts };
  // A reimbursement's submitter has signed unless a case says otherwise, so its approval may follow.
  const filled = c.filled ?? CONFIRMED;
  const input: LineActionsInput = {
    caller: { id: c.caller, isFinance: c.isFinance ?? facts.finance.includes(c.caller) },
    expense: { state: c.state ?? "owner_approval", backfill: c.backfill ?? false, reimburseeUnknown: c.reimburseeUnknown ?? false },
    approval,
    facts,
    filled,
    holds: lineHolds(c.boardApproval ?? false, facts, filled),
  };
  return lineActions(input);
}

/** Acts as `act` or `act:SEAT`, the main one starred. */
const acts = (c: Case) => run(c).actions.map((a) => `${a.primary ? "*" : ""}${a.act}${a.seat ? `:${a.seat}` : ""}`);
const seats = (...s: Array<[FilledSeat["seat"], number]>): FilledSeat[] => s.map(([seat, signerUserId]) => ({ seat, signerUserId }));
const CONFIRMED = seats(["SUBMITTER", 1]);
const approveOf = (c: Case) => run(c).actions.find((a) => a.act === "approve");

describe("acts per role", () => {
  it("a bucket owner's main act is the approval, the program approver's sign-off; raise exception goes under More", () => {
    expect(acts({ caller: 2 })).toEqual(["*approve", "raise-exception"]);
    expect(approveOf({ caller: 2 })?.noteRequired).toBe(false);
    expect(run({ caller: 2 }).awaiting).toEqual(["Awaiting Treasurer"]);
  });

  it("a reimbursement line waits for its submitter before anyone may approve it", () => {
    expect(acts({ caller: 2, filled: [] })).toEqual(["raise-exception"]);
    expect(acts({ caller: 5, filled: [] })).toEqual([]);
    expect(run({ caller: 2, filled: [] }).awaiting).toEqual(["Awaiting approval", "Awaiting Submitter", "Awaiting Treasurer"]);
    expect(acts({ caller: 2, filled: [], facts: { kind: "card_charge" } })).toEqual(["*approve", "raise-exception"]);
  });

  it("once the line is approved its approver has no act left", () => {
    expect(acts({ caller: 2, ...APPROVED })).toEqual([]);
  });

  it("an approver of the bucket finance moved the line to approves it, or raises another exception", () => {
    expect(acts({ caller: 2, approval: { status: "finance_assigned", ownerId: 7 } })).toEqual(["*approve", "raise-exception"]);
  });

  it("on a line whose bucket finance made final, the approver's only act is Approve", () => {
    const approval = { status: "finance_assigned", ownerId: 7, bucketFinal: true };
    expect(acts({ caller: 2, approval })).toEqual(["*approve"]);
    expect(acts({ caller: 3, approval })).toEqual([]);
    expect(run({ caller: 2, approval }).awaiting).toContain("Finance made this bucket final");
    expect(acts({ caller: 2, approval: { ...approval, status: "pending" } })).toEqual(["*approve"]);
  });

  it("FINANCE outside the bucket has no approve act, and signs as Treasurer only once the line is approved", () => {
    expect(acts({ caller: 3 })).toEqual(["raise-exception"]);
    expect(run({ caller: 3 }).actions.find((a) => a.act === "raise-exception")?.noteRequired).toBe(true);
    expect(run({ caller: 3 }).awaiting).toContain("Awaiting Treasurer");
    expect(acts({ caller: 3, ...APPROVED })).toEqual(["*sign:TREASURER"]);
  });

  it("a Board member may approve in place of the bucket's approvers, under More and with a reason", () => {
    expect(acts({ caller: 5 })).toEqual(["approve"]);
    expect(approveOf({ caller: 5 })?.noteRequired).toBe(true);
  });

  it("a Board stand-in's approval is the main act when no bucket approver can approve", () => {
    expect(acts({ caller: 5, facts: { conflicted: [1, 2, 8] } })).toEqual(["*approve"]);
    expect(run({ caller: 3, facts: { conflicted: [1, 2, 8] } }).awaiting).toContain("Awaiting a Board stand-in");
  });

  describe("a Board stand-in is secondary unless only the Board can act", () => {
    const primaries = (c: Case) => run(c).actions.filter((x) => x.primary);

    it("leaves a line with no main act, so it does not wait on the Board member, while a bucket approver can approve", () => {
      expect(primaries({ caller: 5 })).toEqual([]);
      expect(primaries({ caller: 5, approval: { status: "finance_assigned", ownerId: 7 } })).toEqual([]);
      expect(primaries({ caller: 5, approval: { status: "finance_assigned", ownerId: 7, bucketFinal: true } })).toEqual([]);
      expect(primaries({ caller: 5, facts: { approvers: [2, 4], conflicted: [1, 2, 8] } })).toEqual([]);
    });

    it("is the main act when every bucket approver is conflicted or already seated through their household", () => {
      expect(primaries({ caller: 5, facts: { conflicted: [1, 2, 8] } }).map((x) => x.act)).toEqual(["approve"]);
      expect(primaries({ caller: 5, facts: { seatedHouseholds: [2] } }).map((x) => x.act)).toEqual(["approve"]);
    });

    it("the Board seat stays the Board member's main act", () => {
      const facts = { reimburseeIsMember: false };
      expect(primaries({ caller: 5, facts, ...APPROVED, filled: seats(["TREASURER", 3]) }).map((x) => x.seat)).toEqual(["BOARD"]);
    });
  });

  it("an org-level line takes a Board member's approval, with no reason", () => {
    const orgLevel = { approvers: [], orgLevel: true };
    expect(acts({ caller: 5, facts: orgLevel })).toEqual(["*approve"]);
    expect(approveOf({ caller: 5, facts: orgLevel })?.noteRequired).toBe(false);
    expect(run({ caller: 3, facts: orgLevel }).awaiting).toContain("Awaiting a Board stand-in");
  });

  it("the Board seat is offered only after the approval and the Treasurer", () => {
    const facts = { kind: "card_charge" as const, boardSeat: true };
    expect(acts({ caller: 5, facts, ...APPROVED })).toEqual([]);
    expect(run({ caller: 5, facts, ...APPROVED }).awaiting).toContain("Awaiting Board");
    expect(acts({ caller: 5, facts, ...APPROVED, filled: seats(["TREASURER", 3]) })).toEqual(["*sign:BOARD"]);
  });

  it("a non-member reimbursement waits for its Board signature after the approval", () => {
    const facts = { reimburseeIsMember: false };
    expect(run({ caller: 3, facts }).awaiting).toContain("Board approval after the line is approved");
    expect(acts({ caller: 5, facts, ...APPROVED, filled: seats(["TREASURER", 3]) })).toEqual(["*sign:BOARD"]);
  });

  it("nobody is offered the submitter seat: the person reimbursed signs it by confirming the receipt", () => {
    for (const caller of [1, 2, 3, 5]) expect(acts({ caller, filled: [] })).not.toContain("*sign:SUBMITTER");
    for (const caller of [1, 2, 3, 5]) expect(acts({ caller, filled: [] })).not.toContain("sign:SUBMITTER");
  });

  it("FINANCE settles a raised exception: Assign bucket is the main act, Reject exception goes under More with a required note", () => {
    const { actions } = run({ caller: 3, approval: { status: "exception_raised", ownerId: 7 } });
    expect(actions.map((a) => `${a.primary ? "*" : ""}${a.act}${a.seat ? `:${a.seat}` : ""}`)).toEqual(["*assign-bucket", "reject-exception"]);
    expect(actions.find((a) => a.act === "reject-exception")?.noteRequired).toBe(true);
  });

  it("FINANCE resolves an unknown bucket and assigns an unassigned one", () => {
    expect(acts({ caller: 3, state: "assign_ownership", approval: { status: "unknown", ownerId: null } })).toEqual(["*resolve-bucket"]);
    expect(acts({ caller: 3, state: "assign_ownership", approval: { status: "pending", ownerId: null } })).toEqual(["*assign-bucket"]);
    expect(acts({ caller: 5, state: "assign_ownership", approval: { status: "pending", ownerId: null } })).toEqual([]);
  });

  it("a FINANCE holder who is also a bucket approver approves as an approver", () => {
    const facts = { approvers: [2, 4], finance: [4], ownerHousehold: [2] };
    expect(acts({ caller: 4, facts })).toEqual(["*approve", "raise-exception"]);
    expect(approveOf({ caller: 4, facts })?.noteRequired).toBe(false);
  });

  it("marks at most one main act per line", () => {
    for (const caller of [1, 2, 3, 4, 5, 6]) {
      for (const facts of [{}, { boardSeat: true, kind: "card_charge" as const }, { approvers: [], orgLevel: true }, { approvers: [2, 3] }]) {
        for (const c of [{}, APPROVED, { ...APPROVED, filled: seats(["TREASURER", 3]) }]) {
          expect(run({ caller, facts, ...c }).actions.filter((a) => a.primary).length).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("offers at most one part per line, which is the main act", () => {
    // 4 is a bucket approver, FINANCE and Board at once.
    const everything = { approvers: [2, 4], finance: [3, 4], board: [4, 5, 6] };
    for (const caller of [2, 3, 4, 5]) {
      for (const facts of [everything, { ...everything, boardSeat: true, kind: "card_charge" as const }, { ...everything, approvers: [], orgLevel: true }]) {
        for (const c of [{}, APPROVED, { ...APPROVED, filled: seats(["TREASURER", 3]) }]) {
          expect(run({ caller, facts, ...c }).actions.filter((a) => a.act === "approve" || a.act === "sign").length).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe("acts per conflict", () => {
  it("a conflicted bucket owner is offered no decision", () => {
    expect(acts({ caller: 2, facts: { conflicted: [1, 2, 8] } })).toEqual([]);
  });

  it("FINANCE on their own expense gets no act", () => {
    expect(acts({ caller: 1, isFinance: true, facts: { finance: [1, 3], approvers: [1, 2] }, filled: [] })).toEqual([]);
  });

  it("conflicted FINANCE still chooses a line's bucket, and neither raises nor rejects an exception", () => {
    const facts = { conflicted: [1, 3, 8] };
    expect(acts({ caller: 3, state: "assign_ownership", facts, approval: { status: "unknown", ownerId: null } })).toEqual(["*resolve-bucket"]);
    expect(acts({ caller: 3, state: "assign_ownership", facts, approval: { status: "pending", ownerId: null } })).toEqual(["*assign-bucket"]);
    expect(acts({ caller: 3, facts, approval: { status: "exception_raised", ownerId: 7 } })).toEqual(["*assign-bucket"]);
    expect(acts({ caller: 3, facts })).toEqual([]);
  });

  it("an approver whose household already holds a seat on the expense is offered no approval", () => {
    expect(acts({ caller: 2, facts: { seatedHouseholds: [2] } })).toEqual(["raise-exception"]);
  });

  it("whoever approved the line is offered no seat on it", () => {
    expect(acts({ caller: 2, ...APPROVED, facts: { finance: [2, 3] } })).toEqual([]);
  });

  it("a household already seated on the expense is offered no seat", () => {
    expect(acts({ caller: 3, ...APPROVED, facts: { seatedHouseholds: [3] } })).toEqual([]);
  });

  it("the bucket owner's household and the reimbursee's setter are not offered the Treasurer seat", () => {
    expect(acts({ caller: 3, ...APPROVED, facts: { ownerHousehold: [2, 3] } })).not.toContain("*sign:TREASURER");
    expect(acts({ caller: 3, ...APPROVED, facts: { reimburseeSetter: 3 } })).toEqual([]);
  });

  it("a Board member stands in for the Treasurer only when no FINANCE holder can sign", () => {
    expect(acts({ caller: 5, ...APPROVED, facts: { conflicted: [1, 3, 8] } })).toEqual(["*sign:TREASURER"]);
  });
});

describe("holds", () => {
  it("no seat is offered while the reimbursee is unknown", () => {
    const r = run({ caller: 3, reimburseeUnknown: true, ...APPROVED });
    expect(r.actions).toEqual([]);
    expect(r.awaiting).toContain("Held until finance names the reimbursee");
  });

  it("nothing is approved while the reimbursee is unknown, not even by a Board member", () => {
    for (const caller of [1, 2, 5]) expect(acts({ caller, reimburseeUnknown: true })).not.toContainEqual(expect.stringMatching(/approve|sign/));
    const r = run({ caller: 3, reimburseeUnknown: true });
    expect(r.awaiting).toContain("Held until finance names the reimbursee");
    expect(r.awaiting).not.toContain("Awaiting approval");
  });

  it("nothing is approved before the line has a bucket", () => {
    expect(run({ caller: 2, state: "assign_ownership", approval: { status: "pending", ownerId: null } }).actions).toEqual([]);
  });

  it("the Board's approval of a large purchase is a hold, not an act", () => {
    expect(run({ caller: 5, boardApproval: true }).awaiting).toContain("Held until the Board's approval is recorded");
  });

  it("a line whose bucket conflicted FINANCE made final waits for a Board signature after its approval", () => {
    const final = { approval: { status: "finance_assigned", ownerId: 7, bucketFinal: true }, facts: { conflictedFinal: true } };
    expect(run({ caller: 3, ...final }).awaiting).toContain("Board approval after the line is approved");
    expect(acts({ caller: 5, ...APPROVED, facts: { conflictedFinal: true }, filled: seats(["SUBMITTER", 1], ["TREASURER", 3]) })).toEqual(["*sign:BOARD"]);
  });

  it("a seat nobody can fill shows as held", () => {
    const facts = { kind: "card_charge" as const, boardSeat: true, board: [8] };
    expect(run({ caller: 3, facts }).awaiting).toContain("Held: no one without a conflict can sign");
  });

  it("a backfilled expense takes no act and says why", () => {
    expect(run({ caller: 3, backfill: true, state: "qb_complete" })).toEqual({ actions: [], awaiting: ["Booked before the app; no sign-off"] });
  });

  it("a closed expense takes no act and shows no status", () => {
    expect(run({ caller: 3, state: "rejected" })).toEqual({ actions: [], awaiting: [] });
  });
});

describe("mayRecordBoardAuthorization", () => {
  const expense = { state: "qb_pending", backfill: false, reimburseeUnknown: false, boardAuthorization: null };
  const cardFacts = { ...base, kind: "card_charge" as const, boardSeat: true };
  const may = (callerId: number, over: Partial<Parameters<typeof mayRecordBoardAuthorization>[0]> = {}) =>
    mayRecordBoardAuthorization({ callerId, expense, factsByLine: [cardFacts], boardApprovalNeeded: false, ...over });

  it("FINANCE without a conflict records it; a Board member does not while FINANCE can", () => {
    expect(may(3)).toBe(true);
    expect(may(5)).toBe(false);
    expect(may(2)).toBe(false);
  });

  it("a Board member records it when no FINANCE holder can", () => {
    expect(may(5, { factsByLine: [{ ...cardFacts, conflicted: [1, 3, 8] }] })).toBe(true);
  });

  it("is refused to the conflicted, once recorded, while the reimbursee is unknown, and when nothing needs it", () => {
    expect(may(1, { factsByLine: [{ ...cardFacts, finance: [1] }] })).toBe(false);
    expect(may(3, { expense: { ...expense, boardAuthorization: "Board vote" } })).toBe(false);
    expect(may(3, { expense: { ...expense, reimburseeUnknown: true } })).toBe(false);
    expect(may(3, { factsByLine: [base] })).toBe(false);
    expect(may(3, { factsByLine: [base], boardApprovalNeeded: true })).toBe(true);
  });
});

describe("signatureTab", () => {
  const sign = (seat: "TREASURER" | "BOARD") => ({ act: "sign" as const, seat, primary: true, noteRequired: false });

  it("puts a FINANCE holder's Treasurer seat in To sign", () => {
    expect(signatureTab(base, sign("TREASURER"), 3)).toBe("toSign");
  });

  it("puts the Board seat, and a Board member's Treasurer stand-in, in the Board tab", () => {
    expect(signatureTab(base, sign("BOARD"), 5)).toBe("board");
    expect(signatureTab(base, sign("TREASURER"), 5)).toBe("board");
  });

  it("gives every other act no tab", () => {
    expect(signatureTab(base, { act: "approve", primary: true, noteRequired: false }, 2)).toBeNull();
    expect(signatureTab(base, { act: "sign", seat: "SUBMITTER", primary: true, noteRequired: false }, 1)).toBeNull();
  });

  it("lists a line in a tab only once the function offers its signature, so only after the earlier steps", () => {
    const tabs = (c: Case) => {
      const approved = (c.approval ?? { status: "pending" }).status === "approved";
      const facts = { ...base, approved, approver: approved ? 2 : null, ...c.facts };
      return run(c).actions.map((a) => signatureTab(facts, a, c.caller)).filter((t) => t !== null);
    };
    expect(tabs({ caller: 3 })).toEqual([]);
    expect(tabs({ caller: 3, ...APPROVED })).toEqual(["toSign"]);
    const card = { ...APPROVED, facts: { kind: "card_charge" as const, boardSeat: true } };
    expect(tabs({ caller: 5, ...card })).toEqual([]);
    expect(tabs({ caller: 5, ...card, filled: seats(["TREASURER", 3]) })).toEqual(["board"]);
  });
});
