import { z } from "zod";

const OrgEventsResponseSchema = z.object({
  events: z.array(z.object({
    id: z.number().int(),
    eventType: z.string(),
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })),
});

const FALLBACK_INTERVAL_MS = 60_000;

// ── Generic shapes — apps provide their own row/status types via the repo ────
export interface OrgEventRow {
  id: number;
  orgId: string;
  eventType: string;
  payload: string;
  status: string;
}

export type OrgEventStatus = "pending" | "processed" | "failed";

export interface OrgEventsRepo {
  getMaxId(): Promise<number>;
  findOne(id: number): Promise<OrgEventRow | null>;
  exists(id: number): Promise<boolean>;
  insert(data: { id: number; orgId: string; eventType: string; payload: string; receivedAt: Date; status: OrgEventStatus }): Promise<void>;
  updateStatus(id: number, status: OrgEventStatus, failureReason?: string | null): Promise<void>;
  findPending(orgId: string): Promise<OrgEventRow[]>;
}

export interface PollSettings {
  globalServerUrl: string | null;
  pollIntervalMinutes: number;
  pollWindowStart: string;
  pollWindowEnd: string;
}

export interface OrgEventsPollerDeps {
  /** Loads current poll settings (admin-owned config; e.g. settingsData singleton). */
  getSettings(): Promise<PollSettings>;
  /** Returns the org ids this app should poll events for. */
  getOrgIds(): Promise<string[]>;
  orgEventsRepo: OrgEventsRepo;
  /**
   * App-specific resolution logic for a single event. Receives the parsed
   * payload; throw to mark the event "failed" (it'll be retried next cycle).
   */
  onEvent(args: { eventType: string; orgId: string; eventId: number; payload: Record<string, unknown> }): Promise<void>;
  /**
   * Optional hook called before every updateStatus call.
   * Throw to abort the status write (e.g. machine transition guard).
   * The failed→failed re-write passes currentStatus === nextStatus; implementations
   * that skip that case should check and return early.
   */
  assertTransition?(id: number, currentStatus: OrgEventStatus, nextStatus: OrgEventStatus): Promise<void>;
  /** Unique key so multiple pollers in one process don't collide on the start-guard. */
  pollerKey: string;
  /** Mints the bearer token sent with each org-events fetch. */
  signToken(claims: { orgId: string; orgName: string }): Promise<string>;
}

function isWithinWindow(start: string, end: string): boolean {
  const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return nowMinutes >= toMinutes(start) && nowMinutes <= toMinutes(end);
}

interface ResolvedConfig {
  globalServerUrl: string;
  orgIds: string[];
  pollIntervalMinutes: number;
  pollWindowStart: string;
  pollWindowEnd: string;
}

async function loadConfig(deps: OrgEventsPollerDeps): Promise<ResolvedConfig | null> {
  const settings = await deps.getSettings();
  if (!settings.globalServerUrl) return null;

  const orgIds = await deps.getOrgIds();
  if (orgIds.length === 0) return null;

  return {
    globalServerUrl: settings.globalServerUrl,
    orgIds,
    pollIntervalMinutes: settings.pollIntervalMinutes,
    pollWindowStart: settings.pollWindowStart,
    pollWindowEnd: settings.pollWindowEnd,
  };
}

async function processEvent(eventId: number, orgId: string, deps: OrgEventsPollerDeps): Promise<void> {
  const event = await deps.orgEventsRepo.findOne(eventId);
  if (!event) throw new Error(`Event ${eventId} not found`);

  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  await deps.onEvent({ eventType: event.eventType, orgId, eventId, payload });
}

async function runPollCycle(deps: OrgEventsPollerDeps): Promise<void> {
  const { orgEventsRepo } = deps;

  const config = await loadConfig(deps);
  if (!config) return;

  const { globalServerUrl, orgIds } = config;

  for (const orgId of orgIds) {
    try {
      const retryEvents = await orgEventsRepo.findPending(orgId);

      for (const event of retryEvents) {
        const currentStatus = event.status as OrgEventStatus;
        try {
          await processEvent(event.id, orgId, deps);
          await deps.assertTransition?.(event.id, currentStatus, "processed");
          await orgEventsRepo.updateStatus(event.id, "processed", null);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await deps.assertTransition?.(event.id, currentStatus, "failed");
          await orgEventsRepo.updateStatus(event.id, "failed", msg);
        }
      }

      const cursor = await orgEventsRepo.getMaxId();
      const token = await deps.signToken({ orgId, orgName: "" });
      const res = await fetch(
        `${globalServerUrl}/orgs/${encodeURIComponent(orgId)}/events?after=${cursor}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) {
        console.error(`[org-events:${deps.pollerKey}] Failed to fetch events for org ${orgId}: HTTP ${res.status}`);
        continue;
      }

      const parsed = OrgEventsResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        console.error(`[org-events:${deps.pollerKey}] Invalid response shape for org ${orgId}:`, parsed.error.flatten());
        continue;
      }
      const { events } = parsed.data;

      for (const event of events) {
        if (await orgEventsRepo.exists(event.id)) continue;

        await orgEventsRepo.insert({
          id: event.id,
          orgId,
          eventType: event.eventType,
          payload: JSON.stringify(event.payload),
          receivedAt: new Date(),
          status: "pending",
        });

        try {
          await processEvent(event.id, orgId, deps);
          await deps.assertTransition?.(event.id, "pending", "processed");
          await orgEventsRepo.updateStatus(event.id, "processed", null);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[org-events:${deps.pollerKey}] Failed to process event ${event.id}:`, msg);
          await deps.assertTransition?.(event.id, "pending", "failed");
          await orgEventsRepo.updateStatus(event.id, "failed", msg);
        }
      }
    } catch (err) {
      console.error(`[org-events:${deps.pollerKey}] Poll cycle error for org ${orgId}:`, err);
    }
  }
}

function scheduleNext(intervalMs: number, deps: OrgEventsPollerDeps): void {
  setTimeout(() => {
    tick(deps).catch((err) => console.error(`[org-events:${deps.pollerKey}] Unhandled poll error:`, err));
  }, intervalMs);
}

async function tick(deps: OrgEventsPollerDeps): Promise<void> {
  const config = await loadConfig(deps);
  if (!config) {
    scheduleNext(FALLBACK_INTERVAL_MS, deps);
    return;
  }

  const intervalMs = config.pollIntervalMinutes * 60_000;

  if (isWithinWindow(config.pollWindowStart, config.pollWindowEnd)) {
    await runPollCycle(deps);
  }

  scheduleNext(intervalMs, deps);
}

const g = globalThis as typeof globalThis & { __orgEventsPollersStarted?: Set<string> };

export function startOrgEventsPoller(deps: OrgEventsPollerDeps): void {
  if (!g.__orgEventsPollersStarted) g.__orgEventsPollersStarted = new Set();
  if (g.__orgEventsPollersStarted.has(deps.pollerKey)) return;
  g.__orgEventsPollersStarted.add(deps.pollerKey);
  console.log(`[org-events:${deps.pollerKey}] poller starting`);
  tick(deps).catch((err) => console.error(`[org-events:${deps.pollerKey}] Startup poll error:`, err));
}
