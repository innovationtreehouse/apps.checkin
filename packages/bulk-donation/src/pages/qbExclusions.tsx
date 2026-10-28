"use client";
import { useState } from "react";
import { Alert, Anchor, Table, Title } from "@mantine/core";
import { paged, useLoad, when } from "../components/api";
import LoadError from "../components/LoadError";
import Pager from "../components/Pager";

interface ExclusionRow { id: number; qbTxnId: string; reason: string; excludedAt: string }

/** /donations/qb-exclusions — the QuickBooks entries finance removed from donation's matching, now carried into income's. */
export default function QbExclusionsPage() {
  const [page, setPage] = useState(1);
  const rows = useLoad<ExclusionRow[]>(paged("/qb-exclusions", page));

  return (
    <>
      <Title order={3} mb="md">QuickBooks exclusions</Title>
      <Alert color="blue" mb="md">
        Income now matches every Benevity deposit, and these exclusions are carried into its own. Exclude a deposit in{" "}
        <Anchor href="/income/exclusions">income&apos;s exclusions</Anchor>.
      </Alert>
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
      <Pager page={page} onChange={setPage} rows={rows.data} />
    </>
  );
}
