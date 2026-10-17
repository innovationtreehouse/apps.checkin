/**
 * Relay configuration.
 */
import { z } from "zod";

const schema = z.object({
  /** SNS topic all alerts are published to. SNS → Slack is wired separately. */
  SNS_TOPIC_ARN: z.string().min(1, "SNS_TOPIC_ARN is required"),
  MONITORING_ENV: z.string().min(1, "MONITORING_ENV is required"),
  MONITOR_NAME: z.string().min(1).default("monitoring-relay"),
  /** Max outbox rows to drain per run. */
  RELAY_BATCH_LIMIT: z.coerce.number().int().positive().default(50),
  /** Failed deliveries that reach this attempt count are dead-lettered (DEAD) instead of
   * retried forever, so a persistently-failing alert can't wedge the oldest-first drain. */
  RELAY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
});

export interface RelayConfig {
  snsTopicArn: string;
  env: string;
  monitorName: string;
  batchLimit: number;
  maxAttempts: number;
}

export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const parsed = schema.parse(env);
  return {
    snsTopicArn: parsed.SNS_TOPIC_ARN,
    env: parsed.MONITORING_ENV,
    monitorName: parsed.MONITOR_NAME,
    batchLimit: parsed.RELAY_BATCH_LIMIT,
    maxAttempts: parsed.RELAY_MAX_ATTEMPTS,
  };
}
