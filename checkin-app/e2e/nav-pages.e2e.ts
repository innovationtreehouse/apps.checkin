/**
 * Every page each seeded persona's nav shows, opened in a real browser. A page fails on an
 * uncaught page error, a red error chip or inline error alert, a 5xx or denied API call it
 * makes, or a bounce to sign-in or access-denied. The page list is the nav's own
 * (test-support/navPages), so a new tab is covered once it is in the nav.
 */
import { expect, test, type Page } from "@playwright/test";
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
const KNOWN_FAILURES: KnownFailure[] = [
  {
    page: "/attendance/certifications",
    personas: [FINANCE, INVENTORY_MANAGER, MEMBER],
    bug: "the nav offers it, but /api/kioskdisplay/certifications answers 403 and the page shows Forbidden",
  },
  {
    page: "/my-household",
    personas: [FINANCE, APPROVER, TREASURER, INVENTORY_MANAGER],
    bug: "the nav offers it, but /api/household/emergency-contacts answers 403",
  },
  {
    page: "/safety/trusted-adults",
    personas: [APPROVER, TREASURER],
    bug: "the nav offers it, but the page sends them to the home page",
  },
];

/** A red alert a fresh seed shows on purpose: a prompt to fill in data the seed leaves empty. */
interface SeedPrompt { page: string; personas: string[]; text: string }
/** The fail-closed prompt until the Board sets the re-check interval (#2544). */
const BG_INTERVAL_UNSET =
  "⛔ Background-check interval is not set. Until the board enters the policy value (in months), every background check counts as expired: every renewal is sent back for a fresh background review, and no one counts as a supervising adult in the two-deep check. Enter the real Treehouse re-check interval above.";
const SEED_PROMPTS: SeedPrompt[] = [
  { page: "/settings", personas: [BOARD], text: BG_INTERVAL_UNSET },
  { page: "/settings/membership", personas: [BOARD], text: BG_INTERVAL_UNSET },
  { page: "/my-household", personas: [MEMBER], text: "No emergency contact on file. Add at least one." },
];

const isKnown = (email: string, page: string) => KNOWN_FAILURES.some((k) => k.page === page && k.personas.includes(email));
const isSeedPrompt = (email: string, page: string, problem: string) =>
  SEED_PROMPTS.some((p) => p.page === page && p.personas.includes(email) && problem === `error alert: ${p.text}`);

/** How long a page may keep requesting after it loads; one still requesting then is itself a problem. */
const SETTLE_MS = 30_000;
/** A page's share of its persona's test time: the navigation limit, the settle, and a margin. */
const PAGE_BUDGET_MS = 90_000 + SETTLE_MS + 10_000;

/** Opens a page and lets it settle; a page that never finishes loading is itself a problem. */
async function openPage(page: Page, href: string): Promise<string[]> {
  try {
    const res = await page.goto(href);
    const problems = res && res.status() >= 400 ? [`page answered ${res.status()}`] : [];
    const settled = await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).then(() => true, () => false);
    if (!settled) problems.push(`still loading after ${SETTLE_MS / 1000} s, so a late error could be missed`);
    return problems;
  } catch (err) {
    return [`did not load: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`];
  }
}

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
      test.setTimeout(60_000 + pages.length * PAGE_BUDGET_MS);

      const failures: string[] = [];
      for (const href of pages) {
        await test.step(href, async () => {
          const problems = await openPage(page, href);
          problems.push(...(await watch.problems()));
          // A role gate sends a viewer it refuses to the home page.
          if (href !== "/" && new URL(page.url()).pathname === "/") problems.unshift("sent to the home page");
          for (const problem of problems.filter((p) => !isSeedPrompt(email, href, p))) {
            failures.push(`${href}: ${problem}`);
            console.log(`  ✘ ${email} ${href}: ${problem}`);
          }
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
        const problems = await openPage(page, known.page);
        problems.push(...(await watch.problems()));
        if (new URL(page.url()).pathname === "/") problems.push("sent to the home page");
        expect(problems).toEqual([]);
      });
    }
  }
});
