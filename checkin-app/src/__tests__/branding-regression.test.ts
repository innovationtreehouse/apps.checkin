import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), 'utf8');

/**
 * Source-level guards for two wiring/config faults that jsdom can't reproduce
 * (one is a CSS custom-property scope issue, the other a CLI runner choice).
 */
describe('branding & seed wiring', () => {
  /**
   * The next/font CSS variables (--font-fredoka/-nunito/-space-mono) must live on <html>,
   * the same scope where MantineProvider declares --mantine-font-family: var(--font-nunito).
   * On <body>, those vars are undefined at :root, every font-family resolves to an invalid
   * var(), and the whole document falls back to the UA default serif.
   */
  it('applies brand.fontVariables to <html>, not <body>', () => {
    const layout = read('src', 'app', 'layout.tsx');
    const htmlTag = layout.match(/<html[^>]*>/)?.[0] ?? '';
    const bodyTag = layout.match(/<body[^>]*>/)?.[0] ?? '';

    expect(htmlTag).toMatch(/className=\{brand\.fontVariables\}/);
    expect(bodyTag).not.toMatch(/fontVariables/);
  });

  /**
   * The prisma seed must run via tsx. main's modern `prisma-client` generator emits an ESM
   * client that ts-node (even with module=CommonJS) can't load — `prisma db seed` failed with
   * "exports is not defined in ES module scope". prisma.config.ts is authoritative in Prisma 7.
   */
  it('runs the prisma seed via tsx, not ts-node', () => {
    const prismaConfig = read('prisma.config.ts');
    expect(prismaConfig).toMatch(/seed:\s*["'`]tsx /);
    expect(prismaConfig).not.toMatch(/ts-node/);

    const pkg = JSON.parse(read('package.json'));
    expect(pkg.prisma?.seed ?? '').toMatch(/\btsx\b/);
    expect(pkg.prisma?.seed ?? '').not.toMatch(/ts-node/);
  });
});
