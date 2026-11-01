"use client";

import { useState } from "react";
import { Button, Card, Center, Group, Loader, Select, Stack, Text, Title } from "@mantine/core";
import { SettingsTabs } from "@/components/admin/SettingsTabs";
import { AlertBanner } from "@/components/admin/AlertBanner";
import { notifications } from "@mantine/notifications";
import { LoadError } from "@checkin/component-ui";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useSeedForm } from "@/hooks/useSeedForm";
import { useLoad } from "@/lib/api";
import { LOCALIZATION_ROLES } from "@/lib/nav/sections/settings";
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
  const { ready, loading: authLoading } = useRequireRole(LOCALIZATION_ROLES);

  const [timezone, setTimezone] = useState("America/Chicago");
  const [locale, setLocale] = useState("en-US");

  // Snapshot of the values as last loaded/saved; isDirty compares it to current
  // state to drive the unsaved-changes guard.
  const [initial, setInitial] = useState<Record<string, string> | null>(null);

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const flash = (m: string) => setMessage(m);

  const { data, error, reload } = useLoad<{ settings: Settings }>(ready ? "/api/admin/settings/localization" : null);

  const saveSettings = async () => {
    setSaving(true);
    flash("");
    try {
      const res = await fetch("/api/admin/settings/localization", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone, locale }),
      });
      if (res.ok) { notifications.show({ message: "Settings saved." }); setInitial({ timezone, locale }); reload(); }
      else { const d = await res.json().catch(() => ({})); flash(d.error || "Save failed."); }
    } catch { notifications.show({ color: "red", message: "Network error.", autoClose: false }); }
    finally { setSaving(false); }
  };

  const isDirty = !!initial && !shallowEqual(initial, { timezone, locale });
  useUnsavedGuard(isDirty);
  useSeedForm(data, isDirty, ({ settings }) => {
    setTimezone(settings.timezone);
    setLocale(settings.locale);
    setInitial({ timezone: settings.timezone, locale: settings.locale });
  });

  if (authLoading) return <PageLoader />;
  if (!ready) return null; // redirect in flight

  return (
    <Stack>
      <SettingsTabs active="localization" />

      <AlertBanner message={message} tone="error" />

      {error && <LoadError what="the localization settings" message={error} onRetry={reload} />}

      {!data ? (
        !error && <Center py="xl"><Loader /></Center>
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
