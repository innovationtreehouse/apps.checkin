import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PendingAlert } from "@checkin/monitoring-db";

// Capture what the relay hands to SNS. PublishCommand is stubbed to a thin
// `{ input }` carrier and SNSClient#send to a shared spy, so we can assert the
// terminus contract (subject, message, attributes) without a live AWS call.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock("@aws-sdk/client-sns", () => ({
  SNSClient: class {
    send = sendMock;
  },
  PublishCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

import { safeSubject, safeAttr, withReferenceTrailer, publishAlert, isPermanentSnsError, SNS_PUBLISH_TIMEOUT_MS } from "./sns.js";

describe("safeAttr", () => {
  it("strips control chars (incl. newlines) that would make Publish reject", () => {
    expect(safeAttr("shopify\nread\tsvc")).toBe("shopify read svc");
  });

  it("clamps an over-long value to 256 chars", () => {
    expect(safeAttr("x".repeat(500))).toHaveLength(256);
  });

  it("leaves a normal value unchanged", () => {
    expect(safeAttr("shopify-read")).toBe("shopify-read");
  });
});

describe("isPermanentSnsError", () => {
  it("classifies a malformed-attribute / auth / not-found error as permanent", () => {
    expect(isPermanentSnsError(Object.assign(new Error("x"), { name: "InvalidParameterException" }))).toBe(true);
    expect(isPermanentSnsError(Object.assign(new Error("x"), { name: "AuthorizationErrorException" }))).toBe(true);
    expect(isPermanentSnsError(Object.assign(new Error("x"), { name: "NotFoundException" }))).toBe(true);
  });

  it("classifies a non-throttling 4xx as permanent", () => {
    expect(isPermanentSnsError({ name: "X", $metadata: { httpStatusCode: 400 } })).toBe(true);
  });

  it("classifies throttling / 5xx / abort / unknown as transient", () => {
    expect(isPermanentSnsError(Object.assign(new Error("x"), { name: "ThrottledException" }))).toBe(false);
    expect(isPermanentSnsError({ name: "X", $metadata: { httpStatusCode: 429 } })).toBe(false);
    expect(isPermanentSnsError({ name: "X", $metadata: { httpStatusCode: 500 } })).toBe(false);
    expect(isPermanentSnsError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(false);
    expect(isPermanentSnsError(new Error("network down"))).toBe(false); // unknown ⇒ retry, don't drop
  });
});

describe("safeSubject", () => {
  it("collapses newlines to spaces", () => {
    expect(safeSubject("line one\nline two")).toBe("line one line two");
  });

  it("truncates to 100 chars (SNS limit)", () => {
    const long = "x".repeat(150);
    expect(safeSubject(long)).toHaveLength(100);
  });

  it("leaves a short single-line subject unchanged", () => {
    expect(safeSubject("[prod] shopify-read sync is stale")).toBe("[prod] shopify-read sync is stale");
  });

  it("collapses newlines BEFORE truncating, so a past-100 newline can't leak through", () => {
    // A naive truncate-then-collapse would cut at 100 and could leave a trailing newline;
    // collapsing first guarantees the 100-char window is already single-line.
    const out = safeSubject("a".repeat(100) + "\nLEAK");
    expect(out).toHaveLength(100);
    expect(out).not.toContain("\n");
    expect(out).toBe("a".repeat(100));
  });
});

describe("withReferenceTrailer", () => {
  const alert = (correlationId: string | null): PendingAlert => ({
    id: 1n,
    healthEventId: 42n,
    service: "shopify-read",
    env: "prod",
    severity: "CRITICAL",
    subject: "subj",
    summary: "body",
    correlationId,
    attempts: 0,
  });

  it("appends the incident id and correlation id", () => {
    expect(withReferenceTrailer("body", alert("abc-123"))).toBe("body\n\nRef: incident 42 · correlation abc-123");
  });

  it("omits the correlation segment when absent", () => {
    expect(withReferenceTrailer("body", alert(null))).toBe("body\n\nRef: incident 42");
  });
});

// ── Item 3: the SNS terminus contract — publishAlert actually called ────────────
describe("publishAlert (SNS terminus contract)", () => {
  const TOPIC = "arn:aws:sns:us-east-1:123456789012:monitoring-alerts";

  const makeAlert = (over: Partial<PendingAlert> = {}): PendingAlert => ({
    id: 1n,
    healthEventId: 42n,
    service: "shopify-read",
    env: "prod",
    severity: "CRITICAL",
    subject: "[prod] shopify-read sync is stale",
    summary: "Last successful sync was 2h ago.",
    correlationId: "abc-123",
    attempts: 0,
    ...over,
  });

  const lastInput = () => sendMock.mock.calls.at(-1)![0].input;

  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });

  it("publishes to the topic with the safe subject and the reference-trailer message", async () => {
    const alert = makeAlert();
    await publishAlert(TOPIC, alert);

    const input = lastInput();
    expect(input.TopicArn).toBe(TOPIC);
    expect(input.Subject).toBe(safeSubject(alert.subject));
    expect(input.Message).toBe(withReferenceTrailer(alert.summary, alert));
  });

  it("attaches the routing/trace attributes the downstream subscriber relies on", async () => {
    await publishAlert(TOPIC, makeAlert());

    const attrs = lastInput().MessageAttributes;
    expect(attrs.service).toEqual({ DataType: "String", StringValue: "shopify-read" });
    expect(attrs.env).toEqual({ DataType: "String", StringValue: "prod" });
    expect(attrs.severity).toEqual({ DataType: "String", StringValue: "CRITICAL" });
    expect(attrs.healthEventId).toEqual({ DataType: "String", StringValue: "42" });
    expect(attrs.correlationId).toEqual({ DataType: "String", StringValue: "abc-123" });
  });

  it("omits the correlationId attribute when the incident has none", async () => {
    await publishAlert(TOPIC, makeAlert({ correlationId: null }));

    const attrs = lastInput().MessageAttributes;
    expect(attrs.correlationId).toBeUndefined();
    // The always-present attributes are still there.
    expect(attrs.service).toBeDefined();
    expect(attrs.healthEventId).toBeDefined();
  });

  it("truncates an oversized, multiline subject to a single line <= 100 chars at the command boundary", async () => {
    const subject = "a".repeat(60) + "\n" + "b".repeat(60);
    await publishAlert(TOPIC, makeAlert({ subject }));

    const { Subject } = lastInput();
    expect(Subject.length).toBeLessThanOrEqual(100);
    expect(Subject).not.toContain("\n");
  });

  it("sanitizes message attributes so a malformed upstream field can't fail the Publish", async () => {
    await publishAlert(TOPIC, makeAlert({ service: "shopify\nread".padEnd(400, "y"), correlationId: "c\nrr" }));

    const attrs = lastInput().MessageAttributes;
    expect(attrs.service.StringValue).not.toContain("\n");
    expect(attrs.service.StringValue.length).toBeLessThanOrEqual(256);
    expect(attrs.correlationId.StringValue).toBe("c rr");
  });

  it("propagates an SNS publish failure so the relay's retry path fires", async () => {
    sendMock.mockRejectedValueOnce(new Error("AuthorizationError: not allowed to publish"));

    await expect(publishAlert(TOPIC, makeAlert())).rejects.toThrow("AuthorizationError");
  });

  it("aborts a hung publish after the timeout (fails fast instead of running to the Lambda limit)", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      // A publish that never resolves on its own — it only settles if the abort signal fires.
      sendMock.mockImplementation((_cmd: unknown, opts: { abortSignal: AbortSignal }) => {
        signal = opts.abortSignal;
        return new Promise((_resolve, reject) => {
          opts.abortSignal.addEventListener("abort", () =>
            reject(Object.assign(new Error("Request aborted"), { name: "AbortError" })),
          );
        });
      });

      const p = publishAlert(TOPIC, makeAlert());
      const rejects = expect(p).rejects.toThrow(/abort/i);
      await vi.advanceTimersByTimeAsync(SNS_PUBLISH_TIMEOUT_MS);
      await rejects;

      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
