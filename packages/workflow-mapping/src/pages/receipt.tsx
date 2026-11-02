"use client";
import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Alert, Anchor, Badge, Button, Group, NumberInput, Paper, Radio, ScrollArea, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { formatGtinDisplay } from "@checkin/gtin";
import { USAGE_BEHAVIORS } from "@checkin/receipt-types";
import { LINE_STATUS_COLOR, LINE_STATUS_LABEL, STATE_COLOR, STATE_LABEL, api, errorMessage, notifyNavCounts, useCanManage, useLoad } from "../components/api";
import { formatCents } from "@checkin/money";
import { MIN_CATALOG_SEARCH_LENGTH, catalogSearchTerm } from "../lib/catalog-search";
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
/** GET /api/catalog/items rows, with their category and subcategory included. */
interface CatalogItem {
  gtin13: string;
  name: string;
  category: { name: string };
  subcategory: { name: string };
}

const itemLabel = (item: CatalogItem) => `${item.name} · ${item.category.name} / ${item.subcategory.name} · ${formatGtinDisplay(item.gtin13)}`;

/** Catalog items matching the typed text, from the catalog's own search route; none until a search for the current text returns. */
function useCatalogSearch(q: string): { items: CatalogItem[]; error: string | null; answered: boolean } {
  const [result, setResult] = useState<{ term: string; items: CatalogItem[]; error: string | null } | null>(null);
  const term = catalogSearchTerm(q);
  useEffect(() => {
    if (term === null) return;
    let live = true;
    const t = setTimeout(() => {
      api<CatalogItem[]>(`/api/catalog/items?q=${encodeURIComponent(term)}&limit=20`)
        .then((rows) => { if (live) setResult({ term, items: rows, error: null }); })
        .catch((e: unknown) => { if (live) setResult({ term, items: [], error: errorMessage(e) }); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [term]);
  return result && result.term === term ? { items: result.items, error: result.error, answered: true } : { items: [], error: null, answered: false };
}

/** Catalog names by GTIN, one request per distinct GTIN; a name that fails to load is left out and the part still shows its ID. */
function useCatalogNames(gtins: string[]): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const key = [...new Set(gtins)].sort().join(",");
  useEffect(() => {
    if (!key) return;
    let live = true;
    Promise.all(key.split(",").map((gtin13) => api<CatalogItem>(`/api/catalog/items/${gtin13}`).catch(() => null)))
      .then((rows) => { if (live) setNames(new Map(rows.flatMap((row) => (row ? [[row.gtin13, row.name] as const] : [])))); });
    return () => { live = false; };
  }, [key]);
  return names;
}

/**
 * /inventory/receiving/[id] — one receipt's lines, their mapping decisions, and the push controls.
 * `backHref` is the page it was opened from, which the back link returns to.
 */
export default function ReceiptPage({ backHref = "/inventory/receiving" }: { backHref?: string }) {
  const { id } = useParams<{ id: string }>();
  const canManage = useCanManage();
  const detail = useLoad<Detail>(`/receipts/${id}`);
  const catalogNames = useCatalogNames((detail.data?.ReceivedReceiptLineStatus ?? []).flatMap((ls) => ls.assignedGtin13 ?? []));
  const [busy, setBusy] = useState(false);
  const [openLineId, setOpenLineId] = useState<number | null>(null);

  async function act(path: string, body?: unknown, message = "Saved"): Promise<boolean> {
    setBusy(true);
    try {
      const res = await api<{ state?: string; validationNotes?: string } | null>(path, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res?.validationNotes) {
        const title = res.state === "applying" ? "Apply didn't finish" : "Apply failed";
        notifications.show({ title, message: res.validationNotes, color: "red", autoClose: false });
      } else notifications.show({ message, color: "green" });
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
  const base = `/receipts/${receipt.id}`;
  const items = new Map(parsed.lineItems.map((li) => [li.receiptLineItemId, li]));

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
        <Badge size="lg" variant="light" color={STATE_COLOR[receipt.state] ?? "gray"}>{STATE_LABEL[receipt.state] ?? receipt.state}</Badge>
      </Group>
      <Group gap="xl" align="start" my="md">
        <Field label="Total" value={formatCents(parsed.receiptTotalCents, parsed.currency)} money />
        <Field label="Tax" value={formatCents(parsed.taxCents, parsed.currency)} money />
        <Field label="Shipping" value={formatCents(parsed.shippingCents, parsed.currency)} money />
        <Field label="Discount" value={formatCents(parsed.discountCents ? -parsed.discountCents : parsed.discountCents, parsed.currency)} money />
        <Field label="Receipt id" value={parsed.receiptId ?? "—"} mono />
        <Field label="Received" value={new Date(receipt.createdAt).toLocaleString()} />
      </Group>
      {receipt.validationNotes && <Alert color="orange" mb="md" title="Last push failed">{receipt.validationNotes}</Alert>}
      {receipt.state === "applying" && (
        <Text size="sm" c="dimmed" mb="md">Applying — the system retries this automatically.</Text>
      )}
      {canManage && receipt.state === "apply_failed" && (
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
          {receipt.state === "apply_failed" && (
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
            // A provisional part takes its name from the line's description when the receipt applies.
            const mappedName = ls.assignedGtin13 ? catalogNames.get(ls.assignedGtin13) : li?.description;
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
                      ) : (
                        <Group gap={4} wrap="nowrap">
                          <Button size="xs" variant="light" onClick={() => setOpenLineId(ls.id)}>Associate</Button>
                          <Button size="xs" variant="subtle" loading={busy} onClick={() => act(`${lineBase}/non-inventory`, undefined, "Marked not inventory")}>
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
                            onSubmit={async (form, body) => {
                              if (await act(`${lineBase}/${form}`, body)) setOpenLineId(null);
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

function LineForm({ busy, onSubmit, onCancel }: {
  busy: boolean;
  onSubmit: (form: LineFormKind, body: NonNullable<ReturnType<typeof lineFormBody>>) => void;
  onCancel: () => void;
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
                  {results.map((item) => <Radio key={item.gtin13} size="xs" value={item.gtin13} label={itemLabel(item)} />)}
                </Stack>
              </Radio.Group>
            </ScrollArea.Autosize>
          )}
          {found.answered && !found.error && (
            <Group>
              <Button size="xs" variant="light" onClick={() => { setName(search.trim()); setForm("propose"); }}>Propose new item</Button>
            </Group>
          )}
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
      </Group>
    </Stack>
  );
}
