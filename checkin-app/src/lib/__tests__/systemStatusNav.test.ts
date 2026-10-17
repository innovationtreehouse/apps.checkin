import { SYSTEM_STATUS_NAV_LINKS } from "../systemStatusNav";

describe("SYSTEM_STATUS_NAV_LINKS", () => {
  it("is a non-empty list of nav links with name and href", () => {
    expect(SYSTEM_STATUS_NAV_LINKS.length).toBeGreaterThan(0);
    for (const link of SYSTEM_STATUS_NAV_LINKS) {
      expect(typeof link.name).toBe("string");
      expect(link.href.startsWith("/system-status/")).toBe(true);
    }
  });

  it("has unique hrefs", () => {
    const hrefs = SYSTEM_STATUS_NAV_LINKS.map((l) => l.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  // The full list is the board/sysadmin audience. The layout filters it
  // down to Unsynced Scans for a keyholder (Q15); this module stays the
  // unfiltered catalog.
  it("exposes every tab to the section audience", () => {
    expect(SYSTEM_STATUS_NAV_LINKS.map((l) => l.name)).toEqual([
      "System Status",
      "Link Status",
      "Lifecycle",
      "Errors",
      "Unsynced Scans",
      "Audit Log",
    ]);
  });
});
