"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Center, Group, Loader, Stack, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { SettingsTabs } from "@/components/admin/SettingsTabs";
import { useUnsavedGuard } from "@/components/UnsavedChangesProvider";
import { useRequireRole } from "@/hooks/useRequireRole";

const REALM_PATTERN = /^\d{1,30}$/;

export default function QuickBooksSettingsPage() {
  const { ready, loading: authLoading } = useRequireRole(["isBoardMember"]);

  const [realmId, setRealmId] = useState("");
  const [initial, setInitial] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetch("/api/settings/quickbooks")
        .then(async (res) => {
          if (!res.ok) return;
          const { settings } = (await res.json()) as { settings: { qboProductionRealmId: string | null } };
          setRealmId(settings.qboProductionRealmId ?? "");
          setInitial(settings.qboProductionRealmId ?? "");
        })
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  const isDirty = initial !== null && realmId.trim() !== initial;
  useUnsavedGuard(isDirty);

  const save = async () => {
    const value = realmId.trim();
    if (value && !REALM_PATTERN.test(value)) {
      setError("Enter the numeric QuickBooks company id, or leave blank to turn QuickBooks off.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/settings/quickbooks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qboProductionRealmId: value || null }),
      });
      if (res.ok) {
        notifications.show({ message: "QuickBooks settings saved." });
        await load();
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "Save failed.");
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setSaving(false);
    }
  };

  if (authLoading) return <Center mih="60vh"><Loader /></Center>;
  if (!ready) return null;

  return (
    <Stack>
      <SettingsTabs active="quickbooks" />
      {loading ? (
        <Center py="xl"><Loader /></Center>
      ) : (
        <Card withBorder radius="md" padding="lg">
          <Title order={3} mb="xs">QuickBooks company</Title>
          <Text size="sm" c="dimmed" mb="md">
            The production app reaches only this QuickBooks company. Leave it blank and the app
            never contacts QuickBooks. Every change is recorded in the audit log.
          </Text>
          {initial === "" && (
            <Alert color="blue" variant="light" mb="md">
              <Text size="sm">QuickBooks is off until a company id is set.</Text>
            </Alert>
          )}
          <TextInput
            label="Company id (realm)"
            value={realmId}
            onChange={(e) => setRealmId(e.currentTarget.value)}
            error={error}
            inputMode="numeric"
            autoComplete="off"
          />
          <Group justify="flex-end" mt="md">
            <Button onClick={save} loading={saving} disabled={!isDirty}>
              Save
            </Button>
          </Group>
        </Card>
      )}
    </Stack>
  );
}
