"use client";
import { useState } from "react";
import { Button, Group } from "@mantine/core";
import { send } from "./api";

/** The part of a line's sign-off status Approve All reads: the acts the server says the caller may take. */
export interface LineActsStatus {
  lineItemId: number;
  actions?: { act: string; primary: boolean; noteRequired?: boolean }[];
}

/**
 * The approval rows of every line whose main act for the caller is an approval that needs no
 * note. A line whose approval needs a note is approved on its own, where the note is asked for.
 */
export function approvableIds(statuses: LineActsStatus[], approvals: { id: number; lineItemId: number }[]): number[] {
  const approvalOf = new Map(approvals.map((a) => [a.lineItemId, a.id]));
  return statuses
    .filter((s) => s.actions?.some((a) => a.act === "approve" && a.primary && !a.noteRequired))
    .map((s) => approvalOf.get(s.lineItemId))
    .filter((id): id is number => id !== undefined);
}

/** "Approve all N as Program approver", shown only when the caller's main act is an approval on two or more lines. */
export default function ApproveAllButton({ base, statuses, approvals, onDone }: {
  base: string;
  statuses: LineActsStatus[];
  approvals: { id: number; lineItemId: number }[];
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const ids = approvableIds(statuses, approvals);
  if (ids.length < 2) return null;
  return (
    <Group>
      <Button
        loading={busy}
        onClick={async () => {
          setBusy(true);
          const ok = await send(`${base}/approve-lines`, "POST", { approvalIds: ids }, `Approved ${ids.length} lines`);
          setBusy(false);
          if (ok) onDone();
        }}
      >
        Approve all {ids.length} as Program approver
      </Button>
    </Group>
  );
}
