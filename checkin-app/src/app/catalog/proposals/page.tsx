"use client";
// The screen lives in the global-catalog library; the host supplies its queues' pending counts.
import { useSession } from "next-auth/react";
import ProposalsPage from "@checkin/global-catalog/pages/proposals";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { libraryCount } from "@/components/navBadges";

export default function Proposals() {
  const { status } = useSession();
  const counts = useTodoCounts(status === "authenticated");
  return (
    <ProposalsPage
      pendingItemReferences={libraryCount(counts, "catalog", "pendingItemReferences")}
      pendingProvisionalItems={libraryCount(counts, "catalog", "pendingProvisionalItems")}
    />
  );
}
