"use client";
import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Alert, Anchor, Badge, Button, Group, NumberInput, Paper, Radio, ScrollArea, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { formatGtinDisplay } from "@checkin/gtin";
import {
  CatalogNamesUnavailable, HttpError, MIN_CATALOG_SEARCH_LENGTH, NO_CATALOG_NAMES, catalogItemLabel, catalogSearchTerm, useCatalogSearch, withLookup, withProvisionalNames,
  type CatalogItem, type CatalogNames,
} from "@checkin/component-ui";
import { USAGE_BEHAVIORS } from "@checkin/receipt-types";
import { LINE_STATUS_COLOR, LINE_STATUS_LABEL, api, stateColor, stateLabel, errorMessage, notifyNavCounts, useCanManage, useLoad } from "../components/api";
import { formatCents } from "@checkin/money";
import { type LineFormKind, lineFormBody } from "../lib/line-form";
import { lineLockReason } from "../lib/line-lock";

interface Receipt {
  id: number;
  state: string;
  validationNotes?: string | null;
  createdAt: string;
  inventoryAppliedAt: string | null;
  inventoryUnconfirmedAt: string | null;
  expenseAppliedAt: string | null;
  donationAppliedAt: string | null;
  matchingPendingSince?: string | null;
  applyFirstFailedAt?: string | null;
}
interface LineItem {
  receiptLineItemId: number;
  lineNumber: number;
  description: string;
  partNumber: string | null;
  manufacturer: string | null;
  quantity: number;
  unitPriceCents?: number;
  totalPriceCents?: number;
}
interface ParsedReceipt {
  receiptId?: string;
  openBackorders: number;
  vendorName?: string | null;
  currency: string;
  receiptTotalCents?: number;
  taxCents?: number;
  shippingCents?: number;
  discountCents?: number;
  receiptDate: string | null;
  lineItems: LineItem[];
}
interface LineStatus {
  id: number;
  receiptLineItemId: number;
  recognitionStatus: string;
  assignedGtin13: string | null;
  provisionalItemGtin13: string | null;
  proposedName: string | null;
  conversionFactor: number;
}
interface Detail {
  ReceivedReceipt: Receipt;
  WorkflowReceiptView: ParsedReceipt;
  ReceivedReceiptLineStatus: LineStatus[];
}

/** GET /api/catalog/categories and /subcategories rows; both lists omit archived entries. */
interface CategoryOption {
  id: number;
  name: string;
  letter: string;
}
interface SubcategoryOption {
  id: number;
  name: string;
  number: number;
  categoryId: number;
}
/** The provisional names GET /api/inventory/org-items/{gtin13} returns beside the row. */
interface OrgItemNames { InventoryProvisionalItem?: { provisionalGtin13: string; name: string }[] }

/** A part's catalog name, else its provisional name from org-items, else the error the catalog or org-items read threw. */
async function partName(gtin13: string): Promise<unknown> {
  const catalog = await api<CatalogItem>(`/api/catalog/items/${gtin13}`).then((item): unknown => item.name, (e: unknown) => e);
  if (typeof catalog === "string") return catalog;
  let row: OrgItemNames | null = null;
  try {
    row = await api<OrgItemNames>(`/api/inventory/org-items/${gtin13}`);
  } catch (e) {
    // A 404 means the org has no row for the part; any other failure leaves the name unknown.
    if (!(e instanceof HttpError && e.status === 404)) return e;
  }
  return row?.InventoryProvisionalItem?.find((p) => p.provisionalGtin13 === gtin13)?.name ?? catalog;
}

/** Part names by GTIN, one lookup per distinct GTIN, with the GTINs the catalog lacks or failed to answer for. */
function usePartNames(gtins: string[]): CatalogNames {
  const [lookup, setLookup] = useState<CatalogNames>(NO_CATALOG_NAMES);
  const key = [...new Set(gtins)].sort().join(",");
  useEffect(() => {
    if (!key) return;
    let live = true;
    const ids = key.split(",");
    Promise.all(ids.map(partName))
      .then((found) => { if (live) setLookup(ids.reduce((acc, gtin13, i) => withLookup(acc, gtin13, found[i]), NO_CATALOG_NAMES)); });
    return () => { live = false; };
  }, [key]);
  return lookup;
}

/**
 * /inventory/receiving/[id] — one receipt's lines, their mapping decisions, and the push controls.
 * `backHref` is the page it was opened from, which the back link returns to.
 */
export default function ReceiptPage({ backHref = "/inventory/receiving" }: { backHref?: string }) {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const canManage = useCanManage();
  const detail = useLoad<Detail>(`/receipts/${id}`);
  const partLookup = usePartNames((detail.data?.ReceivedReceiptLineStatus ?? []).flatMap((ls) => ls.assignedGtin13 ?? ls.provisionalItemGtin13 ?? []));
  const [busy, setBusy] = useState(false);
  const [openLineId, setOpenLineId] = useState<number | null>(null);

  /** Returns to the page the receipt was opened from once the receipt is resolved. */
  function leaveIfResolved(state: string): boolean {
    if (state !== "resolved") return false;
    notifications.show({ message: "Receipt resolved", color: "green" });
    router.push(backHref);
    return true;
  }

  /** Posts an action. A line decision (`lineDecision`) can complete and apply the receipt, so it re-reads the state after. */
  async function act(path: string, body?: unknown, message = "Saved", lineDecision = false): Promise<boolean> {
    setBusy(true);
    try {
      const res = await api<{ state?: string; validationNotes?: string } | null>(path, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res?.validationNotes) {
        const title = res.state === "applying" ? "Apply didn't finish" : "Apply failed";
        notifications.show({ title, message: res.validationNotes, color: "red", autoClose: false });
        return true;
      }
      // An unreadable state leaves the page as it is; the reload below reports the failure.
      const after = lineDecision ? await api<Detail>(`/receipts/${id}`).catch(() => null) : null;
      if (!(after && leaveIfResolved(after.ReceivedReceipt.state))) notifications.show({ message, color: "green" });
      return true;
    } catch (err) {
      notifications.show({ title: "Couldn't save", message: errorMessage(err), color: "red", autoClose: false });
      return false;
    } finally {
      setBusy(false);
      detail.reload();
      notifyNavCounts();
    }
  }

  if (detail.error) return <Alert color="red" title="Couldn't load the receipt">{detail.error}</Alert>;
  if (!detail.data) return <Text c="dimmed">Loading…</Text>;
  const { ReceivedReceipt: receipt, WorkflowReceiptView: parsed, ReceivedReceiptLineStatus: lines } = detail.data;
  const lockReason = lineLockReason(receipt);
  const editable = canManage && !lockReason;
  // Waits for a person: a failed apply, or one left applying with a recorded failure.
  const stuck = receipt.state === "apply_failed" || (receipt.state === "applying" && !!receipt.applyFirstFailedAt);
  const base = `/receipts/${receipt.id}`;
  const items = new Map(parsed.lineItems.map((li) => [li.receiptLineItemId, li]));
  const partLabels = withProvisionalNames(partLookup);

  /** Runs matching now, then says how many of the lines undecided before it matched. */
  async function runMatching() {
    const undecided = new Set(lines.filter((ls) => ls.recognitionStatus === "unrecognized").map((ls) => ls.id));
    setBusy(true);
    try {
      await api(`${base}/run-matching`, { method: "POST" });
      const after = await api<Detail>(base);
      if (leaveIfResolved(after.ReceivedReceipt.state)) return;
      if (after.ReceivedReceipt.matchingPendingSince) {
        notifications.show({ message: "Catalog still unavailable. Try again later, or map the lines by hand.", color: "gray" });
      } else {
        const matched = after.ReceivedReceiptLineStatus.filter((ls) => undecided.has(ls.id) && ls.recognitionStatus === "recognized").length;
        notifications.show({ message: `${matched} ${matched === 1 ? "line" : "lines"} matched`, color: "green" });
      }
    } catch (err) {
      notifications.show({ title: "Couldn't run matching", message: errorMessage(err), color: "red", autoClose: false });
    } finally {
      setBusy(false);
      detail.reload();
      notifyNavCounts();
    }
  }

  return (
    <>
      {editable && openLineId !== null ? (
        <Anchor component="button" size="sm" onClick={() => setOpenLineId(null)}>← Back to receipt</Anchor>
      ) : (
        <Anchor component={Link} href={backHref} size="sm">← Back</Anchor>
      )}
      <Group justify="space-between" mt="md">
        <Stack gap={0}>
          <Title order={3}>{parsed.vendorName ?? "Receipt"} · {formatCents(parsed.receiptTotalCents, parsed.currency)}</Title>
          <Text size="sm" c="dimmed">{parsed.receiptDate ?? "No date"}</Text>
        </Stack>
        <Group gap="xs">
          {receipt.matchingPendingSince && <Badge size="lg" variant="light" color="yellow">Matching pending</Badge>}
          {receipt.matchingPendingSince && canManage && (
            <Button size="xs" variant="light" loading={busy} onClick={runMatching}>Run matching now</Button>
          )}
          <Badge size="lg" variant="light" color={stateColor(receipt.state, parsed.openBackorders)}>{stateLabel(receipt.state, parsed.openBackorders)}</Badge>
        </Group>
      </Group>
      <Group gap="xl" align="start" my="md">
        <Field label="Total" value={formatCents(parsed.receiptTotalCents, parsed.currency)} money />
        <Field label="Tax" value={formatCents(parsed.taxCents, parsed.currency)} money />
        <Field label="Shipping" value={formatCents(parsed.shippingCents, parsed.currency)} money />
        <Field label="Discount" value={formatCents(parsed.discountCents ? -parsed.discountCents : parsed.discountCents, parsed.currency)} money />
        <Field label="Receipt id" value={parsed.receiptId ?? "—"} mono />
        <Field label="Received" value={new Date(receipt.createdAt).toLocaleString()} />
      </Group>
      {receipt.matchingPendingSince && (
        <Text size="sm" c="dimmed" mb="md">{"Matching didn't run because the catalog was unavailable. Run matching now, or map the lines by hand."}</Text>
      )}
      {receipt.validationNotes && <Alert color="orange" mb="md" title="Last push failed">{receipt.validationNotes}</Alert>}
      {receipt.state === "applying" && !stuck && (
        <Text size="sm" c="dimmed" mb="md">Applying — the system retries this automatically.</Text>
      )}
      {canManage && stuck && (
        <Alert color="gray" mb="md" title="Lines locked">
          Lines are locked once a receipt is sent to apply. Retry sends the part that failed with the same lines.
        </Alert>
      )}
      {canManage && (
        <Group mb="md">
          {receipt.state === "pending_review" && (
            <Button
              loading={busy}
              onClick={async () => {
                if (await act(`${base}/proceed`, undefined, "Proceeded")) await act(`${base}/apply`, undefined, "Applied");
              }}
            >
              Proceed
            </Button>
          )}
          {stuck && (
            <Button
              variant="light"
              loading={busy}
              onClick={async () => {
                if (await act(`${base}/retry-apply`, undefined, "Retrying")) await act(`${base}/apply`, undefined, "Applied");
              }}
            >
              Retry apply
            </Button>
          )}
        </Group>
      )}
      <CatalogNamesUnavailable lookup={partLookup} />
      <Table withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>#</Table.Th>
            <Table.Th>Description</Table.Th>
            <Table.Th>Part</Table.Th>
            <Table.Th>Qty</Table.Th>
            <Table.Th ta="right">Unit</Table.Th>
            <Table.Th ta="right">Total</Table.Th>
            <Table.Th>Mapping</Table.Th>
            {editable && <Table.Th>Actions</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {lines.map((ls, i) => {
            const li = items.get(ls.receiptLineItemId);
            const lineBase = `${base}/lines/${ls.id}`;
            const isOpen = editable && openLineId === ls.id;
            const mappedGtin = ls.assignedGtin13 ?? ls.provisionalItemGtin13;
            // A provisional part has no row until the receipt applies, and then takes the proposed name, else the line's description.
            const mappedName = (mappedGtin && partLookup.names.get(mappedGtin)) ?? (ls.assignedGtin13 ? undefined : ls.proposedName ?? li?.description) ?? (mappedGtin && partLabels.get(mappedGtin));
            return (
              <Fragment key={ls.id}>
                <Table.Tr bg={isOpen ? "var(--mantine-color-blue-light)" : undefined}>
                  <Table.Td>{li?.lineNumber ?? i + 1}</Table.Td>
                  <Table.Td>{li?.description ?? "—"}</Table.Td>
                  <Table.Td>{[li?.manufacturer, li?.partNumber].filter(Boolean).join(" ") || "—"}</Table.Td>
                  <Table.Td>{li?.quantity ?? "—"}</Table.Td>
                  <Table.Td ta="right" ff="monospace" style={{ whiteSpace: "nowrap" }}>{formatCents(li?.unitPriceCents, parsed.currency)}</Table.Td>
                  <Table.Td ta="right" ff="monospace" style={{ whiteSpace: "nowrap" }}>{formatCents(li?.totalPriceCents, parsed.currency)}</Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="light" color={LINE_STATUS_COLOR[ls.recognitionStatus] ?? "gray"}>
                      {LINE_STATUS_LABEL[ls.recognitionStatus] ?? ls.recognitionStatus}
                    </Badge>
                    {mappedGtin && (
                      <Text size="xs" ff="monospace" c="dimmed">
                        {formatGtinDisplay(mappedGtin)}{mappedName ? ` · ${mappedName}` : ""} ×{ls.conversionFactor}
                      </Text>
                    )}
                  </Table.Td>
                  {editable && (
                    <Table.Td>
                      {isOpen ? (
                        <Button size="xs" variant="subtle" onClick={() => setOpenLineId(null)}>Close</Button>
                      ) : ls.recognitionStatus !== "unrecognized" ? (
                        <Button size="xs" variant="subtle" color="gray" onClick={() => setOpenLineId(ls.id)}>Change</Button>
                      ) : (
                        <Group gap={4} wrap="nowrap">
                          <Button size="xs" variant="light" onClick={() => setOpenLineId(ls.id)}>Associate</Button>
                          <Button size="xs" variant="subtle" loading={busy} onClick={() => act(`${lineBase}/non-inventory`, undefined, "Marked not inventory", true)}>
                            Not inventory
                          </Button>
                        </Group>
                      )}
                    </Table.Td>
                  )}
                </Table.Tr>
                {isOpen && (
                  <Table.Tr>
                    <Table.Td colSpan={COLUMNS + 1}>
                      <Paper component="section" p="md" withBorder aria-label={`Line ${li?.lineNumber ?? i + 1} details`}>
                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg">
                          <LineDetails item={li} currency={parsed.currency} />
                          <LineForm
                            busy={busy}
                            onCancel={() => setOpenLineId(null)}
                            onNonInventory={ls.recognitionStatus === "non_inventory" ? undefined : async () => {
                              if (await act(`${lineBase}/non-inventory`, undefined, "Marked not inventory")) setOpenLineId(null);
                            }}
                            onSubmit={async (form, body) => {
                              if (await act(`${lineBase}/${form}`, body, "Saved", true)) setOpenLineId(null);
                            }}
                          />
                        </SimpleGrid>
                      </Paper>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Fragment>
            );
          })}
        </Table.Tbody>
      </Table>
    </>
  );
}

/** Columns before Actions; the open line's detail row spans them all. */
const COLUMNS = 7;

function Field({ label, value, money, mono }: { label: string; value: string; money?: boolean; mono?: boolean }) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">{label}</Text>
      <Text size="sm" ff={money || mono ? "monospace" : undefined}>{value}</Text>
    </Stack>
  );
}

/** The open line as the receipt states it, shown beside its mapping form. */
function LineDetails({ item, currency }: { item: LineItem | undefined; currency: string }) {
  if (!item) return <Text c="dimmed">This line is missing from the stored receipt.</Text>;
  return (
    <Stack gap="xs">
      <Title order={5}>Line {item.lineNumber}: {item.description}</Title>
      <SimpleGrid cols={3} spacing="sm">
        <Field label="Part #" value={item.partNumber ?? "—"} mono />
        <Field label="Manufacturer" value={item.manufacturer ?? "—"} />
        <Field label="Qty" value={String(item.quantity)} />
        <Field label="Unit price" value={formatCents(item.unitPriceCents, currency)} money />
        <Field label="Line total" value={formatCents(item.totalPriceCents, currency)} money />
      </SimpleGrid>
    </Stack>
  );
}

function LineForm({ busy, onSubmit, onCancel, onNonInventory }: {
  busy: boolean;
  onSubmit: (form: LineFormKind, body: NonNullable<ReturnType<typeof lineFormBody>>) => void;
  onCancel: () => void;
  onNonInventory?: () => void;
}) {
  const [form, setForm] = useState<LineFormKind>("associate");
  const [chosen, setChosen] = useState<CatalogItem | null>(null);
  const [search, setSearch] = useState("");
  const found = useCatalogSearch(search);
  const results = [...(chosen ? [chosen] : []), ...found.items.filter((item) => item.gtin13 !== chosen?.gtin13)];
  const gtin13 = chosen?.gtin13 ?? null;
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [subcategoryId, setSubcategoryId] = useState<string | null>(null);
  const [usage, setUsage] = useState<string | null>(null);
  const [factor, setFactor] = useState<number | string>(1);
  const conversionFactor = Number(factor) || 1;
  const categories = useLoad<CategoryOption[]>("/api/catalog/categories");
  const subcategories = useLoad<SubcategoryOption[]>("/api/catalog/subcategories");
  const categoryOptions = (categories.data ?? []).map((c) => ({ value: String(c.id), label: `${c.letter} — ${c.name}` }));
  const subcategoryOptions = (subcategories.data ?? [])
    .filter((s) => String(s.categoryId) === categoryId)
    .map((s) => ({ value: String(s.id), label: `${String(s.number).padStart(2, "0")} — ${s.name}` }));
  const body = lineFormBody(form, { gtin13, name, categoryId, subcategoryId, usage, conversionFactor });

  return (
    <Stack gap={4}>
      {form === "associate" ? (
        <>
          <TextInput
            size="xs"
            placeholder="Search the catalog by name, GTIN or category"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            error={found.error && `Couldn't search the catalog: ${found.error}`}
            miw={320}
          />
          {catalogSearchTerm(search) === null && <Text size="xs" c="dimmed">Type at least {MIN_CATALOG_SEARCH_LENGTH} characters</Text>}
          {found.answered && !found.error && results.length === 0 && <Text size="xs" c="dimmed">No matching catalog items</Text>}
          {results.length > 0 && (
            <ScrollArea.Autosize mah={220}>
              <Radio.Group
                aria-label="Catalog items"
                value={gtin13}
                onChange={(v) => setChosen(results.find((item) => item.gtin13 === v) ?? null)}
              >
                <Stack gap={6} py={4}>
                  {results.map((item) => <Radio key={item.gtin13} size="xs" value={item.gtin13} label={catalogItemLabel(item)} />)}
                </Stack>
              </Radio.Group>
            </ScrollArea.Autosize>
          )}
          <Group>
            <Button size="xs" variant="light" onClick={() => { setName(search.trim()); setForm("propose"); }}>Propose new item</Button>
          </Group>
        </>
      ) : (
        <>
          <TextInput size="xs" placeholder="Proposed name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Select
            size="xs"
            placeholder="Category"
            data={categoryOptions}
            value={categoryId}
            onChange={(v) => { setCategoryId(v); setSubcategoryId(null); }}
            searchable
            error={categories.error && `Couldn't load categories: ${categories.error}`}
            nothingFoundMessage="No categories — add them in Categories"
          />
          <Select
            size="xs"
            placeholder={categoryId ? "Subcategory" : "Choose a category first"}
            data={subcategoryOptions}
            value={subcategoryId}
            onChange={setSubcategoryId}
            disabled={!categoryId}
            searchable
            error={subcategories.error && `Couldn't load subcategories: ${subcategories.error}`}
            nothingFoundMessage="No subcategories for this category"
          />
          <Select size="xs" placeholder="Usage behavior" data={[...USAGE_BEHAVIORS]} value={usage} onChange={setUsage} />
        </>
      )}
      <NumberInput size="xs" label="Units per receipt unit" min={1} value={factor} onChange={setFactor} />
      <Group gap={4}>
        <Button
          size="xs"
          loading={busy}
          disabled={!body}
          onClick={() => { if (body) onSubmit(form, body); }}
        >
          Save
        </Button>
        <Button size="xs" variant="subtle" onClick={form === "propose" ? () => setForm("associate") : onCancel}>Cancel</Button>
        {onNonInventory && (
          <Button size="xs" variant="subtle" color="gray" loading={busy} onClick={onNonInventory}>Not inventory</Button>
        )}
      </Group>
    </Stack>
  );
}
