/** Apply errors left in `validationNotes` when a receipt's stored data can't be read; retrying it can never succeed. */
export const UNREADABLE_RECEIPT_ERRORS = {
  notJson: "Stored receipt data is not valid JSON",
  invalid: "Stored receipt data failed validation",
} as const;

export const isUnreadableReceiptNote = (note?: string | null): boolean =>
  !!note && Object.values(UNREADABLE_RECEIPT_ERRORS).some((error) => note.includes(error));
