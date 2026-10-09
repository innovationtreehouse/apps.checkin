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
import { leadsAnyProgram, leadPendingCount } from "@/components/navBadges";
import { MY_PROGRAMS_LIBRARY_TABS, visibleLibraryTabs } from "@/lib/libraryNav";
import { TabBadge } from "@/components/ui/CountBadge";

import { PageLoader } from "@/components/ui/PageLoader";
/**
 * Program-leader "My Programs" chrome: section title + subtabs (Attendance inbox /
 * Conflicts), gated to program lead mentors. Lead status rides in on the
 * todo-counts payload the nav already fetches — no new session field. Matches the
 * program-ops layout's route-driven Tabs pattern.
 */
export default function MyProgramsLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const authed = status === "authenticated";
  const counts = useTodoCounts(authed);
  const { conflicts } = useConflicts(authed);
  // Library tabs (e.g. Expense approvals) admit their own audience, such as a
  // program treasurer who leads no program; Attendance/Conflicts stay lead-only.
  const libraryTabs = visibleLibraryTabs(MY_PROGRAMS_LIBRARY_TABS, session?.user, counts);
  const isLead = leadsAnyProgram(counts);
  const admitted = isLead || libraryTabs.length > 0;

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
    // Authenticated but leads no program → not their home. Wait for counts (null)
    // so we don't bounce a real lead mid-fetch.
    else if (authed && counts !== null && !admitted) router.push("/");
  }, [status, authed, counts, admitted, router]);

  if (status === "loading" || counts === null) {
    return (
      <PageLoader />
    );
  }
  if (!admitted) return null; // redirect in flight

  const TABS = [
    ...(isLead
      ? [
          { value: "/my-programs/attendance", label: "Attendance" },
          { value: "/my-programs/conflicts", label: "Conflicts" },
        ]
      : []),
    ...libraryTabs.map((t) => ({ value: t.href, label: t.name })),
  ];
  const active =
    TABS.filter((t) => pathname === t.value || pathname.startsWith(`${t.value}/`))
      .sort((a, b) => b.value.length - a.value.length)[0]?.value ?? TABS[0].value;

  const pending = leadPendingCount(counts);
  const conflictCount = conflicts?.length ?? 0;
  const subtitle: Record<string, string> = {
    "/my-programs/attendance": "Manage Attendance for Programs you lead",
    "/my-programs/conflicts": "Resolve Duplicate or overlapping check-ins for your programs",
  };

  return (
    <PageContainer>
      <Tabs value={active} onChange={(v) => { if (v && v !== active) router.push(v); }} mb="md">
        <ScrollableTabsList>
          {isLead && (
            <>
              <Tabs.Tab
                value="/my-programs/attendance"
                rightSection={pending > 0 ? <CountBadge intent="action">{pending}</CountBadge> : undefined}
              >
                Attendance
              </Tabs.Tab>
              <Tabs.Tab
                value="/my-programs/conflicts"
                rightSection={conflictCount > 0 ? <CountBadge intent="alert">{conflictCount}</CountBadge> : undefined}
              >
                Conflicts
              </Tabs.Tab>
            </>
          )}
          {libraryTabs.map((t) => (
            <Tabs.Tab key={t.href} value={t.href} rightSection={<TabBadge badge={t.badge?.(counts) ?? null} />}>
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
