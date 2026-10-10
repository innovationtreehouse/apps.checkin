import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: 'standalone',
  // The checkin-hosted libraries (#1286, #1287, #1272) ship raw TS/TSX — route factories
  // off their `.` entry, client pages and nav off subpath exports — so Next must
  // transpile them.
  transpilePackages: ['@inventory/global-catalog', '@inventory/local-inventory', '@inventory/expense'],
  // Deps hoist to the repo-root node_modules and future @checkin/* packages live
  // in ../packages. Point standalone file tracing at the repo root so it follows
  // those symlinks and bundles the linked code into the image (otherwise Next
  // infers the app dir as the trace root and ships dangling symlinks).
  outputFileTracingRoot: path.join(__dirname, '..'),
  // The membership-agreement PDF is fetched from S3 at runtime (not read from
  // disk or imported), so there's nothing to bundle into the standalone image.
};

export default nextConfig;

// Force dev server reload for Prisma schema updates
