import { anyRole, everyone, sectionShown, visibleLinks } from "@/lib/nav/gates";
import type { NavSection } from "@/lib/nav/types";

const board = anyRole(["isBoardMember"]);

const SECTION: NavSection = {
  id: "grouped",
  label: "Grouped",
  href: "/grouped",
  visible: anyRole(["isFinance", "isBoardMember"]),
  links: [
    { name: "Plain", href: "/grouped/plain", visible: board },
    {
      name: "Group",
      href: "/grouped/board-page",
      subLinks: [
        { name: "Board page", href: "/grouped/board-page", visible: board },
        { name: "Shared page", href: "/grouped/shared-page" },
      ],
    },
    {
      name: "Board group",
      href: "/grouped/inherits",
      visible: board,
      subLinks: [{ name: "Inherits", href: "/grouped/inherits" }, { name: "Open", href: "/grouped/open", visible: everyone }],
    },
  ],
};

describe("visibleLinks — grouped tabs", () => {
  it("keeps every sub-link a board member may open", () => {
    const links = visibleLinks(SECTION, { isBoardMember: true }, null);
    expect(links.map((l) => l.href)).toEqual(["/grouped/plain", "/grouped/board-page", "/grouped/inherits"]);
    expect(links[1].subLinks?.map((s) => s.href)).toEqual(["/grouped/board-page", "/grouped/shared-page"]);
  });

  it("filters sub-links by their own gate and opens the first one left", () => {
    const links = visibleLinks(SECTION, { isFinance: true }, null);
    expect(links.map((l) => l.href)).toEqual(["/grouped/shared-page"]);
    expect(links[0].subLinks?.map((s) => s.href)).toEqual(["/grouped/shared-page"]);
  });

  it("hides a group whose own gate refuses the viewer, whatever its sub-links allow", () => {
    expect(visibleLinks(SECTION, { isFinance: true }, null).some((l) => l.name === "Board group")).toBe(false);
  });

  it("hides a group with no visible sub-link, and the section with it", () => {
    const allBoard: NavSection = { ...SECTION, links: [SECTION.links[1]].map((l) => ({ ...l, subLinks: l.subLinks?.slice(0, 1) })) };
    expect(visibleLinks(allBoard, { isFinance: true }, null)).toEqual([]);
    expect(sectionShown(allBoard, { isFinance: true }, null)).toBe(false);
  });
});
