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
  IconHome,
  IconList,
  IconBug,
  IconLogout,
  IconMail,
  IconMoon,
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
import type { TodoCounts } from '@/app/api/nav/todo-counts/route';
import { navBadgeFor, leadsAnyProgram } from '@/components/navBadges';
import { CountBadge, badgeIntentFor } from '@/components/ui/CountBadge';
import type { SessionUser } from '@/types/auth';
import { FACILITY_SECTION_ROLES } from '@/lib/facilityNav';
import { FINANCE_SECTION_ROLES } from '@/lib/financeNav';
import { MEMBERSHIP_OPS_SECTION_ROLES } from '@/lib/membershipOpsNav';
import { SAFETY_SECTION_ROLES } from '@/lib/safetyNav';
import { SETTINGS_SECTION_ROLES } from '@/lib/settingsNav';

type NavItem = {
  href: string;
  label: string;
  icon: React.ReactNode;
  // counts is passed so computed-role items (e.g. the staff "My Programs" home,
  // gated on leading ≥1 program) can decide visibility from the todo-counts payload.
  visible: (user: SessionUser | undefined, signedIn: boolean, counts: TodoCounts | null) => boolean;
  // Per-role destination override. The hub (/membership-ops) redirects to the admin-only
  // first tab, so a reviewer-only user must be pointed straight at their one reachable tab.
  hrefFor?: (user: SessionUser | undefined) => string;
  // Dev-instance-only item (hidden in prod). The target route 404s off a dev instance anyway;
  // this just keeps it out of the prod nav. Gated on useIsDevInstance() at render, not `visible`.
  devOnly?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { href: '/my-household', label: 'My Household', icon: <IconHome size={18} />, visible: (_u, signedIn) => signedIn },
  {
    href: '/safety',
    label: 'Safety',
    icon: <IconShieldCheck size={18} />,
    visible: (u) => SAFETY_SECTION_ROLES.some((r) => !!u?.[r]),
  },
  { href: '/my-activities', label: 'My Activities', icon: <IconActivity size={18} />, visible: (_u, signedIn) => signedIn },
  {
    // Staff home for program lead mentors — distinct route from the attendee
    // "My Programs" tab at /my-activities/programs. Visible only to someone who
    // leads ≥1 program; that signal rides in on the todo-counts payload the nav
    // already fetches (no new session field).
    href: '/my-programs',
    label: 'My Programs',
    icon: <IconUsersGroup size={18} />,
    visible: (_u, signedIn, counts) => signedIn && leadsAnyProgram(counts),
  },
  { href: '/attendance', label: 'Attendance', icon: <IconClipboardList size={18} />, visible: (_u, signedIn) => signedIn },
  { href: '/programs', label: 'Programs', icon: <IconCalendarEvent size={18} />, visible: () => true },
  { href: '/communication', label: 'Communication', icon: <IconMail size={18} />, visible: (_u, signedIn) => signedIn },
  {
    href: '/shop-ops',
    label: 'Shop Ops',
    icon: <IconTool size={18} />,
    visible: (u) =>
      !!u?.isSysadmin ||
      !!u?.isBoardMember ||
      !!u?.toolStatuses?.some((ts) => ts.level === 'MAY_CERTIFY_OTHERS'),
  },
  {
    href: '/facility-ops',
    label: 'Facility Ops',
    icon: <IconBuildingWarehouse size={18} />,
    // Same union the section layout gates on — operations reach the two aggregate
    // tools (#1633), so they get the nav entry too. Derived, never a second table.
    visible: (u) => FACILITY_SECTION_ROLES.some((r) => !!u?.[r]),
  },
  {
    href: '/membership-ops',
    label: 'Membership Ops',
    icon: <IconUsers size={18} />,
    // Reviewers get in for the Background-check Review tab, operations for Participants;
    // other tabs 403 independently. The hub redirects each to their first visible tab.
    visible: (u) => MEMBERSHIP_OPS_SECTION_ROLES.some((r) => !!u?.[r]),
    // Admins land on the hub (→ first tab); a reviewer-only user has just the Review tab.
    hrefFor: (u) =>
      !u?.isSysadmin && !u?.isBoardMember && u?.isBackgroundCheckReviewer
        ? '/membership-ops/review'
        : '/membership-ops',
  },
  {
    href: '/membership-audit',
    label: 'Membership Audit',
    icon: <IconUserSearch size={18} />,
    visible: (u) => !!u?.isSysadmin || !!u?.isBoardMember,
  },
  {
    href: '/program-ops',
    label: 'Program Ops',
    icon: <IconBriefcase size={18} />,
    visible: (u) => !!u?.isSysadmin || !!u?.isBoardMember,
  },
  {
    href: '/finance-ops',
    label: 'Finance Ops',
    icon: <IconCoin size={18} />,
    // Finance Ops is board-only — sysadmin has no access (issue #1083).
    visible: (u) => FINANCE_SECTION_ROLES.some((r) => !!u?.[r]),
  },
  {
    href: '/system-status',
    label: 'System Status',
    icon: <IconSettings size={18} />,
    visible: (u) => !!u?.isSysadmin || !!u?.isBoardMember,
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: <IconAdjustments size={18} />,
    visible: (u) => SETTINGS_SECTION_ROLES.some((r) => !!u?.[r]),
  },
  { href: '/index', label: 'Index', icon: <IconList size={18} />, visible: (_u, signedIn) => signedIn },
  // Dev tools (dev instances only) — a single entry into the /dev tab section:
  // captured email inbox (EMAIL_DEV_MOCK.md) + Zoho Sign mock
  // (docs/ops/contract-signing-mock.md).
  { href: '/dev', label: 'Debug', icon: <IconBug size={18} />, visible: (_u, signedIn) => signedIn, devOnly: true },
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
    (item) => item.visible(user, signedIn, todoCounts) && (!item.devOnly || isDevInstance),
  );

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
            const href = item.hrefFor?.(user) ?? item.href;
            const active = isActive(pathname, href);
            // White labels on the colored sidebar; theme default (dark) elsewhere.
            const sidebarText = onColoredSidebar ? 'var(--mantine-color-white)' : undefined;
            // Badge keys off the canonical section href, not the per-role
            // destination — a reviewer-only user's link points at /review, but its
            // badges live under the /membership-ops case.
            const badges = navBadgeFor(item.href, todoCounts);
            return (
              <NavLink
                key={item.href}
                component={Link}
                href={href}
                onNavigate={guardNav}
                label={item.label}
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
