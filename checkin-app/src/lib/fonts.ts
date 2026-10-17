/**
 * Font loading for the Innovation Treehouse brand (Next.js App Router).
 *   Fredoka    → headings / brand wordmark (SIL OFL)
 *   Nunito     → body / UI text (SIL OFL)
 *   Space Mono → IDs, codes, mono accents (SIL OFL)
 *
 * Vendored under ./fonts/ and served via next/font/local: a build must never
 * depend on fonts.gstatic.com being up or Google keeping old file URLs alive
 * (they 404'd the pinned Fredoka files and broke the v1.1.2 prod build).
 * Latin subset only, matching the previous next/font/google config.
 * Put `fontVariables` on <html> (see layout.tsx).
 */
import localFont from 'next/font/local';

export const fredoka = localFont({
  src: './fonts/fredoka-latin-var.woff2',
  weight: '300 700',
  variable: '--font-fredoka',
  display: 'swap',
});

export const nunito = localFont({
  src: './fonts/nunito-latin-var.woff2',
  weight: '200 1000',
  variable: '--font-nunito',
  display: 'swap',
});

export const spaceMono = localFont({
  src: [
    { path: './fonts/space-mono-latin-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/space-mono-latin-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-space-mono',
  display: 'swap',
});

/** Join all font variable classes for the <body> className. */
export const fontVariables = `${fredoka.variable} ${nunito.variable} ${spaceMono.variable}`;
