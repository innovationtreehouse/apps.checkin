"use client";

import { Fragment, useState } from "react";
import { Card, Center, Code, Loader, Stack, Table, Text, Title } from "@mantine/core";
import { LoadError } from "@checkin/component-ui";
import { useLoad } from "@/lib/api";

type ErrorLogRow = {
  id: number;
  timestamp: string;
  route: string | null;
  message: string;
  stack: string | null;
  context: unknown;
};

export function ErrorLogPanel() {
  const { data, error, reload } = useLoad<{ errors?: ErrorLogRow[] }>("/api/system-status/errors");
  const [expanded, setExpanded] = useState<number | null>(null);

  if (error) return <LoadError what="the error log" message={error} onRetry={reload} />;
  if (!data) {
    return (
      <Center mih="30vh">
        <Loader />
      </Center>
    );
  }
  const errors = data.errors ?? [];

  if (errors.length === 0) {
    return (
      <Card withBorder radius="md" padding="lg">
        <Text c="green">● No backend errors logged.</Text>
        <Text size="sm" c="dimmed" mt="xs">
          Backend errors captured by logBackendError appear here. Rolling 30-day log.
        </Text>
      </Card>
    );
  }

  return (
    <Card withBorder radius="md" padding="lg">
      <Title order={4} mb="md">Recent Backend Errors</Title>
      <Text c="dimmed" size="sm" mb="md">
        Up to 100 most recent entries (auto-purged after 30 days). Click a row to expand stack/context.
      </Text>
      <Table.ScrollContainer minWidth={600}>
        <Table striped highlightOnHover verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Time</Table.Th>
              <Table.Th>Route</Table.Th>
              <Table.Th>Message</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {errors.map((e) => (
              <Fragment key={e.id}>
                <Table.Tr
                  onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                  style={{ cursor: "pointer" }}
                >
                  <Table.Td style={{ whiteSpace: "nowrap" }}>
                    {new Date(e.timestamp).toLocaleString()}
                  </Table.Td>
                  <Table.Td>{e.route ? <Code>{e.route}</Code> : <Text c="dimmed">—</Text>}</Table.Td>
                  <Table.Td>{e.message}</Table.Td>
                </Table.Tr>
                {expanded === e.id && (
                  <Table.Tr>
                    <Table.Td colSpan={3}>
                      <Stack gap="xs">
                        {e.stack && (
                          <div>
                            <Text size="xs" fw={700} tt="uppercase" c="dimmed">Stack</Text>
                            <Code block fz="xs">{e.stack}</Code>
                          </div>
                        )}
                        {e.context != null && (
                          <div>
                            <Text size="xs" fw={700} tt="uppercase" c="dimmed">Context</Text>
                            <Code block fz="xs">{JSON.stringify(e.context, null, 2)}</Code>
                          </div>
                        )}
                        {!e.stack && e.context == null && (
                          <Text c="dimmed" size="sm">No additional detail.</Text>
                        )}
                      </Stack>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Fragment>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}
