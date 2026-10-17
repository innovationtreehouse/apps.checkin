"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

// Settings has no landing of its own — redirect to the first tab the viewer can
// open. Board/sysadmin start on Membership Settings; operations (who reach only
// Outreach) start there, so widening the section gate never lands them on a page
// that bounces them straight back out.
export default function SettingsIndex() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status !== "authenticated") return;
    const user = session?.user as { isSysadmin?: boolean; isBoardMember?: boolean } | undefined;
    const isBoard = user?.isSysadmin === true || user?.isBoardMember === true;
    router.replace(isBoard ? "/settings/membership" : "/settings/outreach");
  }, [status, session, router]);

  return null;
}
