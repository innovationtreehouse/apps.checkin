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
  /** Problems seen since the last call, which also clears them; a chip or alert still up is reported once. */
  problems(): Promise<string[]>;
}

const deniedOrBroken = (status: number) => status >= 500 || status === 401 || status === 403;
const UNWIRED = /not connected|not wired in this environment/;
/** Set on a chip or alert once reported, so one that stays up is not reported again on the next tab. */
const REPORTED = "data-e2e-reported";

/** The text of each element matching `selector` not reported before, marking it reported. */
async function newlyShown(page: Page, selector: string): Promise<string[]> {
  return page.locator(`${selector}:not([${REPORTED}])`).evaluateAll((els, mark) =>
    els.map((el) => {
      el.setAttribute(mark, "");
      return (el instanceof HTMLElement ? el.innerText : el.textContent ?? "").replace(/\s+/g, " ").trim();
    }), REPORTED);
}

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
      for (const text of await newlyShown(page, RED_CHIP)) found.push(`error chip: ${text}`);
      for (const text of await newlyShown(page, RED_ALERT)) found.push(`error alert: ${text}`);
      if (await page.getByText(CRASH_TEXT).count()) found.push("crash screen");
      return found;
    },
  };
}
