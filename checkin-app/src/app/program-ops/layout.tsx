"use client";

import { usePathname, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect } from "react";
import { Box, Center, Loader, Stack, Text } from "@mantine/core";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { CountBadge } from "@/components/ui/CountBadge";
import { PageContainer } from "@/components/ui/PageContainer";
import { PROGRAM_OPS } from "@/lib/nav/sections/programOps";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { programsMisconfigBadge } from "@/components/navBadges";

// A program-edit URL (/program-ops/programs/[id]) carries a PROGRAM id, so the
// layout can gate it precisely against the caller's led-program set. Session URLs
// (/program-ops/sessions/[id|new]) carry an EVENT id (or none), which the layout
// can't resolve to a program without a fetch — those keep a chrome-less admit for
// any authenticated caller and the page enforces (Event->program 403 in the API).
const programEditId = (pathname: string | null): number | null => {
  const m = pathname?.match(/^\/program-ops\/programs\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
};
const isSessionFlowPath = (pathname: string | null) =>
  !!pathname?.match(/^\/program-ops\/sessions\/(\d+|new)/);

export default function ProgramOpsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, status } = useSession();

  const user = session?.user;
  const isGlobalAdmin = PROGRAM_OPS.visible(user, null);

  // Red pill on the Programs tab for priced programs missing their Shopify variant.
  // The count is only in the payload for admin/board, so gate the fetch on that.
  const todoCounts = useTodoCounts(isGlobalAdmin);
  const badgeFor = (href: string): React.ReactNode => {
    if (href !== "/program-ops/programs") return undefined;
    const badge = programsMisconfigBadge(todoCounts);
    return badge ? (
      <CountBadge intent="alert" aria-label={badge.label}>{badge.count}</CountBadge>
    ) : undefined;
  };

  // Row-aware: a lead mentor reaches program-edit only for the programs they lead.
  const editProgramId = programEditId(pathname);
  const leadsThisProgram =
    editProgramId !== null && !!user?.programsLed?.includes(editProgramId);
  const isSessionFlow = isSessionFlowPath(pathname);

  // Chrome-less (no section tabs) for the lead-mentor edit screens, as under /admin.
  const isChromeless = editProgramId !== null || isSessionFlow;
  const authorized =
    isGlobalAdmin || leadsThisProgram || (isSessionFlow && status === "authenticated");

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/");
    } else if (status === "authenticated" && !authorized) {
      router.push("/");
    }
  }, [status, authorized, router]);

  if (status === "loading") {
    return (
      <Center mih="60vh">
        <Stack align="center">
          <Loader />
          <Text>Verifying Program Access...</Text>
        </Stack>
      </Center>
    );
  }

  if (!session || !authorized) return null;

  if (isChromeless) return <>{children}</>;

  return (
    <PageContainer>
      <SectionTabs links={PROGRAM_OPS.links} prefixMatch badgeFor={badgeFor} mb="md" />
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </PageContainer>
  );
}
