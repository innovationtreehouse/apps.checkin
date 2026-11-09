import { beforeEach, describe, expect, it } from "vitest";
import { kindOf } from "@checkin/component-kit";
import {
  inertCatalogEventSource,
  inertCatalogReader,
  inertCatalogSubmissions,
  inertDonationSink,
  inertExpenseSink,
  inertInventorySink,
} from "../../contract";
import { callerId, requireActor } from "../../runtime";
import { configure } from "../helpers/setup";

describe("actor ids come only from an integer principal id", () => {
  beforeEach(() => configure());

  it("callerId returns an integer id", () => {
    expect(callerId({ id: 12 })).toBe(12);
  });

  it.each([undefined, null, "12", 1.5, Number.NaN])("callerId throws on %s", (id) => {
    expect(() => callerId({ id })).toThrow();
  });

  it("requireActor is 401 with no principal", async () => {
    configure({ principal: null });
    await expect(requireActor()).rejects.toMatchObject({ status: 401 });
  });

  it.each([Number.NaN, 1.5])("requireActor is 401 for a principal whose id is %s", async (id) => {
    configure({ principal: { id, name: "ghost" } });
    await expect(requireActor()).rejects.toMatchObject({ status: 401 });
  });
});

describe("inert catalog reader", () => {
  it("an unbound catalog match says it is not wired, never \"no match\"", async () => {
    const err = await inertCatalogReader.lookupItems("Acme", [{ index: 0, partNumber: "P1" }]).catch((e: unknown) => e);
    expect(kindOf(err)).toBe("settings");
  });
});

/** The failure kind of calling an inert port with no arguments: the stand-ins ignore them. */
async function kindOfUnboundCall(port: unknown): Promise<string> {
  if (typeof port !== "function") throw new Error("not a port method");
  return kindOf(await Promise.resolve().then(() => Reflect.apply(port, undefined, [])).catch((err: unknown) => err));
}

describe("inert ports", () => {
  it.each([
    ["CatalogReader.checkReferences", inertCatalogReader.checkReferences],
    ["CatalogReader.getActiveItem", inertCatalogReader.getActiveItem],
    ["CatalogSubmissions.proposeItemReference", inertCatalogSubmissions.proposeItemReference],
    ["CatalogSubmissions.reportConflict", inertCatalogSubmissions.reportConflict],
    ["CatalogSubmissions.allocateProvisionalGtin", inertCatalogSubmissions.allocateProvisionalGtin],
    ["CatalogSubmissions.proposeProvisionalItem", inertCatalogSubmissions.proposeProvisionalItem],
    ["ExpenseSink.pushReceipt", inertExpenseSink.pushReceipt],
    ["DonationSink.ingestInKind", inertDonationSink.ingestInKind],
    ["InventorySink.applyDelta", inertInventorySink.applyDelta],
    ["CatalogEventSource.eventsSince", inertCatalogEventSource.eventsSince],
  ])("unbound %s says it is not wired, never a bug or an empty answer", async (_name, port) => {
    expect(await kindOfUnboundCall(port)).toBe("settings");
  });
});
