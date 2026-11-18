"use client";
import { useState } from "react";
import { Alert, Button, NumberInput, Paper, Stack, Switch, Text, Title } from "@mantine/core";
import { dollarsToCents, formatCents } from "@checkin/money";
import { send, useLoad, useRoles } from "../components/api";
import { LoadError } from "@checkin/component-ui";
import { financeCeilingCents } from "../lib/threshold-rules";
import { capitalThresholdsUnset } from "../lib/expense-rules";

const FIELDS = [
  { key: "boardReviewTotalCents", label: "Board review: receipt total at or over (flagged, and held until the Board's approval is recorded)", min: 0.01 },
  { key: "capitalTotalThresholdCents", label: "Capital review: receipt total at or over", min: 0 },
  { key: "capitalLineItemThresholdCents", label: "Capital review: unit price at or over", min: 0 },
  { key: "everydayTotalLimitCents", label: "Everyday card charge: total under", min: 0.01 },
  { key: "everydayItemLimitCents", label: "Everyday card charge: no single item over", min: 0.01 },
] as const;
type Key = (typeof FIELDS)[number]["key"];
const CAPITAL_KEYS = new Set<Key>(["capitalTotalThresholdCents", "capitalLineItemThresholdCents"]);

const QB_FIELDS = [
  { key: "qbMatchWindowDays", label: "QuickBooks match window: days either side of the receipt date", max: 30, lowerOnly: false },
  { key: "qbMaxCreatesPerRun", label: "QuickBooks entries created per run (at most 100)", max: 100, lowerOnly: true },
  { key: "qbMaxCreatesPerDay", label: "QuickBooks entries created per day", max: 1000, lowerOnly: true },
] as const;
type QbKey = (typeof QB_FIELDS)[number]["key"];

/** What a non-Board viewer may do with a field: no limit, raise it up to a ceiling, or nothing. */
type Reach = { ceilingCents?: number; readOnly: boolean; note?: string };

function reachOf(key: Key, savedCents: number | null, minCents: number): Reach {
  const ceiling = financeCeilingCents(key, savedCents);
  if (ceiling === null || savedCents === null || (ceiling <= savedCents && savedCents <= minCents)) return { readOnly: true, note: "The Board sets this." };
  if (ceiling <= savedCents) return { ceilingCents: ceiling, readOnly: false, note: "You can lower this. Only the Board can raise it." };
  return { ceilingCents: ceiling, readOnly: false, note: `Only the Board can raise this above ${formatCents(ceiling)}.` };
}

/** /settings/finance — the org's money thresholds and QuickBooks limits. FINANCE or Board edits; every change is audited. */
export default function SettingsPage() {
  const settings = useLoad<Record<Key, number | null> & Record<QbKey, number> & { capitalReviewEnabled: boolean }>("/org-settings");
  const { isBoard } = useRoles();
  // Only the fields the user has edited; the rest show the saved value.
  const [edits, setEdits] = useState<Partial<Record<Key | QbKey, number | "">>>({});
  const [capitalOn, setCapitalOn] = useState<boolean | null>(null);
  const savedOn = settings.data?.capitalReviewEnabled ?? true;
  const reviewOn = capitalOn ?? savedOn;
  const dollars = (key: Key): number | "" => {
    const saved = settings.data?.[key];
    return edits[key] ?? (saved == null ? "" : saved / 100);
  };
  const reach = (key: Key, min: number): Reach =>
    isBoard || !settings.data ? { readOnly: false } : reachOf(key, settings.data[key], dollarsToCents(min));

  async function save() {
    const patch = Object.fromEntries([
      ...(reviewOn !== savedOn ? [["capitalReviewEnabled", reviewOn]] : []),
      ...FIELDS.flatMap((f) => {
        if (CAPITAL_KEYS.has(f.key) && !reviewOn) return [];
        const v = edits[f.key];
        return typeof v === "number" ? [[f.key, dollarsToCents(v)]] : [];
      }),
      ...QB_FIELDS.flatMap((f) => {
        const v = edits[f.key];
        return typeof v === "number" ? [[f.key, v]] : [];
      }),
    ]);
    if (await send("/org-settings", "PUT", patch, "Settings saved")) {
      setEdits({});
      setCapitalOn(null);
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
          <Switch
            label="Capital review"
            description={isBoard ? "Off sends no expense or donated equipment to capital review." : "Only the Board can turn capital review off."}
            checked={reviewOn}
            disabled={!settings.data || (!isBoard && savedOn)}
            onChange={(e) => setCapitalOn(e.currentTarget.checked)}
          />
          {settings.data && capitalThresholdsUnset(settings.data) && (
            <Alert color="yellow">
              The capital review thresholds are not set, so every expense and donated line waits at capital review. Set both
              thresholds or turn capital review off.
            </Alert>
          )}
          {FIELDS.map((f) => {
            const off = CAPITAL_KEYS.has(f.key) && !reviewOn;
            const r = off ? { readOnly: true, note: "Turn capital review on to change this." } : reach(f.key, f.min);
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
                disabled={off}
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
