/** X9 and X13, driven by their refusals fixtures: each payload gets the answer the fixture names. */
import { beforeEach, expect, it } from "vitest";
import { kindOf } from "@checkin/component-kit";
import { refusals, type RefusalExpectation, type Refusals } from "@checkin/receipt-contract-fixtures";
import type { CompletedReceipt } from "@checkin/receipt-types";
import type { InKindDonor } from "../../contract";
import { db } from "../../db";
import { ingestInKind, recordInKindDonor } from "../../inKind";
import { describeDb } from "../helpers/db";
import { configureTestRuntime, TEST_ORG_ID } from "../helpers/factories";

const KIND: Record<RefusalExpectation, string> = { accepted: "accepted", refused: "data", bug: "bug" };

async function answer(send: () => Promise<unknown>): Promise<string> {
  try {
    await send();
    return "accepted";
  } catch (err) {
    return kindOf(err);
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
        expect(await answer(() => send(c.payload))).toBe(KIND[c.expect]);
      });
    }
  });
}

type Donor = { orgId: string; receiptId: string; donor: InKindDonor; seq: number };

contract(refusals<CompletedReceipt>("X9", { orgId: TEST_ORG_ID }), ingestInKind);
contract(refusals<Donor>("X13", { orgId: TEST_ORG_ID }), (p) => recordInKindDonor(p.orgId, p.receiptId, p.donor, p.seq));
