"use client";

import { useRef, useState, type ReactNode } from "react";
import { Button, Group, Stack, Textarea } from "@mantine/core";

// The body of a confirm dialog that needs a reason: an empty reason is flagged on the field and never confirmed.
export function ReasonConfirm({ children, confirmLabel, missingReason, onCancel, onConfirm }: {
  children: ReactNode;
  confirmLabel: string;
  missingReason: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const confirm = () => {
    if (!reason.trim()) {
      setError(missingReason);
      field.current?.focus();
      return;
    }
    onConfirm(reason.trim());
  };
  return (
    <Stack gap="xs">
      {children}
      <Textarea
        ref={field}
        label="Reason"
        required
        autosize
        minRows={2}
        value={reason}
        error={error}
        onChange={(e) => { setReason(e.currentTarget.value); setError(null); }}
      />
      <Group justify="flex-end" mt="sm">
        <Button variant="default" onClick={onCancel}>Cancel</Button>
        <Button onClick={confirm}>{confirmLabel}</Button>
      </Group>
    </Stack>
  );
}
