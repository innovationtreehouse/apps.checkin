"use client";
import { useState } from "react";
import { Alert, Button, Checkbox, NumberInput, Paper, Stack, Title } from "@mantine/core";
import { send, useLoad, useRoles } from "../components/api";

interface Settings {
  taxExempt: boolean;
  requireFinanceReviewWithTax: boolean;
  enforceReceiptAgeLimit: boolean;
  receiptAgeLimitDays: number;
  ocrEnabled: boolean;
}

const FLAGS = [
  { key: "taxExempt", label: "The organization is tax-exempt" },
  { key: "requireFinanceReviewWithTax", label: "Send receipts that charge tax to finance review" },
  { key: "enforceReceiptAgeLimit", label: "Send receipts older than the age limit to finance review" },
  { key: "ocrEnabled", label: "Read receipts automatically. Turn this off to stop every automatic reading; uploads go straight to typing the details." },
] as const;

/** /receipts/settings — tax-exempt, age-limit and automatic-reading settings. FINANCE edits; BOARD reads. */
export default function ReceiptSettingsPage() {
  const { isFinance } = useRoles();
  const settings = useLoad<Settings>("/settings");
  const [edits, setEdits] = useState<Partial<Settings>>({});
  const value = <K extends keyof Settings>(k: K): Settings[K] | undefined => edits[k] ?? settings.data?.[k];

  async function save() {
    if (await send("/settings", "PUT", edits, "Settings saved", "Couldn't save the settings")) {
      setEdits({});
      settings.reload();
    }
  }

  return (
    <>
      <Title order={3} mb="md">Receipt settings</Title>
      {settings.error && <Alert color="red" mb="md">{settings.error}</Alert>}
      <Paper withBorder p="md" maw={520}>
        <Stack>
          {FLAGS.map((f) => (
            <Checkbox
              key={f.key}
              label={f.label}
              disabled={!isFinance}
              checked={value(f.key) ?? false}
              onChange={(e) => setEdits({ ...edits, [f.key]: e.currentTarget.checked })}
            />
          ))}
          <NumberInput
            label="Age limit (days)"
            min={1}
            disabled={!isFinance}
            value={value("receiptAgeLimitDays") ?? ""}
            onChange={(v) => typeof v === "number" && setEdits({ ...edits, receiptAgeLimitDays: v })}
          />
          {isFinance && <Button w="fit-content" onClick={() => void save()} disabled={Object.keys(edits).length === 0}>Save</Button>}
        </Stack>
      </Paper>
    </>
  );
}
