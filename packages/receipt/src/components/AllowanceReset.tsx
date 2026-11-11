"use client";
import { useState } from "react";
import { Button, Group, Modal, Stack, Text, Textarea } from "@mantine/core";
import { send } from "./api";

/** Finance's or the Board's button to give `personId` a full reading allowance from now, for a reason. */
export default function AllowanceReset({ personId }: { personId: number }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function reset() {
    setBusy(true);
    const done = await send(`/allowance/${personId}/reset`, "POST", { reason: reason.trim() }, "Reading allowance reset", "Couldn't reset the reading allowance");
    setBusy(false);
    if (done) {
      setOpen(false);
      setReason("");
    }
  }

  return (
    <>
      <Button size="xs" variant="light" onClick={() => setOpen(true)}>Reset reading allowance</Button>
      <Modal opened={open} onClose={() => setOpen(false)} title="Reset reading allowance">
        <Stack>
          <Text size="sm">The uploader gets a full day&apos;s automatic readings from now. Every reading counts, whether it works or not.</Text>
          <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} required />
          <Group justify="end">
            <Button variant="default" onClick={() => setOpen(false)}>Cancel</Button>
            <Button loading={busy} disabled={!reason.trim()} onClick={() => void reset()}>Reset allowance</Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
