import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOG_SEARCH_DEBOUNCE_MS, CatalogPicker, catalogSearchTerm, useCatalogSearch, type CatalogItem } from "./catalogPicker";

const item = (gtin13: string, name: string): CatalogItem => ({ gtin13, name, category: { name: "Hardware" }, subcategory: { name: "Bolts" } });

/** Each search's answer, settled by the test; keyed by the `q` the hook sent. */
const pending = new Map<string, (res: { status: number; body: unknown }) => void>();

function answer(q: string, body: unknown, status = 200) {
  const settle = pending.get(q);
  if (!settle) throw new Error(`no search sent for "${q}"`);
  return act(async () => { settle({ status, body }); });
}

const wait = (ms = CATALOG_SEARCH_DEBOUNCE_MS) => act(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  pending.clear();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", (url: string) => {
    const q = new URL(url, "http://test").searchParams.get("q") ?? "";
    return new Promise((resolve) => {
      pending.set(q, ({ status, body }) => resolve({ ok: status < 400, status, text: async () => JSON.stringify(body) }));
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("catalogSearchTerm", () => {
  it.each(["", " ", "a", " b "])("gives no search term for %j", (q) => {
    expect(catalogSearchTerm(q)).toBeNull();
  });

  it("trims a long enough query", () => {
    expect(catalogSearchTerm("  drill ")).toBe("drill");
  });
});

describe("useCatalogSearch", () => {
  it("sends one search once typing pauses, and is searching until it answers", async () => {
    const { result, rerender } = renderHook(({ q }) => useCatalogSearch(q), { initialProps: { q: "" } });
    rerender({ q: "dr" });
    rerender({ q: "dri" });
    rerender({ q: "drill" });
    expect(result.current).toMatchObject({ searching: true, answered: false });
    expect(pending.size).toBe(0);

    await wait();
    expect([...pending.keys()]).toEqual(["drill"]);
    await answer("drill", [item("4006381333931", "Drill")]);

    expect(result.current).toMatchObject({ searching: false, answered: true, error: null, items: [{ name: "Drill" }] });
  });

  it("drops an older search that answers after a newer one", async () => {
    const { result, rerender } = renderHook(({ q }) => useCatalogSearch(q), { initialProps: { q: "" } });
    rerender({ q: "bolt" });
    await wait();
    rerender({ q: "bolts" });
    await wait();
    await answer("bolts", [item("4006381333931", "Bolts M6")]);
    await answer("bolt", [item("0012345678905", "Old bolt")]);

    expect(result.current.items.map((i) => i.name)).toEqual(["Bolts M6"]);
  });

  it("reports an empty answer and a failed search", async () => {
    const { result, rerender } = renderHook(({ q }) => useCatalogSearch(q), { initialProps: { q: "" } });
    rerender({ q: "nothing" });
    await wait();
    await answer("nothing", []);
    expect(result.current).toMatchObject({ answered: true, items: [], error: null });

    rerender({ q: "broken" });
    await wait();
    await answer("broken", { error: "Catalog unavailable" }, 503);
    expect(result.current).toMatchObject({ answered: true, items: [], error: "Catalog unavailable" });
  });

  it("does not search under the minimum length", async () => {
    const { result } = renderHook(() => useCatalogSearch("a"));
    await wait();
    expect(pending.size).toBe(0);
    expect(result.current).toMatchObject({ searching: false, answered: false });
  });
});

describe("CatalogPicker", () => {
  function typeInto(text: string) {
    render(<MantineProvider><CatalogPicker label="Part" value={null} onChange={() => {}} /></MantineProvider>);
    const input = screen.getByRole("textbox", { name: "Part" });
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: text } });
  }

  it("asks for more characters under the minimum", async () => {
    typeInto("a");
    await wait();
    expect(screen.getByText("Type at least 2 characters")).toBeTruthy();
  });

  it("shows a loader while searching, then that nothing matched", async () => {
    typeInto("zzz");
    expect(screen.getByLabelText("Searching the catalog")).toBeTruthy();
    await wait();
    await answer("zzz", []);
    expect(screen.queryByLabelText("Searching the catalog")).toBeNull();
    expect(screen.getByText("No matching part")).toBeTruthy();
  });

  it("shows why a search failed", async () => {
    typeInto("broken");
    await wait();
    await answer("broken", { error: "Catalog unavailable" }, 503);
    expect(screen.getByText("Couldn't search the catalog: Catalog unavailable")).toBeTruthy();
  });

  it("offers a provisional part typed by its P number", async () => {
    typeInto("P000123");
    await wait();
    await answer("P000123", []);
    expect(screen.getByText("P000123 (provisional part)")).toBeTruthy();
  });
});
