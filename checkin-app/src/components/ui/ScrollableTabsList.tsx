"use client";

import { ScrollArea, Tabs } from "@mantine/core";
import type { MantineSpacing, StyleProp } from "@mantine/core";

type TabsListProps = React.ComponentProps<typeof Tabs.List>;

interface ScrollableTabsListProps extends TabsListProps {
  /** Bottom margin for the whole tab bar (applied to the scroll wrapper, not the inner list). */
  mb?: StyleProp<MantineSpacing>;
}

/**
 * Drop-in replacement for `<Tabs.List>` that scrolls horizontally on narrow
 * screens instead of wrapping into several cramped rows. On wide screens it
 * behaves exactly like a normal tab bar (no scrollbar, full-width underline).
 *
 * Use it anywhere inside `<Tabs>` where `<Tabs.List>` would go.
 */
export function ScrollableTabsList({ children, style, mb, ...props }: ScrollableTabsListProps) {
  return (
    <ScrollArea type="auto" scrollbarSize={6} mb={mb}>
      {/*
        min-width: max-content is what actually makes this scroll. nowrap alone only
        stops wrapping — the flex row still shrinks to the ScrollArea's width, and the
        first thing to collapse is the count Badge, whose `overflow: hidden` zeroes its
        automatic minimum size (labels have `white-space: nowrap` and keep their
        min-content floor), leaving empty tab pills on narrow screens. With max-content
        the row overflows and the ScrollArea scrolls instead.
      */}
      <Tabs.List style={{ flexWrap: "nowrap", minWidth: "max-content", ...style }} {...props}>
        {children}
      </Tabs.List>
    </ScrollArea>
  );
}
