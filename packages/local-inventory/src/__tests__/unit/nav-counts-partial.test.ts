/** One failing nav count leaves the other pills showing. The data layer is mocked; no database. */
import { expect, it, vi } from "vitest";

const { boom } = vi.hoisted(() => ({ boom: new Error("db down") }));
vi.mock("../../lib/db", () => ({
  db: {
    receiveQueue: { count: async () => 4 },
    inventoryMergeConflict: { count: async () => { throw boom; } },
    orgItem: { count: async () => 2 },
  },
}));

const { configureLocalInventory, getNavCounts } = await import("../../runtime");
const { inertCatalogEventSource } = await import("../../contract");

it("leaves out a failed count and logs it, keeping the others", async () => {
  configureLocalInventory({
    auth: { getPrincipal: async () => null },
    org: async () => ({ id: "org-1", name: "Org One" }),
    catalogEventSource: inertCatalogEventSource,
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  expect(await getNavCounts()).toEqual({ openBackorders: 4, unlocated: 2 });
  expect(error).toHaveBeenCalledWith("nav counts: local-inventory pendingMergeConflicts failed", boom);
  error.mockRestore();
});
