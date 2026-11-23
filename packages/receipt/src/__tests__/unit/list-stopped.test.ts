import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "../../generated/prisma/client";
import { ports, requireActor } from "../../runtime";
import { receiptRepo, stuckSince } from "../../repositories/receipt";
import { receiptService } from "../../services/receiptService";

const FINANCE = 1;
const UPLOADER = 2;
const REIMBURSEE = 3;
const UPLOADER_HOUSEMATE = 4;
const REIMBURSEE_HOUSEMATE = 5;
const MERGED_AWAY = 6;
const SURVIVOR = 7;
const GONE = 8;

const HOUSEHOLDS = [[UPLOADER, UPLOADER_HOUSEMATE], [REIMBURSEE, REIMBURSEE_HOUSEMATE], [SURVIVOR, MERGED_AWAY]];

interface Row {
  id: string;
  uploadedByUserId: number;
  reimburseePersonId: number | null;
}

let stopped: Row[] = [];

const live = (id: number): number | null => (id === GONE ? null : id === MERGED_AWAY ? SURVIVOR : id);

const fakePorts = {
  personIds: {
    liveIds: vi.fn(async (ids: number[]) => new Map(ids.map((id) => [id, live(id)]))),
    storedIdsOf: vi.fn(async (id: number) => [id]),
  },
  households: {
    householdOf: vi.fn(async (ids: number[]) => HOUSEHOLDS.filter((h) => h.some((m) => ids.includes(m))).flat()),
  },
};

vi.mock("../../runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime")>()),
  getOrgId: vi.fn().mockResolvedValue("org-1"),
  requireActor: vi.fn(),
  ports: vi.fn(),
}));

vi.mock("../../repositories/receipt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../repositories/receipt")>()),
  receiptRepo: { list: vi.fn() },
  stuckSince: vi.fn(async () => new Map()),
}));

function seed(): Row[] {
  return [
    { id: "clear", uploadedByUserId: UPLOADER, reimburseePersonId: REIMBURSEE },
    { id: "clear-no-reimbursee", uploadedByUserId: UPLOADER, reimburseePersonId: null },
    { id: "merged-uploader", uploadedByUserId: MERGED_AWAY, reimburseePersonId: null },
    { id: "merged-reimbursee", uploadedByUserId: UPLOADER, reimburseePersonId: MERGED_AWAY },
    { id: "gone-uploader", uploadedByUserId: GONE, reimburseePersonId: REIMBURSEE },
    { id: "gone-reimbursee", uploadedByUserId: UPLOADER, reimburseePersonId: GONE },
    { id: "finance-uploaded", uploadedByUserId: FINANCE, reimburseePersonId: null },
    { id: "finance-reimbursed", uploadedByUserId: UPLOADER, reimburseePersonId: FINANCE },
  ];
}

/** The stopped read is the one whose where names `pushedAt`; the needs-attention read returns nothing. */
function isStoppedRead(where: Prisma.ReceiptWhereInput): boolean {
  return "pushedAt" in where;
}

function viewAs(id: number) {
  vi.mocked(requireActor).mockResolvedValue({ id } as Awaited<ReturnType<typeof requireActor>>);
}

beforeEach(() => {
  vi.clearAllMocks();
  stopped = seed();
  vi.mocked(ports).mockReturnValue(fakePorts as unknown as ReturnType<typeof ports>);
  // The store answers with live people, as receiptRepo.list does; an id naming nobody live stays stored.
  vi.mocked(receiptRepo.list).mockImplementation(async (where) =>
    (isStoppedRead(where) ? stopped : []).map((r) => ({
      ...r,
      orgId: "org-1",
      state: "receipt_finalized",
      uploadedByUserId: live(r.uploadedByUserId) ?? r.uploadedByUserId,
      reimburseePersonId: r.reimburseePersonId == null ? null : (live(r.reimburseePersonId) ?? r.reimburseePersonId),
    })) as never,
  );
});

async function shownTo(viewer: number): Promise<string[]> {
  viewAs(viewer);
  const rows = await receiptService.listNeedsAttention("finance");
  return rows.map((r) => r.id).sort();
}

describe("listNeedsAttention leaves out the stopped receipts the finance viewer is party to", () => {
  it.each([
    ["a finance viewer, not where they upload or are reimbursed", FINANCE, ["clear", "clear-no-reimbursee", "merged-reimbursee", "merged-uploader"]],
    ["the uploader", UPLOADER, ["finance-uploaded", "merged-uploader"]],
    ["the uploader's housemate", UPLOADER_HOUSEMATE, ["finance-uploaded", "merged-uploader"]],
    ["the reimbursee", REIMBURSEE, ["clear-no-reimbursee", "finance-reimbursed", "finance-uploaded", "merged-reimbursee", "merged-uploader"]],
    ["the reimbursee's housemate", REIMBURSEE_HOUSEMATE, ["clear-no-reimbursee", "finance-reimbursed", "finance-uploaded", "merged-reimbursee", "merged-uploader"]],
    ["the person a party was merged into", SURVIVOR, ["clear", "clear-no-reimbursee", "finance-reimbursed", "finance-uploaded"]],
  ])("%s", async (_who, viewer, expected) => {
    expect(await shownTo(viewer)).toEqual([...expected].sort());
  });

  it("shows no stopped receipt and reads no people when none is stopped", async () => {
    stopped = [];
    expect(await shownTo(FINANCE)).toEqual([]);
    expect(fakePorts.personIds.liveIds).not.toHaveBeenCalled();
    expect(fakePorts.households.householdOf).not.toHaveBeenCalled();
  });
});

describe("listNeedsAttention's reads do not grow with the stopped receipts", () => {
  function reads(): number {
    const portCalls = Object.values(fakePorts).flatMap((port) => Object.values(port)).reduce((n, fn) => n + fn.mock.calls.length, 0);
    return portCalls + vi.mocked(receiptRepo.list).mock.calls.length + vi.mocked(stuckSince).mock.calls.length;
  }

  async function readsWith(extra: number): Promise<number> {
    vi.clearAllMocks();
    stopped = seed();
    for (let i = 0; i < extra; i++) {
      stopped.push(
        { id: `clear-${i}`, uploadedByUserId: UPLOADER, reimburseePersonId: REIMBURSEE },
        { id: `merged-${i}`, uploadedByUserId: MERGED_AWAY, reimburseePersonId: GONE },
      );
    }
    viewAs(FINANCE);
    await receiptService.listNeedsAttention("finance");
    return reads();
  }

  it("makes the same number of reads for 1 extra receipt of each kind as for 40", async () => {
    expect(await readsWith(40)).toBe(await readsWith(1));
  });
});
