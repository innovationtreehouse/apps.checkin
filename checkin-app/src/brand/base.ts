import { createTheme, rem } from '@mantine/core';
import type { Brand } from './types';

/**
 * Base, brand-agnostic theme: shape scale + component behaviors only — no palette, no
 * fonts, no wordmark. Brands extend this (see treehouse.ts) via mergeThemeOverrides, so
 * these structural defaults are inherited by every brand.
 */
export const baseTheme = createTheme({
  defaultRadius: 'md',
  radius: { xs: rem(8), sm: rem(10), md: rem(12), lg: rem(16), xl: rem(22) },

  components: {
    Button:     { defaultProps: { radius: 'xl' } },   // pill buttons
    Badge:      { defaultProps: { radius: 'xl' } },
    Card:       { defaultProps: { radius: 'lg', withBorder: true, shadow: 'sm', padding: 'lg' } },
    Paper:      { defaultProps: { radius: 'lg' } },
    ActionIcon: { defaultProps: { radius: 'xl' } },
    TextInput:  { defaultProps: { radius: 'md' } },
    // scrollAreaProps: a long option list shows its scrollbar whenever it overflows;
    // Mantine's default ('scroll') hides it until the first scroll event.
    Select:     { defaultProps: { radius: 'md', scrollAreaProps: { type: 'auto' } } },
    Textarea:   { defaultProps: { radius: 'md' } },
  },
});

/** The unbranded CheckMeIn app: stock Mantine palette + system fonts, text wordmark. */
export const baseBrand: Brand = {
  id: 'base',
  appName: 'CheckMeIn',
  home: { title: 'CheckMeIn', subtitle: 'the program and attendance system for your community' },
  theme: baseTheme,
  fontVariables: '',
  logo: null,
  nav: { accent: 'blue' }, // stock Mantine primary; no colored sidebar
};
