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
import { notifications } from "@mantine/notifications";
import { brand } from '@/brand';
import DevLoginPicker from '@/components/DevLoginPicker';
import { useIsDevInstance, useIsLocalInstance } from '@/components/EnvProvider';
import JoinTreehouseBanner from '@/components/JoinTreehouseBanner';
import Notifications from '@/components/Notifications';
import { isCloseChoiceWarning, useCloseChoice, type CloseChoiceAnswer } from '@/components/CloseChoiceDialog';
import { RoleBadge } from '@/components/ui/RoleBadge';
import { PageLoader } from '@/components/ui/PageLoader';

export default function Home() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const isDevInstance = useIsDevInstance();
  const isLocalInstance = useIsLocalInstance();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [isCheckedIn, setIsCheckedIn] = useState<boolean | null>(null);

  const { ask: askCloseChoice, dialog: closeChoiceDialog } = useCloseChoice();

  const [isLastKeyholder, setIsLastKeyholder] = useState(false);
  const [isTwoDeepViolation, setIsTwoDeepViolation] = useState(false);
  // null = not loaded yet; once loaded, status/processStatus drive the join banner.
  const [membership, setMembership] = useState<{ status: string | null; processStatus: string | null } | null>(null);

  const checkAttendanceStatus = useCallback(async () => {
    if (!session?.user) return;
    try {
      const res = await fetch('/api/attendance');
      const data = await res.json();
      const currentUserId = session.user?.id;

      // Works with both "full" and "limited" access responses
      if (data.access === "full") {
        const attendanceList = data.attendance || [];
        const userActiveVisit = attendanceList.find(
          (visit: { participant: { id: number } }) => visit.participant.id === currentUserId
        );
        setIsCheckedIn(!!userActiveVisit);
      } else {
        // Limited access — use self field
        setIsCheckedIn(data.self !== null && data.self !== undefined);
      }

      // Use server-computed safety flags
      if (data.safety) {
        const userIsKeyholder = session.user?.isKeyholder;
        setIsLastKeyholder(data.safety.isLastKeyholder && userIsKeyholder);
        setIsTwoDeepViolation(data.safety.isTwoDeepViolation);
      } else {
        setIsLastKeyholder(false);
        setIsTwoDeepViolation(false);
      }
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

  const handleToggleCheckin = async (answer?: CloseChoiceAnswer) => {
    if (!session?.user) return;
    setLoading(true);
    setMessage("");
    let next: CloseChoiceAnswer | null = null;
    try {
      const participantId = session.user?.id;
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participantId, ...answer })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setMessage(`${data.type === 'checkin' ? 'Successfully checked in!' : 'Successfully checked out!'}`);
        await checkAttendanceStatus(); // Re-fetch the status securely
      } else if (isCloseChoiceWarning(data)) {
        next = await askCloseChoice(data);
      } else {
        setMessage(`Error: ${data.error || 'Failed to update attendance'}`);
      }
    } catch {
      notifications.show({ color: "red", message: "Failed to connect to API", autoClose: false });
    }
    setLoading(false);
    if (next) await handleToggleCheckin(next);
  };

  const user = session?.user;
  const canSelfCheckin =
    !!user?.isSysadmin || !!user?.isBoardMember || !!user?.isKeyholder || isDevInstance;
  const isPrivileged = !!user?.isSysadmin || !!user?.isKeyholder;

  return (
    <Container size="sm" py="xl">
      {closeChoiceDialog}
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
              {isTwoDeepViolation && (
                <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Critical Warning">
                  Two-Deep Compliance is failing. An unaccompanied youth is present without
                  sufficient adult supervision.
                </Alert>
              )}
              {isLastKeyholder && (
                <Alert color="yellow" icon={<IconAlertTriangle size={18} />} title="You are the last Keyholder present.">
                  If others are still recorded inside when you check out, you will be asked
                  whether to close the facility or leave having handed over.
                </Alert>
              )}

              {/* Check-in Toggle Button — in production, only privileged users can self-check-in from the web */}
              {isCheckedIn !== null && canSelfCheckin && (
                <Button
                  size="lg"
                  fullWidth
                  color={isCheckedIn ? 'red' : 'treehouseGreen'}
                  onClick={() => handleToggleCheckin()}
                  loading={loading}
                >
                  {isCheckedIn ? 'Check Out' : 'Check In'}
                </Button>
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

        {message && (
          <Alert mt="lg" variant="light">
            {message}
          </Alert>
        )}
      </Card>
    </Container>
  );
}
