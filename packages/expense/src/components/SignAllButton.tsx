"use client";
import { useState } from "react";
import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, send } from "./api";

interface LineStatus {
  lineItemId: number;
  actions: Array<{ act: string; seat?: string }>;
}

/** The lines the server offers this viewer a Treasurer signature on. */
export function treasurerLines(lines: LineStatus[]): number[] {
  return lines.filter((l) => l.actions.some((a) => a.act === "sign" && a.seat === "TREASURER")).map((l) => l.lineItemId);
}

/**
 * "Sign all N as Treasurer" on a To sign row: reads the expense's lines the viewer may sign as
 * Treasurer and signs them in one all-or-nothing request. A refusal names the line and signs none.
 */
export default function SignAllButton({ expenseId, count, onSigned }: { expenseId: string; count: number; onSigned: () => void }) {
  const [busy, setBusy] = useState(false);
  const base = `/expenses/${encodeURIComponent(expenseId)}`;

  async function signAll() {
    setBusy(true);
    try {
      const lineItemIds = treasurerLines(await api<LineStatus[]>(`${base}/signoffs`));
      if (lineItemIds.length === 0) {
        notifications.show({ message: "Nothing left on this expense for you to sign as Treasurer; reload the list", color: "red", autoClose: false });
        return;
      }
      if (await send(`${base}/sign-lines`, "POST", { lineItemIds }, `Signed ${lineItemIds.length} as Treasurer`)) onSigned();
    } catch (err) {
      notifications.show({ message: `Couldn't read the lines to sign: ${errorMessage(err)}`, color: "red", autoClose: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button size="compact-xs" variant="light" loading={busy} onClick={() => void signAll()}>
      Sign all {count} as Treasurer
    </Button>
  );
}
