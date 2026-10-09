# Build context is the REPO ROOT (not checkin-app/) so the workspace install can
# see the root package.json, root package-lock.json, and every workspace manifest.
# Build with:  docker build -f checkin-app/Dockerfile .

# Stage 1: Install dependencies (whole workspace, hoisted to /app/node_modules)
FROM node:24-alpine AS deps
WORKDIR /app
# Copy only the manifests + lockfile first for a cache-friendly `npm ci` layer.
# Add packages/*/package.json here when @checkin/* packages land (item 4).
COPY package.json package-lock.json* ./
COPY checkin-app/package.json ./checkin-app/package.json
RUN npm ci

# Stage 2: Build the app
FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# npm does not hoist remote-tarball deps (xlsx is pinned to the SheetJS CDN
# tarball, not the vulnerable registry build) to the root node_modules — they
# stay in the workspace's own node_modules. Copy it too, or `next build` fails
# with "Module not found: Can't resolve 'xlsx'".
COPY --from=deps /app/checkin-app/node_modules ./checkin-app/node_modules
COPY . .
# Generate the Prisma client + security classifications inside the app workspace
# (its schema lives at checkin-app/prisma; the security generator resolves its
# script + output paths relative to the app cwd).
RUN npm -w checkin-app exec -- prisma generate
# The global catalog (#1286) ships its own Prisma schema + client; its generated
# client (packages/global-catalog/src/generated) is gitignored, so it must be
# generated in the image too or the catalog routes fail "Module not found:
# ../generated/prisma/client". This also re-emits the committed catalog security
# classifications (idempotent).
RUN npm -w @inventory/global-catalog exec -- prisma generate
# Same for local inventory (#1287): its own gitignored client + classifications.
RUN npm -w @inventory/local-inventory exec -- prisma generate
# Same for income: its own gitignored client + classifications.
RUN npm -w @inventory/income exec -- prisma generate
# Build stamp surfaced in the app footer: the deployed commit SHA, passed via
# --build-arg by the deploy workflow and inlined into the bundle (NEXT_PUBLIC_*,
# build-time). Empty in local/ad-hoc builds -> the footer shows "dev".
ARG NEXT_PUBLIC_GIT_SHA
ENV NEXT_PUBLIC_GIT_SHA=${NEXT_PUBLIC_GIT_SHA}
# Release tag, passed by the prod deploy workflow only -> footer shows
# "<tag> <sha>" on prod. Empty on dev/local builds -> footer shows the hash alone.
ARG NEXT_PUBLIC_RELEASE_TAG
ENV NEXT_PUBLIC_RELEASE_TAG=${NEXT_PUBLIC_RELEASE_TAG}
# `git describe --tags --long --abbrev=7 --always` of the built commit, e.g.
# "v1.0.8-0-ge790e17" — the tag it descends from, how many commits past it, and
# the commit itself. Answers "what is running" in one string for a build that is
# NOT itself a release: a bare SHA can't tell you it is 2 commits past v1.0.7,
# and the release tag alone is empty on every non-prod build. Requires the deploy
# workflow to check out with fetch-depth: 0 (a shallow clone has no tags, and
# describe silently degrades to the bare SHA).
ARG NEXT_PUBLIC_GIT_DESCRIBE
ENV NEXT_PUBLIC_GIT_DESCRIBE=${NEXT_PUBLIC_GIT_DESCRIBE}
# Branch, passed by deploy-dev.yml (main) and deploy-staging.yml (the rel/*
# branch being deployed) -> footer shows "<branch> <sha>" on those envs. NOT
# passed by deploy-prod.yml: on prod, github.ref_name IS the tag, so passing it
# here would just duplicate NEXT_PUBLIC_RELEASE_TAG in the label. Empty on
# prod/local builds -> footer omits the branch part.
ARG NEXT_PUBLIC_GIT_BRANCH
ENV NEXT_PUBLIC_GIT_BRANCH=${NEXT_PUBLIC_GIT_BRANCH}
# Needed for GitHub to build the image, overwritten by secrets in AWS at run time.
# (next build imports auth-options.ts, which requires these to exist; the values
# are never used — every route is dynamic — and never reach the runner stage.)
ENV GOOGLE_CLIENT_ID=build-placeholder \
    GOOGLE_CLIENT_SECRET=build-placeholder \
    NEXTAUTH_SECRET=build-placeholder
RUN npm -w checkin-app run build
# Self-contained prisma CLI tree for the runner stage (see the COPY there):
# copying node_modules/prisma + @prisma alone is NOT enough — @prisma/config
# requires hoisted transitive deps (e.g. `effect`), which the deploy-build
# smoke caught. An isolated install pulls the full closure; the version is
# read from the workspace install, so the CLI can never drift from the
# lockfile's.
RUN mkdir /prisma-cli && cd /prisma-cli && npm init -y >/dev/null \
 && npm install --no-audit --no-fund --save-exact \
      prisma@"$(node -p "require('/app/node_modules/prisma/package.json').version")"

# Stage 3: Production image
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# RDS TLS: the pg driver verifies the server certificate (sslmode=require is
# strict in the Prisma 7 / pg stack), and Amazon's RDS CA is not in the OS
# trust store — without this, every query dies with "unable to get local
# issuer certificate". NODE_EXTRA_CA_CERTS appends to Node's default roots.
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-global-bundle.pem

# next.config sets outputFileTracingRoot to the repo root, so the standalone
# bundle mirrors the workspace layout: server.js + traced .next under
# checkin-app/, with the hoisted node_modules and root package.json at the top.
COPY --from=builder /app/checkin-app/.next/standalone ./
COPY --from=builder /app/checkin-app/.next/static ./checkin-app/.next/static
COPY --from=builder /app/checkin-app/public ./checkin-app/public
# The Rust-free `prisma-client` generator emits the client into src/generated/prisma,
# which Next's standalone output tracing bundles automatically — there is no
# node_modules/.prisma engine directory to copy as there was with prisma-client-js.
COPY --from=builder /app/checkin-app/prisma ./checkin-app/prisma
# Prisma 7 only reads the datasource URL from a config file (schema-level `url`
# was removed), so the migrate ECS task — `cd checkin-app && npx prisma migrate
# deploy` in this image — needs one. The repo's prisma.config.ts can't be
# shipped: its dotenv / prisma/config imports don't resolve here. The deploy
# variant has no imports.
COPY --from=builder /app/checkin-app/prisma.config.deploy.ts ./checkin-app/prisma.config.ts
# The prisma CLI is a devDependency, so Next's standalone file-trace never
# includes it — `npx prisma migrate deploy` in the migrate ECS task was
# fetching LATEST prisma from the npm registry at deploy time ("npm warn exec
# ... will be installed: prisma@X"): version drift vs the lockfile plus a
# registry dependency in the middle of a deploy. Ship the builder's isolated,
# lockfile-versioned CLI tree (full transitive closure — same alpine base, so
# engine binaries match) under checkin-app/node_modules, where the migrate
# command's cwd resolves it without touching the standalone /app/node_modules.
# CI's deploy-build smoke asserts it with `npx --no-install prisma --version`.
COPY --from=builder /prisma-cli/node_modules ./checkin-app/node_modules

EXPOSE 4000
ENV PORT=4000
# Bind all interfaces. The Next standalone server listens on $HOSTNAME, which
# Docker otherwise sets to the container id — that resolves to the bridge IP
# only, so published ports can miss it. 0.0.0.0 covers the bridge IP locally and
# the task ENI in ECS.
ENV HOSTNAME=0.0.0.0
CMD ["node", "checkin-app/server.js"]
