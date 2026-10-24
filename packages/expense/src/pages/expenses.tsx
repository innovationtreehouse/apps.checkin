"use client";
import type { ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Anchor, Badge, Group, Pagination, SegmentedControl, Table, Text, Title } from "@mantine/core";
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
  { value: "all", label: "All" },
  { value: "awaiting_me", label: "Waiting on you" },
  { value: "assign_ownership", label: "Assign ownership" },
  { value: "resolve_ownership", label: "Resolve ownership" },
  { value: "owner_approval", label: "Owner approval" },
  { value: "owner_exception", label: "Exceptions" },
  { value: "capital_review", label: "Capital review" },
  { value: "set_depreciation_cycle", label: "Depreciation" },
  { value: "qb_pending", label: "QB pending" },
];

/** /expense/expenses — FINANCE and Board's expense queue. */
export default function ExpensesPage() {
  return <ExpenseList detailBase="/expense/expenses" defaultView="all" />;
}

/**
 * The expense queue by view. The routes confine an approver to their buckets' expenses, so the
 * same list serves Expense Ops and the approver's Programs I Lead tab. `viewBadge` is the host's
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
  const view = VIEWS.some((v) => v.value === params.get("view")) ? (params.get("view") as string) : defaultView;
  const page = Math.max(1, Number(params.get("page")) || 1);
  const listHref = (v: string, p: number) => `${detailBase}?view=${v}&page=${p}`;
  const show = (v: string, p: number) => router.replace(listHref(v, p), { scroll: false });
  const counts = useLoad<Record<string, number>>("/counts");
  const rows = useLoad<ExpenseRow[]>(`/expenses?view=${view}&page=${page}&limit=${PAGE_SIZE}`);
  const total = useLoad<{ total: number }>(`/expenses/count?view=${view}`);

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
