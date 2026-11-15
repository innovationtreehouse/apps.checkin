"use client";

import { useRouter } from 'next/navigation';
import { useSession, signIn } from "next-auth/react";
import {
  Alert,
  Button,
  Card,
  Container,
  Divider,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconAddressBook,
  IconUrgent,
} from '@tabler/icons-react';
import { brand } from '@/brand';
import DevLoginPicker from '@/components/DevLoginPicker';
import { useIsDevInstance, useIsLocalInstance } from '@/components/EnvProvider';
import JoinTreehouseBanner from '@/components/JoinTreehouseBanner';
import Notifications from '@/components/Notifications';
import { RoleBadge } from '@/components/ui/RoleBadge';
import { PageLoader } from '@/components/ui/PageLoader';
import { BuildingUnconfirmedAlert } from '@/components/BuildingUnconfirmedAlert';
import { LoadError } from '@checkin/component-ui';
import { useLoad } from '@/lib/api';
import { useFreshRead } from '@/hooks/useFreshRead';

type AttendanceAnswer = {
  safety?: { isLastKeyholder?: boolean; isTwoDeepViolation?: boolean };
  building?: { reachable?: boolean; lastSeenAt?: string | null; queued?: number };
};

export default function Home() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const isDevInstance = useIsDevInstance();
  const isLocalInstance = useIsLocalInstance();

  const membership = useLoad<{ membershipStatus?: string | null; process?: { status?: string | null } | null }>(
    session?.user ? '/api/membership' : null,
    { expireOn401: false },
  );

  // No auto-retry: a pending retry shows nothing, and a keyholder must see that the check failed.
  const attendancePath = session?.user ? '/api/attendance' : null;
  const attendance = useLoad<AttendanceAnswer>(attendancePath, { retry: false, expireOn401: false });
  // A cached answer may be old, so the page says it is still checking until this visit's read answers.
  const { fresh, retry: retryAttendance } = useFreshRead(attendancePath, attendance.reload);
  const safety = attendance.data;
  const lastKeyholder = Boolean(safety?.safety?.isLastKeyholder && session?.user?.isKeyholder);
  const twoDeep = Boolean(safety?.safety?.isTwoDeepViolation);
  const reachable = safety?.building?.reachable === true;
  const isLastKeyholder = reachable && lastKeyholder;
  const isTwoDeepViolation = reachable && twoDeep;
  // The kiosk is unreachable or still syncing, so the building state behind a warning can't be confirmed.
  const unconfirmedSince = !reachable && (lastKeyholder || twoDeep)
    ? { lastSeenAt: safety?.building?.lastSeenAt ?? null, queued: safety?.building?.queued ?? 0 }
    : null;

  // While the session is still resolving, `session` is undefined — rendering the
  // ternary below as-is would flash the signed-out landing at a signed-in user.
  if (status === "loading") return <PageLoader />;


  const user = session?.user;
  const isPrivileged = !!user?.isSysadmin || !!user?.isKeyholder;

  return (
    <Container size="sm" py="xl">
      <Card withBorder shadow="sm" radius="md" padding="xl">
        <Stack align="center" gap="xs" mb="lg">
          <Title order={1} ta="center">
            {isDevInstance ? `${brand.home.title} (dev)` : brand.home.title}
          </Title>
          <Text c="dimmed" size="lg" ta="center">
            {brand.home.subtitle}
          </Text>
        </Stack>

        <Stack>
          {session ? (
            <>
              <Paper withBorder radius="md" p="md">
                <Text ta="center">
                  Welcome back, <strong>{session.user?.name || session.user?.email}</strong>!
                </Text>
                {(user?.isSysadmin || user?.isKeyholder) && (
                  <Group justify="center" gap="xs" mt="xs">
                    {user?.isSysadmin && <RoleBadge role="isSysadmin" />}
                    {user?.isKeyholder && <RoleBadge role="isKeyholder" />}
                  </Group>
                )}
              </Paper>

              {/* Visitor call-to-action — only for non-members; copy reflects in-flight state */}
              {membership.error && (
                <LoadError what="your membership status" message={membership.error} onRetry={membership.reload} />
              )}
              {membership.data && membership.data.membershipStatus !== 'ACTIVE' && (
                <JoinTreehouseBanner processStatus={membership.data.process?.status ?? null} />
              )}

              {/* In-app red-dot indicators (membership reviewer queue / blocked apps, …) */}
              <Notifications />

              {/* Operational Warnings */}
              {attendance.error && (
                <LoadError
                  what="the building safety check"
                  message={`${attendance.error} Two-deep and last-keyholder warnings can't show until it loads.`}
                  onRetry={retryAttendance}
                />
              )}
              {attendancePath && !fresh && !attendance.error && (
                <Group gap="xs" role="status">
                  <Loader size="xs" />
                  <Text size="sm" c="dimmed">Checking building safety…</Text>
                </Group>
              )}
              {unconfirmedSince && <BuildingUnconfirmedAlert lastSeenAt={unconfirmedSince.lastSeenAt} queued={unconfirmedSince.queued} />}
              {isTwoDeepViolation && (
                <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Critical Warning">
                  Two-Deep Compliance is failing. An unaccompanied youth is present without
                  sufficient adult supervision.
                </Alert>
              )}
              {isLastKeyholder && (
                <Alert color="yellow" icon={<IconAlertTriangle size={18} />} title="You are the last Keyholder present.">
                  If others are still recorded inside when you badge out at the kiosk, it will
                  offer to close the building.
                </Alert>
              )}

              {/* Board Directory Button for Keyholders/Admins */}
              {isPrivileged && (
                <>
                  <Button
                    variant="default"
                    fullWidth
                    leftSection={<IconAddressBook size={18} />}
                    onClick={() => router.push('/safety/board-contacts')}
                  >
                    View Board Directory
                  </Button>
                  <Button
                    variant="light"
                    color="red"
                    fullWidth
                    leftSection={<IconUrgent size={18} />}
                    onClick={() => router.push('/safety')}
                  >
                    Emergency Contacts
                  </Button>
                </>
              )}
            </>
          ) : (
            <Stack align="center">
              <Text c="dimmed" ta="center">
                Explore our upcoming events and sign up, or sign in to access your dashboard.
              </Text>

              <Button
                size="md"
                onClick={() => router.push('/programs')}
                style={{ maxWidth: 300, width: '100%' }}
              >
                See Public Programs
              </Button>

              <Divider label="OR" labelPosition="center" w="100%" maw={300} />

              <Button
                size="md"
                onClick={() => signIn('google')}
                style={{ maxWidth: 300, width: '100%' }}
              >
                Sign In To Dashboard
              </Button>
              {isLocalInstance && <DevLoginPicker />}
            </Stack>
          )}
        </Stack>
      </Card>
    </Container>
  );
}
