/**
 * The dev-tools tabs (app/dev/layout.tsx); /dev redirects to the first tab. Dev
 * instances only: every target page 404s off a dev instance and AppFrame shows
 * the entry only there.
 */
import type { NavSection } from "@/lib/nav/types";
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
