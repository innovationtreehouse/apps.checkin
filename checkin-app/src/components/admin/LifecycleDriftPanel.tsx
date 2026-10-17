"use client";

import { useEffect, useState } from "react";
import { Badge, Card, Center, Group, Loader, Stack, Text } from "@mantine/core";

type LifecycleViolation = {
  model: "ProgramParticipant" | "OrgMembershipProcess";
  key: string;
  status: string;
  invariant: string;
};

/**
 * System Status "Lifecycle" panel: read-only view of
 * the current off-diagram rows across both lifecycle machines, from the same
 * `validate()` the reconciler cron uses. The human face of the reconciler — the
 * board sees drift live, without waiting for the cron email.
 */
export function LifecycleDriftPanel() {
  const [violations, setViolations] = useState<LifecycleViolation[] | null>(null);
  const [scanned, setScanned] = useState<number>(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/system-status/lifecycle");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setViolations(data.violations);
        setScanned(data.scanned);
      } catch {
        setFailed(true);
      }
    })();
  }, []);

  if (failed) return <Text c="red">Failed to load lifecycle status.</Text>;
  if (!violations) {
    return (
      <Center mih="30vh">
        <Loader />
      </Center>
    );
  }

  if (violations.length === 0) {
    return (
      <Card withBorder radius="md" padding="lg">
        <Text c="green">● No off-diagram rows — every lifecycle row validates clean.</Text>
        <Text size="sm" c="dimmed" mt="xs">
          Scanned {scanned} enrollment / membership rows against the state-machine invariants.
          The nightly reconciler auto-heals stranded holds and reports the rest here.
        </Text>
      </Card>
    );
  }

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {violations.length} off-diagram of {scanned} scanned. Enrollment I1 (stranded hold)
        auto-heals on the next reconciler run; the rest need a human.
      </Text>
      {violations.map((v) => (
        <Card key={`${v.model}:${v.key}`} withBorder radius="md" padding="md">
          <Group gap="xs" wrap="wrap">
            <Badge color="red">{v.invariant}</Badge>
            <Badge color="gray" variant="light">{v.model}</Badge>
            <Text size="sm">{v.key}</Text>
            <Text size="xs" c="dimmed">status {v.status}</Text>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}
