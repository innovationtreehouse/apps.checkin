"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { notifications } from "@mantine/notifications";
import { Alert, Anchor, Badge, Button, Code, CloseButton, Group, Pagination, SegmentedControl, Table, Text, Title } from "@mantine/core";
import { formatGtinDisplay } from "../lib/gtin";
import { errorMessage, lastPage, PAGE_SIZE, useCanSeeReceiving, useLoad } from "../components/api";
import LoadError from "../components/LoadError";

interface LogRow {
  id: number;
  changedAt: string;
  changeType: string;
  gtin13: string;
  fieldChanged: string;
  valueBefore: string | null;
  valueAfter: string | null;
  receiptId?: string | null;
}

/** One receipt or donation apply. The log's audience (INVENTORY_MANAGER, FINANCE, BOARD) reads every field. */
export interface ApplyRow {
  id: number;
  status: "applied" | "failed";
  receivedAt: string;
  sourceKey?: string;
  receiptId?: string | null;
  deltaJson?: string;
  failureReason?: string | null;
}

export interface ApplyLine {
  gtin13: string;
  quantityDelta: number;
  isDelayed: boolean;
  isProvisional: boolean;
  conversionFactor: number;
}

export interface ParsedDelta {
  retailer: string | null;
  lines: ApplyLine[] | null;
  pretty: string;
}

const FIELD_LABELS: Record<string, string> = {
  existingQuantity: "Existing Quantity",
  desiredQuantity: "Desired Quantity",
  locationId: "Location",
  backstockLocationId: "Backstock Location",
};

type View = "parts" | "applies";
/** Maps receipt ids to their Part mapping receipt ids; the host supplies it to viewers who can open Part mapping. */
export type ReceivedReceiptIds = (receiptIds: readonly string[]) => Promise<Record<string, number>>;

const APPLIES_HREF = "/inventory/inventory-log?view=applies";
type StatusFilter = "" | "failed" | "applied";

/** The delta's retailer and lines; `lines` is null when the payload does not parse or its lines are not a list. */
export function parseDelta(deltaJson: string | undefined): ParsedDelta {
  if (!deltaJson) return { retailer: null, lines: null, pretty: "" };
  try {
    const parsed = JSON.parse(deltaJson) as {
      source?: { retailer?: string | null };
      lineItems?: unknown;
    };
    if (parsed.lineItems !== undefined && !Array.isArray(parsed.lineItems)) {
      return { retailer: parsed.source?.retailer ?? null, lines: null, pretty: JSON.stringify(parsed, null, 2) };
    }
    const items = (parsed.lineItems ?? []) as Array<Partial<ApplyLine>>;
    const lines = items.map((l) => ({
      gtin13: String(l.gtin13 ?? ""),
      quantityDelta: Number(l.quantityDelta ?? 0),
      isDelayed: l.isDelayed === true,
      isProvisional: l.isProvisional === true,
      conversionFactor: Number(l.conversionFactor ?? 1),
    }));
    return { retailer: parsed.source?.retailer ?? null, lines, pretty: JSON.stringify(parsed, null, 2) };
  } catch {
    return { retailer: null, lines: null, pretty: deltaJson };
  }
}

/** The receipt or donation an apply came from, read off its source key. */
export function applySource(row: ApplyRow): { kind: "receipt" | "donation"; id: string } | null {
  if (row.receiptId) return { kind: "receipt", id: row.receiptId };
  const m = /^(receipt|donation):(.+)$/.exec(row.sourceKey ?? "");
  return m ? { kind: m[1] as "receipt" | "donation", id: m[2] } : null;
}

function useLogQuery() {
  const router = useRouter();
  const sp = useSearchParams();
  const view: View = sp.get("view") === "applies" ? "applies" : "parts";
  const status = sp.get("status");
  const statusFilter: StatusFilter = status === "failed" || status === "applied" ? status : "";
  const receiptId = sp.get("receiptId") ?? "";
  const go = (next: Record<string, string>) => {
    const q = new URLSearchParams(Object.entries(next).filter(([, v]) => v !== ""));
    router.replace(`/inventory/inventory-log${q.size ? `?${q}` : ""}`, { scroll: false });
  };
  return { view, statusFilter, receiptId, go };
}

/** /inventory/inventory-log — every stock change by part, and every receipt or donation apply with its outcome. */
export default function InventoryLogPage({ receivedReceiptIds }: { receivedReceiptIds?: ReceivedReceiptIds }) {
  const canSee = useCanSeeReceiving();
  return (
    <>
      <Title order={3} mb="md">Inventory log</Title>
      {canSee ? <LogViews receivedReceiptIds={receivedReceiptIds} /> : (
        <Alert color="gray">The inventory log is open to inventory managers, Finance and the Board.</Alert>
      )}
    </>
  );
}

function LogViews({ receivedReceiptIds }: { receivedReceiptIds?: ReceivedReceiptIds }) {
  const { view, statusFilter, receiptId, go } = useLogQuery();
  return (
    <>
      <SegmentedControl
        mb="md"
        value={view}
        onChange={(v) => go({ view: v === "applies" ? "applies" : "" })}
        data={[
          { value: "parts", label: "By part" },
          { value: "applies", label: "By receipt or donation" },
        ]}
      />
      {view === "parts"
        ? <PartsView key={receiptId} receiptId={receiptId} onReceipt={(id) => go({ receiptId: id })} />
        : <AppliesView key={statusFilter} status={statusFilter} onStatus={(s) => go({ view: "applies", status: s })} onReceipt={(id) => go({ receiptId: id })} receivedReceiptIds={receivedReceiptIds} />}
    </>
  );
}

function PartsView({ receiptId, onReceipt }: { receiptId: string; onReceipt: (id: string) => void }) {
  const [page, setPage] = useState(1);
  const filter = receiptId ? new URLSearchParams({ receiptId }).toString() : "";
  const rows = useLoad<LogRow[]>(`/inventory-log?page=${page}&limit=${PAGE_SIZE}${filter && `&${filter}`}`);
  const count = useLoad<{ total: number }>(`/inventory-log/count${filter && `?${filter}`}`);
  return (
    <>
      {receiptId && (
        <Group gap="xs" mb="md">
          <Text size="sm">Changes from receipt <Code>{receiptId}</Code></Text>
          <CloseButton size="sm" aria-label="Show every change" onClick={() => onReceipt("")} />
        </Group>
      )}
      {rows.error ? <LoadError what="the inventory log" message={rows.error} onRetry={rows.reload} />
        : rows.data === null ? <Text c="dimmed">Loading…</Text>
          : rows.data.length === 0 ? <Text c="dimmed">No log entries yet.</Text>
            : (
              <>
                <Table striped highlightOnHover withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>When</Table.Th><Table.Th>Type</Table.Th><Table.Th>Part No.</Table.Th>
                      <Table.Th>Field</Table.Th><Table.Th>Before</Table.Th><Table.Th>After</Table.Th><Table.Th>Receipt</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {rows.data.map((entry) => (
                      <Table.Tr key={entry.id}>
                        <Table.Td>{new Date(entry.changedAt).toLocaleString()}</Table.Td>
                        <Table.Td><Badge color={entry.changeType === "manual" ? "gray" : "blue"} variant="light">{entry.changeType}</Badge></Table.Td>
                        <Table.Td ff="monospace">{formatGtinDisplay(entry.gtin13)}</Table.Td>
                        <Table.Td>{FIELD_LABELS[entry.fieldChanged] ?? entry.fieldChanged}</Table.Td>
                        <Table.Td>{entry.valueBefore ?? "—"}</Table.Td>
                        <Table.Td>{entry.valueAfter ?? "—"}</Table.Td>
                        <Table.Td>
                          {entry.receiptId && !receiptId
                            ? <Anchor size="sm" component="button" onClick={() => onReceipt(entry.receiptId ?? "")}>{entry.receiptId}</Anchor>
                            : entry.receiptId ?? "—"}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
                <Pagination mt="md" value={page} onChange={setPage} total={lastPage(count.data?.total ?? 0)} />
              </>
            )}
    </>
  );
}

/** The Part mapping receipt id of each receipt on the page; empty without a resolver, and an error chip when the lookup fails. */
function usePartMappingIds(rows: ApplyRow[] | null, resolve: ReceivedReceiptIds | undefined): Record<string, number> {
  const [ids, setIds] = useState<Record<string, number>>({});
  const key = (rows ?? []).flatMap((r) => {
    const s = applySource(r);
    return s?.kind === "receipt" ? [s.id] : [];
  }).join("\n");
  useEffect(() => {
    if (!resolve || !key) return;
    let live = true;
    resolve(key.split("\n"))
      .then((m) => { if (live) setIds(m); })
      .catch((err: unknown) => {
        if (live) notifications.show({ color: "red", autoClose: false, title: "Couldn't link receipts to Part mapping", message: errorMessage(err) });
      });
    return () => { live = false; };
  }, [resolve, key]);
  return ids;
}

function AppliesView({ status, onStatus, onReceipt, receivedReceiptIds }: {
  status: StatusFilter; onStatus: (s: StatusFilter) => void; onReceipt: (id: string) => void; receivedReceiptIds?: ReceivedReceiptIds;
}) {
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const filter = status && `status=${status}`;
  const rows = useLoad<ApplyRow[]>(`/received-inventory-deltas?page=${page}&limit=${PAGE_SIZE}${filter && `&${filter}`}`);
  const partMappingIds = usePartMappingIds(rows.data, receivedReceiptIds);
  const count = useLoad<{ total: number }>(`/received-inventory-deltas/count${filter && `?${filter}`}`);
  return (
    <>
      <SegmentedControl
        size="xs"
        mb="md"
        value={status || "all"}
        onChange={(v) => onStatus(v === "failed" || v === "applied" ? v : "")}
        data={[
          { value: "all", label: "All" },
          { value: "failed", label: "Failed" },
          { value: "applied", label: "Applied" },
        ]}
      />
      {rows.error ? <LoadError what="the receipt and donation applies" message={rows.error} onRetry={rows.reload} />
        : rows.data === null ? <Text c="dimmed">Loading…</Text>
          : rows.data.length === 0 ? <Text c="dimmed">{status === "failed" ? "No failed applies." : "No receipts or donations applied yet."}</Text>
            : (
              <>
                <Table striped highlightOnHover withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Received</Table.Th><Table.Th w={90}>Status</Table.Th><Table.Th>Source</Table.Th>
                      <Table.Th>Retailer</Table.Th><Table.Th>Lines</Table.Th><Table.Th>Failure</Table.Th><Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {rows.data.map((row) => (
                      <ApplyRows
                        key={row.id}
                        row={row}
                        open={expanded === row.id}
                        onToggle={() => setExpanded(expanded === row.id ? null : row.id)}
                        onReceipt={onReceipt}
                        partMappingId={partMappingIds[applySource(row)?.id ?? ""]}
                      />
                    ))}
                  </Table.Tbody>
                </Table>
                <Pagination mt="md" value={page} onChange={setPage} total={lastPage(count.data?.total ?? 0)} />
              </>
            )}
    </>
  );
}

function ApplyRows({ row, open, onToggle, onReceipt, partMappingId }: {
  row: ApplyRow; open: boolean; onToggle: () => void; onReceipt: (id: string) => void; partMappingId?: number;
}) {
  const [showPayload, setShowPayload] = useState(false);
  const delta = parseDelta(row.deltaJson);
  const source = applySource(row);
  const delayed = delta.lines?.filter((l) => l.isDelayed).length ?? 0;
  return (
    <>
      <Table.Tr>
        <Table.Td>{new Date(row.receivedAt).toLocaleString()}</Table.Td>
        <Table.Td><Badge size="sm" color={row.status === "applied" ? "green" : "red"}>{row.status}</Badge></Table.Td>
        <Table.Td>
          {source?.kind === "receipt" && partMappingId !== undefined
            ? <Anchor component={Link} href={`/inventory/receiving/${partMappingId}?from=${encodeURIComponent(APPLIES_HREF)}`} size="sm">Receipt {source.id}</Anchor>
            : source?.kind === "receipt" ? `Receipt ${source.id}`
            : source ? `Donation #${source.id}` : "—"}
        </Table.Td>
        <Table.Td>{delta.retailer ?? "—"}</Table.Td>
        <Table.Td>
          {delta.lines === null ? "—" : delta.lines.length}
          {delayed > 0 && <Badge ml="xs" size="sm" variant="light" color="yellow">{delayed} to receive queue</Badge>}
        </Table.Td>
        <Table.Td>{row.failureReason ? <Text size="sm" c="red">{row.failureReason}</Text> : "—"}</Table.Td>
        <Table.Td>
          <Anchor size="sm" component="button" onClick={onToggle}>{open ? "Hide lines" : "Show lines"}</Anchor>
        </Table.Td>
      </Table.Tr>
      {open && (
        <Table.Tr>
          <Table.Td colSpan={7}>
            {delta.lines === null
              ? <Text size="sm" c="dimmed" mb="xs">The payload is not in the expected shape; see the raw payload.</Text>
              : <ApplyLines lines={delta.lines} />}
            <Group gap="sm" mt="xs">
              {source?.kind === "receipt" && row.status === "applied" && (
                <Button size="compact-xs" variant="light" onClick={() => onReceipt(source.id)}>Its stock changes</Button>
              )}
              {delta.pretty && (
                <Button size="compact-xs" variant="subtle" onClick={() => setShowPayload((s) => !s)}>
                  {showPayload ? "Hide raw payload" : "Show raw payload"}
                </Button>
              )}
            </Group>
            {showPayload && (
              <Code block mt="xs" style={{ whiteSpace: "pre-wrap", maxHeight: 500, overflow: "auto" }}>{delta.pretty}</Code>
            )}
          </Table.Td>
        </Table.Tr>
      )}
    </>
  );
}

function ApplyLines({ lines }: { lines: ApplyLine[] }) {
  if (lines.length === 0) return <Text size="sm" c="dimmed">No lines.</Text>;
  return (
    <Table withTableBorder>
      <Table.Thead>
        <Table.Tr><Table.Th>Part No.</Table.Th><Table.Th>Quantity</Table.Th><Table.Th>Conversion</Table.Th><Table.Th>Went to</Table.Th></Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {lines.map((l, i) => (
          <Table.Tr key={`${l.gtin13}-${i}`}>
            <Table.Td ff="monospace">
              {formatGtinDisplay(l.gtin13)}
              {l.isProvisional && <Badge ml="xs" size="xs" variant="light">provisional</Badge>}
            </Table.Td>
            <Table.Td>{l.quantityDelta > 0 ? `+${l.quantityDelta}` : l.quantityDelta}</Table.Td>
            <Table.Td>{l.conversionFactor === 1 ? "—" : `×${l.conversionFactor}`}</Table.Td>
            <Table.Td>{l.isDelayed ? "Receive queue" : "Stock"}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
