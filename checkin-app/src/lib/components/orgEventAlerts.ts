/** The alert port a catalog-event consumer library binds: an email to the Board. */
export function orgEventAlerts(
  template: "board.inventoryEventsStuck" | "board.expenseEventsStuck" | "board.receiptMappingEventsStuck",
  errorLabel: string,
) {
  return {
    async orgEventsStuck({ failed, unprocessed, unreadable, reconcileFailed = 0 }: { failed: number; unprocessed: number; unreadable: boolean; reconcileFailed?: number }): Promise<void> {
      const { emailBoardMembers } = await import("@/lib/emailRecipients");
      const events = unreadable
        ? "could not read the catalog's events"
        : failed > 0 || unprocessed > 0 ? `found ${failed} newly failed and ${unprocessed} unprocessed catalog event(s)` : null;
      const provisionals = reconcileFailed > 0 ? `could not apply the catalog's decision to ${reconcileFailed} provisional item(s)` : null;
      const problem = [events, provisionals].filter(Boolean).join(" and ");
      await emailBoardMembers(template, { problem }, errorLabel);
    },
  };
}
