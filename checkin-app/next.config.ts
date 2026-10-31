import type { NextConfig } from "next";
import path from "node:path";
import { MAX_UPLOAD_BODY_BYTES } from "./src/lib/requestBodyLimit";

const nextConfig: NextConfig = {
  output: 'standalone',
  // The checkin-hosted libraries ship raw TS/TSX — route factories
  // off their `.` entry, client pages and nav off subpath exports — so Next must
  // transpile them.
  transpilePackages: ['@checkin/global-catalog', '@checkin/local-inventory', '@checkin/bulk-donation', '@checkin/expense', '@checkin/workflow-mapping', '@checkin/income', '@checkin/receipt', '@checkin/quickbooks', '@checkin/s-ingest-core', '@checkin/pg-kit', '@checkin/component-kit', '@checkin/component-ui'],
  // Deps hoist to the repo-root node_modules and future @checkin/* packages live
  // in ../packages. Point standalone file tracing at the repo root so it follows
  // those symlinks and bundles the linked code into the image (otherwise Next
  // infers the app dir as the trace root and ships dangling symlinks).
  outputFileTracingRoot: path.join(__dirname, '..'),
  // The membership-agreement PDF is fetched from S3 at runtime (not read from
  // disk or imported), so there's nothing to bundle into the standalone image.
  experimental: {
    // The middleware runs on /api, so Next buffers each request body for the route up to this
    // size and stops reading there. It must fit the largest upload.
    proxyClientMaxBodySize: MAX_UPLOAD_BODY_BYTES,
  },
  // Only this origin may frame a page: the kiosk wrapper frames the board from the
  // same Pi proxy origin. API responses are left alone so a route's own CSP stands.
  async headers() {
    return [{ source: '/((?!api/).*)', headers: [{ key: 'Content-Security-Policy', value: "frame-ancestors 'self'" }] }];
  },
  // The program-leader home's former path, kept working for bookmarks.
  async redirects() {
    return [
      { source: '/my-programs/:path*', destination: '/programs-i-lead/:path*', permanent: true },
      { source: '/inventory/received-deltas', destination: '/inventory/inventory-log?view=applies', permanent: true },
      { source: '/expense/settings', destination: '/settings/finance', permanent: true },
      { source: '/inventory/in-kind', destination: '/donations/in-kind-gifts', permanent: true },
    ];
  },
};

export default nextConfig;

// Force dev server reload for Prisma schema updates
