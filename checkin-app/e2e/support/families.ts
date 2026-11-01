import { expect, type Browser, type Page } from "@playwright/test";
import { api, loginAs } from "../../flow-tests/helpers";
import { persona } from "./kiosk";
import { watchPage } from "./pageErrors";
import { BOARD, send } from "./seedState";
import { signIn } from "./session";

export const REVIEWER = "bg.reviewer@example.com";

const CONTACT = { emergencyContactName: "Pat Outside", emergencyContactPhone: "555-987-6543" };

/** Mints a one-person household with no membership and returns its lead's email. */
export async function newFamily(): Promise<string> {
  const minted = await api<{ personaId: number }>(null, "/api/auth/dev-personas", { method: "POST" });
  if (minted.status !== 200) throw new Error(`mint family: ${minted.status}`);
  const { personaId } = minted.json;
  // The mint answers with the id only; a bare number searches the directory by id.
  const { json } = await api<{ people: Array<{ id: number; email: string }> }>(await loginAs(BOARD), `/api/people/search?q=${personaId}`);
  const person = json.people.find((p) => p.id === personaId);
  if (!person) throw new Error(`minted family ${personaId} not in the directory`);
  return person.email;
}

/** A new family that has given its phone and emergency contact, so nothing prompts for them. */
export async function settledFamily(): Promise<string> {
  const email = await newFamily();
  const onboarded = await send(await loginAs(email), "POST", "/api/profile/onboarding", { phone: "555-123-4567", ...CONTACT });
  if (onboarded.status !== 200) throw new Error(`onboard family: ${onboarded.status}`);
  return email;
}

/** Opens the family's application with a saved address, still at intake; returns its id. */
export async function applicationAtIntake(email: string): Promise<number> {
  const family = await loginAs(email);
  const started = await send(family, "POST", "/api/membership");
  if (started.status !== 201) throw new Error(`start application: ${started.status}`);
  const saved = await send(family, "PATCH", "/api/membership/intake", {
    household: { line1: "123 Maker Lane", city: "Austin", state: "TX", postalCode: "78701", ...CONTACT },
    primaryParent: { name: (await persona(email)).name },
  });
  if (saved.status !== 200) throw new Error(`save intake: ${saved.status}`);
  const { json } = await api<{ process: { id: number } }>(family, "/api/membership");
  return json.process.id;
}

/** Submits the family's intake, which leaves it waiting on its agreement and consent; returns its id. */
export async function submittedApplication(email: string): Promise<number> {
  const processId = await applicationAtIntake(email);
  const submitted = await send(await loginAs(email), "POST", "/api/membership/intake/submit");
  if (submitted.status !== 200) throw new Error(`submit intake: ${submitted.status}`);
  return processId;
}

/** Has the Board record the agreement and consent, which opens payment; returns the application's id. */
export async function applicationAtPayment(email: string): Promise<number> {
  const processId = await submittedApplication(email);
  const board = await loginAs(BOARD);
  for (const action of ["mark-contract", "mark-bg-consent"]) {
    const marked = await send(board, "POST", "/api/membership-ops/applications/external", { processId, action });
    if (marked.status !== 200) throw new Error(`${action}: ${marked.status}`);
  }
  return processId;
}

/** A reviewer's decision, naming the family's lead when it is an approval. */
export async function review(reviewerEmail: string, processId: number, familyEmail: string, result: "APPROVE" | "REJECT" = "APPROVE"): Promise<void> {
  const body = result === "APPROVE" ? { subjectPersonIds: [(await persona(familyEmail)).id] } : { note: "The report needs a second look." };
  const reviewed = await send(await loginAs(reviewerEmail), "POST", "/api/membership/reviews", { processId, result, ...body });
  if (reviewed.status !== 200) throw new Error(`review ${result}: ${reviewed.status}`);
}

/** Runs `steps` on a page signed in as `email`, asserting after them that the page showed no problem but `expected`. */
export async function asViewer(browser: Browser, email: string, steps: (page: Page) => Promise<void>, expected?: RegExp): Promise<void> {
  const { context } = await signIn(browser, email);
  const page = await context.newPage();
  const watch = watchPage(page);
  await steps(page);
  const problems = await watch.problems();
  expect(expected ? problems.filter((p) => !expected.test(p)) : problems).toEqual([]);
  await context.close();
}
