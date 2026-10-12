"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Box, Center, Loader, Stack, Text } from "@mantine/core";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { PageContainer } from "@/components/ui/PageContainer";
import { inventoryAreaLinks, isCatalogViewerClient } from "@/lib/catalogNav";
import { useTodoCounts } from "@/hooks/useTodoCounts";

export default function CatalogLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const authorized = isCatalogViewerClient(session?.user);
  const counts = useTodoCounts(status === "authenticated");

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
    else if (status === "authenticated" && !authorized) router.push("/");
  }, [status, authorized, router]);

  if (status === "loading") {
    return (
      <Center mih="60vh">
        <Stack align="center">
          <Loader />
          <Text>Verifying Inventory Access...</Text>
        </Stack>
      </Center>
    );
  }

  if (!authorized) return null;

  return (
    <PageContainer>
      <SectionTabs links={inventoryAreaLinks(session?.user, counts?.releasedLibraries)} mb="md" />
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </PageContainer>
  );
}
