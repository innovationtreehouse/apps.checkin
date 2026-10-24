/**
 * Minimal PrismaClient double for unit tests. Only the delegate methods the code
 * under test actually calls are stubbed (as `vi.fn`s you can assert on); everything
 * else is intentionally absent so an unexpected DB call fails loudly rather than
 * silently no-op'ing. Core functions that take prisma (ingestNode, withSyncRun, …)
 * are mocked at the module boundary in the tests that need them, so this only has to
 * satisfy the few direct `prisma.*` calls in the read-path code (e.g. store.upsert).
 */
import { vi } from "vitest";

export interface FakePrisma {
  store: { upsert: ReturnType<typeof vi.fn> };
}

export function fakePrisma(): FakePrisma {
  return {
    store: { upsert: vi.fn().mockResolvedValue(undefined) },
  };
}

/** An opaque prisma stand-in for code paths that only forward prisma to mocked core fns. */
export const prismaSentinel = { __fake: true } as unknown as import("@checkin/s-ingest-core").PrismaClient;
