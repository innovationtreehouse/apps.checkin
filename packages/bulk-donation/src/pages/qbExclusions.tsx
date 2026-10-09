"use client";
import { useState } from "react";
import { Button, Group, Paper, Table, TextInput, Title } from "@mantine/core";
import { act, api, useCanWrite, useLoad, when } from "../components/api";
import LoadError from "../components/LoadError";

interface ExclusionRow { id: number; qbTxnId: string; reason: string; excludedAt: string }

/** /donations/qb-exclusions — QuickBooks entries finance removed from matching for good. */
export default function QbExclusionsPage() {
  const canWrite = useCanWrite();
  const rows = useLoad<ExclusionRow[]>("/qb-exclusions");
  const [qbTxnId, setQbTxnId] = useState("");
  const [reason, setReason] = useState("");

  async function add() {
    const ok = await act(
      () => api("/qb-exclusions", { method: "POST", body: JSON.stringify({ qbTxnId, reason }) }),
      "Excluded", rows.reload,
    );
    if (ok) { setQbTxnId(""); setReason(""); }
  }

  return (
    <>
      <Title order={3} mb="md">QuickBooks exclusions</Title>
      {canWrite && (
        <Paper withBorder p="md" radius="md" mb="md" maw={640}>
          <Group align="flex-end">
            <TextInput label="QuickBooks transaction id" value={qbTxnId} onChange={(e) => setQbTxnId(e.currentTarget.value)} />
            <TextInput label="Reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} style={{ flex: 1 }} />
            <Button onClick={add} disabled={!qbTxnId.trim() || !reason.trim()}>Exclude</Button>
          </Group>
        </Paper>
      )}
      {rows.error && <LoadError what="exclusions" message={rows.error} onRetry={rows.reload} />}
      <Table striped>
        <Table.Thead>
          <Table.Tr><Table.Th>QuickBooks id</Table.Th><Table.Th>Reason</Table.Th><Table.Th>Excluded</Table.Th></Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(rows.data ?? []).map((r) => (
            <Table.Tr key={r.id}><Table.Td>{r.qbTxnId}</Table.Td><Table.Td>{r.reason}</Table.Td><Table.Td>{when(r.excludedAt)}</Table.Td></Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}
