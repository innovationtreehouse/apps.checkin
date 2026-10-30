export type { InKindSource } from "../services/inKindAcceptService";
export type WaitingOn = "withdrawal" | "replay" | "donor" | "uploader" | "value" | "decision" | "bucket" | "capital" | "booking";

/** A gift's most urgent wait, as a badge. */
export const IN_KIND_STATE: Record<WaitingOn, { label: string; color: string }> = {
  withdrawal: { label: "Withdrawn after money", color: "red" },
  replay: { label: "Receipt resent with different values", color: "red" },
  donor: { label: "Donor needed", color: "yellow" },
  uploader: { label: "Uploader not recorded", color: "yellow" },
  value: { label: "Value needed", color: "yellow" },
  decision: { label: "Waiting to be accepted", color: "blue" },
  bucket: { label: "Bucket archived or has no Class", color: "orange" },
  capital: { label: "Waiting on capital review", color: "violet" },
  booking: { label: "Ready to book", color: "green" },
};
