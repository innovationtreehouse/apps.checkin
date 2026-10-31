const MAX_NAMED_PROVISIONALS = 20;

function provisionalsProblem(items: { gtin13: string; name: string }[]): string {
  const named = items.slice(0, MAX_NAMED_PROVISIONALS).map((item) => `${item.name} (${item.gtin13})`);
  if (items.length > named.length) named.push(`and ${items.length - named.length} more`);
  return `could not apply the catalog's decision to ${items.length} provisional item(s): ${named.join(", ")}`;
}

/** The alert port a catalog-event consumer library binds: an email to the Board. */
export function orgEventAlerts(
  template: "board.inventoryEventsStuck" | "board.expenseEventsStuck" | "board.receiptMappingEventsStuck",
  errorLabel: string,
) {
  return {
    async orgEventsStuck({ failed, unprocessed, unreadable, stuckProvisionals = [] }: { failed: number; unprocessed: number; unreadable: boolean; stuckProvisionals?: { gtin13: string; name: string }[] }): Promise<void> {
      const { emailBoardMembers } = await import("@/lib/emailRecipients");
      const events = unreadable
        ? "could not read the catalog's events"
        : failed > 0 || unprocessed > 0 ? `found ${failed} newly failed and ${unprocessed} unprocessed catalog event(s)` : null;
      const provisionals = stuckProvisionals.length > 0 ? provisionalsProblem(stuckProvisionals) : null;
      const problem = [events, provisionals].filter(Boolean).join(" and ");
      await emailBoardMembers(template, { problem }, errorLabel);
    },
  };
}
