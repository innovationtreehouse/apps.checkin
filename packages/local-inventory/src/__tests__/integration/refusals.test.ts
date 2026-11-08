/** X4 and the gift load, driven by their refusals fixtures: each payload gets the answer, status and message the fixture names. */
import { expect, it } from "vitest";
import { kindOf, toHttpError } from "@checkin/component-kit";
import { refusals, type RefusalCase, type RefusalExpectation, type Refusals } from "@checkin/receipt-contract-fixtures";
import { describeDb } from "../helpers/db";
import { db } from "../../lib/db/index";
import { createInventoryRepository } from "../../lib/repositories/inventoryRepository";
import { createProvisionalItemRepository } from "../../lib/repositories/provisionalItemRepository";
import { createProvisionalResolutionRepository } from "../../lib/repositories/provisionalResolutionRepository";
import { createReceiveQueueRepository } from "../../lib/repositories/receiveQueueRepository";
import { createProvisionalItemService } from "../../lib/services/provisionalItemService";
import { createReceiptService, type ApplyLineItem, type DonationLineItem } from "../../lib/services/receiptService";
import { setupIntegrationDb } from "../helpers/setup";
import { TEST_ORG_ID } from "../helpers/seed";

setupIntegrationDb();

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

function receiptService() {
  const inventoryRepo = createInventoryRepository(db);
  return createReceiptService({
    provisionalItemService: createProvisionalItemService({
      provisionalRepo: createProvisionalItemRepository(db),
      resolutionRepo: createProvisionalResolutionRepository(db),
      inventoryRepo,
      db,
    }),
    inventoryRepo,
    receiveQueueRepo: createReceiveQueueRepository(db),
    db,
  });
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

type Delta = { orgId: string; receiptId: string; retailer?: string; lineItems: ApplyLineItem[] };
type Load = { orgId: string; donationId: string; lineItems: DonationLineItem[] };

contract(refusals<Delta>("X4", { orgId: TEST_ORG_ID }), (p) => receiptService().applyReceipt(p.orgId, p.receiptId, p.retailer, p.lineItems));
contract(refusals<Load>("gift-load", { orgId: TEST_ORG_ID }), (p) => receiptService().applyDonation(p.orgId, p.donationId, p.lineItems));
