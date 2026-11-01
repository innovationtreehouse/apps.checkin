import { Box } from "@mantine/core";

// Canonical page wrapper: same left indent + top position for every top-level
// page/tab layout, so tabs and headings don't "dance" when navigating between
// sections. marginTop -8 trims half the AppShell md padding (16px) while
// leaving tab bars clear of the fixed 60px header (z-index 200). A negative
// value here must never exceed the AppShell's md padding, or content slides up
// behind the header and clips the tab bars. paddingLeft adds a small indent past
// the content edge.
export function PageContainer({ children }: { children: React.ReactNode }) {
  return (
    <Box style={{ maxWidth: 1200, margin: "0 auto", marginTop: -8, paddingLeft: 8, display: "flow-root" }}>
      {children}
    </Box>
  );
}
