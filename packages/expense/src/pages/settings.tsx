"use client";
import { useState } from "react";
import { Button, NumberInput, Paper, Stack, Text, Title } from "@mantine/core";
import { send, useLoad } from "../components/api";
import LoadError from "../components/LoadError";

const FIELDS = [
  { key: "capitalEquipmentUnitCents", label: "Capital-equipment flag: unit price at or over", min: 0.01 },
  { key: "boardReviewTotalCents", label: "Board-review flag: total at or over", min: 0.01 },
  { key: "noteInLieuLimitCents", label: "Note in lieu of a receipt: limit", min: 0.01 },
  { key: "capitalTotalThresholdCents", label: "Capital review: receipt total over (0 = off)", min: 0 },
  { key: "capitalLineItemThresholdCents", label: "Capital review: line total over (0 = off)", min: 0 },
] as const;
type Key = (typeof FIELDS)[number]["key"];

/** /expense/settings — the org's money thresholds. FINANCE or Board edits; every change is audited. */
export default function SettingsPage() {
  const settings = useLoad<Record<Key, number>>("/org-settings");
  // Only the fields the user has edited; the rest show the saved value.
  const [edits, setEdits] = useState<Partial<Record<Key, number | "">>>({});
  const dollars = (key: Key): number | "" => edits[key] ?? (settings.data ? settings.data[key] / 100 : "");

  async function save() {
    const patch = Object.fromEntries(
      FIELDS.flatMap((f) => {
        const v = edits[f.key];
        return typeof v === "number" ? [[f.key, Math.round(v * 100)]] : [];
      }),
    );
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
          <Text size="sm" c="dimmed">Amounts in dollars. Flags are for awareness; changes are recorded with who made them.</Text>
          {FIELDS.map((f) => (
            <NumberInput
              key={f.key}
              label={f.label}
              prefix="$"
              decimalScale={2}
              min={f.min}
              value={dollars(f.key)}
              onChange={(v) => setEdits({ ...edits, [f.key]: typeof v === "number" ? v : "" })}
            />
          ))}
          <Button onClick={() => void save()} disabled={!settings.data}>Save</Button>
        </Stack>
      </Paper>
    </>
  );
}
