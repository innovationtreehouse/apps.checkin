/**
 * Every page each seeded persona's nav shows, opened in a real browser. A page fails on an
 * uncaught page error, a red error chip or inline error alert, a 5xx or denied API call it
 * makes, or a bounce to sign-in or access-denied. The page list is the nav's own
 * (test-support/navPages), so a new tab is covered once it is in the nav.
 */
import { expect, test } from "@playwright/test";
import type { NavSection, NavUser } from "@/lib/nav/types";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import { api, type Session } from "../flow-tests/helpers";
import { navPages, navSections } from "../test-support/navPages";
import { watchPage } from "./support/pageErrors";
import { APPROVER, BOARD, bucket, FINANCE, INVENTORY_MANAGER, MEMBER, releaseLibraries, TREASURER, type Undo } from "./support/seedState";
import { signIn } from "./support/session";

const PERSONAS = [FINANCE, BOARD, APPROVER, TREASURER, INVENTORY_MANAGER, MEMBER];

/** A page that fails today: skipped by the sweep and asserted on its own as `test.fail` until its fix lands. */
interface KnownFailure { page: string; personas: string[]; bug: string }
const KNOWN_FAILURES: KnownFailure[] = [];

const isKnown = (email: string, page: string) => KNOWN_FAILURES.some((k) => k.page === page && k.personas.includes(email));

let sections: NavSection[];
const undo: Undo[] = [];

test.beforeAll(async () => {
  sections = navSections();
  undo.push(await releaseLibraries());
  // The approver owns a bucket and the treasurer is its treasurer, so their approval pages show.
  undo.push((await bucket(`Nav pages ${Date.now()}`, APPROVER, TREASURER)).undo);
});

test.afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

/** The persona's nav pages, read from its session and nav counts as the browser reads them. */
async function pagesFor(session: Session): Promise<string[]> {
  const me = await api<{ user?: NavUser }>(session, "/api/auth/session");
  const counts = await api<TodoCounts>(session, "/api/nav/todo-counts");
  expect(counts.status).toBe(200);
  if (!me.json.user) throw new Error("no session user");
  return navPages(sections, me.json.user, counts.json);
}

test.describe("nav pages in the browser", () => {
  for (const email of PERSONAS) {
    test(`${email} opens every page in their nav without an error`, async ({ browser }) => {
      const { context, session } = await signIn(browser, email);
      const page = await context.newPage();
      const watch = watchPage(page);
      const pages = (await pagesFor(session)).filter((p) => !isKnown(email, p));
      expect(pages.length).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const href of pages) {
        await test.step(href, async () => {
          const res = await page.goto(href);
          await page.waitForLoadState("networkidle");
          const problems = await watch.problems();
          if (res && res.status() >= 400) problems.unshift(`page answered ${res.status()}`);
          failures.push(...problems.map((p) => `${href}: ${p}`));
        });
      }
      await context.close();
      expect(failures).toEqual([]);
    });
  }

  for (const known of KNOWN_FAILURES) {
    for (const email of known.personas) {
      test(`${email} opens ${known.page} (${known.bug})`, async ({ browser }) => {
        test.fail();
        const { context } = await signIn(browser, email);
        const page = await context.newPage();
        const watch = watchPage(page);
        await page.goto(known.page);
        await page.waitForLoadState("networkidle");
        expect(await watch.problems()).toEqual([]);
      });
    }
  }
});
