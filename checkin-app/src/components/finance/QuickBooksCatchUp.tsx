"use client";

import { useEffect, useState } from "react";
import { Button, Group, Paper, Stack, Text } from "@mantine/core";
import { refusalMessage, showError } from "@checkin/component-ui";
import { api, useLoad } from "@/lib/api";
import { useOrgTime } from "@/components/TimezoneProvider";

type Lane = "expense" | "in-kind" | "income";

interface CatchUpView {
  lane: Lane | null;
  status: "started" | "queued" | "running" | "stranded" | "idle";
  heldBy: Lane | null;
  until: string | null;
  queued: Lane[];
  pausedUntil: string | null;
  lastRuns: Partial<Record<Lane, { ended: string; created: number; capped: string | null }>>;
}

const LANES: Lane[] = ["expense", "in-kind", "income"];
const LABEL: Record<Lane, string> = { expense: "Expenses", "in-kind": "Gifts of goods", income: "Income" };
const PATH = "/api/finance/quickbooks/catch-up";
const POLL_MS = 5000;

/** One line on what the posting slot is doing now. */
export function slotLine(view: CatchUpView): string {
  const waiting = view.queued.map((l) => LABEL[l]).join(", ");
  if (view.heldBy) return `Posting ${LABEL[view.heldBy]} to QuickBooks now.${waiting ? ` Waiting: ${waiting}.` : ""}`;
  if (waiting) return `The last QuickBooks run stopped without finishing; waiting: ${waiting}. Press Catch up to restart them, or they run with tonight's posting.`;
  return "Nothing is posting to QuickBooks now. Posting runs every night.";
}

/** The lines worth finance's notice: a throttle pause in force, and each lane whose last run stopped at its per-run limit. */
export function noticeLines(view: CatchUpView, formatTime: (date: string) => string): string[] {
  const lines = view.pausedUntil ? [`Posting paused: QuickBooks asked us to slow down; resumes at ${formatTime(view.pausedUntil)}.`] : [];
  for (const lane of LANES) {
    const run = view.lastRuns[lane];
    if (run?.capped === "count") lines.push(`The last ${LABEL[lane]} run stopped after ${run.created} entries; the rest go in the next run.`);
  }
  return lines;
}

/**
 * Finance's buttons to post one lane to QuickBooks now instead of waiting for the nightly run.
 * One lane posts at a time; a lane asked for while another posts waits its turn.
 */
export default function QuickBooksCatchUp() {
  const state = useLoad<CatchUpView>(PATH);
  const [starting, setStarting] = useState<Lane | null>(null);
  const view = state.data;
  const busy = !!view?.heldBy;
  const { reload } = state;
  const { formatTime } = useOrgTime();

  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => void reload(), POLL_MS);
    return () => clearTimeout(timer);
  }, [busy, reload, view]);

  async function start(lane: Lane) {
    setStarting(lane);
    try {
      await api<CatchUpView>(PATH, { method: "POST", body: JSON.stringify({ lane }) });
    } catch (err) {
      showError(refusalMessage(err), { title: "Couldn't start posting" });
    }
    setStarting(null);
    await reload();
  }

  return (
    <Paper withBorder p="md">
      <Stack gap="xs">
        <Text fw={500}>Catch up on QuickBooks posting</Text>
        <Text size="sm" c="dimmed">
          Posts one lane to QuickBooks now instead of waiting for the nightly run. One run creates at most 100 entries; the
          rest go in the next run.
        </Text>
        {view && <Text size="sm">{slotLine(view)}</Text>}
        {view &&
          noticeLines(view, (date) => formatTime(date, { timeStyle: "short" })).map((line) => (
            <Text key={line} size="sm">
              {line}
            </Text>
          ))}
        <Group gap="xs">
          {LANES.map((lane) => {
            const label = LABEL[lane];
            const running = view?.heldBy === lane;
            const waiting = !running && !!view?.queued.includes(lane);
            return (
              <Button key={lane} size="xs" variant="light" loading={starting === lane} disabled={running || waiting} onClick={() => void start(lane)}>
                {running ? `${label}: posting…` : waiting ? `${label}: waiting` : `Catch up ${label.toLowerCase()}`}
              </Button>
            );
          })}
        </Group>
      </Stack>
    </Paper>
  );
}
