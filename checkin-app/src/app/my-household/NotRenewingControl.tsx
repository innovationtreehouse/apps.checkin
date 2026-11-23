"use client";

import { useState } from 'react';
import { errorMessage, showError, showSuccess } from '@checkin/component-ui';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { api } from '@/lib/api';
import { formatDateOnly } from '@/lib/time';

/** A lead says the household won't renew, or takes it back; the membership itself is untouched. */
export default function NotRenewingControl({ noted, validUntil }: { noted: boolean; validUntil: string | null }) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const send = async (method: 'POST' | 'DELETE') => {
    setSaving(true);
    try {
      await api('/api/membership/not-renewing', { method });
      showSuccess(method === 'POST' ? "We've told the Board you won't be renewing." : "Your renewal reminders will resume.");
      setConfirming(false);
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (noted) {
    return (
      <Alert color="gray" mb="lg">
        <Group justify="space-between" align="center" wrap="wrap">
          <Text>You&apos;ve told the Board you won&apos;t be renewing. You can still renew at any time.</Text>
          <Button size="xs" fz={15} variant="default" loading={saving} onClick={() => send('DELETE')}>Undo</Button>
        </Group>
      </Alert>
    );
  }

  if (!confirming) {
    return (
      <Group mb="lg">
        <Button size="xs" fz={15} variant="subtle" color="gray" onClick={() => setConfirming(true)}>We won&apos;t be renewing</Button>
      </Group>
    );
  }

  const through = validUntil ? formatDateOnly(validUntil, { year: 'numeric', month: 'short', day: 'numeric' }) : null;
  return (
    <Alert color="gray" mb="lg" title="Tell the Board you won't be renewing?">
      <Stack gap="xs">
        <Text size="sm">
          Your membership continues {through ? `through ${through}` : 'to the end of the year you have paid for'}, and
          renewal emails stop. You can change your mind and renew at any time from this page.
        </Text>
        <Group>
          <Button size="xs" fz={15} color="gray" loading={saving} onClick={() => send('POST')}>Yes, tell the Board</Button>
          <Button size="xs" fz={15} variant="default" disabled={saving} onClick={() => setConfirming(false)}>Cancel</Button>
        </Group>
      </Stack>
    </Alert>
  );
}
