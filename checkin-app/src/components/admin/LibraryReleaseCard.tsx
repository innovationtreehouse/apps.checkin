"use client";

import { useState } from "react";
import { Card, Checkbox, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { LIBRARY_KEYS, LIBRARY_LABELS, type LibraryKey } from "@/lib/libraryRelease";
import { notifyNavRefresh } from "@/lib/nav-refresh";

/** Board-only: release a library's nav entries to everyone. Each toggle saves immediately. */
export function LibraryReleaseCard({ initial }: { initial: readonly string[] }) {
  const [released, setReleased] = useState<string[]>([...initial]);
  const [saving, setSaving] = useState<LibraryKey | null>(null);

  const toggle = async (lib: LibraryKey, on: boolean) => {
    const next = on ? [...released, lib] : released.filter((k) => k !== lib);
    setSaving(lib);
    try {
      const res = await fetch("/api/settings/membership", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releasedLibraries: next }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        notifications.show({ color: "red", message: err?.error ?? "Failed to save" });
        return;
      }
      setReleased(next);
      notifyNavRefresh();
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
