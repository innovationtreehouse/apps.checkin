import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { Prisma } from "../../generated/prisma/client";
import { pushReceipt, runFullFlow } from "../../lib/receipt-flow";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, FINANCE, actAs, clearAll, configure, manualDetails, recordingPorts, stateOf, textFile } from "../helpers/setup";

let ports: ReturnType<typeof recordingPorts>;

beforeEach(async () => {
  await clearAll();
  ports = recordingPorts();
  configure({ receiptSink: ports.receiptSink });
  actAs(ALICE);
});

/** ALICE's balanced receipt, never delivered, moved straight to `state`. */
async function receiptIn(state: string, detail: Prisma.ReceiptDetailUncheckedUpdateInput = {}): Promise<string> {
  const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
  await db.receipt.update({ where: { id: r.id }, data: { pushedAt: null } });
  await db.receiptDetail.update({ where: { id: r.id }, data: { state, ...detail } });
  ports.calls.pushes.length = 0;
  return r.id;
}

const setState = (id: string, state: string) => Prisma.sql`UPDATE receipt_details SET state = ${state} WHERE id = ${id}`;

/** Resolves once another session waits on a lock, or once `settled` is true. */
async function untilBlocked(settled: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !settled(); i++) {
    const [{ n }] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!settled()) throw new Error("the action never waited on the held write");
}

/**
 * Runs `action` while another transaction holds `statements` uncommitted, and commits them once
 * `action` waits on their locks: the competing write lands between the action's read and its write.
 */
async function racing<T>(statements: Prisma.Sql[], action: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let held!: () => void;
  const isHeld = new Promise<void>((r) => (held = r));
  const holder = db.$transaction(
    async (tx) => {
      for (const s of statements) await tx.$executeRaw(s);
      held();
      await released;
    },
    { timeout: 20_000 },
  );
  await isHeld;
  let settled = false;
  const result = Promise.allSettled([action()]).then(([r]) => ((settled = true), r));
  try {
    await untilBlocked(() => settled);
  } finally {
    release();
    await holder;
  }
  return result;
}

describeDb("a state change racing the receipt flow", () => {
  it("a discard that commits while the flow finalizes stands: nothing is finalized or delivered", async () => {
    const id = await receiptIn("uploaded", { reviewedAt: new Date() });
    const result = await racing([setState(id, "discarded")], () => runFullFlow(id, null));
    expect(result.status).toBe("fulfilled");
    expect(await stateOf(id)).toBe("discarded");
    expect(ports.calls.pushes).toHaveLength(0);
  });

  it("a reject that commits while the flow moves the receipt on stands", async () => {
    const id = await receiptIn("uploaded");
    await racing([setState(id, "rejected")], () => runFullFlow(id, null));
    expect(await stateOf(id)).toBe("rejected");
  });

  it("the flow leaves a receipt discarded before it ran as it is", async () => {
    const id = await receiptIn("discarded");
    await runFullFlow(id, null);
    expect(await stateOf(id)).toBe("discarded");
  });

  it("push delivers only a receipt that is still finalized", async () => {
    const id = await receiptIn("rejected");
    expect(await pushReceipt(id, null)).toBe(false);
    expect(ports.calls.pushes).toHaveLength(0);
  });
});

describeDb("two transitions from one state", () => {
  it("a reject read before a finalize commits answers 409 and the finalize stands", async () => {
    const id = await receiptIn("financial_review");
    actAs(FINANCE);
    const result = await racing([setState(id, "receipt_finalized")], () => receiptService.rejectFinancial(id, "late"));
    expect(result).toMatchObject({ status: "rejected", reason: { status: 409 } });
    expect(await stateOf(id)).toBe("receipt_finalized");
  });

  it("a discard read before a confirm commits answers 409 and the confirm stands", async () => {
    const id = await receiptIn("submitter_review");
    const result = await racing([setState(id, "uploaded")], () => receiptService.discard(id, "submitter"));
    expect(result).toMatchObject({ status: "rejected", reason: { status: 409 } });
    expect(await stateOf(id)).toBe("uploaded");
  });
});

describeDb("an edit racing the freeze", () => {
  const lineOf = async (id: string) => db.receiptLineItem.findFirstOrThrow({ where: { receiptId: id } });
  const snapshot = async (id: string) => ({
    detail: await db.receiptDetail.findUniqueOrThrow({ where: { id } }),
    receipt: await db.receipt.findUniqueOrThrow({ where: { id }, omit: { fileBlob: true } }),
    lines: await db.receiptLineItem.findMany({ where: { receiptId: id }, orderBy: { id: "asc" } }),
  });

  const cases: Array<[string, (id: string) => Prisma.Sql[], (id: string) => Promise<unknown>]> = [
    ["edit", () => [], (id) => receiptService.edit(id, "submitter", { tax: 1 })],
    ["addLine", () => [Prisma.sql`LOCK TABLE receipt_line_items IN SHARE MODE`], (id) => receiptService.addLine(id, "submitter", { description: "Washer", quantity: 1, unitPrice: 5 })],
    [
      "editLine",
      (id) => [Prisma.sql`UPDATE receipt_line_items SET description = description WHERE receipt_id = ${id}`],
      async (id) => receiptService.editLine(id, "submitter", (await lineOf(id)).id, { unitPrice: 1 }),
    ],
    [
      "deleteLine",
      (id) => [Prisma.sql`UPDATE receipt_line_items SET description = description WHERE receipt_id = ${id}`],
      async (id) => receiptService.deleteLine(id, "submitter", (await lineOf(id)).id),
    ],
    [
      "setReimbursement",
      (id) => [Prisma.sql`UPDATE receipts SET needs_reimbursement = needs_reimbursement WHERE id = ${id}`],
      (id) => receiptService.setReimbursement(id, { needsReimbursement: true }),
    ],
  ];

  const freezes = [
    ["confirm", "uploaded"],
    ["finalize", "receipt_finalized"],
  ] as const;
  const raced = cases.flatMap(([name, locks, action]) => freezes.map(([freeze, state]) => [name, freeze, state, locks, action] as const));

  it.each(raced)("%s read before a %s commits is refused and changes nothing", async (_name, _freeze, frozen, locks, action) => {
    const id = await receiptIn("submitter_review");
    await lineOf(id);
    const before = await snapshot(id);
    const result = await racing([setState(id, frozen), ...locks(id)], () => action(id));
    expect(result).toMatchObject({ status: "rejected", reason: { status: 400 } });
    const after = await snapshot(id);
    expect(after.lines).toEqual(before.lines);
    expect({ ...after.detail, state: "submitter_review" }).toEqual(before.detail);
    expect(after.receipt).toEqual(before.receipt);
  });
});
