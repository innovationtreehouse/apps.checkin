import { anyRole, everyone, linkGate, sectionShown, tabHrefs, visibleLinks } from "@/lib/nav/gates";
import type { NavSection } from "@/lib/nav/types";
import type { TodoCounts } from "@/lib/nav/todoCounts";

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

describe("visibleLinks — sub-link library release", () => {
  const LIBRARY_SECTION: NavSection = {
    ...SECTION,
    links: [{ name: "Group", href: "/grouped/shared-page", subLinks: [
      { name: "Shared page", href: "/grouped/shared-page" },
      { name: "Income page", href: "/grouped/income-page", library: "income" },
    ] }],
  };
  const releasing = (releasedLibraries: string[]) => ({ releasedLibraries }) as TodoCounts;

  it("hides a sub-link until its library is released", () => {
    expect(visibleLinks(LIBRARY_SECTION, { isFinance: true }, releasing([]))[0].subLinks?.map((s) => s.name)).toEqual(["Shared page"]);
    expect(visibleLinks(LIBRARY_SECTION, { isFinance: true }, releasing(["income"]))[0].subLinks?.map((s) => s.name)).toEqual(["Shared page", "Income page"]);
  });

  it("shows an unreleased library's sub-link to the Board", () => {
    expect(visibleLinks(LIBRARY_SECTION, { isBoardMember: true }, releasing([]))[0].subLinks?.map((s) => s.name)).toEqual(["Shared page", "Income page"]);
  });

  it("gates a library sub-link by its release through linkGate", () => {
    expect(linkGate(LIBRARY_SECTION, "/grouped/income-page")({ isFinance: true }, releasing([]))).toBe(false);
    expect(linkGate(LIBRARY_SECTION, "/grouped/income-page")({ isFinance: true }, releasing(["income"]))).toBe(true);
  });
});

describe("linkGate — grouped tabs", () => {
  it("resolves a sub-link's own gate, ahead of a group sharing its href", () => {
    expect(linkGate(SECTION, "/grouped/board-page")({ isFinance: true }, null)).toBe(false);
    expect(linkGate(SECTION, "/grouped/board-page")({ isBoardMember: true }, null)).toBe(true);
    expect(linkGate(SECTION, "/grouped/shared-page")({ isFinance: true }, null)).toBe(true);
  });

  it("refuses a sub-link the group's own gate refuses", () => {
    expect(linkGate(SECTION, "/grouped/open")({ isFinance: true }, null)).toBe(false);
    expect(linkGate(SECTION, "/grouped/open")({ isBoardMember: true }, null)).toBe(true);
  });

  it("agrees with visibleLinks for every sub-link and viewer", () => {
    for (const user of [{ isFinance: true }, { isBoardMember: true }, {}]) {
      const shown = visibleLinks(SECTION, user, null).flatMap((l) => l.subLinks ?? []).map((s) => s.href);
      for (const href of SECTION.links.flatMap((l) => l.subLinks ?? []).map((s) => s.href)) {
        expect([href, linkGate(SECTION, href)(user, null)]).toEqual([href, shown.includes(href)]);
      }
    }
  });
});

describe("tabHrefs", () => {
  it("lists a tab's own href and its sub-links'", () => {
    expect(tabHrefs(SECTION.links[0])).toEqual(["/grouped/plain"]);
    expect(tabHrefs(SECTION.links[1])).toEqual(["/grouped/board-page", "/grouped/board-page", "/grouped/shared-page"]);
  });
});
