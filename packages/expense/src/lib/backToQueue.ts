/**
 * Where a detail page goes after a decision: back to the queue it was opened from once nothing is
 * left there for the viewer, else null, and the page reloads in place. A page opened from
 * anywhere else has no queue and always reloads.
 */
export function backToQueue(queueHref: string | null | undefined, leftForViewer: boolean): string | null {
  return queueHref && !leftForViewer ? queueHref : null;
}
