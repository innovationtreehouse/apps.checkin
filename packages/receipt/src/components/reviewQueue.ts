/** The review screen's queues. The selected one rides in `?queue=` so a receipt opened from it can return to it. */
export const QUEUES = [
  { value: "financial_review", label: "Finance review" },
  { value: "duplicate_flagged", label: "Duplicates" },
  { value: "validation_failed", label: "Totals off" },
  { value: "ocr_failed", label: "Unreadable" },
  { value: "flow_error", label: "Errors" },
  { value: "", label: "All" },
];

const DEFAULT_QUEUE = "financial_review";
const ALL = "all";

/** The receipt state a `?queue=` value selects; "" is every state. Unknown values get the default queue. */
export function parseQueue(param: string | null): string {
  if (param === ALL) return "";
  return QUEUES.some((q) => q.value && q.value === param) ? (param as string) : DEFAULT_QUEUE;
}

/** The queue a receipt opened under review returns to: `?queue=` when given, else the queue its state is in. */
export function returnQueue(param: string | null, state: string): string {
  if (param !== null) return parseQueue(param);
  return QUEUES.some((q) => q.value && q.value === state) ? state : DEFAULT_QUEUE;
}

const queueParam =(queue: string) => `queue=${queue || ALL}`;

/** The review screen showing `queue`. */
export const reviewHref = (queue: string) => `/receipts/review?${queueParam(queue)}`;

/** A receipt opened from the review screen's `queue`. */
export const reviewDetailHref = (id: string, queue: string) => `/receipts/review/${encodeURIComponent(id)}?${queueParam(queue)}`;
