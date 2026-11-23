import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "../../generated/prisma/client";
import { ports } from "../../runtime";
import { receiptRepo } from "../../repositories/receipt";
import { receiptService } from "../../services/receiptService";

const FINANCE = 1;
const SYSADMIN = 2;
const MEMBER = 3;
const BOARD = 4;
const NO_ACCOUNT = 5;
const BOARD_HOUSEMATE = 6;
const MERGED_AWAY = 7;
const SURVIVOR = 8;
const UPLOADER = 9;
const GONE = 10;

const HOUSEHOLDS = [[BOARD, BOARD_HOUSEMATE], [SURVIVOR, MERGED_AWAY]];

interface Row {
  id: string;
  orgId: string;
  needsReimbursement: boolean;
  uploadedByUserId: number;
  reimburseePersonId: number | null;
  state: string;
}

let rows: Row[] = [];
let awaiting: Array<{ receiptId: string; reimburseePersonId: number; changedFields: string[] }> = [];
const refusedSeat = new Map<string, number[]>();

const live = (id: number): number | null => (id === GONE ? null : id === MERGED_AWAY ? SURVIVOR : id);

const fakePorts = {
  personIds: {
    liveIds: vi.fn(async (ids: number[]) => new Map(ids.map((id) => [id, live(id)]))),
    storedIdsOf: vi.fn(async (id: number) => (id === SURVIVOR ? [SURVIVOR, MERGED_AWAY] : [id])),
  },
  households: {
    householdOf: vi.fn(async (ids: number[]) => HOUSEHOLDS.filter((h) => h.some((m) => ids.includes(m))).flat()),
  },
  reimbursees: {
    withoutAccount: vi.fn(async (ids: number[]) => ids.filter((id) => id === NO_ACCOUNT || id === GONE)),
  },
  submitterConfirmations: {
    awaiting: vi.fn(async () => awaiting),
    confirmable: vi.fn(async (ids: string[], signer: number) => ids.filter((id) => !(refusedSeat.get(id) ?? []).includes(signer))),
  },
};

vi.mock("../../runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime")>()),
  getOrgId: vi.fn().mockResolvedValue("org-1"),
  ports: vi.fn(),
}));

type IdFilter = number | string | null | { in?: Array<number | string>; notIn?: number[]; not?: null };

function matchesId(value: number | string | null, filter: IdFilter): boolean {
  if (filter === null || typeof filter !== "object") return value === filter;
  if (filter.in && !filter.in.includes(value as number & string)) return false;
  if (filter.notIn && filter.notIn.includes(value as number)) return false;
  if ("not" in filter && value === filter.not) return false;
  return true;
}

/** The where shapes the confirmation reads use; any other key fails the test. */
function matches(row: Row, where: Prisma.ReceiptWhereInput): boolean {
  return Object.entries(where).every(([key, filter]) => {
    switch (key) {
      case "orgId":
      case "needsReimbursement":
        return row[key] === filter;
      case "id":
      case "uploadedByUserId":
      case "reimburseePersonId":
        return matchesId(row[key], filter as IdFilter);
      case "details":
        return row.state === (filter as { state: string }).state;
      default:
        throw new Error(`the fake receipt store reads no "${key}" filter`);
    }
  });
}

vi.mock("../../repositories/receipt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../repositories/receipt")>()),
  receiptRepo: { list: vi.fn(), count: vi.fn(), listLineItems: vi.fn() },
}));

/** A reimbursement waiting in submitter review. */
function inReview(id: string, uploadedByUserId: number, reimburseePersonId: number | null, over: Partial<Row> = {}): Row {
  return { id, orgId: "org-1", needsReimbursement: true, uploadedByUserId, reimburseePersonId, state: "submitter_review", ...over };
}

/** A reimbursement whose expense waits for a confirmation from `onExpense`. */
function sent(id: string, uploadedByUserId: number, onExpense: number): Row {
  awaiting.push({ receiptId: id, reimburseePersonId: onExpense, changedFields: [] });
  return { id, orgId: "org-1", needsReimbursement: true, uploadedByUserId, reimburseePersonId: onExpense, state: "finalized" };
}

function seed(): Row[] {
  return [
    inReview("finance-own", UPLOADER, FINANCE),
    inReview("sysadmin-own", UPLOADER, SYSADMIN),
    inReview("member-own", UPLOADER, MEMBER),
    inReview("member-self-upload", MEMBER, MEMBER),
    inReview("member-no-reimbursement", UPLOADER, MEMBER, { needsReimbursement: false }),
    inReview("member-past-review", UPLOADER, MEMBER, { state: "finance_review" }),
    inReview("member-other-org", UPLOADER, MEMBER, { orgId: "org-2" }),
    inReview("merged-away-own", UPLOADER, MERGED_AWAY),
    inReview("no-account", UPLOADER, NO_ACCOUNT),
    inReview("no-account-board-household", BOARD_HOUSEMATE, NO_ACCOUNT),
    inReview("no-account-board-uploaded", BOARD, NO_ACCOUNT),
    inReview("gone", UPLOADER, GONE),
    sent("finance-sent", UPLOADER, FINANCE),
    sent("merged-away-sent", UPLOADER, MERGED_AWAY),
    sent("no-account-sent", UPLOADER, NO_ACCOUNT),
    sent("no-account-sent-board-refused", UPLOADER, NO_ACCOUNT),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  awaiting = [];
  refusedSeat.clear();
  refusedSeat.set("no-account-sent-board-refused", [BOARD]);
  rows = seed();
  vi.mocked(ports).mockReturnValue(fakePorts as unknown as ReturnType<typeof ports>);
  // The store answers with live people, as receiptRepo.list does.
  vi.mocked(receiptRepo.list).mockImplementation(async (where) =>
    rows.filter((r) => matches(r, where)).map((r) => ({
      ...r,
      uploadedByUserId: live(r.uploadedByUserId) ?? r.uploadedByUserId,
      reimburseePersonId: r.reimburseePersonId == null ? null : (live(r.reimburseePersonId) ?? r.reimburseePersonId),
    })) as never,
  );
  vi.mocked(receiptRepo.count).mockImplementation(async (where) => rows.filter((r) => matches(r, where)).length);
});

describe("countToConfirm counts the reimbursements waiting on the viewer", () => {
  it.each([
    ["a finance holder, in review and once the expense exists", FINANCE, false, 2],
    ["a sysadmin", SYSADMIN, false, 1],
    ["a plain member, not for their own upload or past review", MEMBER, false, 1],
    ["a merged person, under the id merged into them and on the expense", SURVIVOR, false, 2],
    ["a Board member, on behalf of a reimbursee with no account, none they or their household are party to", BOARD, true, 2],
    ["a Board member's housemate who is not on the Board", BOARD_HOUSEMATE, false, 0],
    ["the same Board member read as not on the Board", BOARD, false, 0],
    ["a sysadmin on the Board, their own and every on-behalf one they may sign", SYSADMIN, true, 6],
  ])("%s", async (_who, personId, isBoardMember, expected) => {
    expect(await receiptService.countToConfirm(personId, isBoardMember)).toBe(expected);
  });

  it("counts nothing on behalf of a reimbursee who has an account", async () => {
    rows = [inReview("has-account", UPLOADER, MEMBER)];
    awaiting = [];
    expect(await receiptService.countToConfirm(BOARD, true)).toBe(0);
  });
});

describe("countToConfirm's reads do not grow with the receipts", () => {
  function reads(): number {
    const portCalls = Object.values(fakePorts).flatMap((port) => Object.values(port)).reduce((n, fn) => n + fn.mock.calls.length, 0);
    return portCalls + vi.mocked(receiptRepo.list).mock.calls.length + vi.mocked(receiptRepo.count).mock.calls.length;
  }

  async function readsWith(extra: number): Promise<number> {
    vi.clearAllMocks();
    awaiting = [];
    rows = seed();
    for (let i = 0; i < extra; i++) {
      rows.push(inReview(`board-review-${i}`, UPLOADER, NO_ACCOUNT), inReview(`member-review-${i}`, UPLOADER, MEMBER), sent(`board-sent-${i}`, UPLOADER, NO_ACCOUNT));
    }
    await receiptService.countToConfirm(BOARD, true);
    await receiptService.countToConfirm(MEMBER, false);
    return reads();
  }

  it("makes the same number of reads for 1 extra receipt of each kind as for 40", async () => {
    expect(await readsWith(40)).toBe(await readsWith(1));
  });
});
