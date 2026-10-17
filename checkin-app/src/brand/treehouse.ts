import { createTheme, type MantineColorsTuple } from '@mantine/core';
import type { Brand } from './types';
import { baseBrand, baseTheme } from './base';
import { fontVariables } from '@/lib/fonts';

// Brand green — the house. Index 6 = #78B858 (sampled from the logo).
const treehouseGreen: MantineColorsTuple = [
  '#f1f8ec', '#ddeecf', '#c3e0a9', '#a4d07f', '#8cc466',
  '#84bf5e', // 5  ← primaryShade (dark)
  '#78b858', // 6  ← brand / primaryShade (light)
  '#5fa343', '#4a8334', '#3a6629',
];

// Brand purple — the circuit-tree & wordmark. Index 6 = #6E4A98.
const treehousePurple: MantineColorsTuple = [
  '#f4eff9', '#e6d9f0', '#cdb6e1', '#ad8ccd', '#8e66b6',
  '#7d57a8',
  '#6e4a98', // 6  ← brand
  '#5e3d84', '#4c3169', '#3a2651',
];

/**
 * Innovation Treehouse — a specialization of the base app. Extends baseTheme (shapes +
 * component behaviors) with the brand palette and fonts. The lowercase wordmark style is
 * applied per-instance (tt="lowercase") where the app name renders, not globally to all
 * headings. Auto light/dark is retained; primaryShade is tuned per scheme.
 *
 * NOTE: this module is imported by the server-side root layout, so the theme must be built
 * with createTheme alone — mergeThemeOverrides is a client-only Mantine export and throws if
 * called during server module evaluation. baseTheme only sets defaultRadius/radius/components,
 * so spreading it and merging `components` explicitly is an exact equivalent of the deep merge.
 */
export const treehouseBrand: Brand = {
  ...baseBrand,
  id: 'treehouse',
  appName: 'CheckMeIn',
  home: { title: 'Innovation Treehouse Operations', subtitle: 'the program and attendance system for our community' },
  fontVariables,
  // Trademarked brand collateral — see /TRADEMARKS.md. The source-code license does NOT grant
  // a license to use the Innovation Treehouse logo/marks; replace when reusing for another org.
  logo: { src: '/brand/treehouse-logo-full.webp', width: 84, height: 40, alt: 'Innovation Treehouse' },
  nav: { accent: 'treehouseGreen', sidebar: 'treehousePurple.9' },
  theme: createTheme({
    ...baseTheme,
    colors: { treehouseGreen, treehousePurple },
    primaryColor: 'treehouseGreen',
    primaryShade: { light: 6, dark: 5 },

    // Brand green (#78B858, L≈0.39) is too light to carry white text — white-on-green is
    // only ~2.4:1, below WCAG AA. autoContrast lets Mantine pick a dark label per button bg;
    // `black` makes that dark a soft near-black (not harsh #000). Dark-on-green ≈ 7.2:1.
    autoContrast: true,
    black: '#1a1b1e',

    fontFamily: 'var(--font-nunito), system-ui, -apple-system, "Segoe UI", sans-serif',
    fontFamilyMonospace: 'var(--font-space-mono), ui-monospace, SFMono-Regular, Menlo, monospace',
    headings: {
      fontFamily: 'var(--font-fredoka), var(--font-nunito), "Trebuchet MS", system-ui, sans-serif',
      fontWeight: '600',
    },
  }),
};
