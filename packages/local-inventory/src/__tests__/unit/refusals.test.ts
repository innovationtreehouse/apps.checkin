/** X4 and the gift load, driven by their refusals fixtures: each payload gets the answer the fixture names. */
import { expect, it } from "vitest";
import { kindOf } from "@checkin/component-kit";
import { refusals, type RefusalExpectation, type Refusals } from "@checkin/receipt-contract-fixtures";
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

async function answer(send: () => Promise<unknown>): Promise<string> {
  try {
    await send();
    return "accepted";
  } catch (err) {
    return kindOf(err);
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
        expect(await answer(() => send(c.payload))).toBe(KIND[c.expect]);
      });
    }
  });
}

type Delta = { orgId: string; receiptId: string; retailer?: string; lineItems: ApplyLineItem[] };
type Load = { orgId: string; donationId: string; lineItems: DonationLineItem[] };

contract(refusals<Delta>("X4", { orgId: TEST_ORG_ID }), (p) => receiptService().applyReceipt(p.orgId, p.receiptId, p.retailer, p.lineItems));
contract(refusals<Load>("gift-load", { orgId: TEST_ORG_ID }), (p) => receiptService().applyDonation(p.orgId, p.donationId, p.lineItems));
