"use client";

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, Checkbox, Container, Group, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { AdminPageHeader } from '@/components/admin/AdminPageHeader';
import { AlertBanner } from '@/components/admin/AlertBanner';
import { useUnsavedGuard, shallowEqual } from '@/components/UnsavedChangesProvider';

import { PageLoader } from "@/components/ui/PageLoader";
const DAYS_MAP = [
  { label: 'Sun', value: 0 },
  { label: 'Mon', value: 1 },
  { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 },
  { label: 'Thu', value: 4 },
  { label: 'Fri', value: 5 },
  { label: 'Sat', value: 6 },
];

export function NewEventForm() {
  const { status } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [programs, setPrograms] = useState<{ id: number, name: string }[]>([]);

  const defaultProgramId = searchParams.get('programId') || ""; // URL-prefilled, not a user edit
  const [name, setName] = useState("");
  const [description] = useState("");
  const [programId, setProgramId] = useState(defaultProgramId);
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");

  // Recurrence
  const [repeats, setRepeats] = useState(false);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  const [until, setUntil] = useState("");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState("");

  // Dirty = any field (incl. recurrence) changed from blank creation defaults.
  // daysOfWeek joined to a string so it fits shallowEqual's primitive compare.
  const isDirty =
    !submitted &&
    !shallowEqual(
      { name: "", programId: defaultProgramId, startDate: "", startTime: "", endTime: "", repeats: false, daysOfWeek: "", until: "" },
      { name, programId, startDate, startTime, endTime, repeats, daysOfWeek: daysOfWeek.join(','), until },
    );
  useUnsavedGuard(isDirty);

  const fetchPrograms = useCallback(async () => {
    try {
      const res = await fetch('/api/programs');
      if (res.ok) {
        setPrograms(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push('/');
    } else if (status === "authenticated") {
      fetchPrograms();
    }
  }, [status, router, fetchPrograms]);

  const toggleDay = (day: number) => {
    setDaysOfWeek(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort()
    );
  };

  // Event spans one day's wall-clock window (mirrors API): end must beat start on
  // the same date. Build real Dates and guard bad/empty input so we never false-flag.
  const timeError = (() => {
    if (!startTime || !endTime) return false;
    const base = startDate || '2000-01-01'; // date not picked yet → still compare times
    const start = new Date(`${base}T${startTime}`);
    const end = new Date(`${base}T${endTime}`);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return false;
    return end <= start;
  })();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage("");

    if (timeError) {
      setSaving(false);
      return; // fields are already highlighted; skip the doomed server round-trip
    }

    if (repeats && (daysOfWeek.length === 0 || !until)) {
      setMessage("Please select at least one day of the week and an end date for recurring events.");
      setSaving(false);
      return;
    }

    if (repeats && daysOfWeek.length > 0 && until) {
      // Parse as local dates (YYYY-MM-DD as local midnight) so getDay() matches the picker.
      const start = new Date(`${startDate}T00:00:00`);
      const end = new Date(`${until}T00:00:00`);
      if (end < start) {
        setMessage("The end date must be on or after the start date.");
        setSaving(false);
        return;
      }
      // A window of ≥7 days always covers every weekday; only short ranges need scanning.
      const spanDays = Math.round((end.getTime() - start.getTime()) / 86400000);
      if (spanDays < 7) {
        let hit = false;
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          if (daysOfWeek.includes(d.getDay())) { hit = true; break; }
        }
        if (!hit) {
          setMessage("The selected day(s) don't fall within the start–end date range. Pick a wider range or different days.");
          setSaving(false);
          return;
        }
      }
    }

    try {
      interface EventPayload {
        name: string;
        description: string;
        programId: number | null;
        startDate: string;
        startTime: string;
        endTime: string;
        recurrence?: { daysOfWeek: number[]; until: string };
      }

      const payload: EventPayload = {
        name,
        description,
        programId: programId ? parseInt(programId) : null,
        startDate,
        startTime,
        endTime
      };

      if (repeats) {
        payload.recurrence = { daysOfWeek, until };
      }

      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        setSubmitted(true); // clear unsaved-changes guard before redirect
        router.push(programId ? `/program-ops/programs/${programId}` : '/program-ops/events');
      } else {
        const err = await res.json().catch(() => ({}));
        setMessage(err.error || "Failed to create event");
      }
    } catch {
      notifications.show({ color: "red", message: "Network error", autoClose: false });
    } finally {
      setSaving(false);
    }
  };

  if (loading || status === "loading") {
    return <PageLoader />;
  }

  const cancelHref = programId ? `/program-ops/programs/${programId}` : '/programs';

  return (
    <Card withBorder radius="md" padding="lg">
      <AdminPageHeader title="Schedule Event" back={{ href: cancelHref, label: 'Cancel' }} mb="lg" />

      <AlertBanner message={message} tone="error" mb="md" />

      <form onSubmit={handleSubmit}>
        <Stack>
          <TextInput
            label="Event Name"
            required
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="e.g. Session 1: Intro to Woodworking"
          />

          <Select
            label="Associated Program"
            value={programId}
            onChange={(v) => setProgramId(v ?? "")}
            data={[
              { value: "", label: "-- None (Standalone Event) --" },
              ...programs.map((p) => ({ value: String(p.id), label: p.name })),
            ]}
          />

          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <TextInput type="date" label={repeats ? 'Start Date' : 'Date'} required value={startDate} onChange={(e) => setStartDate(e.currentTarget.value)} />
            <TextInput type="time" label="Start Time" required value={startTime} onChange={(e) => setStartTime(e.currentTarget.value)} error={timeError} styles={timeError ? { input: { color: 'var(--mantine-color-red-6)' } } : undefined} />
            <TextInput type="time" label="End Time" required value={endTime} onChange={(e) => setEndTime(e.currentTarget.value)} error={timeError ? 'End time must be after start time' : undefined} styles={timeError ? { input: { color: 'var(--mantine-color-red-6)' } } : undefined} />
          </SimpleGrid>

          <Card withBorder radius="md" padding="md">
            <Checkbox
              checked={repeats}
              onChange={(e) => setRepeats(e.currentTarget.checked)}
              label="Generate Recurring Events"
            />

            {repeats && (
              <Stack mt="md">
                <div>
                  <Text fw={500} mb="xs">Repeat on Days:</Text>
                  <Group gap="xs">
                    {DAYS_MAP.map((day) => (
                      <Button
                        key={day.value}
                        type="button"
                        variant={daysOfWeek.includes(day.value) ? 'filled' : 'default'}
                        onClick={() => toggleDay(day.value)}
                      >
                        {day.label}
                      </Button>
                    ))}
                  </Group>
                </div>
                <TextInput
                  type="date"
                  label="Ends On"
                  required={repeats}
                  value={until}
                  onChange={(e) => setUntil(e.currentTarget.value)}
                  description="Events will be generated individually up to this date."
                  maw={300}
                />
              </Stack>
            )}
          </Card>

          <Button type="submit" disabled={saving} loading={saving} mt="sm">
            Create Event(s)
          </Button>
        </Stack>
      </form>
    </Card>
  );
}

export default function NewEventPage() {
  return (
    <Container size="md" pb="md">
      <Suspense fallback={<PageLoader />}>
        <NewEventForm />
      </Suspense>
    </Container>
  );
}
