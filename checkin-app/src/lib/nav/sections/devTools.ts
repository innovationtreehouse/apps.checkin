/**
 * The dev-tools tabs (app/dev/layout.tsx); /dev redirects to the first tab. Dev
 * instances only: every target page 404s off a dev instance and AppFrame shows
 * the entry only there. The Shopify and BG Check tabs show only while their mock is active (devToolLinks).
 */
import type { NavSection, SectionLink } from "@/lib/nav/types";
import { signedIn } from "@/lib/nav/gates";

export const DEV_TOOLS: NavSection = {
  id: "dev",
  label: "Debug",
  href: "/dev",
  links: [
    { name: "Email", href: "/dev/sent-mail" },
    { name: "Sign", href: "/dev/zoho-sign" },
    { name: "Shopify", href: "/dev/shopify" },
    { name: "BG Check", href: "/dev/bg-consent" },
  ],
  visible: signedIn,
};

/** The dev mocks active on this instance, each read from its config predicate on the server. */
export type DevMocks = { shopify: boolean; bgConsent: boolean };

/** Tabs whose page 404s unless a mock is active, keyed to that mock. */
const MOCK_TABS: Record<string, keyof DevMocks> = { "/dev/shopify": "shopify", "/dev/bg-consent": "bgConsent" };

/** The Debug tabs whose page this instance serves. */
export function devToolLinks(mocks: DevMocks): readonly SectionLink[] {
  return DEV_TOOLS.links.filter((link) => {
    const mock = MOCK_TABS[link.href];
    return !mock || mocks[mock];
  });
}
