"use client";
import { useEffect, useRef, useState } from "react";
import { Button, Group, Paper, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, useLoad } from "./api";
import { MAIL_CATCH_UP_CAP } from "../lib/mailCatchUpCap";

export interface MailRunSummaryView {
  status: "ok" | "listing_failed" | "crashed";
  messages: number;
  receipts: number;
  held: number;
  waiting: number;
  failed: number;
  more: boolean;
}

export interface MailCatchUpView {
  status: "started" | "busy" | "running" | "idle";
  lastRunAt: string | null;
  lastRun: MailRunSummaryView | null;
}

const PATH = "/mail-items/catch-up";
const POLL_MS = 5000;

/** One line on what a finished mail run did, and whether another run would read more now. */
export function catchUpSummary(run: MailRunSummaryView): string {
  if (run.status === "crashed") return "It stopped with an error. Run it again to continue.";
  if (run.status === "listing_failed") return "It couldn't read the mailbox. Run it again later.";
  const parts = [`${run.messages} messages read`, `${run.receipts} receipts made`, `${run.held} held`, `${run.waiting} still waiting`];
  if (run.failed > 0) parts.push(`${run.failed} failed`);
  return `${parts.join(", ")}.${run.more ? " Run it again to continue." : ""}`;
}

/**
 * Finance's button to read the receipt mailbox now instead of waiting for the daily run. The run
 * goes on after the click answers; the panel polls while it runs, then reloads the queue via `onDone`.
 */
export default function MailCatchUp({ onDone }: { onDone: () => void }) {
  const state = useLoad<MailCatchUpView>(PATH);
  const [starting, setStarting] = useState(false);
  const running = state.data?.status === "running";
  const { reload } = state;

  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => void reload(), POLL_MS);
    return () => clearTimeout(timer);
  }, [running, reload, state.data]);

  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) onDone();
    wasRunning.current = running;
  }, [running, onDone]);

  async function start() {
    setStarting(true);
    try {
      const answer = await api<MailCatchUpView>(PATH, { method: "POST" });
      if (answer.status === "busy") notifications.show({ color: "yellow", message: "Mail intake is already running. This page shows when it ends." });
    } catch (err) {
      notifications.show({ title: "Couldn't start catching up", message: errorMessage(err), color: "red", autoClose: false });
    }
    setStarting(false);
    await reload();
  }

  const last = state.data?.lastRun;
  return (
    <Paper withBorder p="md" mb="xl">
      <Stack gap="xs">
        <Group justify="space-between">
          <Text fw={500}>Catch up on mailed receipts</Text>
          <Button loading={starting} disabled={running} onClick={() => void start()}>
            {running ? "Catching up…" : "Catch up now"}
          </Button>
        </Group>
        <Text size="sm" c="dimmed">
          Reads the receipt mailbox now instead of waiting for the daily run. One run makes up to {MAIL_CATCH_UP_CAP} new
          receipts, and each one is a paid automatic reading.
        </Text>
        {last && state.data?.lastRunAt && (
          <Text size="sm">
            Last run, ended {new Date(state.data.lastRunAt).toLocaleString()}: {catchUpSummary(last)}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
