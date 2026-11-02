import { act, render, renderHook } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, ViewerProvider, createClient, errorMessage, type Loaded, type Viewer } from "./index";
import { clearLoads } from "./loadCache";

const { api, useLoad } = createClient("/api/things");

type Answer = Response | Error | Promise<Response>;

/** Stubs fetch with `answer` and returns the mock; GET counts come from its calls. */
function stubFetch(answer: (url: string, init?: RequestInit) => Answer) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const out = await answer(url, init);
    if (out instanceof Error) throw out;
    return out;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const gets = (fetchMock: ReturnType<typeof stubFetch>) => fetchMock.mock.calls.filter(([, init]) => !init?.method).length;

/** Runs timers, rAF included, and settles React. */
const advance = (ms = 20) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const person = (id: number): Viewer => ({ id, ageBand: "adult", isFinance: false, isBoardMember: false, isOperations: false, isInventoryManager: false });

describe("errorMessage", () => {
  it("keeps the server's words and replaces exception text", () => {
    expect(errorMessage(new HttpError("No such thing", 404))).toBe("No such thing");
    expect(errorMessage(new TypeError("Failed to fetch"))).toBe("Something went wrong. Try again.");
    expect(errorMessage("text")).toBe("Something went wrong. Try again.");
  });
});

describe("what the server says", () => {
  it.each([
    ["a network failure", () => new TypeError("Failed to fetch"), "Something went wrong. Try again.", null],
    ["a 5xx", () => json({ error: "Boom" }, 503), "Boom", 503],
  ])("%s retries at 2s, 4s, 8s, 16s without a message, then sets error", async (_name, answer, message, status) => {
    const fetchMock = stubFetch(answer);
    const { result } = renderHook(() => useLoad("/x"));
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ retrying: true, error: null, loading: false });
    for (const [wait, calls] of [[2000, 2], [4000, 3], [8000, 4]]) {
      await advance(wait - 1);
      expect(fetchMock).toHaveBeenCalledTimes(calls - 1);
      await advance(1);
      expect(fetchMock).toHaveBeenCalledTimes(calls);
      expect(result.current).toMatchObject({ retrying: true, error: null });
    }
    await advance(16000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.current).toMatchObject({ retrying: false, error: message, status });
    await advance(60000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("recovers from a failure with no message", async () => {
    let calls = 0;
    stubFetch(() => (++calls === 1 ? json({}, 502) : json(["row"])));
    const { result } = renderHook(() => useLoad<string[]>("/x"));
    await advance();
    expect(result.current.retrying).toBe(true);
    await advance(2000);
    expect(result.current).toMatchObject({ data: ["row"], retrying: false, error: null, status: null });
  });

  it("reload after the last attempt starts a new set of retries", async () => {
    const fetchMock = stubFetch(() => json({ error: "Boom" }, 500));
    const { result } = renderHook(() => useLoad("/x"));
    await advance(30000);
    expect(result.current.error).toBe("Boom");
    act(() => { void result.current.reload(); });
    await advance();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(result.current).toMatchObject({ retrying: true, error: null });
  });

  it("a page reopened after failing and closing gets a full set of retries", async () => {
    const fetchMock = stubFetch(() => json({}, 500));
    const first = renderHook(() => useLoad("/x"));
    await advance(0);
    await advance(2000);
    await advance(4000);
    await advance(8000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    first.unmount();
    const second = renderHook(() => useLoad("/x"));
    await advance();
    expect(second.result.current).toMatchObject({ retrying: true, error: null });
  });

  it("a write during a retry chain does not start a second chain", async () => {
    const fetchMock = stubFetch((_url, init) => (init?.method ? json({}) : json({}, 500)));
    renderHook(() => useLoad("/x"));
    await advance(0);
    await api("/y", { method: "POST" });
    await advance(60000);
    expect(gets(fetchMock)).toBe(5);
  });

  it("401 does not retry and calls onSessionExpired once", async () => {
    const fetchMock = stubFetch(() => json({ error: "Unauthorized" }, 401));
    const expired = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => <ViewerProvider viewer={person(1)} onSessionExpired={expired}>{children}</ViewerProvider>;
    const { result } = renderHook(() => useLoad("/x"), { wrapper });
    await advance(30000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ status: 401, retrying: false });
  });

  it("expireOn401 false reports a 401 without calling onSessionExpired", async () => {
    const fetchMock = stubFetch(() => json({ error: "Unauthorized" }, 401));
    const expired = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => <ViewerProvider viewer={person(1)} onSessionExpired={expired}>{children}</ViewerProvider>;
    const { result } = renderHook(() => useLoad("/x", { expireOn401: false }), { wrapper });
    await advance(30000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(expired).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ status: 401, retrying: false });
  });

  it("a write answered 401 does not call onSessionExpired", async () => {
    stubFetch((_url, init) => (init?.method ? json({ error: "Unauthorized" }, 401) : json([])));
    const expired = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => <ViewerProvider viewer={person(1)} onSessionExpired={expired}>{children}</ViewerProvider>;
    renderHook(() => useLoad("/x"), { wrapper });
    await advance();
    await expect(api("/x", { method: "POST" })).rejects.toThrow("Unauthorized");
    await advance();
    expect(expired).not.toHaveBeenCalled();
  });

  it.each([
    [403, json({ error: "Forbidden" }, 403), "Forbidden"],
    [404, json({ error: "No such thing" }, 404), "No such thing"],
    [400, json({ error: "Bad input" }, 400), "Bad input"],
    [200, new Response("<html>", { status: 200 }), "Unexpected non-JSON response (HTTP 200)"],
  ])("HTTP %i does not retry and reports the answer", async (status, answer, message) => {
    const fetchMock = stubFetch(() => answer.clone());
    const { result } = renderHook(() => useLoad("/x"));
    await advance(30000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ error: message, status, retrying: false });
  });

  it("retry: false fails on the first attempt", async () => {
    const fetchMock = stubFetch(() => new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useLoad("/x", { retry: false }));
    await advance(30000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ error: "Something went wrong. Try again.", retrying: false });
  });

  it("keeps retrying in a hidden tab", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const fetchMock = stubFetch(() => json({}, 500));
    renderHook(() => useLoad("/x"));
    await advance();
    await advance(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying offline and reaches the last attempt", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const fetchMock = stubFetch(() => new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useLoad("/x"));
    await advance(30000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.current.error).toBe("Something went wrong. Try again.");
  });

  it("two hooks on one key report the same retry state", async () => {
    const fetchMock = stubFetch(() => json({}, 500));
    const { result } = renderHook(() => [useLoad("/x"), useLoad("/x")]);
    await advance();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.map((l) => [l.retrying, l.error])).toEqual([[true, null], [true, null]]);
    await advance(30000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.current.map((l) => l.error)).toEqual(["HTTP 500", "HTTP 500"]);
  });
});

describe("the five things SWR gets wrong unless told", () => {
  it("1: two libraries with the same path get their own rows", async () => {
    const other = createClient("/api/other");
    stubFetch((url) => json([url]));
    const { result } = renderHook(() => [useLoad<string[]>("/settings"), other.useLoad<string[]>("/settings")]);
    await advance();
    expect(result.current.map((l) => l.data)).toEqual([["/api/things/settings"], ["/api/other/settings"]]);
  });

  it("2: an empty path loads and only null skips", async () => {
    const fetchMock = stubFetch(() => json(["all"]));
    const { result } = renderHook(() => useLoad<string[]>(""));
    await advance();
    expect(result.current.data).toEqual(["all"]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/things");
    fetchMock.mockClear();
    const skipped = renderHook(() => useLoad<string[]>(null));
    await advance();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(skipped.result.current).toMatchObject({ data: null, error: null, loading: false, retrying: false });
  });

  describe("3: a new path", () => {
    const held = () => {
      let release: (r: Response) => void = () => {};
      stubFetch((url) => (url.endsWith("/2") ? new Promise<Response>((r) => { release = r; }) : json(["one"])));
      return (r: Response) => release(r);
    };

    it("starts at null, so old rows never show under the new path", async () => {
      const release = held();
      const { result, rerender } = renderHook(({ path }) => useLoad<string[]>(path), { initialProps: { path: "/1" } });
      expect(result.current.data).toBeNull();
      await advance();
      expect(result.current.data).toEqual(["one"]);
      rerender({ path: "/2" });
      expect(result.current.data).toBeNull();
      await advance();
      expect(result.current).toMatchObject({ data: null, loading: true });
      release(json(["two"]));
      await advance();
      expect(result.current).toMatchObject({ data: ["two"], loading: false });
    });

    it("stays null through a retry chain and after the last failure", async () => {
      stubFetch((url) => (url.endsWith("/2") ? json({ error: "Boom" }, 500) : json(["one"])));
      const { result, rerender } = renderHook(({ path }) => useLoad<string[]>(path), { initialProps: { path: "/1" } });
      await advance();
      rerender({ path: "/2" });
      await advance();
      expect(result.current).toMatchObject({ data: null, retrying: true });
      await advance(30000);
      expect(result.current).toMatchObject({ data: null, error: "Boom" });
    });

    it("keepPrevious keeps the old rows until the answer arrives", async () => {
      const release = held();
      const { result, rerender } = renderHook(({ path }) => useLoad<string[]>(path, { keepPrevious: true }), { initialProps: { path: "/1" } });
      await advance();
      rerender({ path: "/2" });
      await advance();
      expect(result.current).toMatchObject({ data: ["one"], loading: true });
      release(json(["two"]));
      await advance();
      expect(result.current.data).toEqual(["two"]);
    });

    it("keepPrevious does not keep an empty list", async () => {
      stubFetch((url) => (url.endsWith("/2") ? new Promise<Response>(() => {}) : json([])));
      const { result, rerender } = renderHook(({ path }) => useLoad<string[]>(path, { keepPrevious: true }), { initialProps: { path: "/1" } });
      await advance();
      expect(result.current.data).toEqual([]);
      rerender({ path: "/2" });
      await advance();
      expect(result.current.data).toBeNull();
    });

    it("keepPrevious keeps nothing for a null path", async () => {
      stubFetch(() => json(["one"]));
      const { result, rerender } = renderHook(({ path }: { path: string | null }) => useLoad<string[]>(path, { keepPrevious: true }), { initialProps: { path: "/1" as string | null } });
      await advance();
      rerender({ path: null });
      expect(result.current.data).toBeNull();
    });
  });

  describe("4: a person's data does not outlive them", () => {
    let last: Loaded<string[]>;
    const Probe = () => {
      last = useLoad<string[]>("/mine");
      return null;
    };

    it("a different person gets their own answer inside the dedupe window", async () => {
      let answer = "first";
      const fetchMock = stubFetch(() => json([answer]));
      const { rerender } = render(<ViewerProvider viewer={person(1)}><Probe /></ViewerProvider>);
      await advance();
      expect(last.data).toEqual(["first"]);
      answer = "second";
      rerender(<ViewerProvider viewer={person(2)}><Probe /></ViewerProvider>);
      await advance();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(last.data).toEqual(["second"]);
    });

    it("signing out clears, and a page opened later starts empty", async () => {
      let answer = "first";
      stubFetch(() => json([answer]));
      const { rerender } = render(<ViewerProvider viewer={person(1)}><Probe /></ViewerProvider>);
      await advance();
      rerender(<ViewerProvider viewer={null}><div /></ViewerProvider>);
      await advance();
      answer = "second";
      const seen: (string[] | null)[] = [];
      const Recording = () => {
        seen.push(useLoad<string[]>("/mine").data);
        return null;
      };
      rerender(<ViewerProvider viewer={null}><Recording /></ViewerProvider>);
      await advance();
      expect(seen).not.toContainEqual(["first"]);
      expect(seen.at(-1)).toEqual(["second"]);
    });

    it("an answer still in flight for the previous person is dropped", async () => {
      let release: (r: Response) => void = () => {};
      let calls = 0;
      stubFetch(() => (++calls === 1 ? new Promise<Response>((r) => { release = r; }) : json(["second"])));
      const { rerender } = render(<ViewerProvider viewer={person(1)}><Probe /></ViewerProvider>);
      await advance();
      rerender(<ViewerProvider viewer={person(2)}><Probe /></ViewerProvider>);
      await advance();
      release(json(["first"]));
      await advance();
      expect(last.data).toEqual(["second"]);
    });

    it.each([false, true])("the next person never sees the last person's rows on a mounted page (keepPrevious %s)", async (keepPrevious) => {
      let calls = 0;
      stubFetch(() => (++calls === 1 ? json(["first"]) : new Promise<Response>(() => {})));
      const painted: (string[] | null)[] = [];
      const Painted = () => {
        const { data } = useLoad<string[]>("/mine", { keepPrevious });
        useEffect(() => { painted.push(data); });
        return null;
      };
      const { rerender } = render(<ViewerProvider viewer={person(1)}><Painted /></ViewerProvider>);
      await advance();
      expect(painted.at(-1)).toEqual(["first"]);
      rerender(<ViewerProvider viewer={person(2)}><Painted /></ViewerProvider>);
      await advance();
      expect(painted.at(-1)).toBeNull();
    });

    it("moving from session loading to a person does not fetch twice", async () => {
      const fetchMock = stubFetch(() => json(["row"]));
      const { rerender } = render(<ViewerProvider viewer={null}><Probe /></ViewerProvider>);
      await advance();
      rerender(<ViewerProvider viewer={person(1)}><Probe /></ViewerProvider>);
      await advance();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("5: an emptied cache gives the next render its own answer", async () => {
    let answer = "first";
    stubFetch(() => json([answer]));
    const one = renderHook(() => useLoad<string[]>("/x"));
    await advance();
    expect(one.result.current.data).toEqual(["first"]);
    one.unmount();
    clearLoads();
    answer = "second";
    const two = renderHook(() => useLoad<string[]>("/x"));
    await advance();
    expect(two.result.current.data).toEqual(["second"]);
  });
});

describe("a write re-reads cached loads", () => {
  const server = () => {
    let version = 1;
    const fetchMock = stubFetch((_url, init) => {
      if (init?.method === "POST") {
        version += 1;
        return json({});
      }
      if (init?.method === "PUT") return json({ error: "No" }, 400);
      return json([version]);
    });
    return fetchMock;
  };

  it("a mounted key refetches after a successful write", async () => {
    const fetchMock = server();
    const { result } = renderHook(() => useLoad<number[]>("/x"));
    await advance();
    await api("/y", { method: "POST" });
    await advance();
    expect(gets(fetchMock)).toBe(2);
    expect(result.current.data).toEqual([2]);
  });

  it("a key with no mounted page refetches when next opened, inside the dedupe window", async () => {
    const fetchMock = server();
    const first = renderHook(() => useLoad<number[]>("/x"));
    await advance();
    first.unmount();
    await api("/y", { method: "POST" });
    await advance();
    expect(gets(fetchMock)).toBe(1);
    const second = renderHook(() => useLoad<number[]>("/x"));
    await advance();
    expect(gets(fetchMock)).toBe(2);
    expect(second.result.current.data).toEqual([2]);
  });

  it("with no write, reopening inside the dedupe window does not refetch", async () => {
    const fetchMock = server();
    renderHook(() => useLoad<number[]>("/x")).unmount();
    await advance();
    const again = renderHook(() => useLoad<number[]>("/x"));
    await advance();
    expect(gets(fetchMock)).toBe(1);
    expect(again.result.current.data).toEqual([1]);
  });

  it("a failed write and a GET re-read nothing", async () => {
    const fetchMock = server();
    renderHook(() => useLoad<number[]>("/x"));
    await advance();
    await expect(api("/y", { method: "PUT" })).rejects.toThrow("No");
    await api("/other");
    await advance();
    expect(gets(fetchMock)).toBe(2);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/things/x")).toHaveLength(1);
  });

  it("invalidate: false re-reads nothing", async () => {
    const fetchMock = server();
    renderHook(() => useLoad<number[]>("/x"));
    await advance();
    await api("/y", { method: "POST", invalidate: false });
    await advance();
    expect(gets(fetchMock)).toBe(1);
  });
});

describe("the promise from reload", () => {
  it("settles only after the fresh answer has arrived", async () => {
    let finish: (answer: Response) => void = () => {};
    let reads = 0;
    stubFetch(() => {
      reads += 1;
      return reads === 1 ? json({ n: 1 }) : new Promise<Response>((resolve) => { finish = resolve; });
    });
    const { result } = renderHook(() => useLoad<{ n: number }>("/reload-fresh"));
    await advance(0);

    let settled = false;
    void result.current.reload().then(() => { settled = true; });
    await advance(0);
    expect(settled).toBe(false);

    finish(json({ n: 2 }));
    await advance(0);
    expect(settled).toBe(true);
    expect(result.current.data).toEqual({ n: 2 });
  });

  it("settles without rejecting on a failed load, whose message lands in error", async () => {
    let reads = 0;
    stubFetch(() => {
      reads += 1;
      return reads === 1 ? json({ n: 1 }) : json({ error: "No such thing" }, 404);
    });
    const { result } = renderHook(() => useLoad<{ n: number }>("/reload-failed"));
    await advance(0);

    let outcome = "pending";
    void result.current.reload().then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
    await advance(0);
    expect(outcome).toBe("resolved");
    expect(result.current.error).toBe("No such thing");
  });
});
