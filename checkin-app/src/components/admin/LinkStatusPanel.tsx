"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Center,
  Code,
  Group,
  Loader,
  Stack,
  Text,
} from "@mantine/core";

type IntegrationError = {
  id: number;
  source: string;
  message: string;
  context: unknown;
  timestamp: string;
  resolvedAt: string | null;
};

export function LinkStatusPanel() {
  const [errors, setErrors] = useState<IntegrationError[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  function load() {
    return fetch("/api/system-status/links")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setErrors(data.errors);
      })
      .catch(() => {
        setFailed(true);
      });
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleResolved(e: IntegrationError) {
    setBusyId(e.id);
    try {
      await fetch(`/api/system-status/links/${e.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolved: !e.resolvedAt }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  if (failed) return <Text c="red">Failed to load link status.</Text>;
  if (!errors) {
    return (
      <Center mih="30vh">
        <Loader />
      </Center>
    );
  }

  if (errors.length === 0) {
    return (
      <Card withBorder radius="md" padding="lg">
        <Text c="green">● No integration errors logged.</Text>
        <Text size="sm" c="dimmed" mt="xs">
          External-link failures (e.g. Shopify) appear here. Rolling 90-day log.
        </Text>
      </Card>
    );
  }

  return (
    <Stack>
      {errors.map((e) => (
        <Card key={e.id} withBorder radius="md" padding="md">
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Stack gap={4} style={{ minWidth: 0 }}>
              <Group gap="xs">
                <Badge color={e.resolvedAt ? "gray" : "red"}>{e.source}</Badge>
                {e.resolvedAt && (
                  <Badge variant="light">
                    Resolved
                  </Badge>
                )}
                <Text size="xs" c="dimmed">
                  {new Date(e.timestamp).toLocaleString()}
                </Text>
              </Group>
              <Text size="sm">{e.message}</Text>
              {e.context != null && (
                <Code block fz="xs">
                  {JSON.stringify(e.context, null, 2)}
                </Code>
              )}
            </Stack>
            <Button
              size="xs" fz={15}
              variant={e.resolvedAt ? "subtle" : "light"}
              loading={busyId === e.id}
              onClick={() => toggleResolved(e)}
            >
              {e.resolvedAt ? "Reopen" : "Mark resolved"}
            </Button>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}
