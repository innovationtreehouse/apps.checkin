"use client";

import { useEffect, useState } from 'react';
import { Alert, Select, Text } from '@mantine/core';
import { membershipYearLabel, programYearsTouched } from '@/lib/programYear';

/** The Board's membership-year boundary, for a viewer who may read board settings. */
export function useMembershipYearBoundary(enabled: boolean): Date | null {
  const [boundary, setBoundary] = useState<Date | null>(null);
  useEffect(() => {
    if (!enabled) return;
    fetch('/api/settings/membership')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        // A task on the previous release returns the settings row directly.
        const b = (data?.settings?.BoardSettings ?? data?.settings)?.orgMembershipYearBoundary;
        if (b) setBoundary(new Date(b));
      })
      .catch(() => {});
  }, [enabled]);
  return boundary;
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
