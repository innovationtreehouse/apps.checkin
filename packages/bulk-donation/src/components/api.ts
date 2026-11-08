"use client";
import { createClient, errorMessage, HttpError, useViewer, type Loaded } from "@checkin/component-ui";
import { notifications } from "@mantine/notifications";

/**
 * Client fetch helpers. Every donation read and write goes through the host's
 * routes under /api/donations/*; the routes gate server-side, so the client
 * only uses the caller's role to decorate the UI.
 */
const BASE = "/api/donations";

export const { api, useLoad } = createClient(BASE);

/** Whether the viewer may write. Mirrors the write routes' FINANCE gate (BOARD reads only). */
export function useCanWrite(): boolean {
  return useViewer()?.isFinance === true;
}

export interface OwnerOption {
  id: number;
  name: string;
}

/** checkin's active budget-owner buckets, read from the host's bucket route. */
export function useOwners(): Loaded<OwnerOption[]> {
  return useLoad<OwnerOption[]>("/api/budget-owners");
}

export function ownerName(owners: readonly OwnerOption[] | null, id: number | null): string {
  if (id === null) return "—";
  return owners?.find((o) => o.id === id)?.name ?? `Owner #${id}`;
}

/** A route that will never take this request: a 4xx other than 401 (our wiring), 403 (the viewer's own permission) and 429 (a passing overload). */
export function isRefusal(e: unknown): e is HttpError {
  return e instanceof HttpError && e.status >= 400 && e.status < 500 && ![401, 403, 429].includes(e.status);
}

/** A failed inventory load, with a 403 told to the viewer as their own permission. */
export function loadError(e: unknown): unknown {
  return e instanceof HttpError && e.status === 403 ? new HttpError("You don't have permission to load goods into inventory.", 403) : e;
}

export function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/** Run a write, toast the outcome, then reload; a failure's chip stays up until dismissed. Returns whether it succeeded. */
export async function act(call: () => Promise<unknown>, ok: string | ((result: unknown) => string), reload: () => void): Promise<boolean> {
  try {
    const result = await call();
    notifications.show({ message: typeof ok === "string" ? ok : ok(result), color: "green" });
    reload();
    return true;
  } catch (e) {
    notifications.show({
      message: errorMessage(e),
      color: "red",
      autoClose: false,
      styles: { description: { whiteSpace: "pre-line", maxHeight: "50vh", overflowY: "auto" } },
    });
    return false;
  }
}

export { errorMessage, PAGE_SIZE, paged, type Loaded } from "@checkin/component-ui";
