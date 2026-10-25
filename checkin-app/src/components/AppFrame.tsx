"use client";

import { Suspense } from 'react';
import {
  ActionIcon,
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Group,
  NavLink,
  Title,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconActivity,
  IconAdjustments,
  IconBriefcase,
  IconBuildingWarehouse,
  IconCalendarEvent,
  IconClipboardList,
  IconCoin,
  IconGift,
  IconHome,
  IconList,
  IconBug,
  IconLogout,
  IconMail,
  IconMoon,
  IconPackage,
  IconReceipt,
  IconReportMoney,
  IconSettings,
  IconShieldCheck,
  IconSun,
  IconTool,
  IconUser,
  IconUsers,
  IconUsersGroup,
  IconUserSearch,
} from '@tabler/icons-react';
import { useSession, signIn, signOut } from 'next-auth/react';
import { usePathname, useSearchParams } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { brand } from '@/brand';
import { useIsDevInstance } from '@/components/EnvProvider';
import { BuildInfoFooter } from '@/components/BuildInfoFooter';
import { useTodoCounts } from '@/hooks/useTodoCounts';
import { useConfirmNav } from '@/components/UnsavedChangesProvider';
import { sectionBadges } from '@/components/navBadges';
import { CountBadge, badgeIntentFor } from '@/components/ui/CountBadge';
import type { NavSection } from '@/lib/nav/types';
import { sectionShown, tabHrefs, visibleLinks } from '@/lib/nav/gates';
import { ATTENDANCE, COMMUNICATION, INDEX, MY_HOUSEHOLD, PROGRAMS } from '@/lib/nav/sections/personal';
import { SAFETY } from '@/lib/nav/sections/safety';
import { MY_ACTIVITIES } from '@/lib/nav/sections/myActivities';
import { MY_RECEIPTS } from '@/lib/nav/sections/myReceipts';
import { PROGRAMS_I_LEAD } from '@/lib/nav/sections/programsILead';
import { SHOP_OPS } from '@/lib/nav/sections/shopOps';
import { INVENTORY } from '@/lib/nav/sections/inventory';
import { FACILITY_OPS } from '@/lib/nav/sections/facilityOps';
import { MEMBERSHIP_OPS } from '@/lib/nav/sections/membershipOps';
import { MEMBERSHIP_AUDIT } from '@/lib/nav/sections/membershipAudit';
import { PROGRAM_OPS } from '@/lib/nav/sections/programOps';
import { REVENUE_OPS } from '@/lib/nav/sections/revenueOps';
import { DONATIONS } from '@/lib/nav/sections/donations';
import { FINANCE } from '@/lib/nav/sections/finance';
import { SYSTEM_STATUS } from '@/lib/nav/sections/systemStatus';
import { SETTINGS } from '@/lib/nav/sections/settings';
import { DEV_TOOLS } from '@/lib/nav/sections/devTools';

type NavItem = {
  section: NavSection;
  icon: React.ReactNode;
  // Dev-instance-only item (hidden in prod). The target route 404s off a dev instance anyway;
  // this just keeps it out of the prod nav. Gated on useIsDevInstance() at render.
  devOnly?: boolean;
};

// Sidebar order. Each section's gate, tabs and destination live in its descriptor.
const NAV_ITEMS: NavItem[] = [
  { section: MY_HOUSEHOLD, icon: <IconHome size={18} /> },
  { section: SAFETY, icon: <IconShieldCheck size={18} /> },
  { section: MY_ACTIVITIES, icon: <IconActivity size={18} /> },
  { section: MY_RECEIPTS, icon: <IconReceipt size={18} /> },
  { section: PROGRAMS_I_LEAD, icon: <IconUsersGroup size={18} /> },
  { section: ATTENDANCE, icon: <IconClipboardList size={18} /> },
  { section: PROGRAMS, icon: <IconCalendarEvent size={18} /> },
  { section: COMMUNICATION, icon: <IconMail size={18} /> },
  { section: SHOP_OPS, icon: <IconTool size={18} /> },
  { section: INVENTORY, icon: <IconPackage size={18} /> },
  { section: FACILITY_OPS, icon: <IconBuildingWarehouse size={18} /> },
  { section: MEMBERSHIP_OPS, icon: <IconUsers size={18} /> },
  { section: MEMBERSHIP_AUDIT, icon: <IconUserSearch size={18} /> },
  { section: PROGRAM_OPS, icon: <IconBriefcase size={18} /> },
  { section: REVENUE_OPS, icon: <IconCoin size={18} /> },
  { section: FINANCE, icon: <IconReportMoney size={18} /> },
  { section: DONATIONS, icon: <IconGift size={18} /> },
  { section: SYSTEM_STATUS, icon: <IconSettings size={18} /> },
  { section: SETTINGS, icon: <IconAdjustments size={18} /> },
  { section: INDEX, icon: <IconList size={18} /> },
  { section: DEV_TOOLS, icon: <IconBug size={18} />, devOnly: true },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function ColorSchemeToggle() {
  const { toggleColorScheme } = useMantineColorScheme();
  // ponytail: render both icons, let Mantine's light/darkHidden CSS pick.
  // Branching on the scheme in JS causes an SSR hydration mismatch.
  return (
    <Tooltip label="Toggle color scheme">
      <ActionIcon
        variant="subtle"
        color="gray"
        size="lg"
        aria-label="Toggle color scheme"
        onClick={toggleColorScheme}
      >
        <Box component={IconMoon} size={18} darkHidden />
        <Box component={IconSun} size={18} lightHidden />
      </ActionIcon>
    </Tooltip>
  );
}

function AppFrameInner({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isDevInstance = useIsDevInstance();
  const confirmNav = useConfirmNav();
  // Shared chokepoint for every in-app link in the frame: if the current page has
  // unsaved edits and the user declines the confirm, cancel the navigation.
  const guardNav = (e: { preventDefault: () => void }) => {
    if (!confirmNav()) e.preventDefault();
  };
  const [mobileOpened, { toggle: toggleMobile, close: closeMobile }] = useDisclosure(false);
  // Fetch before any early return so the hook order stays stable (rules of hooks).
  const todoCounts = useTodoCounts(!!session);

  // Kiosk mode (mode=kiosk param or valid cert signature present): render full-screen,
  // no app chrome, cursor hidden — preserves the unattended Raspberry-Pi board behavior.
  const isKioskMode = searchParams.get('mode') === 'kiosk' || !!searchParams.get('sig');
  if (isKioskMode) {
    return <div style={{ minHeight: '100vh', cursor: 'none' }}>{children}</div>;
  }

  const signedIn = !!session;
  const user = session?.user;
  // Faithful to the old NavBar: no navigation on the homepage when signed out.
  const showNav = !(!signedIn && pathname === '/');

  const visibleItems = NAV_ITEMS.filter(
    (item) => sectionShown(item.section, user, todoCounts) && (!item.devOnly || isDevInstance),
  ).map((item) => {
    const { section } = item;
    const tabs = visibleLinks(section, user, todoCounts);
    const href = section.hrefFor?.(user, todoCounts) ?? section.href;
    // Longest href this item claims for the current path, so a path under two
    // sections (/receipts/settings sits under /receipts) highlights only the closer one.
    const match = Math.max(0, ...[href, section.href, ...tabs.flatMap(tabHrefs)].filter((h) => isActive(pathname, h)).map((h) => h.length));
    return { ...item, tabs, href, match };
  });
  const bestMatch = Math.max(0, ...visibleItems.map((i) => i.match));

  // A colored sidebar (brand.nav.sidebar set) ⇒ white nav text + filled active pills.
  const onColoredSidebar = !!brand.nav.sidebar;

  const brandEl = (
    <Link href="/" onNavigate={guardNav} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
      {brand.logo ? (
        // The logo art ships with a baked-in white background, so in dark mode a
        // bare <Image> reads as a stark white rectangle. Framing it as a rounded
        // white chip makes the white deliberate; in light mode the chip is
        // invisible (white on white). Transparency isn't an option — the mark's
        // own colors need the light background.
        <Box
          bg="white"
          px={6}
          py={2}
          style={{ borderRadius: 'var(--mantine-radius-md)', display: 'inline-flex', alignItems: 'center' }}
        >
          <Image src={brand.logo.src} alt={brand.logo.alt} width={brand.logo.width} height={brand.logo.height} priority />
        </Box>
      ) : (
        <Title order={3} tt="lowercase" c={`${brand.nav.accent}.7`}>
          {brand.appName}
        </Title>
      )}
      {isDevInstance && (
        <Badge color="orange" variant="filled" size="sm" radius="sm" aria-label="Development environment">
          DEV
        </Badge>
      )}
    </Link>
  );

  const authButtons = signedIn ? (
    <>
      <Button
        component={Link}
        href="/profile"
        onNavigate={guardNav}
        variant="subtle"
        leftSection={<IconUser size={16} />}
      >
        My Profile
      </Button>
      <Button
        color="red"
        variant="light"
        leftSection={<IconLogout size={16} />}
        onClick={() => signOut({ callbackUrl: '/' })}
      >
        Sign Out
      </Button>
    </>
  ) : (
    <Button onClick={() => signIn('google')}>Sign In To Dashboard</Button>
  );

  return (
    <AppShell
      header={{ height: 60 }}
      footer={{ height: 28 }}
      navbar={
        showNav
          ? { width: 260, breakpoint: 'sm', collapsed: { mobile: !mobileOpened } }
          : undefined
      }
      padding="md"
    >
      <AppShell.Header
        style={isDevInstance ? { borderBottom: '3px solid var(--mantine-color-orange-6)' } : undefined}
      >
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            {showNav && (
              <Burger opened={mobileOpened} onClick={toggleMobile} hiddenFrom="sm" size="sm" />
            )}
            {brandEl}
          </Group>
          <Group gap="xs" wrap="nowrap" visibleFrom="sm">
            <ColorSchemeToggle />
            {authButtons}
          </Group>
          <Group hiddenFrom="sm">
            <ColorSchemeToggle />
          </Group>
        </Group>
      </AppShell.Header>

      {showNav && (
        <AppShell.Navbar
          p="md"
          bg={brand.nav.sidebar}
          // overflowY:auto lets the nav scroll when it outgrows the viewport. The <nav>
          // persists across route changes (only AppShell.Main's children swap), so its
          // scrollTop survives navigation instead of jumping to the top.
          style={{ overflowY: 'auto' }}
        >
          {visibleItems.map((item) => {
            const { section, href, tabs } = item;
            const active = item.match > 0 && item.match === bestMatch;
            // White labels on the colored sidebar; theme default (dark) elsewhere.
            const sidebarText = onColoredSidebar ? 'var(--mantine-color-white)' : undefined;
            // Badge keys off the canonical section href, not the per-role
            // destination — a reviewer-only user's link points at /review, but its
            // badges live under the /membership-ops case.
            const badges = sectionBadges(section.href, tabs, todoCounts);
            return (
              <NavLink
                key={section.id}
                component={Link}
                href={href}
                onNavigate={guardNav}
                label={section.label}
                leftSection={item.icon}
                rightSection={
                  badges.length > 0 ? (
                    <Group gap={4} wrap="nowrap">
                      {badges.map((badge, i) => {
                        // Green action + gray info badges go through the shared CountBadge
                        // (treehouseGreen/black and gray.2/gray-8 respectively). The gray solid
                        // fill is deliberate: on the dark purple sidebar a 'light' translucent
                        // tint reads dark. The 'blue' household-in-building badge is a one-off
                        // info color CountBadge doesn't model, so it stays inline (filled + black
                        // text, same as before). NavLink forces section text white on the colored
                        // sidebar, so the dark label is pinned explicitly.
                        const intent = badgeIntentFor(badge.color);
                        return intent ? (
                          <CountBadge key={i} intent={intent} aria-label={badge.label}>
                            {badge.count}
                          </CountBadge>
                        ) : (
                          <Badge
                            key={i}
                            size="md"
                            color={badge.color}
                            variant="filled"
                            c="var(--mantine-color-black)"
                            aria-label={badge.label}
                          >
                            {badge.count}
                          </Badge>
                        );
                      })}
                    </Group>
                  ) : undefined
                }
                active={active}
                variant="light"
                color={brand.nav.accent}
                onClick={closeMobile}
                mb={4}
                classNames={
                  // Readable hover fill; see globals.css .appframe-sidebar-navlink.
                  onColoredSidebar ? { root: 'appframe-sidebar-navlink' } : undefined
                }
                styles={{
                  root: { borderRadius: 'var(--mantine-radius-md)' },
                  label: { color: sidebarText, fontWeight: 600 },
                  section: { color: sidebarText },
                }}
              />
            );
          })}
          <Group mt="md" hiddenFrom="sm" grow>
            {authButtons}
          </Group>
        </AppShell.Navbar>
      )}

      <AppShell.Main>{children}</AppShell.Main>

      <AppShell.Footer>
        <BuildInfoFooter />
      </AppShell.Footer>
    </AppShell>
  );
}

export default function AppFrame({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh' }}>{children}</div>}>
      <AppFrameInner>{children}</AppFrameInner>
    </Suspense>
  );
}
