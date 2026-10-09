"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Box, Center, Loader } from "@mantine/core";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { PageContainer } from "@/components/ui/PageContainer";
import { expenseAreaLinks } from "@/lib/expenseNav";

/**
 * The expense screens. Every route gates and filters server-side (FINANCE, Board, or a bucket
 * approver), so the layout only requires a session and hides tabs the caller cannot use.
 */
export default function ExpenseLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
  }, [status, router]);

  if (status !== "authenticated") {
    return (
      <Center mih="60vh">
        <Loader />
      </Center>
    );
  }

  return (
    <PageContainer>
      <SectionTabs links={expenseAreaLinks(session.user)} mb="md" />
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </PageContainer>
  );
}
