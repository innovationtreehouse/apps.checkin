import type { CatalogRuntimeConfig } from "@checkin/global-catalog";

const findUnique = jest.fn();
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { org: { findUnique } } }));

// The library's root entry pulls in its generated Prisma client, which the
// jest env does not build; only configureCatalog is needed, to capture the config.
const configureCatalog = jest.fn<void, [CatalogRuntimeConfig]>();
jest.mock("@checkin/global-catalog", () => ({ configureCatalog }));
const consumeCatalogEvent = jest.fn();
const inventoryOnOrgEvents = jest.fn();
const workflowOnOrgEvents = jest.fn();
jest.mock("@checkin/expense", () => ({ consumeCatalogEvent }));
jest.mock("@checkin/local-inventory", () => ({ orgEventConsumer: { onOrgEvents: inventoryOnOrgEvents } }));
jest.mock("@checkin/workflow-mapping", () => ({ orgEventConsumer: { onOrgEvents: workflowOnOrgEvents } }));

async function boot(): Promise<CatalogRuntimeConfig> {
  await jest.isolateModulesAsync(async () => {
    const { configureCatalogRuntime } = await import("../configure");
    await configureCatalogRuntime();
  });
  const runtime = configureCatalog.mock.calls.at(-1)?.[0];
  if (!runtime) throw new Error("configureCatalog was not called");
  return runtime;
}

beforeEach(() => {
  findUnique.mockReset();
  configureCatalog.mockReset();
});

describe("configureCatalogRuntime", () => {
  it("boots without touching the database", async () => {
    findUnique.mockRejectedValue(new Error("db unreachable"));
    await boot();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("gives the catalog the host's org, resolved from the seeded Org row", async () => {
    const org = { id: "treehouse", name: "Innovation Treehouse" };
    findUnique.mockResolvedValue(org);
    await expect((await boot()).org()).resolves.toEqual(org);
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "treehouse" } }));
  });
});

describe("S5 consumers", () => {
  const events = [
    { id: 1, orgId: "treehouse", eventType: "provisional_rejected", payload: "{}", createdAt: new Date() },
    { id: 2, orgId: "treehouse", eventType: "provisional_rejected", payload: "{}", createdAt: new Date() },
  ];

  it("registers local-inventory, expense and workflow-mapping, each handed the committed events", async () => {
    const consumers = (await boot()).orgEventConsumers ?? {};
    expect(Object.keys(consumers).sort()).toEqual(["expense", "localInventory", "workflowMapping"]);

    for (const consumer of Object.values(consumers)) await consumer.onOrgEvents(events);

    expect(inventoryOnOrgEvents).toHaveBeenCalledWith(events);
    expect(workflowOnOrgEvents).toHaveBeenCalledWith(events);
    expect(consumeCatalogEvent.mock.calls).toEqual([[events[0]], [events[1]]]);
  });
});
