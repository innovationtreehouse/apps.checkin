"use client";
import { useEffect, useState } from "react";
import {
  ActionIcon, Badge, Button, Checkbox, Divider, Group, Modal,
  Select, Stack, Table, Text, Textarea, TextInput, Title, Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconEye, IconLink, IconX } from "@tabler/icons-react";
import { formatItemId } from "../lib/gtin";
import { api, errorMessage } from "./api";
import LoadError from "./LoadError";
import { USAGE_BEHAVIORS } from "./viewTypes";
import type { CategoryRow, ProvisionalItemRow, SubcategoryRow } from "./viewTypes";

const PAGE_LIMIT = 200;
const STATUS_COLORS: Record<string, string> = { pending: "yellow", approved: "green", rejected: "red", mapped_to_existing: "blue" };

export default function ProvisionalProposalsClient() {
  const [proposals, setProposals] = useState<ProvisionalItemRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [subcategories, setSubcategories] = useState<SubcategoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [onlyPending, setOnlyPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Category names label the rows and feed the approve form, so they load with the list.
  async function load() {
    setLoading(true);
    try {
      const [rows, cats, subs] = await Promise.all([
        api<ProvisionalItemRow[]>(`/provisional-items?page=1&limit=${PAGE_LIMIT}`),
        api<CategoryRow[]>("/categories"),
        api<SubcategoryRow[]>("/subcategories"),
      ]);
      setProposals(rows);
      setCategories(cats);
      setSubcategories(subs);
      setError(null);
    } catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const pending = proposals.filter((p) => p.status === "pending");
  const reviewed = proposals.filter((p) => p.status !== "pending");

  const [approveTarget, setApproveTarget] = useState<ProvisionalItemRow | null>(null);
  const [approveName, setApproveName] = useState("");
  const [approveCategoryId, setApproveCategoryId] = useState<string | null>(null);
  const [approveSubcategoryId, setApproveSubcategoryId] = useState<string | null>(null);
  const [approveUsageBehavior, setApproveUsageBehavior] = useState<string | null>(null);
  const [approveOpen, { open: openApprove, close: closeApprove }] = useDisclosure(false);
  const [approving, setApproving] = useState(false);

  const [rejectTarget, setRejectTarget] = useState<ProvisionalItemRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectOpen, { open: openReject, close: closeReject }] = useDisclosure(false);
  const [rejecting, setRejecting] = useState(false);

  const [mapTarget, setMapTarget] = useState<ProvisionalItemRow | null>(null);
  const [mapGtin, setMapGtin] = useState("");
  const [mapOpen, { open: openMap, close: closeMap }] = useDisclosure(false);
  const [mapping, setMapping] = useState(false);

  function openForApprove(p: ProvisionalItemRow) {
    setApproveTarget(p);
    setApproveName(p.proposedName);
    setApproveUsageBehavior(p.proposedUsageBehavior);
    setApproveCategoryId(p.proposedCategoryId ? String(p.proposedCategoryId) : null);
    setApproveSubcategoryId(p.proposedSubcategoryId ? String(p.proposedSubcategoryId) : null);
    openApprove();
  }

  const resolvedCategoryId = approveCategoryId ? parseInt(approveCategoryId, 10) : null;
  const subcategoryOptions = subcategories
    .filter((s) => resolvedCategoryId === null || s.categoryId === resolvedCategoryId)
    .map((s) => ({ value: String(s.id), label: `${s.number} — ${s.name}` }));

  async function handleApprove() {
    if (!approveTarget) return;
    setApproving(true);
    try {
      await api(`/provisional-items/${approveTarget.id}/approve`, {
        method: "POST",
        body: JSON.stringify({
          name: approveName || undefined,
          usageBehavior: approveUsageBehavior ?? undefined,
          categoryId: approveCategoryId ? parseInt(approveCategoryId, 10) : undefined,
          subcategoryId: approveSubcategoryId ? parseInt(approveSubcategoryId, 10) : undefined,
        }),
      });
      notifications.show({ message: "Proposal approved, new catalog item created", color: "green" });
      closeApprove();
      await load();
    } catch (e) { notifications.show({ message: e instanceof Error ? e.message : "Error", color: "red" }); }
    finally { setApproving(false); }
  }

  async function handleReject() {
    if (!rejectTarget) return;
    setRejecting(true);
    try {
      await api(`/provisional-items/${rejectTarget.id}/reject`, { method: "POST", body: JSON.stringify({ rejectionReason: rejectReason }) });
      notifications.show({ message: "Proposal rejected", color: "orange" });
      closeReject(); setRejectReason(""); setRejectTarget(null);
      await load();
    } catch (e) { notifications.show({ message: e instanceof Error ? e.message : "Error", color: "red" }); }
    finally { setRejecting(false); }
  }

  async function handleMap() {
    if (!mapTarget) return;
    setMapping(true);
    try {
      await api(`/provisional-items/${mapTarget.id}/map-to-existing`, { method: "POST", body: JSON.stringify({ realGtin13: mapGtin.trim() }) });
      notifications.show({ message: "Provisional item mapped to existing catalog entry", color: "blue" });
      closeMap(); setMapGtin(""); setMapTarget(null);
      await load();
    } catch (e) { notifications.show({ message: e instanceof Error ? e.message : "Error", color: "red" }); }
    finally { setMapping(false); }
  }

  const canApprove = !!approveName && !!approveUsageBehavior && !!approveCategoryId && !!approveSubcategoryId;

  function ProposalRow({ p }: { p: ProvisionalItemRow }) {
    return (
      <Table.Tr>
        <Table.Td><Text size="sm" ff="monospace">{formatItemId(p.provisionalGtin13)}</Text></Table.Td>
        <Table.Td>{p.orgName}</Table.Td>
        <Table.Td>{p.proposedName}</Table.Td>
        <Table.Td>{p.proposedCategoryId ? categories.find((c) => c.id === p.proposedCategoryId)?.name ?? `ID ${p.proposedCategoryId}` : "—"}</Table.Td>
        <Table.Td>{new Date(p.proposedAt).toLocaleDateString()}</Table.Td>
        <Table.Td><Badge color={STATUS_COLORS[p.status] ?? "gray"} size="sm">{p.status}</Badge></Table.Td>
        <Table.Td>
          {p.status === "pending" && (
            <Group gap={4}>
              <Tooltip label="Approve"><ActionIcon variant="subtle" size="sm" color="green" onClick={() => openForApprove(p)}><IconEye size={14} /></ActionIcon></Tooltip>
              <Tooltip label="Map to existing item"><ActionIcon variant="subtle" size="sm" color="blue" onClick={() => { setMapTarget(p); setMapGtin(""); openMap(); }}><IconLink size={14} /></ActionIcon></Tooltip>
              <Tooltip label="Reject"><ActionIcon variant="subtle" size="sm" color="red" onClick={() => { setRejectTarget(p); setRejectReason(""); openReject(); }}><IconX size={14} /></ActionIcon></Tooltip>
            </Group>
          )}
        </Table.Td>
      </Table.Tr>
    );
  }

  function ProposalTable({ rows }: { rows: ProvisionalItemRow[] }) {
    return (
      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Provisional PN</Table.Th><Table.Th>Organization</Table.Th><Table.Th>Proposed Name</Table.Th>
            <Table.Th>Category</Table.Th><Table.Th>Proposed At</Table.Th><Table.Th>Status</Table.Th><Table.Th w={110}>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>{rows.map((p) => <ProposalRow key={p.id} p={p} />)}</Table.Tbody>
      </Table>
    );
  }

  return (
    <>
      <Group justify="space-between" align="flex-end" mb="xs">
        <Title order={3}>Provisional Items</Title>
        <Checkbox label="Only show pending" checked={onlyPending} onChange={(e) => setOnlyPending(e.currentTarget.checked)} />
      </Group>
      <Text size="sm" c="dimmed" mb="md">Items proposed by orgs using provisional GTINs. Approve to create a real catalog entry, map to an existing item, or reject.</Text>

      {error ? <LoadError what="provisional proposals" message={error} onRetry={load} />
        : loading ? <Text c="dimmed">Loading…</Text> : proposals.length === 0 ? <Text c="dimmed">No provisional proposals.</Text> : (
        <Stack gap="lg">
          {pending.length > 0 && <div><Text fw={500} mb="xs">Pending ({pending.length})</Text><ProposalTable rows={pending} /></div>}
          {!onlyPending && reviewed.length > 0 && <div><Text fw={500} mb="xs" c="dimmed">Reviewed ({reviewed.length})</Text><ProposalTable rows={reviewed} /></div>}
        </Stack>
      )}

      <Modal opened={approveOpen} onClose={closeApprove} title="Approve Provisional Item" size="lg" centered>
        {approveTarget && (
          <Stack gap="sm">
            <Text size="sm" c="dimmed">Provisional GTIN: <Text span ff="monospace">{formatItemId(approveTarget.provisionalGtin13)}</Text> from <strong>{approveTarget.orgName}</strong></Text>
            <Divider />
            <TextInput label="Item Name" value={approveName} onChange={(e) => setApproveName(e.currentTarget.value)} required data-autofocus />
            <Select label="Category" data={categories.map((c) => ({ value: String(c.id), label: `${c.letter} — ${c.name}` }))} value={approveCategoryId} onChange={(v) => { setApproveCategoryId(v); setApproveSubcategoryId(null); }} required />
            <Select label="Subcategory" data={subcategoryOptions} value={approveSubcategoryId} onChange={setApproveSubcategoryId} disabled={!approveCategoryId} required />
            <Select label="Usage Behavior" data={USAGE_BEHAVIORS.map((b) => ({ value: b, label: b }))} value={approveUsageBehavior} onChange={setApproveUsageBehavior} required />
            <Group justify="flex-end">
              <Button variant="default" onClick={closeApprove}>Cancel</Button>
              <Button color="green" disabled={!canApprove} loading={approving} onClick={handleApprove}>Approve &amp; Create Item</Button>
            </Group>
          </Stack>
        )}
      </Modal>

      <Modal opened={mapOpen} onClose={() => { closeMap(); setMapGtin(""); setMapTarget(null); }} title="Map to Existing Item" centered>
        <Stack gap="sm">
          {mapTarget && <Text size="sm" c="dimmed">Map provisional GTIN <Text span ff="monospace">{formatItemId(mapTarget.provisionalGtin13)}</Text> to an existing catalog item.</Text>}
          <TextInput label="Real GTIN-13" placeholder="0200000000000" value={mapGtin} onChange={(e) => setMapGtin(e.currentTarget.value)} data-autofocus />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => { closeMap(); setMapGtin(""); setMapTarget(null); }}>Cancel</Button>
            <Button color="blue" disabled={!mapGtin.trim()} loading={mapping} onClick={handleMap}>Map Item</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={rejectOpen} onClose={() => { closeReject(); setRejectReason(""); setRejectTarget(null); }} title="Reject Provisional Item" centered>
        <Stack gap="sm">
          {rejectTarget && <Text size="sm">Rejecting: <strong>{rejectTarget.proposedName}</strong> ({formatItemId(rejectTarget.provisionalGtin13)})</Text>}
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
