"use client";

import { Alert, Group } from "@mantine/core";
import { ActiveFilterNotice, StatusFilterBadge } from "@/components/StatusFilter";
import { NOT_RENEWING, statusColor, statusLabel, type ProcessRow } from "./applicationRows";

export function ApplicationsLegend({ rows, active, toggle, clear, showArchived }: {
  rows: readonly ProcessRow[];
  active: string | null;
  toggle: (value: string) => void;
  clear: () => void;
  showArchived: boolean;
}) {
  const statusCounts = rows.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  // The status-filter badges/notice are meaningless on the closed view (every
  // row is ARCHIVED) — the filter itself is ignored there too.
  const notRenewingCount = rows.filter((r) => r.notRenewing).length;

  return (
    <>
      {rows.length > 0 && !showArchived && (
        <>
          {rows.some((r) => r.status === "BLOCKED") && (
            <Alert
              color="red"
              variant="light"
              fw={600}
              onClick={() => toggle("BLOCKED")}
              title="Click to filter to blocked applications"
              style={{ cursor: "pointer" }}
            >
              🚨 {rows.filter((r) => r.status === "BLOCKED").length} application(s) blocked at
              background review — board attention needed.
            </Alert>
          )}
          <Group gap="xs">
            {Object.entries(statusCounts).map(([status, count]) => (
              <StatusFilterBadge key={status} value={status} active={active} onToggle={toggle} color={statusColor(status)}>
                {statusLabel(status)}: {count}
              </StatusFilterBadge>
            ))}
            {notRenewingCount > 0 && (
              <StatusFilterBadge value={NOT_RENEWING} active={active} onToggle={toggle} color="gray">
                Not renewing: {notRenewingCount}
              </StatusFilterBadge>
            )}
          </Group>
        </>
      )}

      {!showArchived && <ActiveFilterNotice active={active} label={statusLabel} onClear={clear} />}
    </>
  );
}
