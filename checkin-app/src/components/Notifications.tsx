"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { Button, Group } from "@mantine/core";
import { CountBadge } from "@/components/ui/CountBadge";
import { usePolling, POLL_IDLE_STOP_MS } from "@/hooks/usePolling";

interface NotificationData {
  membership: { pendingReviews: number; blocked: number };
}

/**
 * In-app red-dot indicators, fed by GET /api/notifications. Today it surfaces the
 * membership domain (a reviewer's pending queue, the board's blocked applications);
 * other domains can be added as new sections as the API grows. Renders nothing when
 * there's nothing to show. Polls lightly so the dots stay current without a refresh.
 */
export default function Notifications() {
  const [data, setData] = useState<NotificationData | null>(null);

  const fetchCounts = useCallback(() => {
    fetch("/api/notifications")
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => { if (d) setData(d); })
      .catch(() => { /* silent — indicators are best-effort */ });
  }, []);
  // Mounted in the root layout, so it polls from every open tab. Pause when
  // hidden and idle-stop so a forgotten tab stops pinning Aurora / re-waking prod.
  usePolling(fetchCounts, 60000, { idleStopMs: POLL_IDLE_STOP_MS });

  const m = data?.membership;
  if (!m || m.blocked === 0) return null;

  return (
    <Group gap="sm" wrap="wrap">
      {m.blocked > 0 && (
        <Button
          component={Link}
          href="/membership-ops/applications"
          variant="light"
          color="red"
          rightSection={<CountBadge intent="alert">{m.blocked}</CountBadge>}
        >
          🚨 Blocked applications
        </Button>
      )}
    </Group>
  );
}
