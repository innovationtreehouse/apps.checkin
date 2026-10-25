/**
 * The pages a viewer's nav shows, derived the way the browser derives them: every section
 * descriptor in src/lib/nav/sections and the page directory, evaluated against the viewer's
 * session user and nav counts. Pure config, no DB access; shared by the browser tests.
 */
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PAGES } from "@/components/pageRegistry";
import { sectionShown, tabHrefs, visibleLinks } from "@/lib/nav/gates";
import type { NavSection, NavUser } from "@/lib/nav/types";
import type { TodoCounts } from "@/lib/nav/todoCounts";

const isSection = (v: unknown): v is NavSection =>
  typeof v === "object" && v !== null
  && "id" in v && typeof v.id === "string"
  && "label" in v && typeof v.label === "string"
  && "href" in v && typeof v.href === "string"
  && "links" in v && Array.isArray(v.links)
  && "visible" in v && typeof v.visible === "function";

/**
 * Every section descriptor in src/lib/nav/sections, so a new section is covered without a list to update.
 * Loaded through `require`: a dynamic `import()` of a .ts file bypasses the test runner's transform and its path aliases.
 */
export function navSections(): NavSection[] {
  const dir = join(__dirname, "../src/lib/nav/sections");
  const load = createRequire(__filename);
  const modules = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => load(join(dir, f)) as Record<string, unknown>);
  return [...new Set(modules.flatMap((m) => Object.values(m).filter(isSection)))];
}

/** The pages the nav shows this viewer: shown sections' destinations and tabs, and the directory's visible pages. */
export function navPages(sections: NavSection[], user: NavUser, counts: TodoCounts | null): string[] {
  const hrefs = new Set<string>();
  for (const section of sections) {
    if (!sectionShown(section, user, counts)) continue;
    hrefs.add(section.hrefFor?.(user, counts) ?? section.href);
    for (const link of visibleLinks(section, user, counts)) for (const href of tabHrefs(link)) hrefs.add(href);
  }
  for (const page of PAGES) if (page.visible(user, counts)) hrefs.add(page.href);
  return [...hrefs].filter((h) => h.startsWith("/") && !h.includes("["));
}
