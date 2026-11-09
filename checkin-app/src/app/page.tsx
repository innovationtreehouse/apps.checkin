"use client";

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useSession, signIn } from "next-auth/react";
import {
  Alert,
  Button,
  Card,
  Container,
  Divider,
  Group,
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

export default function Home() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const isDevInstance = useIsDevInstance();
  const isLocalInstance = useIsLocalInstance();

  const [isLastKeyholder, setIsLastKeyholder] = useState(false);
  const [isTwoDeepViolation, setIsTwoDeepViolation] = useState(false);
  // Set (to the kiosk's last-seen time and backlog) when a warning would show but
  // the kiosk is unreachable or still syncing, so the building state behind it can't be confirmed.
  const [unconfirmedSince, setUnconfirmedSince] = useState<{ lastSeenAt: string | null; queued: number } | null>(null);
  // null = not loaded yet; once loaded, status/processStatus drive the join banner.
  const [membership, setMembership] = useState<{ status: string | null; processStatus: string | null } | null>(null);

  const checkAttendanceStatus = useCallback(async () => {
    if (!session?.user) return;
    try {
      const res = await fetch('/api/attendance');
      const data = await res.json();

      // Use server-computed safety flags
      const lastKeyholder = Boolean(data.safety?.isLastKeyholder && session.user?.isKeyholder);
      const twoDeep = Boolean(data.safety?.isTwoDeepViolation);
      const reachable = data.building?.reachable === true;
      setIsLastKeyholder(reachable && lastKeyholder);
      setIsTwoDeepViolation(reachable && twoDeep);
      setUnconfirmedSince(!reachable && (lastKeyholder || twoDeep)
        ? { lastSeenAt: data.building?.lastSeenAt ?? null, queued: data.building?.queued ?? 0 }
        : null);
    } catch (err) {
      console.error("Failed to fetch attendance status", err);
    }
  }, [session]);

  useEffect(() => {
    // Async fetch that syncs React state from the server; state is set in the
    // promise continuation, not synchronously in this effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    checkAttendanceStatus();
  }, [checkAttendanceStatus]);

  useEffect(() => {
    if (!session?.user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMembership(null);
      return;
    }
    let cancelled = false;
    fetch('/api/membership')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setMembership({ status: data.membershipStatus ?? null, processStatus: data.process?.status ?? null });
        }
      })
      .catch(() => { /* non-blocking: leave banner hidden on error */ });
    return () => { cancelled = true; };
  }, [session]);

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
              {membership && membership.status !== 'ACTIVE' && (
                <JoinTreehouseBanner processStatus={membership.processStatus} />
              )}

              {/* In-app red-dot indicators (membership reviewer queue / blocked apps, …) */}
              <Notifications />

              {/* Operational Warnings */}
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
