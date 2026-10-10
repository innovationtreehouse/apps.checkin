"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Box, Center, Loader, Stack, Text } from "@mantine/core";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { PageContainer } from "@/components/ui/PageContainer";
import { isReceiptReviewerClient, isReceiptSubmitterClient, receiptAreaLinks } from "@/lib/receiptNav";

export default function ReceiptsLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const authorized = isReceiptSubmitterClient(session?.user) || isReceiptReviewerClient(session?.user);

  useEffect(() => {
    if (status === "unauthenticated" || (status === "authenticated" && !authorized)) router.push("/");
  }, [status, authorized, router]);

  if (status === "loading") {
    return (
      <Center mih="60vh">
        <Stack align="center">
          <Loader />
          <Text>Verifying Receipt Access...</Text>
        </Stack>
      </Center>
    );
  }

  if (!authorized) return null;

  return (
    <PageContainer>
      <SectionTabs links={receiptAreaLinks(session?.user)} mb="md" />
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </PageContainer>
  );
}
