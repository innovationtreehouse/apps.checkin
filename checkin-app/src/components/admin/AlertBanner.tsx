import { Alert } from "@mantine/core";

export type AlertTone = "success" | "error" | "info" | "warning";

const TONE_COLOR: Record<AlertTone, string> = {
  success: "green",
  error: "red",
  info: "cyan",
  warning: "yellow",
};

export interface AlertBannerProps {
  /** The message to show. Falsy → renders nothing. */
  message: React.ReactNode;
  /** Severity → Mantine color (success=green, error=red, info=cyan, warning=yellow). */
  tone?: AlertTone;
  title?: string;
  mb?: string | number;
  mt?: string | number;
  onClose?: () => void;
}

/**
 * Shared status banner for admin pages, with one tone→color mapping and a built-in
 * empty-message guard.
 */
export function AlertBanner({ message, tone = "info", title, mb, mt, onClose }: AlertBannerProps) {
  if (!message) return null;
  return (
    <Alert color={TONE_COLOR[tone]} title={title} mb={mb} mt={mt} withCloseButton={!!onClose} onClose={onClose}>
      {message}
    </Alert>
  );
}
