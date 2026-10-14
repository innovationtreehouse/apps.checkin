# qbo-refresher-function

Sole owner of the QuickBooks Online OAuth token pair. The checkin app holds no Intuit
client secret and never refreshes: it invokes this Lambda for a short-lived access token.

## Contract

| Event | Caller | Behaviour |
|---|---|---|
| `{ "action": "current" }` | checkin app (`lambda:InvokeFunction`) | Returns `{ accessToken, expiresAt, realmId, clientId }`. Refreshes first only when the access token has under 10 minutes left (twice the app's cache margin). |
| `{ "action": "keepalive" }` | EventBridge, weekly | Always refreshes, so an idle refresh token never reaches Intuit's 100-day expiry. |

`expiresAt` is epoch ms. `clientId` is not secret; the app re-checks it against its own guard.

## Secret

One Secrets Manager secret per environment (prod, dev), readable and writable only by this
function's role. JSON shape:

```json
{ "clientId": "", "clientSecret": "", "accessToken": "", "refreshToken": "",
  "obtainedAt": 0, "expiresIn": 3600, "realmId": "" }
```

Seed it once from the operator consent flow (`npm run consent -w @inventory/quickbooks`).
Every refresh writes the rotated pair back before returning.

## Guards

- **Single writer**: reserved concurrency 1 serializes every read-refresh-write of the secret.
- **Keys guard**: outside production (`QBO_ENVIRONMENT=sandbox`) the stored `clientId` must
  equal `QBO_DEV_CLIENT_ID` (Intuit development keys open only sandbox companies); in
  production that id is refused. Checked before any Intuit call.
- **invalid_grant**: logs `QBO_INVALID_GRANT` at ERROR and fails without retrying. Recovery
  is an operator re-running consent and reseeding the secret.

## Environment

| Var | Value |
|---|---|
| `QBO_ENVIRONMENT` | `production` (prod) or `sandbox` (dev) |
| `QBO_DEV_CLIENT_ID` | the Intuit development-keys client id (both envs) |
| `QBO_SECRET_ID` | the secret's name or ARN |

Only prod and dev get this function. Staging has no QuickBooks.

## Build and test

```bash
npm run build -w qbo-refresher-function   # tsc + esbuild -> dist/handler.js
npm run test -w qbo-refresher-function    # vitest; fetch and the store are mocked
```

Intuit egress goes through `packages/quickbooks/src/oauth.ts` (outbound surface
`quickbooks.oauth`); this function has no host of its own.
