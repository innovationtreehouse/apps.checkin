import { getServerSession } from "next-auth";
import { config } from "@/lib/config";

const findUnique = jest.fn();
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { org: { findUnique } } }));

// The library's root entry pulls in its generated Prisma client, which the jest env does not build.
jest.mock("@checkin/global-catalog", () => ({}));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/config", () => ({
  config: { isStaging: jest.fn(() => false) },
  isStagingAccessAllowed: jest.requireActual("@/lib/config").isStagingAccessAllowed,
}));

const mockSession = getServerSession as jest.Mock;
const mockIsStaging = config.isStaging as jest.Mock;

type Host = typeof import("../host");

describe("getOrg", () => {
  // The org is cached per module instance, so each test needs a fresh one.
  const withFreshHost = (run: (host: Host) => Promise<void>) =>
    jest.isolateModulesAsync(async () => run(await import("../host")));

  beforeEach(() => findUnique.mockReset());

  it("resolves the seeded Org row on first use and caches it", () =>
    withFreshHost(async ({ getOrg }) => {
      findUnique.mockResolvedValue({ id: "treehouse", name: "Treehouse" });
      await expect(getOrg()).resolves.toEqual({ id: "treehouse", name: "Treehouse" });
      await getOrg();
      expect(findUnique).toHaveBeenCalledTimes(1);
    }));

  it("fails on a DB error instead of returning a default org, and retries next time", () =>
    withFreshHost(async ({ getOrg }) => {
      findUnique.mockRejectedValueOnce(new Error("db unreachable"));
      await expect(getOrg()).rejects.toThrow("db unreachable");
      findUnique.mockResolvedValueOnce({ id: "treehouse", name: "Treehouse" });
      await expect(getOrg()).resolves.toEqual({ id: "treehouse", name: "Treehouse" });
    }));

  it("fails when the Org row is not seeded", () =>
    withFreshHost(async ({ getOrg }) => {
      findUnique.mockResolvedValue(null);
      await expect(getOrg()).rejects.toThrow(/Org row "treehouse" not found/);
    }));
});

describe("getPrincipal", () => {
  beforeEach(() => {
    mockSession.mockReset();
    mockIsStaging.mockReturnValue(false);
  });

  const signedIn = (user: Record<string, unknown>) => mockSession.mockResolvedValue({ user });
  const getPrincipal = async () => (await import("../host")).getPrincipal();

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
