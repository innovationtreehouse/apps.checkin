/**
 * Non-Prisma response models the bulk-donation library ships through handler()
 * (the catalogSyntheticClassifications.ts pattern).
 *
 * DonationNavCounts — the Finance tab badges: two scalar queue sizes, `public`
 * like every count model (no actor, no donor, no amount).
 *
 * InKindQueueItemView — one in-kind gift in the finance queue, from either source
 * (`receipt` or `manual`): waiting on its donor, waiting to be accepted, or
 * withdrawn after its money arrived. It carries what the accept screen shows:
 * receipt and join timestamps, the bucket, the value and its lines, the uploader
 * and recorder, when the donor was replaced, the four accept warnings and the
 * caller's conflict state, plus the gift's queue state and what it waits on, its
 * outcome and decision time, a replay conflict, a bucket hold, each booking
 * side's state, when finance settled a withdrawal, and its QuickBooks match state
 * with the note explaining it, all as `internal` facts. It carries no donor
 * field, so a donor name on the row is stripped from every view.
 *
 * InKindQueueLineView — one line of a queued gift: the item and its description,
 * its quantity, the value finance set and the value ops suggested, all `internal`.
 *
 * InKindDecisionView — the reply to accepting, refusing or returning a gift:
 * which gift, the outcome, who decided and when, the bucket and the total value,
 * all `internal`. It names the decider by id and carries no donor.
 *
 * InKindBucketGiftView — one in-kind gift in a bucket the caller approves: what
 * was given, its value and date, all `internal`. It carries no donor field, so
 * a donor name on the row is stripped from every view, finance's included.
 *
 * InKindBucketGiftLineView — one line of that gift: item and its description,
 * quantity and value, all `internal`.
 *
 * InKindSettleResult — the reply to finance settling a receipt gift's anomaly (a
 * withdrawal or a replay conflict): which gift, which kind, and when, all
 * `internal`. Settling a withdrawal clears the donor, so the reply carries none.
 *
 * InKindGiftDetailView — one in-kind gift on its own page, from either source:
 * its receipt or donation date, value and lines, the donor (`pii`), who
 * recorded it, its join, anomaly and decision timestamps, the bucket, its queue
 * state and what it waits on, each booking side's state, and, for a gift
 * without a receipt, its inventory source key and when its goods loaded. All
 * but the three donor fields are `internal`.
 *
 * InKindGiftDetailLineView — one line of that gift: item and its description,
 * quantity, the value finance set and the value ops suggested, all `internal`.
 *
 * InKindGiftEventView — one row of that gift's history: the event, who acted
 * and when, and its payload, all `internal`. In-kind event payloads carry
 * counts, totals, outcomes and bucket ids, never a donor field.
 *
 * ManualInKindRecordResult — the reply to recording a no-receipt in-kind
 * donation: its id and whether its goods loaded into inventory, both `internal`.
 *
 * Hand-authored, not generated: these describe API responses, not tables. This
 * is a security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  DonationNavCounts: {
    unassignedQueue: "public",
    disbursementHolds: "public",
  },
  InKindQueueItemView: {
    id: "internal",
    receiptId: "internal",
    receiptTotalCents: "internal",
    receiptDate: "internal",
    moneyReceivedAt: "internal",
    donorRecordedAt: "internal",
    withdrawnAfterMoneyAt: "internal",
    source: "internal",
    budgetOwnerId: "internal",
    budgetOwnerName: "internal",
    bucketAssignedAt: "internal",
    totalValueCents: "internal",
    uploadedByUserId: "internal",
    recordedByUserId: "internal",
    donorReplacedAt: "internal",
    warnDonorSurnameMatch: "internal",
    warnDonorIsRecorder: "internal",
    warnLargeValue: "internal",
    warnDonorReplaced: "internal",
    callerConflicted: "internal",
    allFinanceConflicted: "internal",
    state: "internal",
    waitingOn: "internal",
    outcome: "internal",
    decidedAt: "internal",
    replayConflictAt: "internal",
    bucketHeld: "internal",
    revenueBooking: "internal",
    expenseBooking: "internal",
    withdrawalSettledAt: "internal",
    donationDate: "internal",
    qbState: "internal",
    qbNote: "internal",
  },
  InKindQueueLineView: {
    id: "internal",
    gtin13: "internal",
    description: "internal",
    quantity: "internal",
    valueCents: "internal",
    suggestedValueCents: "internal",
  },
  InKindDecisionView: {
    id: "internal",
    source: "internal",
    giftId: "internal",
    outcome: "internal",
    decidedByUserId: "internal",
    decidedAt: "internal",
    budgetOwnerId: "internal",
    totalValueCents: "internal",
  },
  InKindBucketGiftView: {
    id: "internal",
    source: "internal",
    budgetOwnerId: "internal",
    donationDate: "internal",
    totalValueCents: "internal",
  },
  InKindBucketGiftLineView: {
    id: "internal",
    gtin13: "internal",
    description: "internal",
    quantity: "internal",
    valueCents: "internal",
  },
  InKindSettleResult: {
    id: "internal",
    kind: "internal",
    settledAt: "internal",
  },
  InKindGiftDetailView: {
    id: "internal",
    source: "internal",
    receiptId: "internal",
    receiptTotalCents: "internal",
    receiptDate: "internal",
    donationDate: "internal",
    moneyReceivedAt: "internal",
    recordedAt: "internal",
    recordedByUsername: "internal",
    donorFirstName: "pii",
    donorLastName: "pii",
    donorCompanyName: "pii",
    donorRecordedAt: "internal",
    donorReplacedAt: "internal",
    withdrawnAfterMoneyAt: "internal",
    withdrawalSettledAt: "internal",
    replayConflictAt: "internal",
    outcome: "internal",
    decidedAt: "internal",
    budgetOwnerId: "internal",
    budgetOwnerName: "internal",
    bucketHeld: "internal",
    bucketAssignedAt: "internal",
    totalValueCents: "internal",
    state: "internal",
    waitingOn: "internal",
    revenueBooking: "internal",
    expenseBooking: "internal",
    inventorySourceKey: "internal",
    inventoryLoadedAt: "internal",
  },
  InKindGiftDetailLineView: {
    id: "internal",
    gtin13: "internal",
    description: "internal",
    quantity: "internal",
    valueCents: "internal",
    suggestedValueCents: "internal",
  },
  InKindGiftEventView: {
    id: "internal",
    eventType: "internal",
    actorUsername: "internal",
    occurredAt: "internal",
    payload: "internal",
  },
  ManualInKindRecordResult: {
    id: "internal",
    inventoryLoaded: "internal",
  },
} as const;

export const relations = {
  InKindQueueItemView: {
    lines: { model: "InKindQueueLineView", isList: true },
  },
  InKindBucketGiftView: {
    lines: { model: "InKindBucketGiftLineView", isList: true },
  },
  InKindGiftDetailView: {
    lines: { model: "InKindGiftDetailLineView", isList: true },
    events: { model: "InKindGiftEventView", isList: true },
  },
} as const;
