"use client";
import { Alert, Button, Group, Text } from "@mantine/core";

/** A failed load: names what failed and offers a retry, so it never reads as an empty list. */
export default function LoadError({ what, message, onRetry }: { what: string; message: string; onRetry: () => void }) {
  return (
    <Alert color="red" title={`Couldn't load ${what}`} mb="md">
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm">{message}</Text>
        <Button size="xs" variant="light" color="red" onClick={onRetry}>Retry</Button>
      </Group>
    </Alert>
  );
}
