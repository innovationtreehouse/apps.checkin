"use client";

import { useState, useEffect, useCallback } from "react";
import { Button, Card, Center, Group, Loader, Select, Stack, Text, Title } from "@mantine/core";
import { SettingsTabs } from "@/components/admin/SettingsTabs";
import { AlertBanner } from "@/components/admin/AlertBanner";
import { notifications } from "@mantine/notifications";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useUnsavedGuard, shallowEqual } from "@/components/UnsavedChangesProvider";

import { PageLoader } from "@/components/ui/PageLoader";
interface Settings {
  timezone: string;
  locale: string;
}

// IANA zones from the runtime; falls back to the app default if unavailable.
const TZ_OPTIONS = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["America/Chicago"];
  }
})();

// Common locales; the API still accepts any valid BCP-47 value.
const LOCALE_OPTIONS = [
  { value: "en-US", label: "English (United States)" },
  { value: "en-GB", label: "English (United Kingdom)" },
  { value: "en-CA", label: "English (Canada)" },
  { value: "es-US", label: "Spanish (United States)" },
  { value: "es-MX", label: "Spanish (Mexico)" },
  { value: "fr-CA", label: "French (Canada)" },
];

export default function LocalizationSettingsPage() {
  // Stricter than the /settings layout (isSysadmin OR board): localization is isSysadmin-only.
  const { ready, loading: authLoading } = useRequireRole(["isSysadmin"]);

  const [timezone, setTimezone] = useState("America/Chicago");
  const [locale, setLocale] = useState("en-US");

  // Snapshot of the values as last loaded/saved; isDirty compares it to current
  // state to drive the unsaved-changes guard.
  const [initial, setInitial] = useState<Record<string, string> | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const flash = (m: string) => setMessage(m);

  const load = useCallback(() => fetch("/api/admin/settings/localization")
    .then(async (res) => {
      if (res.ok) {
        const { settings } = (await res.json()) as { settings: Settings };
        setTimezone(settings.timezone);
        setLocale(settings.locale);
        setInitial({ timezone: settings.timezone, locale: settings.locale });
      }
    })
    .finally(() => {
      setLoading(false);
    }),
  []);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  const saveSettings = async () => {
    setSaving(true);
    flash("");
    try {
      const res = await fetch("/api/admin/settings/localization", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone, locale }),
      });
      if (res.ok) { notifications.show({ message: "Settings saved." }); setLoading(true); await load(); }
      else { const d = await res.json().catch(() => ({})); flash(d.error || "Save failed."); }
    } catch { notifications.show({ color: "red", message: "Network error.", autoClose: false }); }
    finally { setSaving(false); }
  };

  const isDirty = !!initial && !shallowEqual(initial, { timezone, locale });
  useUnsavedGuard(isDirty);

  if (authLoading) return <PageLoader />;
  if (!ready) return null; // redirect in flight

  return (
    <Stack>
      <SettingsTabs active="localization" />

      <AlertBanner message={message} tone="error" />

      {loading ? (
        <Center py="xl"><Loader /></Center>
      ) : (
        <Card withBorder radius="md" padding="lg">
          <Title order={3} mb="md">Localization</Title>
          <Text c="dimmed" mb="lg">
            Region settings for the whole app. The timezone governs how event times are
            saved and shown; the locale governs date and number formatting.
          </Text>
          <Group align="flex-end" gap="lg" wrap="wrap">
            <Select
              label="Timezone"
              description="IANA zone for event times."
              searchable
              w={300}
              data={TZ_OPTIONS}
              value={timezone}
              onChange={(v) => v && setTimezone(v)}
            />
            <Select
              label="Locale"
              description="Date & number formatting."
              w={260}
              data={LOCALE_OPTIONS}
              value={locale}
              onChange={(v) => v && setLocale(v)}
            />
          </Group>
          <Button mt="lg" disabled={saving} loading={saving} onClick={saveSettings} style={{ alignSelf: "flex-start" }}>
            Save settings
          </Button>
        </Card>
      )}
    </Stack>
  );
}
