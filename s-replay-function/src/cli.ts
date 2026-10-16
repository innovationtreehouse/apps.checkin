/**
 * Local dev entry — runs the same admin operations the Lambda handler exposes.
 *
 *   npm run replay -- --reason "<why>" [--actor <id>] [--object ORDER] [--gid <gid>] [--since <iso>] [--store <id>] [--all]
 *   npm run reset-watermark -- --reason "<why>" [--actor <id>] [--object ORDER] [--to <iso>] [--store <id>] [--all]
 *   npm run reingest-bulk -- --reason "<why>" [--actor <id>] [--since <iso>] [--bulk <operationId>] [--store <id>] [--all]
 *
 * --reason is required (audit) and --actor defaults to "cli:<os-user>". reset-watermark
 * with no --to clears the watermark (next sync re-pulls from cutover). reingest-bulk
 * re-reassembles + re-projects stored bulk exports (no Shopify calls). --all is required
when no narrowing filter is given (the op then covers the whole store).
 */
import { prisma, logger } from "@inventory/s-ingest-core";
import { handler } from "./handler.js";
import { flag } from "./args.js";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  const reason = flag(rest, "--reason");
  if (!reason) throw new Error("--reason is required (audit: why is this admin op being run?)");
  const actor = flag(rest, "--actor") ?? `cli:${process.env.USER ?? "unknown"}`;
  const common = {
    storeId: flag(rest, "--store"),
    objectType: flag(rest, "--object"),
    gid: flag(rest, "--gid"),
    ...(rest.includes("--all") ? { scope: "all" } : {}),
    actor,
    reason,
  };

  let event: Record<string, unknown>;
  if (command === "replay") {
    event = { mode: "replay", ...common, since: flag(rest, "--since") };
  } else if (command === "reset-watermark") {
    event = { mode: "reset-watermark", ...common, to: flag(rest, "--to") ?? null };
  } else if (command === "reingest-bulk") {
    event = { mode: "reingest-bulk", ...common, since: flag(rest, "--since"), bulkOperationId: flag(rest, "--bulk") };
  } else {
    throw new Error(`Unknown command: ${command ?? "(none)"}. Use replay | reset-watermark | reingest-bulk.`);
  }

  const result = await handler(event);
  logger.info(`${command} done`, result);
}

main()
  .catch((err) => {
    logger.error("cli failed", { err });
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
