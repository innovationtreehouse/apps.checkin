"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Tabs, Text } from "@mantine/core";
import { CountBadge } from "@/components/ui/CountBadge";
import { PageContainer } from "@/components/ui/PageContainer";
import { ScrollableTabsList } from "@/components/ui/ScrollableTabsList";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { useConflicts } from "@/hooks/useConflicts";
import { leadPendingCount } from "@/components/navBadges";
import type { SectionLink } from "@/lib/nav/types";
import { visibleLinks } from "@/lib/nav/gates";
import { PROGRAMS_I_LEAD } from "@/lib/nav/sections/programsILead";
import { TabBadge } from "@/components/ui/CountBadge";

import { PageLoader } from "@/components/ui/PageLoader";
/**
 * Program-leader "Programs I Lead" chrome: section title + subtabs (Attendance inbox /
 * Conflicts) for program lead mentors, plus library tabs for whoever they admit
 * (Expense approvals: leads and program treasurers). Lead status rides in on the
 * todo-counts payload the nav already fetches — no new session field. Matches the
 * program-ops layout's route-driven Tabs pattern.
 */
export default function ProgramsILeadLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const authed = status === "authenticated";
  const counts = useTodoCounts(authed);
  const { conflicts } = useConflicts(authed);
  // Attendance/Conflicts are lead-only; Expense approvals also admits a program
  // treasurer who leads no program.
  const links = visibleLinks(PROGRAMS_I_LEAD, session?.user, counts);
  const admitted = links.length > 0;

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
    // Authenticated but neither lead nor admitted by a library tab → not their home. Wait for counts (null)
    // so we don't bounce a real lead mid-fetch.
    else if (authed && counts !== null && !admitted) router.push("/");
  }, [status, authed, counts, admitted, router]);

  if (status === "loading" || counts === null) {
    return (
      <PageLoader />
    );
  }
  if (!admitted) return null; // redirect in flight

  const active =
    links.filter((t) => pathname === t.href || pathname.startsWith(`${t.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? links[0].href;

  const pending = leadPendingCount(counts);
  const conflictCount = conflicts?.length ?? 0;
  const tabBadge = ({ href, badge }: SectionLink): React.ReactNode => {
    if (href === "/programs-i-lead/attendance") return pending > 0 ? <CountBadge intent="action">{pending}</CountBadge> : undefined;
    if (href === "/programs-i-lead/conflicts") return conflictCount > 0 ? <CountBadge intent="alert">{conflictCount}</CountBadge> : undefined;
    return <TabBadge badge={badge?.(counts) ?? null} />;
  };
  const subtitle: Record<string, string> = {
    "/programs-i-lead/attendance": "Manage Attendance for Programs you lead",
    "/programs-i-lead/conflicts": "Resolve Duplicate or overlapping check-ins for your programs",
  };

  return (
    <PageContainer>
      <Tabs value={active} onChange={(v) => { if (v && v !== active) router.push(v); }} mb="md">
        <ScrollableTabsList>
          {links.map((t) => (
            <Tabs.Tab key={t.href} value={t.href} rightSection={tabBadge(t)}>
              {t.name}
            </Tabs.Tab>
          ))}
        </ScrollableTabsList>
      </Tabs>
      {subtitle[active] && <Text c="dimmed" mb="md">{subtitle[active]}</Text>}
      {children}
    </PageContainer>
  );
}
