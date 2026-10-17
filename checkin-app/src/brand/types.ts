import type { MantineThemeOverride } from '@mantine/core';

/**
 * A Brand is a *specialization* of the base CheckMeIn app: it supplies palette, fonts,
 * logo, wordmark and nav styling, layered on top of the brand-agnostic base (shapes +
 * component behaviors). The app reads the active `brand` (src/brand) and nothing in the
 * pages/components hardcodes a brand — adding an org is one new Brand object.
 *
 * Note: regulated values (the Shop-Safety tool-cert colors in components/ToolLevelBadge)
 * intentionally live in the base/domain layer and are NOT brandable.
 */
export interface Brand {
  /** Stable id; also emitted as `data-brand` on <body> for any brand-scoped CSS. */
  id: string;
  /** Wordmark text, shown when there is no `logo`. */
  appName: string;
  /** Home page hero copy. Kept per-brand so the base/unbranded build carries no trademark. */
  home: { title: string; subtitle: string };
  /** Mantine theme — base structural theme extended per brand via mergeThemeOverrides. */
  theme: MantineThemeOverride;
  /** className exposing the brand's --font-* CSS vars on <body>; '' = system fonts. */
  fontVariables: string;
  /** Header logo; `null` → render the `appName` wordmark instead. */
  logo: { src: string; width: number; height: number; alt: string } | null;
  /** Sidebar nav styling. `sidebar` set ⇒ colored sidebar with white nav + filled active pills. */
  nav: { accent: string; sidebar?: string };
}
