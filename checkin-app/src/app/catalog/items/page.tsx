"use client";
// The screen lives in the global-catalog library; the host supplies the open conflict count.
import { useSession } from "next-auth/react";
import ItemsPage from "@checkin/global-catalog/pages/items";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { libraryCount } from "@/components/navBadges";

export default function Items() {
  const { status } = useSession();
  const counts = useTodoCounts(status === "authenticated");
  return <ItemsPage unresolvedConflicts={libraryCount(counts, "catalog", "unresolvedConflicts")} />;
}
