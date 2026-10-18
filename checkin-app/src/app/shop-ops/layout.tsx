"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Alert, Button, Card, Center, Container, Loader, Title } from "@mantine/core";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { PageContainer } from "@/components/ui/PageContainer";
import { visibleLinks } from "@/lib/nav/gates";
import { SHOP_OPS } from "@/lib/nav/sections/shopOps";

export default function ShopLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
  }, [status, router]);

  if (status === "loading") {
    return (
      <Center mih="60vh">
        <Loader />
      </Center>
    );
  }

  if (status === "unauthenticated") return null;

  // General access gate (admin ⊂ certifier).
  if (!SHOP_OPS.visible(session?.user, null)) {
    return (
      <Container size="sm" py="xl">
        <Card withBorder radius="md" padding="xl">
          <Title order={2} mb="sm">Access Denied</Title>
          <Alert color="red" mb="md">
            Forbidden: You require the Admin, Board Member, or Certifier role to view this page.
          </Alert>
          <Button onClick={() => router.push("/")}>Back to Home</Button>
        </Card>
      </Container>
    );
  }

  const links = visibleLinks(SHOP_OPS, session?.user, null);
  const active = links.find((link) => pathname === link.href)?.href ?? null;

  // Per-tab gate: a known shop tab the viewer may not see (e.g. /shop/create for
  // a non-admin certifier hitting the URL directly).
  const onHiddenTab =
    SHOP_OPS.links.some((link) => link.href === pathname) && !active;
  if (onHiddenTab) {
    return (
      <Container size="sm" py="xl">
        <Card withBorder radius="md" padding="xl">
          <Title order={2} mb="sm">Access Denied</Title>
          <Alert color="red" mb="md">You do not have access to this section.</Alert>
          <Button onClick={() => router.push("/shop-ops")}>Back to Shop Operations</Button>
        </Card>
      </Container>
    );
  }

  return (
    <PageContainer>
      <SectionTabs links={links} mb="md" />
      {children}
    </PageContainer>
  );
}
