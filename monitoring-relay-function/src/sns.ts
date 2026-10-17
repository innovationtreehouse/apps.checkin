/**
 * SNS publish — the single egress of the relay.
 *
 * The alert is already self-contained in the outbox row (`subject` + `summary`, PRD §3.3),
 * so this just forwards it. `service`/`severity` go on as message attributes so the
 * downstream SNS→Slack subscriber (out of scope here) can route/filter without parsing.
 * The incident id (`healthEventId`) and `correlationId` are attached too, and appended as a
 * trailer to the body, so a responder can pivot from the alert to the health_event / logs.
 *
 * Two hardening guarantees live here:
 *  - Every outbound value is sanitized (`safeSubject`/`safeAttr`) so a malformed upstream
 *    field can't make the whole Publish fail and dead-letter an otherwise-deliverable alert.
 *  - Each publish has a hard client-side deadline (`AbortSignal`) well under the Lambda
 *    timeout, so a hung SNS connection fails fast instead of starving the rest of the batch.
 */
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import type { PendingAlert } from "@checkin/monitoring-db";

/** Per-publish client-side deadline. Must stay well under the Lambda timeout. */
export const SNS_PUBLISH_TIMEOUT_MS = 5_000;

// maxAttempts bounds the SDK's own internal retries so they don't compound with the
// outbox-level retry (attempts/markFailed). The abortSignal below is the hard ceiling.
const client = new SNSClient({ maxAttempts: 3 });

/** SNS subjects are limited to 100 chars and must be ASCII-ish; keep it short. */
export function safeSubject(subject: string): string {
  return subject.replace(/[\r\n]+/g, " ").slice(0, 100);
}

/**
 * Sanitize a value before it becomes an SNS message attribute. An attribute value must be
 * valid UTF-8 and is length-bounded; an over-long or control-char-laden value (e.g. a
 * service name carrying a newline) makes the entire Publish fail. Strip control chars and
 * clamp so a bad upstream field degrades gracefully instead of poisoning the row.
 */
export function safeAttr(value: string): string {

  return value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 256);
}

/** Append a compact reference trailer so the incident is traceable from the notification alone. */
export function withReferenceTrailer(summary: string, alert: PendingAlert): string {
  const corr = alert.correlationId ? ` · correlation ${alert.correlationId}` : "";
  return `${summary}\n\nRef: incident ${alert.healthEventId.toString()}${corr}`;
}

/**
 * Classify an SNS publish failure as permanent (won't succeed on retry → dead-letter now) or
 * transient (retry on the next run). Defaults to transient for anything unrecognised so a
 * monitoring alert is never dropped on an ambiguous error.
 */
export function isPermanentSnsError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  const name = e.name ?? "";
  const status = e.$metadata?.httpStatusCode;

  // Transient: throttling, server errors, our own abort/timeout, transport hiccups.
  if (name.includes("Throttl") || name === "TooManyRequestsException") return false;
  if (name === "TimeoutError" || name === "AbortError") return false;
  if (status === 429 || (status !== undefined && status >= 500)) return false;

  // Permanent: a 4xx caller fault (other than throttling) won't fix itself on retry.
  if (status !== undefined && status >= 400) return true;
  const permanent = new Set([
    "InvalidParameterException",
    "InvalidParameterValueException",
    "AuthorizationErrorException",
    "NotFoundException",
    "InvalidSecurityException",
    "EndpointDisabledException",
    "KMSAccessDeniedException",
    "KMSDisabledException",
    "KMSInvalidStateException",
    "KMSNotFoundException",
  ]);
  if (permanent.has(name)) return true;

  // Unknown (e.g. a network error with no status): retry rather than drop.
  return false;
}

export async function publishAlert(topicArn: string, alert: PendingAlert): Promise<void> {
  const attributes: Record<string, { DataType: string; StringValue: string }> = {
    service: { DataType: "String", StringValue: safeAttr(alert.service) },
    env: { DataType: "String", StringValue: safeAttr(alert.env) },
    severity: { DataType: "String", StringValue: safeAttr(alert.severity) },
    healthEventId: { DataType: "String", StringValue: alert.healthEventId.toString() },
  };
  if (alert.correlationId) {
    attributes.correlationId = { DataType: "String", StringValue: safeAttr(alert.correlationId) };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SNS_PUBLISH_TIMEOUT_MS);
  try {
    await client.send(
      new PublishCommand({
        TopicArn: topicArn,
        Subject: safeSubject(alert.subject),
        Message: withReferenceTrailer(alert.summary, alert),
        MessageAttributes: attributes,
      }),
      { abortSignal: controller.signal },
    );
  } finally {
    clearTimeout(timer);
  }
}
