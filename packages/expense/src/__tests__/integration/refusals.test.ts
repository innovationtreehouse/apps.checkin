/** X5 and the capital send, driven by their refusals fixtures: each payload gets the answer, status and message the fixture names. */
import { expect, it } from "vitest";
import { kindOf, toHttpError } from "@checkin/component-kit";
import { refusals, type RefusalCase, type RefusalExpectation, type Refusals } from "@checkin/receipt-contract-fixtures";
import { describeDb } from "../helpers/db";
import { ORG } from "../helpers/seed";
import { receiveCompletedReceipt } from "../../services/intakeService";
import type { DonatedCapitalLine } from "@checkin/receipt-types";
import { submitDonatedLines } from "../../services/donatedCapitalService";

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
    for (const c of fixture.cases) {
      it(`${c.expect}: ${c.name}`, async () => {
        if (c.afterBase) await send(fixture.base);
        expectAnswer(await answer(() => send(c.payload)), c);
      });
    }
  });
}

contract(refusals("X5", { orgId: ORG }), receiveCompletedReceipt);
contract(refusals<{ orgId: string; lines: DonatedCapitalLine[] }>("capital-send", { orgId: ORG }), (p) => submitDonatedLines(p.orgId, p.lines));
