"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Box } from "@mantine/core";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { PageContainer } from "@/components/ui/PageContainer";
import { MY_ACTIVITIES } from "@/lib/nav/sections/myActivities";

import { PageLoader } from "@/components/ui/PageLoader";
export default function MyActivitiesLayout({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
  }, [status, router]);

  if (status === "loading") {
    return (
      <PageLoader />
    );
  }

  if (status === "unauthenticated") return null;

  return (
    <PageContainer>
      <SectionTabs links={MY_ACTIVITIES.links} prefixMatch mb="md" />
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </PageContainer>
  );
}
