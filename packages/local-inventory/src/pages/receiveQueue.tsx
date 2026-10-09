"use client";
import { useState } from "react";
import { ActionIcon, Checkbox, Group, Table, Text, Title, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconTrash } from "@tabler/icons-react";
import { formatGtinDisplay } from "../lib/gtin";
import { api, errorMessage, useCanManage, useCatalogNames, useLoad } from "../components/api";
import LoadError from "../components/LoadError";

interface QueueRow {
  id: number;
  gtin13: string;
  quantity: number;
  retailer: string;
  queuedAt: string;
  fulfilledAt: string | null;
}

/** /inventory/receive-queue — backordered lines waiting to be received into stock. */
export default function ReceiveQueuePage() {
  const canManage = useCanManage();
  const [includeFulfilled, setIncludeFulfilled] = useState(false);
  const queue = useLoad<QueueRow[]>(`/receive-queue?includeFulfilled=${includeFulfilled}`);
  const names = useCatalogNames((queue.data ?? []).map((r) => r.gtin13));
  const [busy, setBusy] = useState(false);

  async function act(path: string, method: string, message: string) {
    setBusy(true);
    try {
      await api(path, { method });
      notifications.show({ message, color: "green" });
      queue.reload();
    } catch (err) {
      notifications.show({ message: errorMessage(err), color: "red" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Title order={3} mb="md">Receive Queue</Title>
      <Group justify="space-between" mb="md">
        <Text size="sm" c="dimmed">Backordered items waiting to be received into inventory.</Text>
        <Checkbox label="Show fulfilled" checked={includeFulfilled} onChange={(e) => setIncludeFulfilled(e.currentTarget.checked)} />
      </Group>
      {queue.error && <LoadError what="the receive queue" message={queue.error} onRetry={queue.reload} />}
      {queue.data === null ? <Text c="dimmed">Loading…</Text>
        : queue.data.length === 0 ? <Text c="dimmed">No items in the receive queue.</Text>
        : (
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Retailer</Table.Th>
                <Table.Th>Item</Table.Th>
                <Table.Th>Part No.</Table.Th>
                <Table.Th>Quantity</Table.Th>
                <Table.Th>Queued</Table.Th>
                <Table.Th>Fulfilled</Table.Th>
                {canManage && <Table.Th w={96}>Actions</Table.Th>}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {queue.data.map((item) => (
                <Table.Tr key={item.id}>
                  <Table.Td>{item.retailer || "—"}</Table.Td>
                  <Table.Td>{names.get(item.gtin13) ?? <Text span c="dimmed" size="sm">Unknown</Text>}</Table.Td>
                  <Table.Td ff="monospace">{formatGtinDisplay(item.gtin13)}</Table.Td>
                  <Table.Td>{item.quantity}</Table.Td>
                  <Table.Td>{new Date(item.queuedAt).toLocaleString()}</Table.Td>
                  <Table.Td>{item.fulfilledAt ? new Date(item.fulfilledAt).toLocaleString() : "—"}</Table.Td>
                  {canManage && (
                    <Table.Td>
                      {!item.fulfilledAt && (
                        <Group gap={4} wrap="nowrap">
                          <Tooltip label="Mark as received">
                            <ActionIcon variant="subtle" color="green" aria-label="Fulfill" loading={busy} onClick={() => act(`/receive-queue/${item.id}/fulfill`, "POST", "Item received into inventory")}>
                              <IconCheck size={16} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Remove (backorder cancelled)">
                            <ActionIcon variant="subtle" color="red" aria-label="Remove" loading={busy} onClick={() => act(`/receive-queue/${item.id}`, "DELETE", "Backorder removed")}>
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      )}
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
    </>
  );
}
