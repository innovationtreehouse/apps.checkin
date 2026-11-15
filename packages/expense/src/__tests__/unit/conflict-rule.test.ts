/** isConflicted and conflictedExpenses decide the same conflicts — no database. */
import { describe, it, expect, beforeEach } from "vitest";
import { conflictedExpenses, isConflicted } from "../../lib/signoff-facts";
import { bindPorts, directory } from "../helpers/seed";

const SUBMITTER = 1;
const REIMBURSEE = 2;
const HOUSEMATE = 3;
const REIMBURSEE_HOUSEMATE = 4;
const UNRELATED = 5;
const MERGED = 6;
const SURVIVOR = 7;
const SURVIVOR_HOUSEMATE = 8;
const GONE = 9;

const EXPENSES = [
  { id: "own", submitterId: SUBMITTER, reimburseePersonId: null },
  { id: "reimbursed", submitterId: SUBMITTER, reimburseePersonId: REIMBURSEE },
  { id: "unrelated", submitterId: UNRELATED, reimburseePersonId: null },
  { id: "merged", submitterId: MERGED, reimburseePersonId: null },
  { id: "gone-submitter", submitterId: GONE, reimburseePersonId: null },
  { id: "gone-reimbursee", submitterId: UNRELATED, reimburseePersonId: GONE },
];

const PEOPLE = [SUBMITTER, REIMBURSEE, HOUSEMATE, REIMBURSEE_HOUSEMATE, UNRELATED, MERGED, SURVIVOR, SURVIVOR_HOUSEMATE, GONE];

beforeEach(() =>
  bindPorts({
    signoff: directory({
      households: [[SUBMITTER, HOUSEMATE], [REIMBURSEE, REIMBURSEE_HOUSEMATE], [UNRELATED], [MERGED, SURVIVOR, SURVIVOR_HOUSEMATE]],
      merged: { [MERGED]: SURVIVOR },
      unknownPeople: [GONE],
    }),
  }),
);

describe("the conflict rule", () => {
  it.each(PEOPLE)("conflictedExpenses names exactly the expenses isConflicted holds person %i conflicted on", async (personId) => {
    const one = await Promise.all(EXPENSES.map(async (e) => [e.id, await isConflicted(e, personId)] as const));
    const expected = new Set(one.filter(([, c]) => c).map(([id]) => id));
    expect(await conflictedExpenses(EXPENSES, personId)).toEqual(expected);
  });

  it("holds parties, their households and everyone on an expense naming nobody live", async () => {
    expect(await conflictedExpenses(EXPENSES, HOUSEMATE)).toEqual(new Set(["own", "reimbursed", "gone-submitter", "gone-reimbursee"]));
    expect(await conflictedExpenses(EXPENSES, REIMBURSEE_HOUSEMATE)).toEqual(new Set(["reimbursed", "gone-submitter", "gone-reimbursee"]));
    expect(await conflictedExpenses(EXPENSES, SURVIVOR_HOUSEMATE)).toEqual(new Set(["merged", "gone-submitter", "gone-reimbursee"]));
    expect(await conflictedExpenses(EXPENSES, UNRELATED)).toEqual(new Set(["unrelated", "gone-submitter", "gone-reimbursee"]));
  });

  it("an empty list conflicts nothing", async () => {
    expect(await conflictedExpenses([], SUBMITTER)).toEqual(new Set());
  });
});
