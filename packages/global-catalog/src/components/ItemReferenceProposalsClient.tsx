"use client";
import { useEffect, useState } from "react";
import {
  ActionIcon, Button, Group, Modal, Stack, Table, Text, Textarea, Title, Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconX } from "@tabler/icons-react";
import { formatItemId } from "../lib/gtin";
import { api } from "./api";
import type { ItemReferenceProposalRow } from "./viewTypes";

const PAGE_LIMIT = 200;

export default function ItemReferenceProposalsClient() {
  const [proposals, setProposals] = useState<ItemReferenceProposalRow[]>([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setProposals(await api<ItemReferenceProposalRow[]>(`/proposals/item-references?page=1&limit=${PAGE_LIMIT}`));
    } catch (e) { console.error("[ItemReferenceProposalsClient] failed to load proposals", e); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const [rejectTarget, setRejectTarget] = useState<ItemReferenceProposalRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectOpen, { open: openReject, close: closeReject }] = useDisclosure(false);
  const [approving, setApproving] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState(false);

  async function handleApprove(id: number) {
    setApproving(id);
    try {
      await api(`/proposals/item-references/${id}/approve`, { method: "POST" });
      notifications.show({ message: "Mapping approved and written to item references", color: "green" });
      await load();
    } catch (e) { notifications.show({ message: e instanceof Error ? e.message : "Error", color: "red" }); }
    finally { setApproving(null); }
  }

  async function handleReject() {
    if (!rejectTarget) return;
    setRejecting(true);
    try {
      await api(`/proposals/item-references/${rejectTarget.id}/reject`, { method: "POST", body: JSON.stringify({ rejectionReason: rejectReason }) });
      notifications.show({ message: "Proposal rejected", color: "orange" });
      closeReject();
      setRejectReason("");
      setRejectTarget(null);
      await load();
    } catch (e) { notifications.show({ message: e instanceof Error ? e.message : "Error", color: "red" }); }
    finally { setRejecting(false); }
  }

  return (
    <>
      <Title order={3} mb="xs">Item Reference Proposals</Title>
      <Text size="sm" c="dimmed" mb="md">Pending proposals from organizations to map part numbers/descriptions to catalog items.</Text>

      {loading ? <Text c="dimmed">Loading…</Text> : proposals.length === 0 ? (
        <Text c="dimmed">No pending item reference proposals.</Text>
      ) : (
        <Stack gap="sm">
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Organization</Table.Th>
                <Table.Th>Item</Table.Th>
                <Table.Th>Manufacturer</Table.Th>
                <Table.Th>Part #</Table.Th>
                <Table.Th>Description</Table.Th>
                <Table.Th>Retailer</Table.Th>
                <Table.Th>Conv.</Table.Th>
                <Table.Th>Proposed</Table.Th>
                <Table.Th w={100}>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {proposals.map((p) => (
                <Table.Tr key={p.id}>
                  <Table.Td>{p.orgName}</Table.Td>
                  <Table.Td>
                    <Text size="sm">{p.item.name}</Text>
                    <Text size="xs" c="dimmed" ff="monospace">{formatItemId(p.gtin13)}</Text>
                  </Table.Td>
                  <Table.Td>{p.manufacturer ?? <Text c="dimmed" size="sm">—</Text>}</Table.Td>
                  <Table.Td>{p.partNumber ? <Text size="sm" ff="monospace">{p.partNumber}</Text> : <Text c="dimmed" size="sm">—</Text>}</Table.Td>
                  <Table.Td>{p.description ?? <Text c="dimmed" size="sm">—</Text>}</Table.Td>
                  <Table.Td>{p.retailer ?? <Text c="dimmed" size="sm">—</Text>}</Table.Td>
                  <Table.Td>{p.conversionFactor}x</Table.Td>
                  <Table.Td>{new Date(p.proposedAt).toLocaleDateString()}</Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      <Tooltip label="Approve"><ActionIcon variant="subtle" color="green" size="sm" loading={approving === p.id} onClick={() => handleApprove(p.id)}><IconCheck size={14} /></ActionIcon></Tooltip>
                      <Tooltip label="Reject"><ActionIcon variant="subtle" color="red" size="sm" onClick={() => { setRejectTarget(p); setRejectReason(""); openReject(); }}><IconX size={14} /></ActionIcon></Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>
      )}

      <Modal opened={rejectOpen} onClose={() => { closeReject(); setRejectReason(""); setRejectTarget(null); }} title="Reject Proposal" centered>
        <Stack gap="sm">
          {rejectTarget && <Text size="sm">Rejecting proposal from <strong>{rejectTarget.orgName}</strong> for <strong>{rejectTarget.item.name}</strong></Text>}
          <Textarea label="Reason" placeholder="Explain why this proposal is being rejected…" value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} minRows={3} required />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => { closeReject(); setRejectReason(""); setRejectTarget(null); }}>Cancel</Button>
            <Button color="red" disabled={!rejectReason.trim()} loading={rejecting} onClick={handleReject}>Reject</Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
