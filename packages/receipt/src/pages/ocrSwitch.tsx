"use client";
import { Alert, Paper, Stack, Switch, Text, Title } from "@mantine/core";
import { send, useLoad } from "../components/api";

/** The automatic-reading switch. Sysadmin, finance and the Board turn it off for a known fault, and back on. */
export default function OcrSwitchPage() {
  const ocr = useLoad<{ ocrEnabled: boolean }>("/settings/ocr");

  async function toggle(ocrEnabled: boolean) {
    const done = ocrEnabled ? "Automatic reading is on" : "Automatic reading is off";
    if (await send("/settings/ocr", "PUT", { ocrEnabled }, done, "Couldn't change automatic reading")) ocr.reload();
  }

  return (
    <>
      <Title order={3} mb="md">Receipt reading</Title>
      {ocr.error && <Alert color="red" mb="md">{ocr.error}</Alert>}
      <Paper withBorder p="md" maw={520}>
        <Stack>
          <Switch
            label="Read receipts automatically"
            checked={ocr.data?.ocrEnabled ?? false}
            disabled={!ocr.data}
            onChange={(e) => void toggle(e.currentTarget.checked)}
          />
          <Text size="sm" c="dimmed">
            Turn this off when automatic reading has a known fault that needs a new release. While it is off, nothing is read
            and nothing counts against anyone&apos;s daily allowance: uploaded and mailed receipts go straight to typing the
            details, and &quot;Read it again&quot; is refused.
          </Text>
        </Stack>
      </Paper>
    </>
  );
}
