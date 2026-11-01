"use client";

import { useLoad } from "@/lib/api";
import type { AttendanceConflict } from "@/lib/attendanceConflicts";
import type { ConflictsResponse } from "@/app/api/my-programs/conflicts/route";

/** Conflicts for the current lead, one shared read for the subtab badge and the list. null until loaded / disabled. */
export function useConflicts(enabled: boolean): { conflicts: AttendanceConflict[] | null; error: string | null; refresh: () => void } {
  const { data, error, reload } = useLoad<ConflictsResponse>(enabled ? "/api/my-programs/conflicts" : null);
  return { conflicts: data?.conflicts ?? null, error, refresh: reload };
}
