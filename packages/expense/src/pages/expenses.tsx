"use client";
import { useState } from "react";
import { Anchor, Badge, Group, Pagination, SegmentedControl, Table, Text, Title } from "@mantine/core";
import { formatCents } from "@inventory/money";
import { STATE_COLORS, STATE_LABELS } from "../lib/expense-constants";
import { PAGE_SIZE, useLoad } from "../components/api";
import LoadError from "../components/LoadError";
import ExpenseSubNav from "../components/ExpenseSubNav";

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
  return <ExpenseList detailBase="/expense/expenses" defaultView="all" subNav />;
}

/**
 * The expense queue by view. The routes confine an approver to their buckets' expenses, so the
 * same list serves Expense Ops and the approver's My Programs tab.
 */
export function ExpenseList({ detailBase, defaultView, subNav = false }: { detailBase: string; defaultView: string; subNav?: boolean }) {
  const [view, setView] = useState(defaultView);
  const [page, setPage] = useState(1);
  const counts = useLoad<Record<string, number>>("/counts");
  const rows = useLoad<ExpenseRow[]>(`/expenses?view=${view}&page=${page}&limit=${PAGE_SIZE}`);
  const total = useLoad<{ total: number }>(`/expenses/count?view=${view}`);

  const label = (v: { value: string; label: string }) => {
    const n = v.value === "all" ? undefined : counts.data?.[v.value];
    return n ? `${v.label} (${n})` : v.label;
  };

  return (
    <>
      {subNav && <ExpenseSubNav current="/expense/expenses" />}
      <Title order={3} mb="md">Expenses</Title>
      <SegmentedControl
        mb="md"
        value={view}
        onChange={(v) => { setView(v); setPage(1); }}
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
                <Anchor href={`${detailBase}/${encodeURIComponent(e.id)}`}>{e.vendorName ?? e.id}</Anchor>
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
        <Pagination value={page} onChange={setPage} total={Math.max(1, Math.ceil((total.data?.total ?? 0) / PAGE_SIZE))} />
      </Group>
    </>
  );
}
