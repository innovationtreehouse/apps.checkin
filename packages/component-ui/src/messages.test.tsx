import { act, render } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Notifications, notifications, notificationsStore } from "@mantine/notifications";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearError, showError, showSuccess } from "./index";

const shown = () => notificationsStore.getState().notifications;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  render(<MantineProvider><Notifications /></MantineProvider>);
});

afterEach(() => {
  act(() => notifications.clean());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe("showSuccess", () => {
  it("goes away by itself and does not interrupt a screen reader", () => {
    act(() => showSuccess("Saved"));
    expect(shown()).toMatchObject([{ message: "Saved", color: "green", role: "status" }]);
    wait(5000);
    expect(shown()).toEqual([]);
  });
});

describe("showError", () => {
  it("stays until dismissed, with the alert role and a close button", () => {
    act(() => showError("Couldn't save"));
    wait(60_000);
    expect(shown()).toMatchObject([{ message: "Couldn't save", color: "red" }]);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't save");
    const close = document.querySelector<HTMLButtonElement>('[role="alert"] button');
    act(() => close?.click());
    expect(shown()).toEqual([]);
  });

  it("collapses identical errors into one", () => {
    act(() => {
      showError("Network error");
      showError("Network error");
    });
    expect(shown()).toHaveLength(1);
  });

  it("keeps different errors apart", () => {
    act(() => {
      showError("One");
      showError("Two");
    });
    expect(shown().map((n) => n.message)).toEqual(["One", "Two"]);
  });

  it("replaces the message under the same key, in place", () => {
    act(() => {
      showError("First try failed", { key: "save" });
      showError("Other", { key: "other" });
      showError("Second try failed", { key: "save", title: "Save" });
    });
    expect(shown()).toMatchObject([{ id: "save", message: "Second try failed", title: "Save" }, { id: "other" }]);
  });

  it("shows again after the person dismissed it", () => {
    act(() => showError("Network error"));
    act(() => notifications.hide("Network error"));
    act(() => showError("Network error"));
    expect(shown()).toHaveLength(1);
  });
});

describe("clearError", () => {
  it("removes only the error under that key", () => {
    act(() => {
      showError("Couldn't save", { key: "save" });
      showError("Couldn't send", { key: "send" });
      clearError("save");
    });
    expect(shown().map((n) => n.id)).toEqual(["send"]);
  });

  it("does nothing when no error stands under the key", () => {
    act(() => clearError("save"));
    expect(shown()).toEqual([]);
  });
});
