import { Alert } from "@mantine/core";
import { useOrgTime } from "@/components/TimezoneProvider";

/**
 * Shown in place of occupancy, open/closed and supervision when the server
 * hasn't heard from the kiosk recently, or the kiosk still has scans to send
 * (see `buildingLink`).
 */
export function BuildingUnconfirmedAlert({ lastSeenAt, queued, mb }: { lastSeenAt: string | null | undefined; queued?: number; mb?: string }) {
  const { formatDateTime } = useOrgTime();
  if (queued) {
    return (
      <Alert color="blue" icon="🔄" title={`Syncing ${queued} ${queued === 1 ? "scan" : "scans"} from the kiosk`} mb={mb}>
        Who is checked in is the visit record until they arrive, not confirmed presence, and
        supervision can&apos;t be checked from here.
      </Alert>
    );
  }
  return (
    <Alert color="orange" icon="📡" title="Can't confirm building state" mb={mb}>
      {lastSeenAt
        ? `The kiosk was last heard from ${formatDateTime(lastSeenAt)}.`
        : "The kiosk hasn't been heard from since the server started."}{" "}
      Who is checked in is the visit record, not confirmed presence, and supervision can&apos;t be
      checked from here. Overnight this is expected — the kiosk stops checking in.
    </Alert>
  );
}
