"use client";
import { useState } from "react";
import { Button, NumberInput, Paper, Stack, Text, Title } from "@mantine/core";
import { LoadError, showError, showSuccess } from "@checkin/component-ui";
import { api, refusalMessage, useIsBoard, useLoad } from "../components/api";

interface Settings {
  maxCreatesPerRun: number;
  maxCreateCentsPerRun: number;
  benevityMaxCreateCentsPerRun: number;
  benevityMatchWindowDays: number;
}
type Key = keyof Settings;

const FIELDS: readonly { key: Key; label: string; cents?: boolean; cap: boolean; max?: number }[] = [
  { key: "maxCreatesPerRun", label: "QuickBooks deposits created per run, all sources together (at most 100)", cap: true, max: 100 },
  { key: "maxCreateCentsPerRun", label: "Dollars booked per run, each source other than Benevity", cents: true, cap: true },
  { key: "benevityMaxCreateCentsPerRun", label: "Dollars booked per run from Benevity", cents: true, cap: true },
  { key: "benevityMatchWindowDays", label: "Benevity match window: days either side of the payout date", cap: false, max: 30 },
];

/** /income/settings — the caps on what one QuickBooks run may create, and the Benevity match window. FINANCE may lower a cap; raising one takes the Board. */
export default function IncomeSettingsPage() {
  const settings = useLoad<Settings>("/settings");
  const isBoard = useIsBoard();
  // Only the fields the user has edited, in the units shown; the rest show the saved value.
  const [edits, setEdits] = useState<Partial<Record<Key, number | "">>>({});
  const [busy, setBusy] = useState(false);
  const shown = (f: (typeof FIELDS)[number]): number | "" => {
    const saved = settings.data?.[f.key];
    return edits[f.key] ?? (saved === undefined ? "" : f.cents ? saved / 100 : saved);
  };

  async function save() {
    const patch = Object.fromEntries(
      FIELDS.flatMap((f) => {
        const v = edits[f.key];
        return typeof v === "number" ? [[f.key, f.cents ? Math.round(v * 100) : v]] : [];
      }),
    );
    setBusy(true);
    try {
      await api("/settings", { method: "PATCH", body: JSON.stringify(patch) });
      showSuccess("Settings saved");
      setEdits({});
      settings.reload();
    } catch (err) {
      showError(refusalMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Title order={3} mb="md">Income settings</Title>
      {settings.error && <LoadError what="income settings" message={settings.error} onRetry={settings.reload} />}
      <Paper withBorder p="md" maw={520}>
        <Stack>
          <Text size="sm" c="dimmed">Changes are recorded with who made them.</Text>
          {FIELDS.map((f) => {
            const lowerOnly = f.cap && !isBoard;
            const saved = settings.data?.[f.key];
            return (
              <NumberInput
                key={f.key}
                label={f.label}
                description={lowerOnly ? "You can lower this. Only the Board can raise it." : undefined}
                prefix={f.cents ? "$" : undefined}
                decimalScale={f.cents ? 2 : 0}
                allowDecimal={f.cents === true}
                min={f.cents ? 0.01 : 1}
                max={lowerOnly && saved !== undefined ? (f.cents ? saved / 100 : saved) : f.max}
                value={shown(f)}
                onChange={(v) => setEdits({ ...edits, [f.key]: typeof v === "number" ? v : "" })}
              />
            );
          })}
          <Button onClick={() => void save()} disabled={!settings.data || busy}>Save</Button>
        </Stack>
      </Paper>
    </>
  );
}
