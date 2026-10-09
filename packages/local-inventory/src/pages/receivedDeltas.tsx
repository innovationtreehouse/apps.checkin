"use client";
import { Fragment, useState } from "react";
import { Anchor, Badge, Code, Pagination, Table, Text, Title } from "@mantine/core";
import { lastPage, PAGE_SIZE, useLoad } from "../components/api";
import LoadError from "../components/LoadError";

/** Receipt id, delta and failure are manager-only fields; a viewer's rows omit them. */
interface DeltaRow {
  id: number;
  status: "applied" | "failed";
  receivedAt: string;
  receiptId?: string;
  deltaJson?: string;
  failureReason?: string | null;
}

function summary(deltaJson: string | undefined): { retailer: string | null; lines: number | null; pretty: string } {
  if (!deltaJson) return { retailer: null, lines: null, pretty: "" };
  try {
    const parsed = JSON.parse(deltaJson) as { retailer?: string | null; lineItems?: unknown[] };
    return { retailer: parsed.retailer ?? null, lines: parsed.lineItems?.length ?? 0, pretty: JSON.stringify(parsed, null, 2) };
  } catch {
    return { retailer: null, lines: null, pretty: deltaJson };
  }
}

/** /inventory/received-deltas — the record of every receipt delta applied to inventory. */
export default function ReceivedDeltasPage() {
  const [page, setPage] = useState(1);
  const rows = useLoad<DeltaRow[]>(`/received-inventory-deltas?page=${page}&limit=${PAGE_SIZE}`);
  const count = useLoad<{ total: number }>("/received-inventory-deltas/count");
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <>
      <Title order={3} mb="md">Applied Receipt Deltas</Title>
      <Text size="sm" c="dimmed" mb="md">Receipt deltas applied to inventory by the receipt pipeline.</Text>
      {rows.error && <LoadError what="applied deltas" message={rows.error} onRetry={rows.reload} />}
      {rows.data === null ? <Text c="dimmed">Loading…</Text>
        : rows.data.length === 0 ? <Text c="dimmed">No deltas received yet.</Text>
        : (
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Received</Table.Th>
                <Table.Th w={90}>Status</Table.Th>
                <Table.Th>Retailer</Table.Th>
                <Table.Th w={80}>Lines</Table.Th>
                <Table.Th>Receipt</Table.Th>
                <Table.Th>Failure</Table.Th>
                <Table.Th>Delta</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.data.map((row) => {
                const s = summary(row.deltaJson);
                return (
                  <Fragment key={row.id}>
                    <Table.Tr>
                      <Table.Td>{new Date(row.receivedAt).toLocaleString()}</Table.Td>
                      <Table.Td><Badge size="sm" color={row.status === "applied" ? "green" : "red"}>{row.status}</Badge></Table.Td>
                      <Table.Td>{s.retailer ?? "—"}</Table.Td>
                      <Table.Td>{s.lines ?? "—"}</Table.Td>
                      <Table.Td>{row.receiptId ? <Code>{row.receiptId}</Code> : "—"}</Table.Td>
                      <Table.Td>{row.failureReason ? <Text size="sm" c="red">{row.failureReason}</Text> : "—"}</Table.Td>
                      <Table.Td>
                        {s.pretty && (
                          <Anchor size="sm" onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
                            {expanded === row.id ? "Hide JSON" : "View JSON"}
                          </Anchor>
                        )}
                      </Table.Td>
                    </Table.Tr>
                    {expanded === row.id && (
                      <Table.Tr>
                        <Table.Td colSpan={7}>
                          <Code block style={{ whiteSpace: "pre-wrap", maxHeight: 500, overflow: "auto" }}>{s.pretty}</Code>
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </Fragment>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      <Pagination mt="md" value={page} onChange={setPage} total={lastPage(count.data?.total ?? 0)} />
    </>
  );
}
