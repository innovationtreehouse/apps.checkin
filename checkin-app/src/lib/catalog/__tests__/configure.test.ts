import type { CatalogRuntimeConfig } from "@inventory/global-catalog";

const findUnique = jest.fn();
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { org: { findUnique } } }));

// The library's root entry pulls in its generated Prisma client, which the
// jest env does not build; only configureCatalog is needed, to capture the config.
const configureCatalog = jest.fn<void, [CatalogRuntimeConfig]>();
jest.mock("@inventory/global-catalog", () => ({ configureCatalog }));

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

  it("resolves the seeded Org row on first use and caches it", async () => {
    findUnique.mockResolvedValue({ id: "treehouse", name: "Treehouse" });
    const runtime = await boot();
    await expect(runtime.org()).resolves.toEqual({ id: "treehouse", name: "Treehouse" });
    await runtime.org();
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("fails on a DB error instead of returning a default org, and retries next time", async () => {
    findUnique.mockRejectedValueOnce(new Error("db unreachable"));
    const runtime = await boot();
    await expect(runtime.org()).rejects.toThrow("db unreachable");
    findUnique.mockResolvedValueOnce({ id: "treehouse", name: "Treehouse" });
    await expect(runtime.org()).resolves.toEqual({ id: "treehouse", name: "Treehouse" });
  });

  it("fails when the Org row is not seeded", async () => {
    findUnique.mockResolvedValue(null);
    const runtime = await boot();
    await expect(runtime.org()).rejects.toThrow(/Org row "treehouse" not found/);
  });
});
