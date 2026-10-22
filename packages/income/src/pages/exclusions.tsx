"use client";
import { useState } from "react";
import { Button, Code, Group, Table, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, useIsFinance, useLoad } from "../components/api";
import LoadError from "../components/LoadError";

interface ExclusionRow {
  id: number;
  qbTxnId: string;
  reason: string;
  excludedAt: string;
}

/**
 * /income/exclusions — QuickBooks deposits finance removed from matching for good (e.g. a
 * check deposit whose amount collides with a payout). There is no undo.
 */
export default function ExclusionsPage() {
  const rows = useLoad<ExclusionRow[]>("/qb-exclusions");
  const isFinance = useIsFinance();
  const [qbTxnId, setQbTxnId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function exclude() {
    setBusy(true);
    try {
      await api("/qb-exclusions", { method: "POST", body: JSON.stringify({ qbTxnId, reason }) });
      notifications.show({ message: "Deposit excluded for good", color: "green" });
      setQbTxnId("");
      setReason("");
      rows.reload();
    } catch (err) {
      notifications.show({ message: errorMessage(err), color: "red" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Title order={3} mb="md">QuickBooks Exclusions</Title>
      {isFinance && (
        <Group gap="xs" align="end" mb="md">
          <TextInput size="xs" label="QuickBooks deposit id" value={qbTxnId} onChange={(e) => setQbTxnId(e.currentTarget.value)} />
          <TextInput size="xs" label="Reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} w={320} />
          <Button size="xs" color="red" disabled={busy || !qbTxnId.trim() || !reason.trim()} onClick={exclude}>Exclude permanently</Button>
        </Group>
      )}
      {rows.error && <LoadError what="exclusions" message={rows.error} onRetry={rows.reload} />}
      {rows.data === null ? <Text c="dimmed">Loading…</Text>
        : rows.data.length === 0 ? <Text c="dimmed">No deposits excluded.</Text>
        : (
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Excluded</Table.Th>
                <Table.Th>Deposit</Table.Th>
                <Table.Th>Reason</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.data.map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td>{new Date(r.excludedAt).toLocaleString()}</Table.Td>
                  <Table.Td><Code>{r.qbTxnId}</Code></Table.Td>
                  <Table.Td>{r.reason}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
    </>
  );
}
