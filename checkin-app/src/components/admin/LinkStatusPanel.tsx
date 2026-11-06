"use client";

import { useState } from "react";
import { errorMessage, LoadError, showError } from "@checkin/component-ui";
import { api, useLoad } from "@/lib/api";
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
  const { data, error, reload } = useLoad<{ errors: IntegrationError[] }>("/api/system-status/links");
  const errors = data?.errors ?? null;
  const [busyId, setBusyId] = useState<number | null>(null);

  async function toggleResolved(e: IntegrationError) {
    setBusyId(e.id);
    try {
      await api(`/api/system-status/links/${e.id}`, {
        method: "PATCH",
        body: JSON.stringify({ resolved: !e.resolvedAt }),
      });
    } catch (err) {
      showError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  if (error) return <LoadError what="link status" message={error} onRetry={reload} />;
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
