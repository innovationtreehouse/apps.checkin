"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, Group, Stack, Text, Textarea, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { APP_TIMEZONE, formatDate } from "@/lib/time";

type Signing = {
  processId: number;
  status: string;
  contractStarted: boolean;
  signerName: string | null;
  contractSignedAt: string | null;
};

// Board view of a household's agreement signing: who signed, or whose request is
// open, with "Reset signing" to recall a stuck request so another lead can sign.
export function SigningStatusCard({ householdId }: { householdId: number }) {
  const [signing, setSigning] = useState<Signing | null>(null);
  const [resetting, setResetting] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => fetch(`/api/membership-ops/applications/external?householdId=${householdId}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => setSigning(data?.signing ?? null))
    .catch(() => { /* card stays hidden */ }), [householdId]);

  useEffect(() => { load(); }, [load]);

  if (!signing || (!signing.contractSignedAt && !signing.contractStarted)) return null;

  const reset = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/membership-ops/applications/external", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processId: signing.processId, action: "reset-signing", reason }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        notifications.show({ message: "Signing reset. The next lead to click sign gets a new request." });
        setResetting(false);
        setReason("");
        await load();
      } else {
        notifications.show({ color: "red", message: data?.error ?? "Couldn't reset the signing.", autoClose: false });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setSaving(false);
    }
  };

  const who = signing.signerName ?? "A household lead";
  return (
    <Card withBorder padding="md">
      <Stack gap="xs">
        <Title order={5}>Membership agreement</Title>
        {signing.contractSignedAt ? (
          <Text size="sm">
            {signing.signerName ? `Signed by ${signing.signerName}` : "Signed"}, {formatDate(signing.contractSignedAt, { year: "numeric", month: "short", day: "numeric", timeZone: APP_TIMEZONE })}
          </Text>
        ) : (
          <>
            <Text size="sm">{who} started signing and hasn&apos;t finished.</Text>
            {resetting ? (
              <Stack gap="xs">
                <Text size="sm" c="dimmed">
                  Resetting recalls this request. The next lead to click sign gets a new one, which Zoho charges for.
                </Text>
                <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} autosize minRows={2} />
                <Group gap="xs">
                  <Button color="red" size="xs" loading={saving} disabled={!reason.trim()} onClick={reset}>Reset signing</Button>
                  <Button variant="subtle" size="xs" disabled={saving} onClick={() => setResetting(false)}>Cancel</Button>
                </Group>
              </Stack>
            ) : (
              <Button variant="light" size="xs" w="fit-content" onClick={() => setResetting(true)}>Reset signing…</Button>
            )}
          </>
        )}
      </Stack>
    </Card>
  );
}
