/** S1, driven by its refusals fixture: each payload gets the answer, status and message the fixture names. */
import { beforeEach, expect, it } from "vitest";
import { kindOf, toHttpError } from "@checkin/component-kit";
import { refusals, type RefusalCase, type RefusalExpectation } from "@checkin/receipt-contract-fixtures";
import type { CompletedReceipt } from "@checkin/receipt-types";
import { ingestReceipt } from "../../services/receiptIntakeService";
import { describeDb } from "../helpers/db";
import { TEST_ORG_ID, clearAll, configure } from "../helpers/setup";

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

const s1 = refusals<CompletedReceipt>("S1", { orgId: TEST_ORG_ID });

describeDb(`S1 — ${s1.callee}`, () => {
  beforeEach(async () => {
    await clearAll();
    configure();
  });

  for (const c of s1.cases) {
    it(`${c.expect}: ${c.name}`, async () => {
      if (c.afterBase) await ingestReceipt(s1.base);
      expectAnswer(await answer(() => ingestReceipt(c.payload)), c);
    });
  }
});
