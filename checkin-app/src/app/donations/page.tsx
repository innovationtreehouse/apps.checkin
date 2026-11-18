"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Text } from "@mantine/core";
import { DONATIONS } from "@/lib/nav/sections/donations";
import { useTodoCounts } from "@/hooks/useTodoCounts";

/** Donations has no landing of its own: open the first tab this viewer can see, once library release is known. */
export default function DonationsIndex() {
  const { data: session } = useSession();
  const counts = useTodoCounts(true);
  const router = useRouter();
  const user = session?.user;

  const target = user && counts ? (DONATIONS.hrefFor?.(user, counts) ?? DONATIONS.href) : null;

  useEffect(() => {
    if (target && target !== DONATIONS.href) router.replace(target);
  }, [target, router]);

  return target === DONATIONS.href ? <Text>No Donations screen is open to you yet.</Text> : null;
}
