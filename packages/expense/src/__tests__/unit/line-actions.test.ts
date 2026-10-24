/** The caller's acts on an expense line and what it waits on otherwise, pure — no database. */
import { describe, it, expect } from "vitest";
import { lineActions, mayRecordBoardAuthorization, type LineActionsInput } from "../../lib/line-actions";
import { lineHolds } from "../../lib/signoff-facts";
import type { FilledSeat, SignoffFacts } from "../../lib/signoff";

// 1 submitter · 2 bucket owner · 3 FINANCE · 4 FINANCE and approver · 5,6 Board · 8 submitter's spouse
const base: SignoffFacts = {
  kind: "reimbursement",
  submitterId: 1,
  approvers: [2],
  orgLevel: false,
  reimburseeIsMember: true,
  finance: [3],
  board: [5, 6],
  conflicted: [1, 8],
  ownerHousehold: [2],
  reimburseeSetter: null,
  seatedHouseholds: [],
  boardSeat: false,
  approved: false,
  approver: null,
};

interface Case {
  caller: number;
  isFinance?: boolean;
  facts?: Partial<SignoffFacts>;
  filled?: FilledSeat[];
  state?: string;
  backfill?: boolean;
  reimburseeUnknown?: boolean;
  approval?: { status: string; ownerId: number | null } | null;
  boardApproval?: boolean;
}

function run(c: Case) {
  const facts: SignoffFacts = { ...base, ...c.facts };
  const filled = c.filled ?? [];
  const input: LineActionsInput = {
    caller: { id: c.caller, isFinance: c.isFinance ?? facts.finance.includes(c.caller) },
    expense: { state: c.state ?? "owner_approval", backfill: c.backfill ?? false, reimburseeUnknown: c.reimburseeUnknown ?? false },
    approval: c.approval === undefined ? { status: "pending", ownerId: 7 } : c.approval,
    facts,
    filled,
    holds: lineHolds(c.boardApproval ?? false, facts, filled),
  };
  return lineActions(input);
}

/** Acts as `act` or `act:SEAT`, the main one starred. */
const acts = (c: Case) => run(c).actions.map((a) => `${a.primary ? "*" : ""}${a.act}${a.seat ? `:${a.seat}` : ""}`);
const seats = (...s: Array<[FilledSeat["seat"], number]>): FilledSeat[] => s.map(([seat, signerUserId]) => ({ seat, signerUserId }));

// The line approved by the bucket owner, as it stands once the Treasurer may sign.
const APPROVED = { state: "qb_pending", approval: { status: "approved", ownerId: 7 }, facts: { approved: true, approver: 2 } } as const;

describe("acts per role", () => {
  it("a bucket owner approves as the main act, with raise exception under More", () => {
    expect(acts({ caller: 2 })).toEqual(["*approve", "raise-exception"]);
    const approve = run({ caller: 2 }).actions.find((a) => a.act === "approve")!;
    expect(approve.noteRequired).toBe(false);
    expect(approve.standIn).toBeUndefined();
    expect(run({ caller: 2 }).awaiting).toEqual(["Awaiting Submitter", "Awaiting Treasurer"]);
  });

  it("FINANCE outside the bucket has no approve act, only raise exception", () => {
    expect(acts({ caller: 3 })).toEqual(["raise-exception"]);
    expect(run({ caller: 3 }).actions[0].noteRequired).toBe(true);
  });

  it("FINANCE signs the Treasurer seat once the line is approved", () => {
    expect(acts({ caller: 3, ...APPROVED })).toEqual(["*sign:TREASURER"]);
  });

  it("a Board member may approve in place of the approvers, with a reason, under More while an approver can act", () => {
    expect(acts({ caller: 5 })).toEqual(["approve"]);
    const approve = run({ caller: 5 }).actions[0];
    expect(approve).toMatchObject({ standIn: true, noteRequired: true });
    expect(run({ caller: 5 }).awaiting).toEqual(["Awaiting Submitter", "Awaiting Treasurer"]);
  });

  it("a Board member's approval is the main act when no bucket approver can approve", () => {
    expect(acts({ caller: 5, facts: { conflicted: [1, 2, 8] } })).toEqual(["*approve"]);
  });

  it("a Board member approves an org-level line as the main act, giving no reason", () => {
    const orgLevel = { approvers: [], orgLevel: true };
    expect(acts({ caller: 5, facts: orgLevel })).toEqual(["*approve"]);
    expect(run({ caller: 5, facts: orgLevel }).actions[0]).toMatchObject({ standIn: true, noteRequired: false });
    expect(run({ caller: 3, facts: orgLevel }).awaiting).toContain("Awaiting approval");
  });

  it("a Board member signs the Board seat after the Treasurer", () => {
    const card = { ...APPROVED, facts: { ...APPROVED.facts, kind: "card_charge" as const, boardSeat: true } };
    expect(acts({ caller: 5, ...card, filled: seats(["TREASURER", 3]) })).toEqual(["*sign:BOARD"]);
  });

  it("only the submitter is offered the submitter seat", () => {
    expect(acts({ caller: 1 })).toEqual(["*sign:SUBMITTER"]);
    for (const caller of [2, 3, 5]) expect(acts({ caller })).not.toContain("sign:SUBMITTER");
  });

  it("FINANCE settles a raised exception: Assign bucket is the main act, Reject exception goes under More with a required note", () => {
    const { actions } = run({ caller: 3, approval: { status: "exception_raised", ownerId: 7 } });
    expect(actions.map((a) => `${a.primary ? "*" : ""}${a.act}`)).toEqual(["*assign-bucket", "reject-exception"]);
    expect(actions.find((a) => a.act === "reject-exception")?.noteRequired).toBe(true);
  });

  it("FINANCE resolves an unknown bucket and assigns an unassigned one", () => {
    expect(acts({ caller: 3, state: "assign_ownership", approval: { status: "unknown", ownerId: null } })).toEqual(["*resolve-bucket"]);
    expect(acts({ caller: 3, state: "assign_ownership", facts: { conflicted: [1, 3, 8] }, approval: { status: "unknown", ownerId: null } })).toEqual([]);
    expect(acts({ caller: 3, state: "assign_ownership", approval: { status: "pending", ownerId: null } })).toEqual(["*assign-bucket"]);
    expect(acts({ caller: 5, state: "assign_ownership", approval: { status: "pending", ownerId: null } })).toEqual([]);
  });

  it("a line finance moved to a new bucket waits for that bucket's approver", () => {
    expect(acts({ caller: 2, approval: { status: "finance_assigned", ownerId: 7 } })).toEqual(["*approve"]);
  });

  it("a FINANCE holder who is also a bucket approver approves, then signs as Treasurer only if someone else approved", () => {
    const facts = { approvers: [2, 4], finance: [4], ownerHousehold: [2] };
    expect(acts({ caller: 4, facts })).toEqual(["*approve", "raise-exception"]);
    expect(acts({ caller: 4, ...APPROVED, facts: { ...facts, ...APPROVED.facts } })).toEqual(["*sign:TREASURER"]);
    expect(acts({ caller: 4, ...APPROVED, facts: { ...facts, approved: true, approver: 4 } })).toEqual([]);
  });

  it("marks at most one main act per line", () => {
    for (const caller of [1, 2, 3, 4, 5, 6]) {
      for (const facts of [{}, { boardSeat: true, kind: "card_charge" as const }, { approvers: [], orgLevel: true }, { approvers: [2, 3] }]) {
        expect(run({ caller, facts }).actions.filter((a) => a.primary).length).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("acts per conflict", () => {
  it("a conflicted bucket owner is offered no decision", () => {
    expect(acts({ caller: 2, facts: { conflicted: [1, 2, 8] } })).toEqual([]);
    expect(run({ caller: 2, facts: { conflicted: [1, 2, 8] } }).awaiting).toContain("Awaiting approval");
  });

  it("FINANCE on their own expense gets only the submitter seat", () => {
    expect(acts({ caller: 1, isFinance: true, facts: { finance: [1, 3], approvers: [1, 2] } })).toEqual(["*sign:SUBMITTER"]);
  });

  it("whoever approved the line is offered no seat on it", () => {
    expect(acts({ caller: 2, ...APPROVED, facts: { ...APPROVED.facts, finance: [2, 3] } })).toEqual([]);
  });

  it("a household already seated on the expense is offered no seat", () => {
    expect(acts({ caller: 3, ...APPROVED, facts: { ...APPROVED.facts, seatedHouseholds: [3] } })).toEqual([]);
  });

  it("the bucket owner's household and the reimbursee's setter are not offered the Treasurer seat", () => {
    expect(acts({ caller: 3, ...APPROVED, facts: { ...APPROVED.facts, ownerHousehold: [2, 3] } })).not.toContain("*sign:TREASURER");
    expect(acts({ caller: 3, ...APPROVED, facts: { ...APPROVED.facts, reimburseeSetter: 3 } })).toEqual([]);
  });

  it("a Board member stands in for the Treasurer only when no FINANCE holder can sign", () => {
    expect(acts({ caller: 5, ...APPROVED, facts: { ...APPROVED.facts, conflicted: [1, 3, 8] } })).toEqual(["*sign:TREASURER"]);
  });
});

describe("order", () => {
  it("the Treasurer seat is not offered before the line is approved", () => {
    expect(acts({ caller: 3 })).not.toContain("*sign:TREASURER");
    expect(acts({ caller: 3 })).not.toContain("sign:TREASURER");
  });

  it("the Board seat is not offered before the Treasurer signs", () => {
    const card = { ...APPROVED, facts: { ...APPROVED.facts, kind: "card_charge" as const, boardSeat: true } };
    expect(acts({ caller: 5, ...card })).toEqual([]);
    expect(run({ caller: 5, ...card }).awaiting).toContain("Awaiting Treasurer");
  });

  it("a non-member reimbursement shows its Board seat as following the approval", () => {
    expect(run({ caller: 3, facts: { reimburseeIsMember: false } }).awaiting).toContain("Board approval after the line is approved");
  });
});

describe("holds", () => {
  it("no seat is offered while the reimbursee is unknown", () => {
    const r = run({ caller: 3, reimburseeUnknown: true, ...APPROVED });
    expect(r.actions).toEqual([]);
    expect(r.awaiting).toContain("Held until finance names the reimbursee");
  });

  it("no approval is offered before the line has a bucket", () => {
    expect(run({ caller: 2, state: "assign_ownership", approval: { status: "pending", ownerId: null } }).actions).toEqual([]);
  });

  it("the Board's approval of a large purchase is a hold, not an act", () => {
    expect(run({ caller: 5, boardApproval: true }).awaiting).toContain("Held until the Board's approval is recorded");
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
