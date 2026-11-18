import { act } from "@testing-library/react";
import { api } from "@/lib/api";

// SWR binds its reconnect handler to the real setTimeout, so a reconnect settles on a real tick.
const realSetTimeout = globalThis.setTimeout;

/** The GETs `fetchMock` saw for `path` exactly, query included. */
export const readsOf = (fetchMock: jest.Mock, path: string) =>
  fetchMock.mock.calls.filter(([url, init]) => String(url) === path && (init?.method ?? "GET") === "GET");

/** Lets the five-second dedupe window pass, then goes offline-to-online. Needs `jest.useFakeTimers()`. */
export async function reconnectAfterDedupe() {
  await act(() => jest.advanceTimersByTimeAsync(6000));
  window.dispatchEvent(new Event("online"));
  await act(() => new Promise<void>((resolve) => { realSetTimeout(resolve, 0); }));
  await act(() => jest.advanceTimersByTimeAsync(20));
}

/** A successful write from somewhere else, which re-reads every load that has not opted out. */
export async function unrelatedWrite() {
  await act(async () => { await api("/api/unrelated", { method: "POST" }); });
  await act(() => new Promise<void>((resolve) => { realSetTimeout(resolve, 20); }));
}
