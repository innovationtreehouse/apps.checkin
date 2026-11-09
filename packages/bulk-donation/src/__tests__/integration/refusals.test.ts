/** X9 and X13, driven by their refusals fixtures: each payload gets the answer, status and message the fixture names. */
import { beforeEach, expect, it } from "vitest";
import { kindOf, toHttpError } from "@checkin/component-kit";
import { refusals, type RefusalCase, type RefusalExpectation, type Refusals } from "@checkin/receipt-contract-fixtures";
import type { CompletedReceipt } from "@checkin/receipt-types";
import type { InKindDonor } from "../../contract";
import { db } from "../../db";
import { ingestInKind, recordInKindDonor } from "../../inKind";
import { describeDb } from "../helpers/db";
import { configureTestRuntime, TEST_ORG_ID } from "../helpers/factories";

const KIND: Record<RefusalExpectation, string> = { accepted: "accepted", refused: "data", bug: "bug" };

type Answer = { kind: string; status?: number; message?: string };

async function answer(send: () => Promise<unknown>): Promise<Answer> {
  try {
    await send();
    return { kind: "accepted" };
  } catch (err) {
    const http = toHttpError(err);
    return { kind: kindOf(err), status: http?.status ?? 500, message: http?.message ?? (err instanceof Error ? err.message : String(err)) };
  }
}

function expectAnswer(got: Answer, c: RefusalCase<unknown>) {
  expect(got.kind).toBe(KIND[c.expect]);
  if (c.refusal) {
    expect(got.status).toBe(c.refusal.status);
    expect(got.message).toContain(c.refusal.message);
  }
}

function contract<P>(fixture: Refusals<P>, send: (payload: P) => Promise<unknown>) {
  describeDb(`${fixture.crossing} — ${fixture.callee}`, () => {
    beforeEach(async () => {
      await db.workflowEvent.deleteMany({});
      await db.inKindDonation.deleteMany({});
      await db.inKindSyncMark.deleteMany({});
      configureTestRuntime();
    });

    for (const c of fixture.cases) {
      it(`${c.expect}: ${c.name}`, async () => {
        if (c.afterBase) await send(fixture.base);
        expectAnswer(await answer(() => send(c.payload)), c);
      });
    }
  });
}

type Donor = { orgId: string; receiptId: string; donor: InKindDonor; seq: number };

contract(refusals<CompletedReceipt>("X9", { orgId: TEST_ORG_ID }), ingestInKind);
contract(refusals<Donor>("X13", { orgId: TEST_ORG_ID }), (p) => recordInKindDonor(p.orgId, p.receiptId, p.donor, p.seq));
