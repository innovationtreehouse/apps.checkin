/** The alert port a catalog-event consumer library binds: an email to the Board. */
export function orgEventAlerts(
  template: "board.inventoryEventsStuck" | "board.expenseEventsStuck" | "board.receiptMappingEventsStuck",
  errorLabel: string,
) {
  return {
    async orgEventsStuck({ failed, unprocessed, unreadable }: { failed: number; unprocessed: number; unreadable: boolean }): Promise<void> {
      const { emailBoardMembers } = await import("@/lib/emailRecipients");
      const problem = unreadable
        ? "could not read the catalog's events"
        : `found ${failed} newly failed and ${unprocessed} unprocessed catalog event(s)`;
      await emailBoardMembers(template, { problem }, errorLabel);
    },
  };
}
