import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: 'standalone',
  // Deps hoist to the repo-root node_modules and future @checkin/* packages live
  // in ../packages. Point standalone file tracing at the repo root so it follows
  // those symlinks and bundles the linked code into the image (otherwise Next
  // infers the app dir as the trace root and ships dangling symlinks).
  outputFileTracingRoot: path.join(__dirname, '..'),
  // The global-catalog library ships raw .tsx (client components + pages) that
  // checkin re-exports (#1286 §3). Next must transpile the workspace package's
  // JSX, so it can't be left as an external — @inventory/money needed no entry
  // because it ships no JSX.
  transpilePackages: ['@inventory/global-catalog'],
  // The membership-agreement PDF is fetched from S3 at runtime (not read from
  // disk or imported), so there's nothing to bundle into the standalone image.
};

export default nextConfig;

// Force dev server reload for Prisma schema updates
