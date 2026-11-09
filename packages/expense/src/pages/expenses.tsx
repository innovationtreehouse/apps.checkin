"use client";
import type { ReactNode } from "react";
import { Anchor, Badge, Checkbox, Group, Pagination, SegmentedControl, Table, Text, Title } from "@mantine/core";
import { formatCents } from "@checkin/money";
import { STATE_COLORS, STATE_LABELS } from "../lib/expense-constants";
import type { ExpenseWaitingOn } from "../lib/waiting-on";
import { PAGE_SIZE, useLoad } from "../components/api";
import { lastPage, LoadError, useUrlChoice, useUrlFilter, useUrlPage } from "@checkin/component-ui";
import { EXPENSE_LIST_VIEWS } from "../nav";

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

/** The rows alone, or beside each row's state label. */
type ListAnswer = ExpenseRow[] | { Expense: ExpenseRow[]; ExpenseWaitingOn?: ExpenseWaitingOn[] };

const VIEWS = [
  { value: "all", label: "All", description: "Every expense you can see, newest first. Open one to act on it." },
  { value: "awaiting_me", label: "Waiting on you", description: "Expenses with lines waiting on your approval." },
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
    description: "Approved expenses waiting on their last signatures or on posting to QuickBooks.",
  },
];

/** /expense/expenses — FINANCE and Board's expense queue. */
export default function ExpensesPage() {
  return <ExpenseList detailBase="/expense/expenses" defaultView="all" />;
}

/**
 * The expense queue by view. The routes confine an approver to their buckets' expenses, so the
 * same list serves Finance and the approver's Programs I Lead tab. `views` are the views the
 * viewer can act in (expenseViewsFor); the routes refuse the others. `viewBadge` is the host's
 * pill beside a view's label: what the viewer can act on there.
 */
export function ExpenseList({
  detailBase,
  defaultView,
  views = EXPENSE_LIST_VIEWS,
  viewBadge,
}: {
  detailBase: string;
  defaultView: string;
  views?: readonly string[];
  viewBadge?: (view: string) => ReactNode;
}) {
  const shown = VIEWS.filter((v) => views.includes(v.value));
  const fallbackView = (shown.find((v) => v.value === defaultView) ?? shown.find((v) => v.value === "all") ?? VIEWS[0]).value;
  const [view, setView] = useUrlChoice("view", shown.map((v) => v.value), fallbackView);
  const current = VIEWS.find((v) => v.value === view) ?? VIEWS[0];
  // Only the All view lists closed expenses; the other views are work still in progress.
  const [active, setActive] = useUrlFilter("active");
  const onlyActive = active !== "0";
  const activeOnly = view === "all" && onlyActive;
  const counts = useLoad<Record<string, number>>("/counts");
  const filter = `view=${view}${activeOnly ? "&active=1" : ""}`;
  const total = useLoad<{ total: number }>(`/expenses/count?${filter}`, { keepPrevious: true });
  const [page, setPage] = useUrlPage(total.data ? lastPage(total.data.total) : null);
  const rows = useLoad<ListAnswer>(`/expenses?${filter}&page=${page}&limit=${PAGE_SIZE}`, { keepPrevious: true });
  const answer = rows.data;
  const list = answer === null ? null : Array.isArray(answer) ? answer : answer.Expense;
  const labels = new Map((answer && !Array.isArray(answer) ? (answer.ExpenseWaitingOn ?? []) : []).map((w) => [w.expenseId, w.label]));
  const listHref = `${detailBase}?view=${view}&page=${page}${onlyActive ? "" : "&active=0"}`;

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
        onChange={setView}
        data={shown.map((v) => ({ value: v.value, label: label(v) }))}
      />
      <Text c="dimmed" size="sm" mb="md">{current.description}</Text>
      {view === "all" && (
        <Checkbox
          mb="md"
          label="Only show active"
          checked={onlyActive}
          onChange={(e) => setActive(e.currentTarget.checked ? "" : "0")}
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
          {(list ?? []).map((e) => (
            <Table.Tr key={e.id}>
              <Table.Td>
                <Anchor href={`${detailBase}/${encodeURIComponent(e.id)}?from=${encodeURIComponent(listHref)}`}>{e.vendorName ?? e.id}</Anchor>
                {e.needsReimbursement && <Badge ml="xs" size="xs" variant="light">Reimbursement</Badge>}
              </Table.Td>
              <Table.Td>{e.receiptDate ?? "—"}</Table.Td>
              <Table.Td>{formatCents(e.receiptTotalCents, e.currency)}</Table.Td>
              <Table.Td>
                <Badge color={STATE_COLORS[e.state] ?? "gray"} variant="light">{labels.get(e.id) ?? STATE_LABELS[e.state] ?? e.state}</Badge>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {list?.length === 0 && <Text c="dimmed" mt="md">Nothing in this view.</Text>}
      <Group justify="center" mt="md">
        <Pagination value={page} onChange={setPage} total={lastPage(total.data?.total ?? 0)} />
      </Group>
    </>
  );
}
