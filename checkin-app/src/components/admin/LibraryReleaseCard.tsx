"use client";

import { useState } from "react";
import { Card, Checkbox, Stack, Text, Title } from "@mantine/core";
import { errorMessage, showError } from "@checkin/component-ui";
import { api } from "@/lib/api";
import { LIBRARY_KEYS, LIBRARY_LABELS, type LibraryKey } from "@/lib/libraryRelease";
import { notifyNavRefresh } from "@/lib/nav-refresh";

/** Board-only: release a library's nav entries to everyone. Each toggle saves immediately. */
export function LibraryReleaseCard({ initial }: { initial: readonly string[] }) {
  const [released, setReleased] = useState<string[]>([...initial]);
  const [saving, setSaving] = useState<LibraryKey | null>(null);

  const toggle = async (lib: LibraryKey, on: boolean) => {
    setSaving(lib);
    try {
      const { settings } = await api<{ settings: { releasedLibraries: string[] } }>("/api/settings/membership", {
        method: "PUT",
        body: JSON.stringify({ perYearVariantClient: true, releaseLibrary: { library: lib, released: on } }),
      });
      setReleased(settings.releasedLibraries);
      notifyNavRefresh();
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card withBorder radius="md" padding="lg">
      <Title order={3} mb="xs">Library release</Title>
      <Text size="sm" c="dimmed" mb="md">
        Until released, a library&apos;s menu entries and tabs show only to board members. Its pages still
        open for anyone their role admits.
      </Text>
      <Stack gap="xs">
        {LIBRARY_KEYS.map((lib) => (
          <Checkbox
            key={lib}
            label={`${LIBRARY_LABELS[lib]} — Visible to everyone`}
            checked={released.includes(lib)}
            disabled={saving !== null}
            onChange={(e) => toggle(lib, e.currentTarget.checked)}
          />
        ))}
      </Stack>
    </Card>
  );
}
