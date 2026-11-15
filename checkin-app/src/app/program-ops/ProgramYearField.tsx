"use client";

import { Alert, Select, Text } from '@mantine/core';
import { LoadError } from '@checkin/component-ui';
import { useLoad } from '@/lib/api';
import { membershipYearLabel, programYearsTouched } from '@/lib/programYear';

type BoundarySettings = { orgMembershipYearBoundary?: string | null };
// A task on the previous release returns the settings row directly.
type MembershipSettingsAnswer = { settings?: BoundarySettings & { BoardSettings?: BoundarySettings } };

export type YearBoundary = { boundary: Date | null; error: string | null; reload: () => Promise<void> };

/** The Board's membership-year boundary, for a viewer who may read board settings. */
export function useMembershipYearBoundary(enabled: boolean): YearBoundary {
  const { data, error, reload } = useLoad<MembershipSettingsAnswer>(enabled ? '/api/settings/membership' : null);
  const b = (data?.settings?.BoardSettings ?? data?.settings)?.orgMembershipYearBoundary;
  return { boundary: b ? new Date(b) : null, error, reload };
}

/** A failed boundary read, shown where the year field would be, since crossing dates can't be told without it. */
export function YearBoundaryError({ load }: { load: YearBoundary }) {
  return load.error ? <LoadError what="the membership year boundary" message={load.error} onRetry={load.reload} /> : null;
}

/** The membership years the form's dates touch; empty while the dates or the boundary are unknown. */
export function formYearsTouched(boundary: Date | null, startAt: string, endAt: string): number[] {
  if (!boundary || !startAt || !endAt || endAt < startAt) return [];
  return programYearsTouched(boundary, new Date(startAt), new Date(endAt));
}

/**
 * Shown only when the dates cross the boundary. The Board records the year from
 * the budget approval; anyone else reads it, or is told to ask the Board.
 */
export function ProgramYearField({ years, value, onChange, canEdit }: {
  years: number[];
  value: number | null;
  onChange: (year: number | null) => void;
  canEdit: boolean;
}) {
  if (years.length < 2) return null;
  const stated = value != null && years.includes(value) ? value : null;
  if (!canEdit) {
    return stated != null
      ? <Text size="sm">Membership year: {membershipYearLabel(stated)} (set by the Board)</Text>
      : <Alert color="yellow" variant="light">These dates cross the membership year boundary, so the program&apos;s membership year comes from its budget approval. Ask the Board to set it.</Alert>;
  }
  return (
    <Select
      label="Membership year"
      description="These dates cross the membership year boundary. Copy the year from the program's budget approval."
      required
      placeholder="Choose the year"
      data={years.map((y) => ({ value: String(y), label: membershipYearLabel(y) }))}
      value={stated != null ? String(stated) : null}
      onChange={(v) => onChange(v ? Number(v) : null)}
    />
  );
}
