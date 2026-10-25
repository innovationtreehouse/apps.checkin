/** The review screen's queues. The selected one rides in `?queue=` so a receipt opened from it can return to it. */
export const QUEUES = [
  { value: "financial_review", label: "Finance review" },
  { value: "duplicate_flagged", label: "Duplicates" },
  { value: "validation_failed", label: "Totals off" },
  { value: "ocr_failed", label: "Unreadable" },
  { value: "flow_error", label: "Errors" },
  { value: "", label: "All" },
];

/** Finalized receipts not yet delivered to receiving. */
export const NOT_PUSHED = "not_pushed";

/** The states FINANCE does not work, listed so finance and the Board can still find every receipt. */
export const OTHER_QUEUES = [
  { value: "auto_upload", label: "Reading (OCR in progress)" },
  { value: "uploaded", label: "Uploaded" },
  { value: "submitter_review", label: "Submitter review" },
  { value: "receipt_finalized", label: "Finalized" },
  { value: NOT_PUSHED, label: "Not delivered to receiving" },
  { value: "discarded", label: "Discarded" },
  { value: "rejected", label: "Rejected" },
];

const DEFAULT_QUEUE = "financial_review";
const ALL = "all";

const isQueue = (value: string | null): value is string =>
  [...QUEUES, ...OTHER_QUEUES].some((q) => q.value && q.value === value);

export const isOtherQueue = (queue: string) => OTHER_QUEUES.some((q) => q.value === queue);

/** The queue a `?queue=` value selects; "" is every state. Unknown values get the default queue. */
export function parseQueue(param: string | null): string {
  if (param === ALL) return "";
  return isQueue(param) ? param : DEFAULT_QUEUE;
}

/** The queue a receipt opened under review returns to: `?queue=` when given, else the queue its state is in. */
export function returnQueue(param: string | null, state: string): string {
  if (param !== null) return parseQueue(param);
  return isQueue(state) ? state : DEFAULT_QUEUE;
}

/** The list API query for `queue`, relative to /api/receipts. */
export function queueListPath(queue: string): string {
  if (!queue) return "";
  if (queue === NOT_PUSHED) return "?state=receipt_finalized&pushed=0";
  return `?state=${queue}`;
}

const queueParam = (queue: string) => `queue=${queue || ALL}`;

/** The review screen showing `queue`. */
export const reviewHref = (queue: string) => `/receipts/review?${queueParam(queue)}`;

/** A receipt opened from the review screen's `queue`. */
export const reviewDetailHref = (id: string, queue: string) => `/receipts/review/${encodeURIComponent(id)}?${queueParam(queue)}`;
