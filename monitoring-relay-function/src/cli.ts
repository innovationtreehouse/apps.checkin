/**
 * Local entry point.
 *
 *   npm run run:once               — drain the outbox once against the .env target.
 *   npm run requeue-dead [<id>]    — operator recovery: move dead-lettered (DEAD) outbox
 *                                    rows back to PENDING so the next run retries them. Pass
 *                                    a numeric outbox id to requeue just one; omit for all
 *                                    DEAD rows in this MONITORING_ENV. Use after fixing the
 *                                    root cause (e.g. SNS topic permissions).
 */
import { prisma, requeueDead } from "@checkin/monitoring-db";
import { loadRelayConfig } from "./config.js";
import { handler } from "./handler.js";

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);

  if (command === "requeue-dead") {
    const cfg = loadRelayConfig();
    const id = arg !== undefined ? BigInt(arg) : undefined;
    const requeued = await requeueDead(prisma, cfg.env, id !== undefined ? { id } : {});
    console.log(JSON.stringify({ ok: true, requeued, env: cfg.env, id: id?.toString() ?? "all" }));
    return;
  }

  const result = await handler();
  console.log(JSON.stringify({ ok: true, ...result }));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
