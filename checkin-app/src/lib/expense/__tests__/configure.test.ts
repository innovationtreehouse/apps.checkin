import type { SignoffDirectory } from "@inventory/expense";

const personRoleFindMany = jest.fn();
const budgetOwnerFindUnique = jest.fn();
const budgetOwnerFindMany = jest.fn();
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    personRole: { findMany: personRoleFindMany },
    budgetOwner: { findUnique: budgetOwnerFindUnique, findMany: budgetOwnerFindMany },
  },
}));

// The library's root entry pulls in its generated Prisma client, which the jest env does not build.
const configureExpense = jest.fn<void, [{ signoff: SignoffDirectory }]>();
jest.mock("@inventory/expense", () => ({ configureExpense }));
jest.mock("@/lib/catalog/configure", () => ({ getOrg: jest.fn() }));

const NOT_DENIED = { NOT: { household: { orgMembership: { status: "DENIED" } } } };

async function signoff(): Promise<SignoffDirectory> {
  await jest.isolateModulesAsync(async () => {
    (await import("../configure")).configureRuntime();
  });
  return configureExpense.mock.calls.at(-1)![0].signoff;
}

beforeEach(() => jest.clearAllMocks());

describe("expense signer directory excludes people in a DENIED household", () => {
  it("FINANCE and BOARD holders", async () => {
    personRoleFindMany.mockResolvedValue([{ personId: 4 }]);
    const dir = await signoff();

    await expect(dir.financeHolders()).resolves.toEqual([4]);
    await dir.boardMembers();

    for (const [{ where }] of personRoleFindMany.mock.calls) {
      expect(where.person).toEqual({ mergedIntoId: null, ...NOT_DENIED });
    }
  });

  it("a bucket's lead mentor and treasurers", async () => {
    budgetOwnerFindUnique.mockResolvedValue({
      programId: 1,
      program: {
        leadMentor: { id: 7, mergedIntoId: null, household: { orgMembership: { status: "DENIED" } } },
        volunteers: [{ personId: 8 }],
      },
    });
    const dir = await signoff();

    await expect(dir.bucketApprovers(100)).resolves.toEqual({ orgLevel: false, approvers: [8] });
    expect(budgetOwnerFindUnique.mock.calls[0][0].select.program.select.volunteers.where.person).toEqual({ mergedIntoId: null, ...NOT_DENIED });
  });

  it("the buckets a person approves", async () => {
    budgetOwnerFindMany.mockResolvedValue([]);
    const dir = await signoff();

    await dir.bucketsApprovedBy(7);

    const [lead, treasurer] = budgetOwnerFindMany.mock.calls[0][0].where.program.OR;
    expect(lead.leadMentor).toEqual({ mergedIntoId: null, ...NOT_DENIED });
    expect(treasurer.volunteers.some.person).toEqual({ mergedIntoId: null, ...NOT_DENIED });
  });
});
