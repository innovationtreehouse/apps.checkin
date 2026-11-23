import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Bare error logs regress silently: console.error(err) and .catch(console.error)
// emit a stack with no stable context prefix, so grepping prod logs for a
// failure site turns up nothing. Require a literal prefix string —
// console.error("Failed to X:", err) passes. Shared so the api-routes block
// (which replaces, not merges, this rule for its files) stays a superset.
const bareConsoleErrorRules = [
  {
    selector:
      "CallExpression[callee.object.name='console'][callee.property.name='error'][arguments.length=1][arguments.0.type='Identifier']",
    message:
      'Do not log a bare error — add a stable context prefix: console.error("Failed to X:", err).',
  },
  {
    selector:
      "CallExpression[callee.property.name='catch'][arguments.0.object.name='console'][arguments.0.property.name='error']",
    message:
      'Do not pass console.error as a handler — wrap it: .catch((err) => console.error("Failed to X:", err)).',
  },
];

// Every deployed instance — prod, cloud-dev, ops-stg — runs the same production
// image, so NODE_ENV is 'production' everywhere and cannot tell them apart.
// CHECKIN_ENV is the only fuse. Shared for the same replace-not-merge reason as
// bareConsoleErrorRules.
const nodeEnvRules = [
  {
    selector:
      "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='NODE_ENV']",
    message:
      "Environment branches gate on config.checkinEnv(), never NODE_ENV — every deployed instance runs the same production image. (Test-harness plumbing in src/lib/prisma.ts is the only exception.)",
  },
];

// The lifecycle modules are imported by client components, so a Prisma VALUE
// reaching them drags the generated client into a page bundle. Types are erased
// at build, so `import type` stays legal. The regex covers the `@/` alias and any
// relative path to the same directory.
const noPrismaValueImport = [
  {
    regex: "(^@/|/)generated/prisma(/|$)",
    message:
      "Client-safe module: use `import type` for @/generated/prisma — a value import pulls the Prisma client into the page bundle.",
    allowTypeImports: true,
  },
];

// A page's role gate comes from its nav section module, so the page and the nav
// cannot drift. An empty list is the plain sign-in gate.
const literalRoleGateRules = [
  {
    selector: "CallExpression[callee.name='useRequireRole'] > ArrayExpression[elements.length>0]",
    message: "Pass the role constant exported by the page's nav section (lib/nav/sections), not a literal list.",
  },
];

// Pages tell a person what happened through the kit's showSuccess / showWarning /
// showError, so every message looks and behaves the same.
const rawNotificationImport = [
  {
    name: "@mantine/notifications",
    message: "Use showSuccess, showWarning or showError from @checkin/component-ui.",
  },
];

// Files still on raw notifications: background-check pages wait for that process's redesign.
const rawNotificationExemptions = [
  "checkin-app/src/app/membership-ops/review/page.tsx",
  "checkin-app/src/app/membership/BackgroundChecksPanel.tsx",
];

// Client code reads through useLoad and writes through api() from @/lib/api, so a
// write re-reads every load on screen and a failure arrives as the route's words.
const rawFetchGlobal = [
  { name: "fetch", message: "Use api() or useLoad from @/lib/api." },
];
const rawFetchProperties = ["window", "globalThis", "self"].map((object) => ({
  object,
  property: "fetch",
  message: "Use api() or useLoad from @/lib/api.",
}));

// Files that still call fetch, one reason each.
const rawFetchExemptions = [
  // Each read is billed when it wakes the database, so it runs only from a button.
  "checkin-app/src/app/finance-ops/payments/page.tsx",
  // Billed diagnostics behind buttons, plus public GitHub calls outside the app's routes.
  "checkin-app/src/components/admin/SystemHealthPanels.tsx",
  // Its read wakes the database on purpose, on its own schedule.
  "checkin-app/src/components/DbWakeNotice.tsx",
  // It re-checks on every path change, which useLoad's dedupe would skip.
  "checkin-app/src/components/OnboardingGate.tsx",
  // A nav-wide shared store with its own refresh broadcast.
  "checkin-app/src/hooks/useTodoCounts.ts",
  // Its after-save read retries by hand.
  "checkin-app/src/app/membership/useMembershipPage.ts",
  // Its mount sends a sync POST when the person returns from signing.
  "checkin-app/src/app/membership/KeyVolunteerAgreementPanel.tsx",
  // A 409 refusal carries the matching people, which HttpError cannot hold.
  "checkin-app/src/app/membership-ops/volunteer-memberships/page.tsx",
  // Background-check pages wait for that process's redesign.
  "checkin-app/src/app/membership-ops/review/page.tsx",
  "checkin-app/src/app/membership/BackgroundChecksPanel.tsx",
  "checkin-app/src/app/dev/bg-consent/DevBgConsentClient.tsx",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next. Globs are **-prefixed so
  // they match in the workspace layout whether eslint runs from the repo root
  // or inside checkin-app/ (build output is checkin-app/.next).
  globalIgnores([
    // Default ignores of eslint-config-next:
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/next-env.d.ts",
    // Generated Prisma client — emitted by `prisma generate`, never linted.
    "**/src/generated/**",
    // Package/function build output (tsc/esbuild) and test coverage reports.
    "**/dist/**",
    "**/coverage/**",
  ]),
  // A rest sibling (`const { id: _id, ...rest } = row`) is how an object omits keys.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { ignoreRestSiblings: true }],
    },
  },
  {
    files: ["**/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...bareConsoleErrorRules,
        ...nodeEnvRules,
        ...literalRoleGateRules,
      ],
    },
  },
  {
    // The root layout mounts the Notifications provider; tests render it to read messages.
    files: ["checkin-app/src/**/*.{ts,tsx}"],
    ignores: [
      "checkin-app/src/app/layout.tsx",
      "**/__tests__/**",
      "**/*.test.{ts,tsx}",
      ...rawNotificationExemptions,
    ],
    rules: {
      "no-restricted-imports": ["error", { paths: rawNotificationImport }],
    },
  },
  {
    // The kit wraps @mantine/notifications for every package page.
    files: ["packages/*/src/**/*.{ts,tsx}"],
    ignores: ["packages/component-ui/**", "**/__tests__/**", "**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { paths: rawNotificationImport }],
    },
  },
  {
    files: [
      "checkin-app/src/app/**/*.{ts,tsx}",
      "checkin-app/src/components/**/*.{ts,tsx}",
      "checkin-app/src/hooks/**/*.{ts,tsx}",
    ],
    ignores: [
      "checkin-app/src/app/api/**",
      "**/__tests__/**",
      "**/*.test.{ts,tsx}",
      ...rawFetchExemptions,
    ],
    rules: {
      "no-restricted-globals": ["error", ...rawFetchGlobal],
      "no-restricted-properties": ["error", ...rawFetchProperties],
    },
  },
  // API routes must log through @/lib/logger (console sink + logBackendError),
  // not raw console. Scoped to server routes only — client code can't use the
  // prisma-backed sink. Broadening to all of src is a follow-up.
  {
    files: ["**/src/app/api/**/*.ts"],
    rules: { "no-console": "warn" },
  },
  {
    // Lifecycle definitions are shared server/client, so they stay Prisma-free at
    // runtime. Tests are excluded: they are not the client bundle and may value-
    // import the generated enum (see lifecycle/enumParity.ts).
    files: [
      "**/src/lib/lifecycle/**/*.ts",
      "**/src/lib/membership/lifecycle.ts",
      "**/src/lib/programs/enrollmentState.ts",
    ],
    ignores: ["**/__tests__/**", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: noPrismaValueImport },
      ],
    },
  },
  {
    // P3-1: error responses must go through apiError() (@/lib/api-response) so the
    // { error, details? } shape stays uniform. Bans re-growing a raw
    // NextResponse.json({ error }) / ({ error, details }) in the route surface.
    // Multi-key error bodies (e.g. { error, code }, { error, requiresOverride })
    // are intentional richer contracts and are NOT flagged.
    //
    // Flat config replaces (does not merge) a same-named rule, and api files
    // also match the src-wide block above, so this array carries the shared
    // bare-console-error rules too — otherwise this block would silence them.
    files: ["**/src/app/api/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='NextResponse'][callee.property.name='json'] > ObjectExpression:has(Property[key.name='error']):not(:has(Property[key.name!='error'][key.name!='details']))",
          message:
            "Return errors via apiError(message, status[, details]) from @/lib/api-response, not a raw NextResponse.json({ error }).",
        },
        ...bareConsoleErrorRules,
        ...nodeEnvRules,
      ],
    },
  },
  // NODE_ENV exemptions. prisma.ts reads it as test-harness/dev-server plumbing
  // (pool sizing, adapter disposal, the dev global), not as an environment fuse;
  // tests set and read it to exercise both builds. Both blocks re-spread the
  // rules they still need, since flat config replaces the array.
  {
    files: ["**/src/lib/prisma.ts"],
    rules: { "no-restricted-syntax": ["error", ...bareConsoleErrorRules] },
  },
  {
    files: ["**/src/**/*.test.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...bareConsoleErrorRules] },
  },
]);

export default eslintConfig;
