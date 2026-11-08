/** X5 and the capital send, driven by their refusals fixtures: each payload gets the answer the fixture names. */
import { expect, it } from "vitest";
import { kindOf } from "@checkin/component-kit";
import { refusals, type RefusalExpectation, type Refusals } from "@checkin/receipt-contract-fixtures";
import { describeDb } from "../helpers/db";
import { ORG } from "../helpers/seed";
import { receiveCompletedReceipt } from "../../services/intakeService";
import { submitDonatedLines, type DonatedLine } from "../../services/donatedCapitalService";

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
    for (const c of fixture.cases) {
      it(`${c.expect}: ${c.name}`, async () => {
        if (c.afterBase) await send(fixture.base);
        expect(await answer(() => send(c.payload))).toBe(KIND[c.expect]);
      });
    }
  });
}

contract(refusals("X5", { orgId: ORG }), receiveCompletedReceipt);
contract(refusals<{ orgId: string; lines: DonatedLine[] }>("capital-send", { orgId: ORG }), (p) => submitDonatedLines(p.orgId, p.lines));
