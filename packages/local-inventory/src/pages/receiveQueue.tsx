"use client";
import { useState } from "react";
import { ActionIcon, Button, Checkbox, Group, Modal, Table, Text, Textarea, Title, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconTrash } from "@tabler/icons-react";
import { formatGtinDisplay } from "../lib/gtin";
import { api, errorMessage, notifyNavCounts, useCanManage, useCatalogNames, useLoad } from "../components/api";
import LoadError from "../components/LoadError";

interface QueueRow {
  id: number;
  gtin13: string;
  quantity: number;
  retailer: string;
  queuedAt: string;
  fulfilledAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

/** /inventory/receive-queue — backordered lines waiting to be received into stock. */
export default function ReceiveQueuePage() {
  const canManage = useCanManage();
  const [includeFulfilled, setIncludeFulfilled] = useState(false);
  const queue = useLoad<QueueRow[]>(`/receive-queue?includeFulfilled=${includeFulfilled}`);
  const names = useCatalogNames((queue.data ?? []).map((r) => r.gtin13));
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState<QueueRow | null>(null);
  const [reason, setReason] = useState("");

  async function act(path: string, init: RequestInit, message: string): Promise<boolean> {
    setBusy(true);
    try {
      await api(path, init);
      notifyNavCounts();
      notifications.show({ message, color: "green" });
      queue.reload();
      return true;
    } catch (err) {
      notifications.show({ message: errorMessage(err), color: "red", autoClose: false });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openCancel(item: QueueRow) {
    setReason("");
    setCancelling(item);
  }

  async function confirmCancel() {
    if (!cancelling || !reason.trim()) return;
    const body = JSON.stringify({ reason: reason.trim() });
    if (await act(`/receive-queue/${cancelling.id}`, { method: "DELETE", body }, "Backorder removed")) setCancelling(null);
  }

  return (
    <>
      <Title order={3} mb="md">Receive Queue</Title>
      <Group justify="space-between" mb="md">
        <Text size="sm" c="dimmed">Backordered items waiting to be received into inventory.</Text>
        <Checkbox label="Show fulfilled and cancelled" checked={includeFulfilled} onChange={(e) => setIncludeFulfilled(e.currentTarget.checked)} />
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
                  <Table.Td>{item.fulfilledAt ? new Date(item.fulfilledAt).toLocaleString() : item.cancelledAt ? `Cancelled: ${item.cancelReason ?? "no reason recorded"}` : "—"}</Table.Td>
                  {canManage && (
                    <Table.Td>
                      {!item.fulfilledAt && !item.cancelledAt && (
                        <Group gap={4} wrap="nowrap">
                          <Tooltip label="Mark as received">
                            <ActionIcon variant="subtle" color="green" aria-label="Fulfill" loading={busy} onClick={() => act(`/receive-queue/${item.id}/fulfill`, { method: "POST" }, "Item received into inventory")}>
                              <IconCheck size={16} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Remove (backorder cancelled)">
                            <ActionIcon variant="subtle" color="red" aria-label="Remove" loading={busy} onClick={() => openCancel(item)}>
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
      <Modal opened={cancelling !== null} onClose={() => setCancelling(null)} title="Cancel backorder" centered>
        <Textarea
          label="Reason"
          description="Why this backorder will not be received. It is recorded with the cancellation."
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          required
          autosize
          minRows={2}
          mb="md"
          data-autofocus
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setCancelling(null)}>Back</Button>
          <Button color="red" loading={busy} disabled={!reason.trim()} onClick={confirmCancel}>Confirm</Button>
        </Group>
      </Modal>
    </>
  );
}
