"use client";
import { Fragment, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Alert, Anchor, Badge, Button, Group, NumberInput, Paper, SimpleGrid, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { LINE_STATUS_COLOR, LINE_STATUS_LABEL, STATE_COLOR, STATE_LABEL, api, errorMessage, formatCents, notifyNavCounts, useCanManage, useLoad } from "../components/api";

interface Receipt {
  id: number;
  state: string;
  validationNotes?: string | null;
  createdAt: string;
  inventoryAppliedAt: string | null;
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

interface AuditRow {
  eventType: string;
  lineStatusId?: number | null;
  details?: unknown;
}
type Leg = "inventory" | "expense" | "donation";

type Form = "associate" | "propose" | null;

// The donation leg records only the receipt's total and date, which a line edit never changes.
const LATE_EDIT_FIX: Partial<Record<Leg, string>> = {
  inventory: "Stock was loaded from the old lines. Adjust it by hand in Inventory.",
  expense: "The expense was sent with the old lines. Correct it by hand in Expenses.",
};

/** Lines edited after a leg applied, grouped by the leg that still holds the old lines. */
function lateEdits(rows: AuditRow[] | null): Map<Leg, Set<number>> {
  const byLeg = new Map<Leg, Set<number>>();
  for (const row of rows ?? []) {
    if (row.eventType !== "line_edited_late" || row.lineStatusId == null) continue;
    const legs = (row.details as { appliedLegs?: Leg[] } | null)?.appliedLegs ?? [];
    for (const leg of legs.filter((l) => LATE_EDIT_FIX[l])) byLeg.set(leg, (byLeg.get(leg) ?? new Set<number>()).add(row.lineStatusId));
  }
  return byLeg;
}

/**
 * /inventory/receiving/[id] — one receipt's lines, their mapping decisions, and the push controls.
 * `backHref` is the page it was opened from, which the back link returns to.
 */
export default function ReceiptPage({ backHref = "/inventory/receiving" }: { backHref?: string }) {
  const { id } = useParams<{ id: string }>();
  const canManage = useCanManage();
  const detail = useLoad<Detail>(`/receipts/${id}`);
  const audit = useLoad<AuditRow[]>(`/audit-log?receiptId=${id}&limit=500`);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ lineId: number; form: Form }>({ lineId: 0, form: null });

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
      audit.reload();
      notifyNavCounts();
    }
  }

  if (detail.error) return <Alert color="red" title="Couldn't load the receipt">{detail.error}</Alert>;
  if (!detail.data) return <Text c="dimmed">Loading…</Text>;
  const { ReceivedReceipt: receipt, WorkflowReceiptView: parsed, ReceivedReceiptLineStatus: lines } = detail.data;
  const lineLegApplied = !!(receipt.inventoryAppliedAt || receipt.expenseAppliedAt);
  const editable = canManage && ["pending_review", "apply_failed"].includes(receipt.state);
  const late = lateEdits(audit.data);
  // An edit after a leg applied never reaches that leg, so the manager confirms the manual fix first.
  const editLine = (path: string, body?: unknown, message?: string) =>
    (!lineLegApplied || window.confirm("Part of this receipt was already applied. This change won't reach it; you'll need to fix that part by hand. Save anyway?"))
      ? act(path, body, message)
      : Promise.resolve(false);
  const base = `/receipts/${receipt.id}`;
  const items = new Map(parsed.lineItems.map((li) => [li.receiptLineItemId, li]));

  return (
    <>
      <Anchor component={Link} href={backHref} size="sm">← Back</Anchor>
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
        <Field label="Discount" value={`${parsed.discountCents ? "−" : ""}${formatCents(parsed.discountCents, parsed.currency)}`} money />
        <Field label="Receipt id" value={parsed.receiptId ?? "—"} mono />
        <Field label="Received" value={new Date(receipt.createdAt).toLocaleString()} />
      </Group>
      {[...late].map(([leg, lineIds]) => (
        <Alert key={leg} color="yellow" mb="md" title="Needs a manual fix">
          {LATE_EDIT_FIX[leg]} Changed after it applied: line{lineIds.size > 1 ? "s" : ""}{" "}
          {lines.filter((ls) => lineIds.has(ls.id)).map((ls) => items.get(ls.receiptLineItemId)?.lineNumber ?? ls.id).join(", ")}.
        </Alert>
      ))}
      {receipt.validationNotes && <Alert color="orange" mb="md" title="Last push failed">{receipt.validationNotes}</Alert>}
      {canManage && (
        <Group mb="md">
          {receipt.state === "pending_review" && (
            <Button loading={busy} onClick={() => act(`${base}/proceed`, undefined, "Proceeded")}>Proceed</Button>
          )}
          {receipt.state === "applying" && (
            <Button loading={busy} onClick={() => act(`${base}/apply`, undefined, "Applied")}>Apply</Button>
          )}
          {(receipt.state === "apply_failed" || receipt.state === "applying") && (
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
            const isOpen = editable && open.lineId === ls.id && !!open.form;
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
                    {(ls.assignedGtin13 ?? ls.provisionalItemGtin13) && (
                      <Text size="xs" ff="monospace" c="dimmed">
                        {ls.assignedGtin13 ?? ls.provisionalItemGtin13} ×{ls.conversionFactor}
                      </Text>
                    )}
                  </Table.Td>
                  {editable && (
                    <Table.Td>
                      {isOpen ? (
                        <Button size="xs" variant="subtle" onClick={() => setOpen({ lineId: 0, form: null })}>Close</Button>
                      ) : (
                        <Group gap={4} wrap="nowrap">
                          <Button size="xs" variant="light" onClick={() => setOpen({ lineId: ls.id, form: "associate" })}>Associate</Button>
                          <Button size="xs" variant="light" onClick={() => setOpen({ lineId: ls.id, form: "propose" })}>Propose</Button>
                          <Button size="xs" variant="subtle" loading={busy} onClick={() => editLine(`${lineBase}/non-inventory`, undefined, "Marked not inventory")}>
                            Not inventory
                          </Button>
                        </Group>
                      )}
                    </Table.Td>
                  )}
                </Table.Tr>
                {isOpen && open.form && (
                  <Table.Tr>
                    <Table.Td colSpan={COLUMNS + 1}>
                      <Paper component="section" p="md" withBorder aria-label={`Line ${li?.lineNumber ?? i + 1} details`}>
                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg">
                          <LineDetails item={li} currency={parsed.currency} />
                          <LineForm
                            form={open.form}
                            busy={busy}
                            onCancel={() => setOpen({ lineId: 0, form: null })}
                            onSubmit={async (body) => {
                              if (await editLine(`${lineBase}/${open.form}`, body)) setOpen({ lineId: 0, form: null });
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

function LineForm({ form, busy, onSubmit, onCancel }: {
  form: "associate" | "propose";
  busy: boolean;
  onSubmit: (body: Record<string, string | number>) => void;
  onCancel: () => void;
}) {
  const [gtin13, setGtin13] = useState("");
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<number | string>("");
  const [subcategoryId, setSubcategoryId] = useState<number | string>("");
  const [usage, setUsage] = useState("Consumable");
  const [factor, setFactor] = useState<number | string>(1);
  const conversionFactor = Number(factor) || 1;

  return (
    <Stack gap={4}>
      {form === "associate" ? (
        <TextInput size="xs" placeholder="GTIN-13" value={gtin13} onChange={(e) => setGtin13(e.currentTarget.value)} />
      ) : (
        <>
          <TextInput size="xs" placeholder="Proposed name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <NumberInput size="xs" placeholder="Category id" min={1} value={categoryId} onChange={setCategoryId} />
          <NumberInput size="xs" placeholder="Subcategory id" min={1} value={subcategoryId} onChange={setSubcategoryId} />
          <TextInput size="xs" placeholder="Usage behavior" value={usage} onChange={(e) => setUsage(e.currentTarget.value)} />
        </>
      )}
      <NumberInput size="xs" label="Units per receipt unit" min={1} value={factor} onChange={setFactor} />
      <Group gap={4}>
        <Button
          size="xs"
          loading={busy}
          onClick={() =>
            onSubmit(
              form === "associate"
                ? { gtin13: gtin13.trim(), conversionFactor }
                : {
                    proposedName: name.trim(),
                    proposedCategoryId: Number(categoryId),
                    proposedSubcategoryId: Number(subcategoryId),
                    proposedUsageBehavior: usage.trim(),
                    conversionFactor,
                  },
            )
          }
        >
          Save
        </Button>
        <Button size="xs" variant="subtle" onClick={onCancel}>Cancel</Button>
      </Group>
    </Stack>
  );
}
