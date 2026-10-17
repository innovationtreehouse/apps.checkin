/**
 * Shared Lambda bundler for the *-function workspaces.
 *
 * Run from a function directory (the workspace's own `build` script does this):
 *
 *     node ../scripts/bundle-function.mjs
 *
 * It bundles `src/handler.ts` -> `dist/handler.js` with esbuild, inlining all
 * reachable workspace source (@checkin/*, the generated Prisma client, zod, ...)
 * and leaving ONLY the shared Prisma runtime + the AWS SDK as external imports.
 *
 * Why those are external:
 *   - @prisma/client / @prisma/adapter-pg / pg  -> provided by the prisma-runtime
 *     Lambda layer at /opt/nodejs/node_modules (one layer shared by all functions).
 *     The generated client is version-locked to @prisma/client, so the layer MUST
 *     pin the exact same version used at `prisma generate` time.
 *   - @aws-sdk/*  -> provided by the Lambda Node runtime.
 *
 * The build FAILS if the bundle ends up depending on any bare module outside that
 * allow-list — that means something that should have been bundled leaked out, or a
 * new heavy dep needs an explicit decision (bundle vs. layer).
 */
import * as esbuild from "esbuild";
import { rmSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { builtinModules } from "node:module";

const cwd = process.cwd();
const fnName = basename(cwd);
const entry = resolve(cwd, "src/handler.ts");
// CJS output (dist/handler.js): Lambda exposes a layer ONLY via NODE_PATH, and Node's
// ESM loader ignores NODE_PATH — so an ESM bundle's external `@prisma/*` imports fail to
// resolve from the layer at runtime. CJS `require` honours NODE_PATH, and @prisma/client's
// exports map serves a `require` (.js) condition. Lambda handler ref: "handler.handler".
const outfile = resolve(cwd, "dist/handler.js");

// Modules intentionally NOT bundled. Everything else must be inlined.
// The `/*` forms matter: the Prisma 7 generated client imports deep subpaths of
// @prisma/client (the runtime + the WASM query compiler), which esbuild treats as
// distinct specifiers from the bare package name.
const LAYER_EXTERNALS = [
  "@prisma/client",
  "@prisma/client/*",
  "@prisma/adapter-pg",
  "@prisma/adapter-pg/*",
  "pg",
  "pg-native",
];
const RUNTIME_EXTERNALS = ["@aws-sdk/*"];
const EXTERNAL = [...LAYER_EXTERNALS, ...RUNTIME_EXTERNALS];

// Allow-list for the import-leak check (node builtins are always fine).
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);
const allowedExternal = (spec) =>
  spec.startsWith("node:") ||
  nodeBuiltins.has(spec) ||
  spec === "pg" ||
  spec === "pg-native" ||
  spec.startsWith("@prisma/client") || // bare + runtime/WASM subpaths (from the layer)
  spec.startsWith("@prisma/adapter-pg") ||
  spec.startsWith("@aws-sdk/"); // Lambda Node runtime

rmSync(resolve(cwd, "dist"), { recursive: true, force: true });

const result = await esbuild.build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  // node22: the externalized Prisma WASM query compiler is shipped as .mjs, so the CJS
  // bundle require()s an ESM file — unflagged from Node 22. Deploy on nodejs22.x.
  target: "node22",
  minify: true,
  sourcemap: "external",
  legalComments: "none",
  logLevel: "info",
  external: EXTERNAL,
  // The generated Prisma client (ESM source) reads `import.meta.url`, which is undefined
  // in a CJS bundle -> fileURLToPath(undefined) throws at load. Shim it to this file's URL.
  define: { "import.meta.url": "__importMetaUrl" },
  banner: {
    js: "const __importMetaUrl=require('url').pathToFileURL(__filename).href;",
  },
  metafile: true,
});

// --- Leak check: every bare external the bundle still imports must be allow-listed.
const out = result.metafile.outputs[Object.keys(result.metafile.outputs).find((f) => f.endsWith("handler.js"))];
const externals = new Set(
  (out?.imports ?? [])
    .filter((i) => i.external)
    .map((i) => i.path)
    .filter((p) => !p.startsWith(".") && !p.startsWith("/")),
);
const stray = [...externals].filter((spec) => !allowedExternal(spec));

const sizeKB = (statSync(outfile).size / 1024).toFixed(1);
console.log(`\n[${fnName}] bundled -> dist/handler.js  (${sizeKB} KB)`);
if (externals.size) {
  console.log(`[${fnName}] external (resolved from layer/runtime): ${[...externals].sort().join(", ")}`);
}

if (stray.length) {
  console.error(
    `\n✗ [${fnName}] bundle leaked unexpected external import(s): ${stray.join(", ")}\n` +
      `  Either bundle them (remove from external) or add them to the layer + allow-list.`,
  );
  process.exit(1);
}
console.log(`✓ [${fnName}] no stray externals — all bare imports map to the prisma layer or Node runtime.`);
