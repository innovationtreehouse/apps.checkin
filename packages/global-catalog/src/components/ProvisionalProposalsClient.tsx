"use client";
import { useEffect, useState } from "react";
import {
  ActionIcon, Badge, Button, Checkbox, Divider, Group, Modal,
  Radio, ScrollArea, Select, Stack, Table, Text, Textarea, TextInput, Title, Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconEye, IconLink, IconX } from "@tabler/icons-react";
import { formatGtinDisplay } from "../lib/gtin";
import { api, useCanManage, useLoad } from "./api";
import { errorMessage, LoadError, showError } from "@checkin/component-ui";
import { USAGE_BEHAVIORS } from "./viewTypes";
import type { CategoryRow, ItemRow, ProvisionalItemRow, SubcategoryRow } from "./viewTypes";

const PAGE_LIMIT = 200;
const STATUS_COLORS: Record<string, string> = { pending: "yellow", approved: "green", rejected: "red", mapped_to_existing: "blue" };
const MIN_SEARCH_LENGTH = 2;

const partLabel = (p: ProvisionalItemRow) => [p.manufacturer, p.partNumber].filter(Boolean).join(" ") || "—";
const itemLabel = (item: ItemRow) => `${item.name} · ${item.category.name} / ${item.subcategory.name} · ${formatGtinDisplay(item.gtin13)}`;

/** Catalog items matching the typed text; none until a search for the current text returns. */
function useItemSearch(q: string): { items: ItemRow[]; error: string | null; answered: boolean } {
  const [result, setResult] = useState<{ term: string; items: ItemRow[]; error: string | null } | null>(null);
  const term = q.trim().length < MIN_SEARCH_LENGTH ? null : q.trim();
  useEffect(() => {
    if (term === null) return;
    let live = true;
    const t = setTimeout(() => {
      api<ItemRow[]>(`/items?q=${encodeURIComponent(term)}&limit=20`)
        .then((rows) => { if (live) setResult({ term, items: rows, error: null }); })
        .catch((e: unknown) => { if (live) setResult({ term, items: [], error: errorMessage(e) }); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [term]);
  return result && result.term === term ? { items: result.items, error: result.error, answered: true } : { items: [], error: null, answered: false };
}

/** What the org recorded about the part, shown wherever a reviewer decides on it. */
function ProposedPart({ p }: { p: ProvisionalItemRow }) {
  return (
    <Group gap="lg">
      <Text size="sm">Part: {partLabel(p)}</Text>
      <Text size="sm">Retailer: {p.retailer ?? "—"}</Text>
      <Text size="sm">Factor: ×{p.conversionFactor}</Text>
    </Group>
  );
}

export default function ProvisionalProposalsClient() {
  const canManage = useCanManage();
  const [onlyPending, setOnlyPending] = useState(true);

  // Category names label the rows and feed the approve form, so they load with the list.
  const proposalsLoad = useLoad<ProvisionalItemRow[]>(`/provisional-items?page=1&limit=${PAGE_LIMIT}`);
  const categoriesLoad = useLoad<CategoryRow[]>("/categories");
  const subcategoriesLoad = useLoad<SubcategoryRow[]>("/subcategories");
  const proposals = proposalsLoad.data ?? [];
  const categories = categoriesLoad.data ?? [];
  const subcategories = subcategoriesLoad.data ?? [];
  const loading = !proposalsLoad.data || !categoriesLoad.data || !subcategoriesLoad.data;
  const error = proposalsLoad.error ?? categoriesLoad.error ?? subcategoriesLoad.error;
  function reloadAll() {
    proposalsLoad.reload();
    categoriesLoad.reload();
    subcategoriesLoad.reload();
  }

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
  const [mapSearch, setMapSearch] = useState("");
  const [mapChoice, setMapChoice] = useState<ItemRow | null>(null);
  const [mapOpen, { open: openMap, close: closeMap }] = useDisclosure(false);
  const [mapping, setMapping] = useState(false);
  const found = useItemSearch(mapOpen ? mapSearch : "");
  const mapResults = [...(mapChoice ? [mapChoice] : []), ...found.items.filter((item) => item.gtin13 !== mapChoice?.gtin13)];

  function openForMap(p: ProvisionalItemRow) {
    setMapTarget(p);
    setMapSearch(p.proposedName);
    setMapChoice(null);
    openMap();
  }

  function closeMapModal() {
    closeMap(); setMapChoice(null); setMapTarget(null);
  }

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
    } catch (e) { showError(errorMessage(e)); }
    finally { setApproving(false); }
  }

  async function handleReject() {
    if (!rejectTarget) return;
    setRejecting(true);
    try {
      await api(`/provisional-items/${rejectTarget.id}/reject`, { method: "POST", body: JSON.stringify({ rejectionReason: rejectReason }) });
      notifications.show({ message: "Proposal rejected", color: "orange" });
      closeReject(); setRejectReason(""); setRejectTarget(null);
    } catch (e) { showError(errorMessage(e)); }
    finally { setRejecting(false); }
  }

  async function handleMap() {
    if (!mapTarget || !mapChoice) return;
    setMapping(true);
    try {
      await api(`/provisional-items/${mapTarget.id}/map-to-existing`, { method: "POST", body: JSON.stringify({ realGtin13: mapChoice.gtin13 }) });
      notifications.show({ message: "Provisional item mapped to existing catalog entry", color: "blue" });
      closeMapModal();
    } catch (e) { showError(errorMessage(e)); }
    finally { setMapping(false); }
  }

  const canApprove = !!approveName && !!approveUsageBehavior && !!approveCategoryId && !!approveSubcategoryId;

  function proposalRow(p: ProvisionalItemRow) {
    return (
      <Table.Tr key={p.id}>
        <Table.Td><Text size="sm" ff="monospace">{formatGtinDisplay(p.provisionalGtin13)}</Text></Table.Td>
        <Table.Td>{p.orgName}</Table.Td>
        <Table.Td>{p.proposedName}</Table.Td>
        <Table.Td>{p.proposedCategoryId ? categories.find((c) => c.id === p.proposedCategoryId)?.name ?? `ID ${p.proposedCategoryId}` : "—"}</Table.Td>
        <Table.Td>{partLabel(p)}</Table.Td>
        <Table.Td>{p.retailer ?? "—"}</Table.Td>
        <Table.Td>×{p.conversionFactor}</Table.Td>
        <Table.Td>{new Date(p.proposedAt).toLocaleDateString()}</Table.Td>
        <Table.Td><Badge color={STATUS_COLORS[p.status] ?? "gray"} size="sm">{p.status}</Badge></Table.Td>
        {canManage && (
          <Table.Td>
            {p.status === "pending" && (
              <Group gap={4}>
                <Tooltip label="Approve"><ActionIcon aria-label="Approve" variant="subtle" size="sm" color="green" onClick={() => openForApprove(p)}><IconEye size={14} /></ActionIcon></Tooltip>
                <Tooltip label="Map to existing item"><ActionIcon aria-label="Map to existing item" variant="subtle" size="sm" color="blue" onClick={() => openForMap(p)}><IconLink size={14} /></ActionIcon></Tooltip>
                <Tooltip label="Reject"><ActionIcon aria-label="Reject" variant="subtle" size="sm" color="red" onClick={() => { setRejectTarget(p); setRejectReason(""); openReject(); }}><IconX size={14} /></ActionIcon></Tooltip>
              </Group>
            )}
          </Table.Td>
        )}
      </Table.Tr>
    );
  }

  function proposalTable(rows: ProvisionalItemRow[]) {
    return (
      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Provisional PN</Table.Th><Table.Th>Organization</Table.Th><Table.Th>Proposed Name</Table.Th>
            <Table.Th>Category</Table.Th><Table.Th>Part</Table.Th><Table.Th>Retailer</Table.Th><Table.Th>Factor</Table.Th>
            <Table.Th>Proposed At</Table.Th><Table.Th>Status</Table.Th>{canManage && <Table.Th w={110}>Actions</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>{rows.map(proposalRow)}</Table.Tbody>
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

      {error ? <LoadError what="provisional proposals" message={error} onRetry={reloadAll} />
        : loading ? <Text c="dimmed">Loading…</Text> : proposals.length === 0 ? <Text c="dimmed">No provisional proposals.</Text> : (
        <Stack gap="lg">
          {pending.length > 0 && <div><Text fw={500} mb="xs">Pending ({pending.length})</Text>{proposalTable(pending)}</div>}
          {!onlyPending && reviewed.length > 0 && <div><Text fw={500} mb="xs" c="dimmed">Reviewed ({reviewed.length})</Text>{proposalTable(reviewed)}</div>}
        </Stack>
      )}

      <Modal opened={approveOpen} onClose={closeApprove} title="Approve Provisional Item" size="lg" centered>
        {approveTarget && (
          <Stack gap="sm">
            <Text size="sm" c="dimmed">Provisional GTIN: <Text span ff="monospace">{formatGtinDisplay(approveTarget.provisionalGtin13)}</Text> from <strong>{approveTarget.orgName}</strong></Text>
            <ProposedPart p={approveTarget} />
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

      <Modal opened={mapOpen} onClose={closeMapModal} title="Map to Existing Item" size="lg" centered>
        <Stack gap="sm">
          {mapTarget && (
            <>
              <Text size="sm" c="dimmed">Map <strong>{mapTarget.proposedName}</strong> (<Text span ff="monospace">{formatGtinDisplay(mapTarget.provisionalGtin13)}</Text>) to an existing catalog item.</Text>
              <ProposedPart p={mapTarget} />
            </>
          )}
          <TextInput
            label="Search the catalog"
            placeholder="Name, short ID or category"
            value={mapSearch}
            onChange={(e) => setMapSearch(e.currentTarget.value)}
            error={found.error && `Couldn't search the catalog: ${found.error}`}
            data-autofocus
          />
          {mapSearch.trim().length < MIN_SEARCH_LENGTH && <Text size="xs" c="dimmed">Type at least {MIN_SEARCH_LENGTH} characters</Text>}
          {found.answered && !found.error && mapResults.length === 0 && <Text size="xs" c="dimmed">No matching catalog items</Text>}
          {mapResults.length > 0 && (
            <ScrollArea.Autosize mah={260}>
              <Radio.Group
                aria-label="Catalog items"
                value={mapChoice?.gtin13 ?? null}
                onChange={(v) => setMapChoice(mapResults.find((item) => item.gtin13 === v) ?? null)}
              >
                <Stack gap={6} py={4}>
                  {mapResults.map((item) => <Radio key={item.gtin13} size="xs" value={item.gtin13} label={itemLabel(item)} />)}
                </Stack>
              </Radio.Group>
            </ScrollArea.Autosize>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={closeMapModal}>Cancel</Button>
            <Button color="blue" disabled={!mapChoice} loading={mapping} onClick={handleMap}>Map Item</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={rejectOpen} onClose={() => { closeReject(); setRejectReason(""); setRejectTarget(null); }} title="Reject Provisional Item" centered>
        <Stack gap="sm">
          {rejectTarget && (
            <>
              <Text size="sm">Rejecting: <strong>{rejectTarget.proposedName}</strong> ({formatGtinDisplay(rejectTarget.provisionalGtin13)})</Text>
              <ProposedPart p={rejectTarget} />
            </>
          )}
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
