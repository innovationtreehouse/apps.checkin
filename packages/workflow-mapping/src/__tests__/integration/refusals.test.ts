/** S1, driven by its refusals fixture: each payload gets the answer the fixture names. */
import { beforeEach, expect, it } from "vitest";
import { kindOf } from "@checkin/component-kit";
import { refusals, type RefusalExpectation } from "@checkin/receipt-contract-fixtures";
import type { CompletedReceipt } from "@checkin/receipt-types";
import { ingestReceipt } from "../../services/receiptIntakeService";
import { describeDb } from "../helpers/db";
import { TEST_ORG_ID, clearAll, configure } from "../helpers/setup";

const KIND: Record<RefusalExpectation, string> = { accepted: "accepted", refused: "data", bug: "bug" };

async function answer(send: () => Promise<unknown>): Promise<string> {
  try {
    await send();
    return "accepted";
  } catch (err) {
    return kindOf(err);
  }
}

const s1 = refusals<CompletedReceipt>("S1", { orgId: TEST_ORG_ID });

describeDb(`S1 — ${s1.callee}`, () => {
  beforeEach(async () => {
    await clearAll();
    configure();
  });

  for (const c of s1.cases) {
    it(`${c.expect}: ${c.name}`, async () => {
      if (c.afterBase) await ingestReceipt(s1.base);
      expect(await answer(() => ingestReceipt(c.payload))).toBe(KIND[c.expect]);
    });
  }
});
