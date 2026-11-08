import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clampPage, hrefWith, readPage, useSetUrlFilters, useUrlChoice, useUrlFilter, useUrlPage } from "./urlState";

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  push: vi.fn<(href: string, options?: { scroll?: boolean }) => void>(),
  replace: vi.fn<(href: string, options?: { scroll?: boolean }) => void>(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => "/donations/transactions",
  useSearchParams: () => nav.search,
}));

beforeEach(() => {
  nav.search = new URLSearchParams();
  nav.push.mockClear();
  nav.replace.mockClear();
});

const at = (query: string) => {
  nav.search = new URLSearchParams(query);
};

describe("readPage", () => {
  it.each([
    ["", 1],
    ["page=3", 3],
    ["page=abc", 1],
    ["page=0", 1],
    ["page=-2", 1],
    ["page=2.5", 1],
    ["page=", 1],
  ])("reads %j as page %i", (query, page) => {
    expect(readPage(new URLSearchParams(query))).toBe(page);
  });

  it("is page 1 with no params at all", () => {
    expect(readPage(null)).toBe(1);
  });
});

describe("clampPage", () => {
  it("holds a page past the end to the last page", () => {
    expect(clampPage(9, 3)).toBe(3);
  });

  it("leaves a page in range alone", () => {
    expect(clampPage(2, 3)).toBe(2);
  });

  it("leaves the page alone while the total is unknown", () => {
    expect(clampPage(9, null)).toBe(9);
    expect(clampPage(9, undefined)).toBe(9);
  });

  it("never clamps below page 1 for an empty list", () => {
    expect(clampPage(4, 0)).toBe(1);
  });
});

describe("hrefWith", () => {
  it("keeps the other keys and removes a null or empty value", () => {
    const params = new URLSearchParams("view=all&page=2&q=x");
    expect(hrefWith("/x", params, { page: null, view: "open", sort: "" })).toBe("/x?view=open&q=x");
  });

  it("leaves a bare path when nothing is left", () => {
    expect(hrefWith("/x", new URLSearchParams("page=2"), { page: null })).toBe("/x");
  });
});

describe("useUrlPage", () => {
  it("reads the page from the URL", () => {
    at("assigned=false&page=4");
    const { result } = renderHook(() => useUrlPage());
    expect(result.current[0]).toBe(4);
  });

  it("falls back to page 1 for a bad page", () => {
    at("page=nope");
    const { result } = renderHook(() => useUrlPage());
    expect(result.current[0]).toBe(1);
  });

  it("shows the last page for a page past the end of a list with a total", () => {
    at("page=9");
    const { result } = renderHook(() => useUrlPage(3));
    expect(result.current[0]).toBe(3);
  });

  it("keeps a page past the end of a list without a total", () => {
    at("page=9");
    const { result } = renderHook(() => useUrlPage());
    expect(result.current[0]).toBe(9);
  });

  it("pushes a page change, keeping the filters", () => {
    at("assigned=false&page=2");
    const { result } = renderHook(() => useUrlPage());
    act(() => result.current[1](3));
    expect(nav.push).toHaveBeenCalledWith("/donations/transactions?assigned=false&page=3", { scroll: false });
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("drops page from the URL for page 1", () => {
    at("assigned=false&page=2");
    const { result } = renderHook(() => useUrlPage());
    act(() => result.current[1](1));
    expect(nav.push).toHaveBeenCalledWith("/donations/transactions?assigned=false", { scroll: false });
  });
});

describe("useSetUrlFilters", () => {
  it("replaces the entry with every key at once and resets the page", () => {
    at("from=2026-01-01&page=5");
    const { result } = renderHook(() => useSetUrlFilters());
    act(() => result.current({ from: "2026-02-01", to: "2026-03-01" }));
    expect(nav.replace).toHaveBeenCalledWith("/donations/transactions?from=2026-02-01&to=2026-03-01", { scroll: false });
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe("useUrlFilter", () => {
  it("reads the filter from the URL, or the fallback", () => {
    at("person=12");
    expect(renderHook(() => useUrlFilter("person")).result.current[0]).toBe("12");
    expect(renderHook(() => useUrlFilter("kind", "any")).result.current[0]).toBe("any");
  });

  it("replaces on change and drops the page", () => {
    at("person=12&page=3");
    const { result } = renderHook(() => useUrlFilter("person"));
    act(() => result.current[1]("40"));
    expect(nav.replace).toHaveBeenCalledWith("/donations/transactions?person=40", { scroll: false });
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("removes the key when set back to the fallback", () => {
    at("person=12&page=3");
    const { result } = renderHook(() => useUrlFilter("person"));
    act(() => result.current[1](""));
    expect(nav.replace).toHaveBeenCalledWith("/donations/transactions", { scroll: false });
  });
});

describe("useUrlChoice", () => {
  const CHOICES = ["all", "true", "false"] as const;

  it("reads a known choice from the URL", () => {
    at("assigned=false");
    expect(renderHook(() => useUrlChoice("assigned", CHOICES, "all")).result.current[0]).toBe("false");
  });

  it("falls back for an unknown choice", () => {
    at("assigned=maybe");
    expect(renderHook(() => useUrlChoice("assigned", CHOICES, "all")).result.current[0]).toBe("all");
  });

  it("replaces on change, drops the page, and removes the key for the fallback", () => {
    at("assigned=true&page=2");
    const { result } = renderHook(() => useUrlChoice("assigned", CHOICES, "all"));
    act(() => result.current[1]("false"));
    expect(nav.replace).toHaveBeenLastCalledWith("/donations/transactions?assigned=false", { scroll: false });
    act(() => result.current[1]("all"));
    expect(nav.replace).toHaveBeenLastCalledWith("/donations/transactions", { scroll: false });
  });

  it("sets the fallback for a value that is not a choice", () => {
    at("assigned=true");
    const { result } = renderHook(() => useUrlChoice("assigned", CHOICES, "all"));
    act(() => result.current[1]("maybe"));
    expect(nav.replace).toHaveBeenLastCalledWith("/donations/transactions", { scroll: false });
  });
});
