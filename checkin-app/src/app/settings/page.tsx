"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

// Settings has no landing of its own — redirect to the first tab the viewer can
// open. Board/sysadmin start on Membership Settings; operations (who reach only
// Outreach) start there, and FINANCE (who reaches only Finance) on Finance, so
// widening the section gate never lands them on a page that bounces them back out.
export default function SettingsIndex() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status !== "authenticated") return;
    const user = session?.user as { isSysadmin?: boolean; isBoardMember?: boolean; isOperations?: boolean } | undefined;
    const isBoard = user?.isSysadmin === true || user?.isBoardMember === true;
    const isOperations = user?.isOperations === true;
    router.replace(isBoard ? "/settings/membership" : isOperations ? "/settings/outreach" : "/settings/finance");
  }, [status, session, router]);

  return null;
}
