"use client";

import { Badge, Center, Group, Loader, Stack, Table, Text } from "@mantine/core";
import { LoadError } from "@checkin/component-ui";
import { useLoad } from "@/lib/api";
import { usePolling, POLL_IDLE_STOP_MS } from "@/hooks/usePolling";
import { useOrgTime } from "@/components/TimezoneProvider";
import { linesByCode, type FaultCodeRow } from "@/lib/quickbooks/faultCodeLines";

const KIND_COLOR: Record<string, string> = {
  system: "gray",
  connection: "orange",
  settings: "yellow",
  data: "blue",
  bug: "red",
};

const REFRESH_MS = 60_000;

export default function QboCodesPage() {
  const { data, error, reload } = useLoad<{ codes: FaultCodeRow[] }>("/api/quickbooks/fault-codes", { keepPrevious: true });
  const { formatDate, formatDateTime } = useOrgTime();
  usePolling(() => void reload(), REFRESH_MS, { idleStopMs: POLL_IDLE_STOP_MS });

  const lines = data ? linesByCode(data.codes) : [];

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Every fault code QuickBooks has sent us, and how the app sorted it.
      </Text>
      {error ? (
        <LoadError what="the QuickBooks codes" message={error} onRetry={reload} />
      ) : !data ? (
        <Center mih="30vh">
          <Loader />
        </Center>
      ) : lines.length === 0 ? (
        <Text c="dimmed" size="sm">
          QuickBooks hasn&apos;t refused anything yet.
        </Text>
      ) : (
        <Table striped withTableBorder verticalSpacing={6} fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Code</Table.Th>
              <Table.Th>Sorted as</Table.Th>
              <Table.Th>Seen</Table.Th>
              <Table.Th>First seen</Table.Th>
              <Table.Th>Last seen</Table.Th>
              <Table.Th>Last lane</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {lines.map((line) => (
              <Table.Tr key={line.code}>
                <Table.Td>{line.code}</Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {line.kinds.map(({ kind, count }) => (
                      <Badge key={kind} color={KIND_COLOR[kind] ?? "gray"} variant="light">
                        {kind} {count}
                      </Badge>
                    ))}
                  </Group>
                </Table.Td>
                <Table.Td>{line.count}</Table.Td>
                <Table.Td>{formatDate(line.firstSeenAt, { day: "numeric", month: "short", year: "numeric" })}</Table.Td>
                <Table.Td>{formatDateTime(line.lastSeenAt, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</Table.Td>
                <Table.Td>{line.lastLane}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
