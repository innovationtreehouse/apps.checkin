"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Center, Loader, Text } from "@mantine/core";
import { DONATIONS } from "@/lib/nav/sections/donations";
import { firstVisibleHref } from "@/lib/nav/gates";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import { useTodoCounts } from "@/hooks/useTodoCounts";

/** How long to wait for the counts before landing on the viewer's first tab by role alone. */
const COUNTS_WAIT_MS = 3000;

/** Counts that release Donations' library, so only the viewer's roles choose the tab. */
const RELEASED: TodoCounts = {
  member: { household: [], programs: [], programsAwaitingFinance: 0 },
  building: 0,
  buildingHousehold: 0,
  buildingReachable: false,
  activePrograms: 0,
  releasedLibraries: ["bulk-donation"],
};

/**
 * Donations has no landing of its own: open the first tab this viewer can see.
 * Library release hides the tabs from non-board viewers until the Board releases
 * it, so the counts decide whether any tab is open; when they don't arrive in time,
 * the viewer's roles alone choose the tab.
 */
export default function DonationsIndex() {
  const { data: session } = useSession();
  const counts = useTodoCounts(true);
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);
  const user = session?.user;

  useEffect(() => {
    const timer = setTimeout(() => setGaveUp(true), COUNTS_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  const releaseKnown = counts ?? (user?.isBoardMember === true || gaveUp ? RELEASED : null);
  const target = user && releaseKnown ? firstVisibleHref(DONATIONS, user, releaseKnown) : null;

  useEffect(() => {
    if (target && target !== DONATIONS.href) router.replace(target);
  }, [target, router]);

  if (target === DONATIONS.href) return <Text>No Donations screen is open to you yet.</Text>;
  return <Center mih="40vh"><Loader /></Center>;
}
