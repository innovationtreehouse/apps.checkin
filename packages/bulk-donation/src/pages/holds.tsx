"use client";
import { Button, Group, Paper, Stack, Table, Text, Title } from "@mantine/core";
import { act, api, useCanWrite, useLoad } from "../components/api";
import LoadError from "../components/LoadError";

interface AccountRule { id: number; companyName: string; corporatePeerCampaign: string }
interface HoldRow {
  id: number;
  disbursementId: string;
  reason: string;
  matchedRows: AccountRule[];
  transaction: { companyName: string | null; corporatePeerCampaign: string | null; donationMethod: string | null; donationType: string | null } | null;
}

/** /donations/holds — disbursements whose gifts match zero or several account rules. */
export default function HoldsPage() {
  const canWrite = useCanWrite();
  const holds = useLoad<HoldRow[]>("/disbursement-holds");
  const groups = new Map<string, HoldRow[]>();
  for (const h of holds.data ?? []) groups.set(h.disbursementId, [...(groups.get(h.disbursementId) ?? []), h]);

  return (
    <>
      <Title order={3} mb="md">Disbursement holds</Title>
      <Text size="sm" c="dimmed" mb="md">Fix the account map, then resubmit the disbursement.</Text>
      {holds.error && <LoadError what="holds" message={holds.error} onRetry={holds.reload} />}
      {holds.data?.length === 0 && <Text c="dimmed">No holds.</Text>}
      <Stack>
        {[...groups].map(([disbursementId, rows]) => (
          <Paper key={disbursementId} withBorder p="md" radius="md">
            <Group justify="space-between" mb="sm">
              <Text fw={600}>Disbursement {disbursementId}</Text>
              {canWrite && (
                <Button size="xs" onClick={() => act(
                  () => api(`/disbursement-holds/${encodeURIComponent(disbursementId)}/resubmit`, { method: "POST" }),
                  "Resubmitted", holds.reload,
                )}>Resubmit</Button>
              )}
            </Group>
            <Table>
              <Table.Thead>
                <Table.Tr><Table.Th>Reason</Table.Th><Table.Th>Company</Table.Th><Table.Th>Campaign</Table.Th><Table.Th>Method / type</Table.Th><Table.Th>Matched rules</Table.Th></Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((h) => (
                  <Table.Tr key={h.id}>
                    <Table.Td>{h.reason}</Table.Td>
                    <Table.Td>{h.transaction?.companyName ?? "—"}</Table.Td>
                    <Table.Td>{h.transaction?.corporatePeerCampaign ?? "—"}</Table.Td>
                    <Table.Td>{[h.transaction?.donationMethod, h.transaction?.donationType].filter(Boolean).join(" / ") || "—"}</Table.Td>
                    <Table.Td>{h.matchedRows.map((r) => `#${r.id} ${r.companyName} / ${r.corporatePeerCampaign}`).join("; ") || "none"}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Paper>
        ))}
      </Stack>
    </>
  );
}
