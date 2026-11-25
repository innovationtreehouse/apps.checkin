"use client";

import { useState } from "react";
import { Button, Group, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { clearError, errorMessage, showError, showSuccess, showWarning } from "@checkin/component-ui";
import { api } from "@/lib/api";
import { notifyNavRefresh } from "@/lib/nav-refresh";

// Stays mounted while hidden, so a re-check in flight keeps its busy state across the closed-view toggle.
export function SettleWaitingButton({ shown, reload }: { shown: boolean; reload: () => Promise<void> }) {
  const [settling, setSettling] = useState(false);
  const settleWaiting = async () => {
    setSettling(true);
    try {
      const { households, opened, failed } = await api<{ households: number; opened: number; failed: number }>(
        "/api/membership-ops/applications/settle-waiting",
        { method: "POST", invalidate: false },
      );
      clearError("settle-waiting");
      const failedNote = failed > 0 ? ` ${failed} failed: see System Status.` : "";
      const summary = `Re-checked ${households} household(s); ${opened} moved on.${failedNote}`;
      if (failed > 0) showWarning(summary, { key: "settle-waiting" });
      else showSuccess(summary);
      notifyNavRefresh();
      await reload();
    } catch (e) {
      showError(errorMessage(e), { key: "settle-waiting", title: "Fix pending background checks" });
    } finally {
      setSettling(false);
    }
  };
  const confirmSettleWaiting = () => {
    modals.openConfirmModal({
      title: "Re-check every application waiting on a background check?",
      children: (
        <Text size="sm">
          Each household whose application waits on a background check is checked again. One whose
          lead already holds a valid check moves on.
        </Text>
      ),
      labels: { confirm: "Re-check", cancel: "Cancel" },
      onConfirm: () => { void settleWaiting(); },
    });
  };

  if (!shown) return null;
  return (
    <Group>
      <Button variant="light" loading={settling} onClick={confirmSettleWaiting}>Fix pending background checks</Button>
    </Group>
  );
}
