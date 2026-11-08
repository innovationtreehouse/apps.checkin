"use client";

import { useEffect } from "react";

/**
 * Mantine disables a button while it loads, and the browser then drops focus from it to the body
 * without firing an event, so Tab would walk the page behind an open modal. When the focused
 * element becomes disabled inside a dialog, focus moves to that dialog. The observer runs before
 * the browser drops focus, so `activeElement` is still the disabled element.
 */
export default function DialogFocusGuard() {
  useEffect(() => {
    const observer = new MutationObserver((records) => {
      const focused = document.activeElement;
      if (!focused?.hasAttribute("disabled")) return;
      if (!records.some((record) => record.target === focused)) return;
      focused.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ["disabled"], subtree: true });
    return () => observer.disconnect();
  }, []);
  return null;
}
