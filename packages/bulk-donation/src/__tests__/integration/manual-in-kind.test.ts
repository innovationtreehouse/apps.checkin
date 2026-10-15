/**
 * The no-receipt in-kind entry: ops picks catalog items (X10) with a quantity and value, the
 * donation is stored with its donor, and its goods load into inventory keyed `donation:<id>` (X11).
 */
import { it, expect, beforeEach, vi } from "vitest";
import type { ResolvedInventoryDelta } from "@inventory/receipt-types";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { configureBulkDonation } from "../../runtime";
import { loadInKindInventory, recordInKindWithoutReceipt } from "../../inKind";
import { manualInKindService, type ManualInKindInput } from "../../services/manualInKindService";
import { TEST_ORG_ID } from "../helpers/factories";

const DRILL = "0011111111116";
const BITS = "0022222222223";
const CATALOG = new Map([
  [DRILL, { gtin13: DRILL, name: "Cordless Drill" }],
  [BITS, { gtin13: BITS, name: "Drill Bits" }],
]);

const input: ManualInKindInput = {
  donor: { firstName: "Jane", lastName: "Donor", companyName: "Acme" },
  donationDate: "2026-10-01",
  lines: [
    { gtin13: DRILL, quantity: 2, valueCents: 15000 },
    { gtin13: BITS, quantity: 10, valueCents: 2500 },
  ],
};

let applied: ResolvedInventoryDelta[];
let applyFails: boolean;

beforeEach(async () => {
  await db.workflowEvent.deleteMany({});
  await db.manualInKindDonation.deleteMany({});
  applied = [];
  applyFails = false;
  configureBulkDonation({
    auth: { getPrincipal: async () => ({ id: 1, name: "testops" }) },
    org: async () => ({ id: TEST_ORG_ID, name: "Test Org" }),
    catalog: { search: async () => [...CATALOG.values()], getItem: async (g) => CATALOG.get(g) ?? null },
    inventory: {
      apply: async (delta) => {
        if (applyFails) throw new Error("inventory down");
        applied.push(delta);
      },
    },
  });
});

describeDb("recordInKindWithoutReceipt", () => {
  it("stores the donor and lines, audits without donor fields, and loads goods under donation:<id>", async () => {
    const { id, inventoryLoaded } = await recordInKindWithoutReceipt(input);

    expect(inventoryLoaded).toBe(true);
    const row = await db.manualInKindDonation.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    expect(row).toMatchObject({
      orgId: TEST_ORG_ID,
      donorFirstName: "Jane",
      donorLastName: "Donor",
      donorCompanyName: "Acme",
      donationDate: "2026-10-01",
      recordedByUserId: 1,
      recordedByUsername: "testops",
    });
    expect(row.inventoryLoadedAt).not.toBeNull();
    expect(row.lines.map(({ gtin13, quantity, valueCents }) => ({ gtin13, quantity, valueCents }))).toEqual(input.lines);

    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ receiptId: `donation:${id}`, orgId: TEST_ORG_ID, retailer: null });
    expect(applied[0].lineItems.map((l) => [l.gtin13, l.quantityDelta])).toEqual([
      [DRILL, 2],
      [BITS, 10],
    ]);

    const [event] = await db.workflowEvent.findMany({ where: { orgId: TEST_ORG_ID } });
    expect(event).toMatchObject({ entityType: "manual_in_kind", entityId: String(id), eventType: "MANUAL_IN_KIND_RECORDED", actorUserId: 1 });
    expect(JSON.parse(event.payload ?? "{}")).toEqual({ lineCount: 2, totalValueCents: 17500 });
    for (const donorField of ["Jane", "Donor", "Acme"]) expect(event.payload).not.toContain(donorField);
  });

  it("rejects an item that is not in the catalog, recording nothing", async () => {
    await expect(
      recordInKindWithoutReceipt({ ...input, lines: [{ gtin13: "0099999999999", quantity: 1, valueCents: 100 }] }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await db.manualInKindDonation.count()).toBe(0);
    expect(applied).toHaveLength(0);
  });

  it("keeps the donation when the load fails, and a retry loads it once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    applyFails = true;
    const { id, inventoryLoaded } = await recordInKindWithoutReceipt(input);
    expect(inventoryLoaded).toBe(false);
    expect((await db.manualInKindDonation.findUniqueOrThrow({ where: { id } })).inventoryLoadedAt).toBeNull();

    applyFails = false;
    await loadInKindInventory(id);
    expect(applied.map((d) => d.receiptId)).toEqual([`donation:${id}`]);
    expect((await db.manualInKindDonation.findUniqueOrThrow({ where: { id } })).inventoryLoadedAt).not.toBeNull();
    expect(await db.manualInKindDonation.count()).toBe(1);
  });

  it("does not load another org's donation", async () => {
    const { id } = await recordInKindWithoutReceipt(input);
    await expect(manualInKindService.loadInventory("other-org", id)).rejects.toMatchObject({ statusCode: 404 });
  });
});
