"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Box, Center, Loader, Stack, Text } from "@mantine/core";
import { PageContainer } from "@/components/ui/PageContainer";
import { INCOME_SECTION_ROLES } from "@/lib/incomeNav";

export default function IncomeLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const authorized = INCOME_SECTION_ROLES.some((r) => !!session?.user?.[r]);

  useEffect(() => {
    if (status === "unauthenticated" || (status === "authenticated" && !authorized)) router.push("/");
  }, [status, authorized, router]);

  if (status === "loading") {
    return (
      <Center mih="60vh">
        <Stack align="center">
          <Loader />
          <Text>Verifying Income Access...</Text>
        </Stack>
      </Center>
    );
  }

  if (!authorized) return null;

  return (
    <PageContainer>
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </PageContainer>
  );
}
