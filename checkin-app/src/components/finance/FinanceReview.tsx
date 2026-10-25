"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { Alert, Anchor, Button, Group, Select, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  NOT_PUSHED,
  OTHER_QUEUES,
  QUEUES,
  QueueCount,
  ReceiptQueueList,
  isOtherQueue,
  isReceiptQueue,
  queueBadge,
  useQueueCounts,
  type QueueBadge,
} from "@checkin/receipt/pages/financeQueue";
import { FINANCE_QUEUE_TABS, FinanceQueueList, financeQueueTab, loadFailure, useFinanceQueueCounts } from "@checkin/expense/pages/financeQueue";
import { FINANCE_REVIEW_PATH } from "@/lib/nav/sections/finance";

/** A tab as the host lays it out: its `?queue=` value, label, group, and this viewer's counts. */
interface Tab {
  queue: string;
  label: string;
  badge: QueueBadge | null;
  actionable: number;
  total: number;
}

const ALL = "all";

const badgeOf = (actionable: number, total: number): QueueBadge | null =>
  actionable > 0 ? { count: actionable, intent: "action" } : total > 0 ? { count: total, intent: "info" } : null;

/** Receiving's apply-failed count, for the Not delivered tab's pointer to Receiving › Apply failed. */
function useApplyFailed(enabled: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch("/api/workflow-mapping/receipts/counts")
      .then((r) => (r.ok ? r.json() : null))
      .then((c: { apply_failed?: number } | null) => { if (live) setN(c?.apply_failed ?? 0); })
      .catch(() => { if (live) setN(0); });
    return () => { live = false; };
  }, [enabled]);
  return n;
}

function TabButton({ tab, selected, onSelect }: { tab: Tab; selected: boolean; onSelect: (queue: string) => void }) {
  return (
    <Button
      size="xs"
      aria-pressed={selected}
      variant={selected ? "filled" : "light"}
      color={selected ? undefined : "gray"}
      style={{ opacity: tab.actionable > 0 || selected ? 1 : 0.6 }}
      onClick={() => onSelect(tab.queue)}
      rightSection={<QueueCount badge={tab.badge} />}
    >
      {tab.label}
    </Button>
  );
}

/**
 * /finance/review — finance's one queue (#2481 §3): the receipt tabs from the receipt library, the
 * expense and Board tabs from the expense library, in three labelled rows. The page owns `?queue=`
 * and `?reason=`; with no `?queue=` it opens the first tab with work for this viewer.
 */
export default function FinanceReview() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: session } = useSession();
  const isFinance = (session?.user as { isFinance?: boolean } | undefined)?.isFinance === true;
  const receipts = useQueueCounts();
  useEffect(() => {
    if (receipts.error) {
      notifications.show({ id: "receipt-queue-counts", title: "Couldn't load the receipt tab counts", message: loadFailure("/api/receipts/queue-counts", receipts.error), color: "red", autoClose: false });
    }
  }, [receipts.error]);
  const expenses = useFinanceQueueCounts();

  const receiptTab = (q: { value: string; label: string }): Tab => {
    const badge = q.value ? queueBadge(q.value, receipts.counts, isFinance) : null;
    const total = q.value === NOT_PUSHED ? (receipts.counts?.notPushed ?? 0) : (receipts.counts?.byState[q.value] ?? 0);
    return { queue: q.value || ALL, label: q.label, badge, actionable: badge?.intent === "action" ? badge.count : 0, total };
  };
  const mainReceiptTabs = QUEUES.map(receiptTab);
  const otherReceiptTabs = OTHER_QUEUES.map(receiptTab);
  const expenseTabs: Tab[] = FINANCE_QUEUE_TABS.map((t) => {
    const c = expenses.counts?.[t.key];
    return { queue: t.queue, label: t.label, badge: c ? badgeOf(c.actionable, c.total) : null, actionable: c?.actionable ?? 0, total: c?.total ?? 0 };
  });
  const boardTabs = expenseTabs.filter((t) => t.queue === "board");
  const expenseRow = expenseTabs.filter((t) => t.queue !== "board");
  // The order a viewer is walked through: Receipts, then Expenses, then Board.
  const ordered = [...mainReceiptTabs.filter((t) => t.queue !== ALL), ...otherReceiptTabs, ...expenseRow, ...boardTabs];
  const loaded = receipts.counts !== null && expenses.counts !== null;

  const param = params.get("queue");
  const known = param !== null && (param === ALL || isReceiptQueue(param) || financeQueueTab(param) !== null);
  const landing = ordered.find((t) => t.actionable > 0)?.queue ?? QUEUES[0].value;
  const queue = known ? param : loaded ? landing : null;
  const reason = params.get("reason");
  const applyFailed = useApplyFailed(queue === NOT_PUSHED);

  const hrefFor = (q: string, chip: string | null = null) => `${FINANCE_REVIEW_PATH}?${new URLSearchParams({ queue: q, ...(chip ? { reason: chip } : {}) })}`;
  const show = (q: string, chip: string | null = null) => router.replace(hrefFor(q, chip), { scroll: false });

  const current = ordered.find((t) => t.queue === queue);
  const next = current ? [...ordered.slice(ordered.indexOf(current) + 1), ...ordered.slice(0, ordered.indexOf(current))].find((t) => t.actionable > 0) : undefined;
  const nothingAnywhere = loaded && ordered.every((t) => t.actionable === 0);
  const expenseTab = queue ? financeQueueTab(queue) : null;

  return (
    <>
      <Title order={3} mb="md">Finance review</Title>
      <Stack gap="xs" mb="md">
        <Group gap="xs" align="center">
          <Text fw={600} w={80}>Receipts</Text>
          {mainReceiptTabs.map((t) => <TabButton key={t.queue} tab={t} selected={queue === t.queue} onSelect={show} />)}
          <Select
            aria-label="More receipt states"
            placeholder="More"
            size="xs"
            data={OTHER_QUEUES}
            value={queue && isOtherQueue(queue) ? queue : null}
            onChange={(q) => q && show(q)}
            renderOption={({ option }) => (
              <Group gap={6} wrap="nowrap">
                {option.label}
                <QueueCount badge={otherReceiptTabs.find((t) => t.queue === option.value)?.badge ?? null} />
              </Group>
            )}
            allowDeselect={false}
            w={240}
          />
          {queue && isOtherQueue(queue) && <QueueCount badge={otherReceiptTabs.find((t) => t.queue === queue)?.badge ?? null} />}
        </Group>
        <Group gap="xs" align="center">
          <Text fw={600} w={80}>Expenses</Text>
          {expenseRow.map((t) => <TabButton key={t.queue} tab={t} selected={queue === t.queue} onSelect={show} />)}
        </Group>
        <Group gap="xs" align="center">
          <Text fw={600} w={80}>Board</Text>
          {boardTabs.map((t) => <TabButton key={t.queue} tab={t} selected={queue === t.queue} onSelect={show} />)}
        </Group>
      </Stack>

      {!queue && <Text c="dimmed">Loading…</Text>}
      {loaded && current && current.total === 0 && (
        <Alert color={nothingAnywhere ? "green" : "blue"} mb="md">
          {nothingAnywhere || !next ? (
            "Nothing waiting on you."
          ) : (
            <>
              Nothing left here. Next:{" "}
              <Anchor component="button" onClick={() => show(next.queue)}>{next.label} ({next.actionable})</Anchor>
            </>
          )}
        </Alert>
      )}
      {queue === NOT_PUSHED && applyFailed > 0 && (
        <Alert color="orange" mb="md">
          <Anchor component={Link} href="/inventory/receiving?queue=failed">
            {applyFailed} {applyFailed === 1 ? "receipt" : "receipts"} failed to apply in receiving
          </Anchor>
        </Alert>
      )}
      {queue && expenseTab && <FinanceQueueList tab={expenseTab.key} counts={expenses.counts} reason={reason} returnHref={hrefFor(queue, reason)} onReason={(r) => show(queue, r)} />}
      {queue && !expenseTab && <ReceiptQueueList queue={queue === ALL ? "" : queue} />}
    </>
  );
}
