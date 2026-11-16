"use client";

import { useState } from "react";
import { Anchor, Button, Card, Checkbox, Group, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useLoad } from "@/lib/api";
import { notifyNavRefresh } from "@/lib/nav-refresh";
import { apiError, type OwnBackgroundCheck } from "./useMembershipPage";

interface CheckStartedRow {
  personId: number;
  name: string | null;
  state: "NEEDS_MARKING" | "NOTHING_TO_DO";
}

/**
 * The /membership "Background checks" panel: the caller's own check and, for a
 * household lead, each other adult in the household, each either needing its check
 * marked started or with nothing to do. Families cannot dismiss a mark.
 */
export default function BackgroundChecksPanel({ selfId, ownCheck, onMarked }: { selfId: number; ownCheck: OwnBackgroundCheck; onMarked: () => void }) {
  const { data, reload } = useLoad<{ rows?: CheckStartedRow[] }>("/api/membership/check-started", { keepPrevious: true });
  const rows = data?.rows;
  const [confirmed, setConfirmed] = useState<Set<number>>(new Set());
  const [busyId, setBusyId] = useState<number | null>(null);
  const [ownStarted, setOwnStarted] = useState(ownCheck.checkStarted);

  const mark = async (personId: number) => {
    setBusyId(personId);
    try {
      const res = await fetch("/api/membership/check-started", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        await reload();
        if (personId === selfId) setOwnStarted(true);
        notifyNavRefresh();
        onMarked();
      } else {
        notifications.show({ color: "red", message: apiError(data, "Could not mark the check started. Please try again."), autoClose: false });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error. The check was not marked started; please try again.", autoClose: false });
    } finally {
      setBusyId(null);
    }
  };

  if (!rows?.length) return null;
  const toolLink = ownCheck.deepLinkUrl ? (
    <Anchor href={ownCheck.deepLinkUrl} target="_blank" rel="noopener noreferrer" size="sm">
      Open the background-check tool →
    </Anchor>
  ) : (
    <Text size="sm" c="dimmed">The background-check link isn&apos;t available yet. Please check back shortly.</Text>
  );

  return (
    <Card withBorder radius="md" padding="lg" mb="lg" maw={640}>
      <Title order={2}>Background checks</Title>
      <Stack gap="md" mt="sm">
        {rows.map((row) => {
          const own = row.personId === selfId;
          const label = own ? "You" : row.name || `Person #${row.personId}`;
          return (
            <Stack key={row.personId} gap="xs" align="flex-start">
              <Text fw={600}>{label}</Text>
              {row.state === "NEEDS_MARKING" ? (
                <>
                  {toolLink}
                  <Checkbox
                    label={own ? "I've started my check in the background-check tool" : "I've started this check in the background-check tool"}
                    checked={confirmed.has(row.personId)}
                    disabled={busyId === row.personId}
                    onChange={(e) => {
                      const next = new Set(confirmed);
                      if (e.currentTarget.checked) next.add(row.personId); else next.delete(row.personId);
                      setConfirmed(next);
                    }}
                  />
                  <Group>
                    <Button size="sm" disabled={!confirmed.has(row.personId)} loading={busyId === row.personId} onClick={() => mark(row.personId)}>
                      Mark check started
                    </Button>
                  </Group>
                </>
              ) : own && ownStarted ? (
                <Text c="green">Your check is marked started. The reviewers take it from here.</Text>
              ) : (
                <Text c="dimmed">Nothing to do.</Text>
              )}
            </Stack>
          );
        })}
      </Stack>
    </Card>
  );
}
