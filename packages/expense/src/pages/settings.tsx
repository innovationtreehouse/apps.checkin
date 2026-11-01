"use client";
import { useState } from "react";
import { Button, NumberInput, Paper, Stack, Text, Title } from "@mantine/core";
import { formatCents } from "@checkin/money";
import { send, useLoad, useRoles } from "../components/api";
import { LoadError } from "@checkin/component-ui";
import { financeCeilingCents } from "../lib/threshold-rules";

const FIELDS = [
  { key: "boardReviewTotalCents", label: "Board review: receipt total at or over (flagged, and held until the Board's approval is recorded)", min: 0.01 },
  { key: "capitalTotalThresholdCents", label: "Capital review: receipt total over", min: 0 },
  { key: "capitalLineItemThresholdCents", label: "Capital review: unit price over", min: 0 },
] as const;
type Key = (typeof FIELDS)[number]["key"];

const QB_FIELDS = [
  { key: "qbMatchWindowDays", label: "QuickBooks match window: days either side of the receipt date", max: 30, lowerOnly: false },
  { key: "qbMaxCreatesPerRun", label: "QuickBooks entries created per run", max: 1000, lowerOnly: true },
  { key: "qbMaxCreatesPerDay", label: "QuickBooks entries created per day", max: 1000, lowerOnly: true },
] as const;
type QbKey = (typeof QB_FIELDS)[number]["key"];

/** What a non-Board viewer may do with a field: no limit, raise it up to a ceiling, or nothing. */
type Reach = { ceilingCents?: number; readOnly: boolean; note?: string };

function reachOf(key: Key, savedCents: number, minCents: number): Reach {
  const ceiling = financeCeilingCents(key, savedCents);
  if (ceiling === null || (ceiling <= savedCents && savedCents <= minCents)) return { readOnly: true, note: "The Board sets this." };
  if (ceiling <= savedCents) return { ceilingCents: ceiling, readOnly: false, note: "You can lower this. Only the Board can raise it." };
  return { ceilingCents: ceiling, readOnly: false, note: `Only the Board can raise this above ${formatCents(ceiling)}.` };
}

/** /settings/finance — the org's money thresholds and QuickBooks limits. FINANCE or Board edits; every change is audited. */
export default function SettingsPage() {
  const settings = useLoad<Record<Key | QbKey, number>>("/org-settings");
  const { isBoard } = useRoles();
  // Only the fields the user has edited; the rest show the saved value.
  const [edits, setEdits] = useState<Partial<Record<Key | QbKey, number | "">>>({});
  const dollars = (key: Key): number | "" => edits[key] ?? (settings.data ? settings.data[key] / 100 : "");
  const reach = (key: Key, min: number): Reach =>
    isBoard || !settings.data ? { readOnly: false } : reachOf(key, settings.data[key], Math.round(min * 100));

  async function save() {
    const patch = Object.fromEntries([
      ...FIELDS.flatMap((f) => {
        const v = edits[f.key];
        return typeof v === "number" ? [[f.key, Math.round(v * 100)]] : [];
      }),
      ...QB_FIELDS.flatMap((f) => {
        const v = edits[f.key];
        return typeof v === "number" ? [[f.key, v]] : [];
      }),
    ]);
    if (await send("/org-settings", "PUT", patch, "Settings saved")) {
      setEdits({});
      settings.reload();
    }
  }

  return (
    <>
      <Title order={3} mb="md">Expense settings</Title>
      {settings.error && <LoadError what="settings" message={settings.error} onRetry={settings.reload} />}
      <Paper withBorder p="md" maw={520}>
        <Stack>
          <Text size="sm" c="dimmed">Amounts in dollars unless a label says otherwise. Flags are for awareness; changes are recorded with who made them.</Text>
          {FIELDS.map((f) => {
            const r = reach(f.key, f.min);
            return (
              <NumberInput
                key={f.key}
                label={f.label}
                description={r.note}
                prefix="$"
                decimalScale={2}
                min={f.min}
                max={r.ceilingCents === undefined ? undefined : r.ceilingCents / 100}
                readOnly={r.readOnly}
                variant={r.readOnly ? "filled" : undefined}
                value={dollars(f.key)}
                onChange={(v) => setEdits({ ...edits, [f.key]: typeof v === "number" ? v : "" })}
              />
            );
          })}
          {QB_FIELDS.map((f) => {
            const capped = f.lowerOnly && !isBoard;
            return (
              <NumberInput
                key={f.key}
                label={f.label}
                description={capped ? "Only the Board can raise this." : undefined}
                allowDecimal={false}
                min={1}
                max={capped && settings.data ? settings.data[f.key] : f.max}
                value={edits[f.key] ?? settings.data?.[f.key] ?? ""}
                onChange={(v) => setEdits({ ...edits, [f.key]: typeof v === "number" ? v : "" })}
              />
            );
          })}
          <Button onClick={() => void save()} disabled={!settings.data}>Save</Button>
        </Stack>
      </Paper>
    </>
  );
}
