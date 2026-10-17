"use client";
import { Badge, Code, Table, Text, Title } from "@mantine/core";
import { useLoad } from "../components/api";
import LoadError from "../components/LoadError";

type Status = "pending" | "processed" | "failed";
interface EventRow {
  id: number;
  eventType: string;
  payload: string;
  receivedAt: string;
  status: Status;
  failureReason: string | null;
}

const STATUS_COLOR = { pending: "blue", processed: "green", failed: "red" } as const;

function payloadSummary(raw: string): string {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
  const parts = [
    ["provisional", payload.provisionalGtin13],
    ["real", payload.realGtin13],
    ["name", payload.name],
    ["reason", payload.rejectionReason],
  ].filter(([, v]) => v).map(([k, v]) => `${k}: ${String(v)}`);
  return parts.join(" · ") || raw;
}

/** /inventory/org-events — catalog decisions about this org's provisional items, as received. */
export default function OrgEventsPage() {
  const events = useLoad<EventRow[]>("/received-org-events");
  return (
    <>
      <Title order={3} mb="md">Received Org Events</Title>
      <Text size="sm" c="dimmed" mb="md">Catalog decisions about provisional items, as this inventory received them.</Text>
      {events.error && <LoadError what="org events" message={events.error} onRetry={events.reload} />}
      {events.data === null ? <Text c="dimmed">Loading…</Text>
        : events.data.length === 0 ? <Text c="dimmed">No events received yet.</Text>
        : (
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={60}>ID</Table.Th>
                <Table.Th>Event</Table.Th>
                <Table.Th>Payload</Table.Th>
                <Table.Th>Received</Table.Th>
                <Table.Th w={100}>Status</Table.Th>
                <Table.Th>Failure</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {events.data.map((e) => (
                <Table.Tr key={e.id}>
                  <Table.Td><Code>{e.id}</Code></Table.Td>
                  <Table.Td>{e.eventType.replace(/_/g, " ")}</Table.Td>
                  <Table.Td><Text size="sm" c="dimmed">{payloadSummary(e.payload)}</Text></Table.Td>
                  <Table.Td>{new Date(e.receivedAt).toLocaleString()}</Table.Td>
                  <Table.Td><Badge size="sm" color={STATUS_COLOR[e.status]}>{e.status}</Badge></Table.Td>
                  <Table.Td>{e.failureReason ? <Text size="sm" c="red">{e.failureReason}</Text> : "—"}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
    </>
  );
}
