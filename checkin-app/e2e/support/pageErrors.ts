/**
 * What a page shows that it should not: an uncaught page error, a red error chip or inline
 * error alert, a 5xx or denied API call, or a bounce to sign-in or access-denied. An integration
 * the local stack does not wire (QuickBooks, the Shopify mirror) answers 503 by design, as the
 * flow tests expect, and does not count.
 */
import type { Page } from "@playwright/test";

/** Mantine sets its color as a CSS variable on the root, so red reads off the style attribute. */
const RED_CHIP = '.mantine-Notification-root[style*="--mantine-color-red"]';
const RED_ALERT = '.mantine-Alert-root[style*="--mantine-color-red"]';
const CRASH_TEXT = /Application error: a client-side exception|Unhandled Runtime Error/;
const BOUNCED = /^\/(access-denied|signin)(\/|$)/;

export interface PageWatch {
  /** Problems seen since the last call, which also clears them. */
  problems(): Promise<string[]>;
}

const deniedOrBroken = (status: number) => status >= 500 || status === 401 || status === 403;
const UNWIRED = /not connected|not wired in this environment/;

/** Starts recording a page's problems; read them with `problems()` after each navigation settles. */
export function watchPage(page: Page): PageWatch {
  let seen: string[] = [];
  let reading: Promise<void>[] = [];
  page.on("pageerror", (err) => seen.push(`page error: ${err.message}`));
  page.on("response", (res) => {
    const url = new URL(res.url());
    if (!url.pathname.startsWith("/api/") || !deniedOrBroken(res.status())) return;
    const problem = `${res.status()} ${url.pathname}${url.search}`;
    if (res.status() !== 503) {
      seen.push(problem);
      return;
    }
    reading.push(res.text().then((body) => { if (!UNWIRED.test(body)) seen.push(problem); }, () => { seen.push(problem); }));
  });

  return {
    async problems() {
      await Promise.all(reading);
      reading = [];
      const found = [...seen];
      seen = [];
      const path = new URL(page.url()).pathname;
      if (BOUNCED.test(path)) found.push(`redirected to ${path}`);
      for (const text of await page.locator(RED_CHIP).allInnerTexts()) found.push(`error chip: ${text.replace(/\s+/g, " ").trim()}`);
      for (const text of await page.locator(RED_ALERT).allInnerTexts()) found.push(`error alert: ${text.replace(/\s+/g, " ").trim()}`);
      if (await page.getByText(CRASH_TEXT).count()) found.push("crash screen");
      return found;
    },
  };
}
