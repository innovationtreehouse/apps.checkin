"use client";
import { useState } from "react";
import { Button, Text } from "@mantine/core";
import { send, useLoad } from "./api";

interface LineStatus {
  lineItemId: number;
  actions: Array<{ act: string; seat?: string; primary: boolean }>;
}

/** The lines whose main act for this viewer is the Treasurer signature. */
export function treasurerLines(lines: LineStatus[]): number[] {
  return lines.filter((l) => l.actions.some((a) => a.primary && a.act === "sign" && a.seat === "TREASURER")).map((l) => l.lineItemId);
}

/**
 * "Sign all N as Treasurer" on a To sign row: N is the expense's lines whose main act for the
 * viewer is the Treasurer signature, and one all-or-nothing request signs them. A refusal names the
 * line and signs none. Nothing to sign draws no button; a failed read says so in red.
 */
export default function SignAllButton({ expenseId, onSigned }: { expenseId: string; onSigned: () => void }) {
  const base = `/expenses/${encodeURIComponent(expenseId)}`;
  const lines = useLoad<LineStatus[]>(`${base}/signoffs`);
  const [busy, setBusy] = useState(false);
  const lineItemIds = treasurerLines(lines.data ?? []);
  if (lines.error) return <Text size="xs" c="red">Couldn&apos;t read the lines to sign: {lines.error}</Text>;
  if (lineItemIds.length === 0) return null;

  async function signAll() {
    setBusy(true);
    const signed = await send(`${base}/sign-lines`, "POST", { lineItemIds }, `Signed ${lineItemIds.length} as Treasurer`);
    setBusy(false);
    if (signed) onSigned();
  }

  return (
    <Button size="compact-xs" variant="light" loading={busy} onClick={() => void signAll()}>
      Sign all {lineItemIds.length} as Treasurer
    </Button>
  );
}
