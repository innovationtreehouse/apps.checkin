"use client";

import { Button, Group, Stack, Table, Text, Title } from "@mantine/core";
import { LoadError } from "@checkin/component-ui";
import { PageLoader } from "@/components/ui/PageLoader";
import { useOrgTime } from "@/components/TimezoneProvider";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useLoad } from "@/lib/api";
import type { ReceiptFlowStatus, StateCount } from "@/lib/receiptFlow/status";
import { RECEIPT_FLOW_ROLES } from "@/lib/nav/sections/finance";

interface FlowRow {
  section: string;
  state: string;
  label: string;
  count: number | null;
}

function sectionRows(section: string, states: StateCount[] | null | undefined): FlowRow[] {
  if (states === undefined) return [];
  if (states === null) return [{ section, state: "not_set_up", label: "Not set up here.", count: null }];
  return states.map((s) => ({ section, state: s.state, label: s.label, count: s.count }));
}

/** One row per state, in the order the flow runs: receipts, then part mapping, then expenses. */
function flowRows(data: ReceiptFlowStatus): FlowRow[] {
  const receipt = data.receipt && [
    ...data.receipt.states,
    { state: "not_delivered", label: "Receipt finalized, not yet sent to part mapping", count: data.receipt.notDelivered },
  ];
  return [
    ...sectionRows("Receipts", data.receipt === undefined ? undefined : receipt ?? null),
    ...sectionRows("Part mapping", data.receiving?.states ?? null),
    ...sectionRows("Expenses", data.expense === undefined ? undefined : data.expense?.states ?? null),
  ];
}

/** How many receipts, receiving records and expenses sit in each state. Counts only. */
export default function ReceiptFlowStatusPage() {
  const { loading, ready } = useRequireRole(RECEIPT_FLOW_ROLES);
  const { formatDateTime } = useOrgTime();
  const { data, error, reload } = useLoad<ReceiptFlowStatus>(ready ? "/api/receipt-flow/status" : null);

  if (loading) return <PageLoader />;
  if (!ready) return null;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>Receipt flow status</Title>
          {data && <Text size="sm" c="dimmed">As of {formatDateTime(data.asOf)}</Text>}
        </div>
        <Button variant="default" onClick={reload}>Refresh</Button>
      </Group>
      {error && <LoadError what="the counts" message={error} onRetry={reload} />}
      {!data && !error && <PageLoader minHeight="20vh" />}
      {data && !error && (
        <Table striped verticalSpacing={4} aria-label="Records in each state">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Section</Table.Th>
              <Table.Th>State</Table.Th>
              <Table.Th ta="right">Count</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {flowRows(data).map((row) => (
              <Table.Tr key={`${row.section}:${row.state}`}>
                <Table.Td>{row.section}</Table.Td>
                <Table.Td c={row.count === null ? "dimmed" : undefined}>{row.label}</Table.Td>
                <Table.Td ta="right">{row.count}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
