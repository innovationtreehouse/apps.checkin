"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { DONATIONS } from "@/lib/nav/sections/donations";
import { useTodoCounts } from "@/hooks/useTodoCounts";

/** Donations has no landing of its own: open the first tab this viewer can see, once library release is known. */
export default function DonationsIndex() {
  const { data: session } = useSession();
  const counts = useTodoCounts(true);
  const router = useRouter();
  const user = session?.user;

  useEffect(() => {
    if (user && counts) router.replace(DONATIONS.hrefFor?.(user, counts) ?? DONATIONS.href);
  }, [user, counts, router]);

  return null;
}
