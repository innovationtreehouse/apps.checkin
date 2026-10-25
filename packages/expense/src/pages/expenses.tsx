"use client";
import type { ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Anchor, Badge, Checkbox, Group, Pagination, SegmentedControl, Table, Text, Title } from "@mantine/core";
import { formatCents } from "@checkin/money";
import { STATE_COLORS, STATE_LABELS } from "../lib/expense-constants";
import { PAGE_SIZE, useLoad } from "../components/api";
import LoadError from "../components/LoadError";

interface ExpenseRow {
  id: string;
  vendorName: string | null;
  receiptTotalCents: number;
  currency: string;
  receiptDate: string | null;
  submittedAt: string;
  state: string;
  needsReimbursement: boolean;
}

const VIEWS = [
  { value: "all", label: "All", description: "Every expense you can see, newest first. Open one to act on it." },
  {
    value: "assign_ownership",
    label: "Assign ownership",
    description: "Expenses with lines that have no owner yet. FINANCE assigns each line an owner.",
  },
  {
    value: "resolve_ownership",
    label: "Resolve ownership",
    description: "Lines the submitter marked as owner unknown. FINANCE picks an owner for each.",
  },
  {
    value: "owner_approval",
    label: "Owner approval",
    description: "Lines waiting on their bucket's approval. The bucket owner or a treasurer approves each or raises an exception.",
  },
  {
    value: "owner_exception",
    label: "Exceptions",
    description: "Lines an approver raised an exception on. FINANCE settles each one.",
  },
  {
    value: "capital_review",
    label: "Capital review",
    description: "Expenses at or over the capital thresholds. FINANCE decides which lines are capital assets.",
  },
  {
    value: "set_depreciation_cycle",
    label: "Depreciation",
    description: "Capital expenses with no depreciation schedule yet. FINANCE sets the cycle and owner bucket.",
  },
  {
    value: "qb_pending",
    label: "QB pending",
    description: "Signed-off expenses waiting for the app to post them to QuickBooks. Nobody needs to act.",
  },
];

/** /expense/expenses — FINANCE and Board's expense queue. */
export default function ExpensesPage() {
  return <ExpenseList detailBase="/expense/expenses" defaultView="all" />;
}

/**
 * The expense queue by view. The routes confine an approver to their buckets' expenses, so the
 * same list serves Finance and the approver's Programs I Lead tab. `viewBadge` is the host's
 * pill beside a view's label: what the viewer can act on there.
 */
export function ExpenseList({
  detailBase,
  defaultView,
  viewBadge,
}: {
  detailBase: string;
  defaultView: string;
  viewBadge?: (view: string) => ReactNode;
}) {
  // The view and page ride in the URL, so an expense opened from here returns to the same slice.
  const router = useRouter();
  const params = useSearchParams();
  const current = VIEWS.find((v) => v.value === params.get("view")) ?? VIEWS.find((v) => v.value === defaultView) ?? VIEWS[0];
  const view = current.value;
  const page = Math.max(1, Number(params.get("page")) || 1);
  // Only the All view lists closed expenses; the other views are work still in progress.
  const onlyActive = params.get("active") !== "0";
  const activeOnly = view === "all" && onlyActive;
  const listHref = (v: string, p: number, active = onlyActive) => `${detailBase}?view=${v}&page=${p}${active ? "" : "&active=0"}`;
  const show = (v: string, p: number, active = onlyActive) => router.replace(listHref(v, p, active), { scroll: false });
  const counts = useLoad<Record<string, number>>("/counts");
  const filter = `view=${view}${activeOnly ? "&active=1" : ""}`;
  const rows = useLoad<ExpenseRow[]>(`/expenses?${filter}&page=${page}&limit=${PAGE_SIZE}`);
  const total = useLoad<{ total: number }>(`/expenses/count?${filter}`);

  const label = (v: { value: string; label: string }) => {
    const n = v.value === "all" ? undefined : counts.data?.[v.value];
    const text = n ? `${v.label} (${n})` : v.label;
    const badge = viewBadge?.(v.value);
    return badge ? <Group gap={6} wrap="nowrap" justify="center">{text}{badge}</Group> : text;
  };

  return (
    <>
      <Title order={3} mb="md">Expenses</Title>
      <SegmentedControl
        mb="md"
        value={view}
        onChange={(v) => show(v, 1)}
        data={VIEWS.map((v) => ({ value: v.value, label: label(v) }))}
      />
      <Text c="dimmed" size="sm" mb="md">{current.description}</Text>
      {view === "all" && (
        <Checkbox
          mb="md"
          label="Only show active"
          checked={onlyActive}
          onChange={(e) => show(view, 1, e.currentTarget.checked)}
        />
      )}
      {rows.error && <LoadError what="expenses" message={rows.error} onRetry={rows.reload} />}
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Vendor</Table.Th>
            <Table.Th>Receipt date</Table.Th>
            <Table.Th>Total</Table.Th>
            <Table.Th>State</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(rows.data ?? []).map((e) => (
            <Table.Tr key={e.id}>
              <Table.Td>
                <Anchor href={`${detailBase}/${encodeURIComponent(e.id)}?from=${encodeURIComponent(listHref(view, page))}`}>{e.vendorName ?? e.id}</Anchor>
                {e.needsReimbursement && <Badge ml="xs" size="xs" variant="light">Reimbursement</Badge>}
              </Table.Td>
              <Table.Td>{e.receiptDate ?? "—"}</Table.Td>
              <Table.Td>{formatCents(e.receiptTotalCents, e.currency)}</Table.Td>
              <Table.Td>
                <Badge color={STATE_COLORS[e.state] ?? "gray"} variant="light">{STATE_LABELS[e.state] ?? e.state}</Badge>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {rows.data?.length === 0 && <Text c="dimmed" mt="md">Nothing in this view.</Text>}
      <Group justify="center" mt="md">
        <Pagination value={page} onChange={(p) => show(view, p)} total={Math.max(1, Math.ceil((total.data?.total ?? 0) / PAGE_SIZE))} />
      </Group>
    </>
  );
}
