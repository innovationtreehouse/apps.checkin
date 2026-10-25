/**
 * Browser sign-in for e2e specs: persona-mint over HTTP (the flow-test `loginAs`), with its
 * session cookies loaded into a fresh browser context.
 */
import type { Browser, BrowserContext } from "@playwright/test";
import { BASE, loginAs, type Session } from "../../flow-tests/helpers";

export interface Persona { context: BrowserContext; session: Session }

/** A browser context signed in as the seeded persona with this email. */
export async function signIn(browser: Browser, email: string): Promise<Persona> {
  const session = await loginAs(email);
  const context = await browser.newContext({ baseURL: BASE });
  await context.addCookies([...session.jar].map(([name, value]) => ({ name, value, url: BASE })));
  return { context, session };
}
