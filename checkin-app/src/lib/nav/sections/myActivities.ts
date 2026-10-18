/** My Activities tabs (my-activities/layout.tsx); /my-activities redirects to the first tab. */
import type { NavSection } from "@/lib/nav/types";
import { signedIn } from "@/lib/nav/gates";

export const MY_ACTIVITIES: NavSection = {
  id: "my-activities",
  label: "My Activities",
  href: "/my-activities",
  links: [
    { name: "My Events", href: "/my-activities/events", icon: "📅" },
    { name: "My Programs", href: "/my-activities/programs", icon: "📚" },
  ],
  visible: signedIn,
};
