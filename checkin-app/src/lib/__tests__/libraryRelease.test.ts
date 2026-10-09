import { isLibraryKey, isLibraryVisible } from "@/lib/libraryRelease";
import { inventoryAreaLinks } from "@/lib/catalogNav";
import { PAGES } from "@/components/pageRegistry";

describe("isLibraryVisible", () => {
  it("shows every library to a board member, released or not", () => {
    expect(isLibraryVisible("expense", { isBoardMember: true, releasedLibraries: [] })).toBe(true);
    expect(isLibraryVisible("catalog", { isBoardMember: true })).toBe(true);
  });

  it("hides an unreleased library from everyone else", () => {
    expect(isLibraryVisible("catalog", { isBoardMember: false, releasedLibraries: ["expense"] })).toBe(false);
    expect(isLibraryVisible("catalog", { releasedLibraries: null })).toBe(false);
  });

  it("shows a released library to everyone", () => {
    expect(isLibraryVisible("local-inventory", { isBoardMember: false, releasedLibraries: ["local-inventory"] })).toBe(true);
  });
});

describe("isLibraryKey", () => {
  it("accepts only known keys", () => {
    expect(isLibraryKey("bulk-donation")).toBe(true);
    expect(isLibraryKey("inventory")).toBe(false);
    expect(isLibraryKey(1)).toBe(false);
  });
});

describe("inventory section tabs", () => {
  const keyholder = { id: 1, isKeyholder: true } as Parameters<typeof inventoryAreaLinks>[0];
  const released = (releasedLibraries: string[]) => ({
    member: { household: [], programs: [], programsAwaitingFinance: 0 },
    building: 0,
    buildingHousehold: 0,
    activePrograms: 0,
    releasedLibraries,
  });

  it("drops each unreleased library's tabs for a non-board viewer", () => {
    expect(inventoryAreaLinks(keyholder, released([]))).toEqual([]);
    const catalogOnly = inventoryAreaLinks(keyholder, released(["catalog"])).map((l) => l.href);
    expect(catalogOnly.length).toBeGreaterThan(0);
    expect(catalogOnly.every((h) => h.startsWith("/catalog"))).toBe(true);
  });

  it("keeps every tab for a board member", () => {
    const board = { id: 2, isBoardMember: true } as Parameters<typeof inventoryAreaLinks>[0];
    const hrefs = inventoryAreaLinks(board, released([])).map((l) => l.href);
    expect(hrefs.some((h) => h.startsWith("/catalog"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/inventory"))).toBe(true);
  });
});

describe("index directory", () => {
  const counts = (releasedLibraries: string[]) => ({
    member: { household: [], programs: [], programsAwaitingFinance: 0 },
    building: 0,
    buildingHousehold: 0,
    activePrograms: 0,
    releasedLibraries,
  });
  const orgItems = PAGES.find((p) => p.href === "/inventory/org-items");

  it("lists a library's pages for a non-board viewer only once released", () => {
    expect(orgItems?.visible({ isKeyholder: true }, true, counts([]))).toBe(false);
    expect(orgItems?.visible({ isKeyholder: true }, true, counts(["local-inventory"]))).toBe(true);
    expect(orgItems?.visible({ isBoardMember: true }, true, counts([]))).toBe(true);
  });
});
