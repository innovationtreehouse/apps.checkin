import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, QUICKBOOKS_LIST_STALE, QuickBooksListsRefresh, createClient, refusalMessage } from "./index";

const STATUS = "/api/books-map/quickbooks-lists";
const REFRESH = "/api/books-map/quickbooks-lists/refresh";
const OPTIONS = "/api/books-map/quickbooks-accounts";

let refreshAnswer: () => Response;
let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const calls = (url: string, method = "GET") => fetchMock.mock.calls.filter(([u, init]) => u === url && (init?.method ?? "GET") === method).length;

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  refreshAnswer = () => json([{ list: "account", refreshedAt: "2026-11-14T18:00:00.000Z", entries: 43 }]);
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === REFRESH && init?.method === "POST") return refreshAnswer();
    if (url === STATUS) return json([{ list: "account", refreshedAt: "2026-11-14T06:00:00.000Z", entries: 42 }, { list: "class", refreshedAt: "2026-11-13T06:00:00.000Z", entries: 7 }]);
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const { useLoad } = createClient("/api");

/** A page whose picker options come from `useLoad`, with the button beside the picker. */
function Picker({ onRefreshed }: { onRefreshed?: () => void }) {
  useLoad(OPTIONS);
  return <QuickBooksListsRefresh onRefreshed={onRefreshed} />;
}

const show = (ui: ReactNode) => render(<MantineProvider>{ui}</MantineProvider>);

describe("QuickBooksListsRefresh", () => {
  it("shows when the older of the two lists was copied", async () => {
    show(<QuickBooksListsRefresh />);
    const older = new Date("2026-11-13T06:00:00.000Z").toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    expect(await screen.findByText(`QuickBooks lists as of ${older}`)).toBeTruthy();
  });

  it("says the lists were never copied while the copy is empty", async () => {
    fetchMock.mockImplementation(async () => json([]));
    show(<QuickBooksListsRefresh />);
    expect(await screen.findByText("QuickBooks lists not copied yet")).toBeTruthy();
  });

  it("updates the copy, then reloads the page's options and tells the page", async () => {
    const onRefreshed = vi.fn();
    show(<Picker onRefreshed={onRefreshed} />);
    await waitFor(() => expect(calls(OPTIONS)).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() => expect(onRefreshed).toHaveBeenCalledTimes(1));
    expect(calls(REFRESH, "POST")).toBe(1);
    await waitFor(() => expect(calls(OPTIONS)).toBe(2));
  });

  it("shows the route's words when QuickBooks can't be read, and reloads nothing", async () => {
    const onRefreshed = vi.fn();
    refreshAnswer = () => json({ error: "QuickBooks did not return its lists. Try again shortly." }, 503);
    show(<QuickBooksListsRefresh onRefreshed={onRefreshed} />);
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    expect(await screen.findByText("QuickBooks did not return its lists. Try again shortly.")).toBeTruthy();
    expect(onRefreshed).not.toHaveBeenCalled();
  });
});

describe("refusalMessage", () => {
  it("is the refusal's words alone for any other refusal", () => {
    expect(refusalMessage(new HttpError("That Class is taken.", 409))).toBe("That Class is taken.");
  });

  it("offers Update now beside a refusal against an out-of-date list", async () => {
    show(refusalMessage(new HttpError("QuickBooks' list in the app doesn't have an account with id 9.", 400, [], QUICKBOOKS_LIST_STALE)));
    expect(screen.getByText(/doesn't have an account with id 9/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update now" })).toBeTruthy();
  });
});

describe("request", () => {
  it("hands a route's error code to the page", async () => {
    fetchMock.mockImplementation(async () => json({ error: "Stale", code: QUICKBOOKS_LIST_STALE }, 400));
    const { api } = createClient("/api");
    await expect(api("/x", { method: "PUT" })).rejects.toMatchObject({ code: QUICKBOOKS_LIST_STALE, status: 400 });
    fetchMock.mockImplementation(async () => json({ error: "No code" }, 400));
    await expect(api("/x", { method: "PUT" })).rejects.toMatchObject({ code: null });
  });
});
