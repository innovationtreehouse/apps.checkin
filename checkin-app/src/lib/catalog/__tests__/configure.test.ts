import type { CatalogRuntimeConfig } from "@inventory/global-catalog";
import { getServerSession } from "next-auth";
import { config } from "@/lib/config";

const findUnique = jest.fn();
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { org: { findUnique } } }));

// The library's root entry pulls in its generated Prisma client, which the
// jest env does not build; only configureCatalog is needed, to capture the config.
const configureCatalog = jest.fn<void, [CatalogRuntimeConfig]>();
jest.mock("@inventory/global-catalog", () => ({ configureCatalog }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/config", () => ({
  config: { isStaging: jest.fn(() => false) },
  isStagingAccessAllowed: jest.requireActual("@/lib/config").isStagingAccessAllowed,
}));

const mockSession = getServerSession as jest.Mock;
const mockIsStaging = config.isStaging as jest.Mock;

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

describe("getPrincipal", () => {
  beforeEach(() => {
    mockSession.mockReset();
    mockIsStaging.mockReturnValue(false);
  });

  const signedIn = (user: Record<string, unknown>) => mockSession.mockResolvedValue({ user });
  const getPrincipal = async () => (await import("../configure")).getPrincipal();

  it("returns the principal for a live session", async () => {
    signedIn({ id: 7, name: "Ada" });
    await expect(getPrincipal()).resolves.toEqual({ id: 7, name: "Ada" });
  });

  it("returns null without a session", async () => {
    mockSession.mockResolvedValue(null);
    await expect(getPrincipal()).resolves.toBeNull();
  });

  it.each([0, -3, 1.5, Number.NaN, "7", undefined])("returns null for session id %p", async (id) => {
    signedIn({ id, name: "Ada" });
    await expect(getPrincipal()).resolves.toBeNull();
  });

  it("returns null for a denied household", async () => {
    signedIn({ id: 7, name: "Ada", denied: true });
    await expect(getPrincipal()).resolves.toBeNull();
  });

  it("applies the staging gate on staging", async () => {
    mockIsStaging.mockReturnValue(true);
    signedIn({ id: 7, name: "Ada" });
    await expect(getPrincipal()).resolves.toBeNull();
    signedIn({ id: 7, name: "Ada", canAccessStaging: true });
    await expect(getPrincipal()).resolves.toEqual({ id: 7, name: "Ada" });
  });
});
