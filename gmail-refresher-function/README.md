# gmail-refresher-function

Sole holder of the receipt mailbox's Google grant. The checkin app holds no Google client
secret and never refreshes: it invokes this Lambda (`GMAIL_REFRESHER_FN`) for a short-lived
access token.

## Contract

| Event | Caller | Behaviour |
|---|---|---|
| `{ "action": "current" }` | checkin app (`lambda:InvokeFunction`) | Refreshes, returns `{ accessToken, expiresAt, mailbox }`. The app caches the token and refuses a `mailbox` other than its own. |
| `{ "action": "keepalive" }` | EventBridge, weekly | The same refresh, so an idle grant does not lapse. |

`expiresAt` is epoch ms.

## Secrets

Both are readable only by this function's role, and the function only reads them.

| Secret | Scope | JSON |
|---|---|---|
| client | one, shared by prod and dev | `{ "clientId": "", "clientSecret": "" }` |
| token | one per environment | `{ "refreshToken": "", "mailbox": "" }` |

Nothing is written back: Google does not rotate the refresh token on refresh, so this function
needs no single-writer guard or reserved concurrency.

## Environment

| Var | Value |
|---|---|
| `GMAIL_CLIENT_SECRET_ID` | the client secret's name or ARN |
| `GMAIL_TOKEN_SECRET_ID` | this environment's token secret's name or ARN |

Only prod and dev get this function, as `gmail-refresher-prod` and `gmail-refresher-dev`.
Staging stays unbound. The dev grant is for the test mailbox, never the real one.

## Consent runbook

The OAuth consent screen must be Internal or In production: Google expires refresh tokens after
7 days while an app is in Testing. The client must allow the redirect URI.

```bash
GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... GMAIL_MAILBOX=... npm run consent -w gmail-refresher-function
```

Sign in as the mailbox. The CLI requests `gmail.readonly` only, refuses any other granted scope,
checks that the grant opens `GMAIL_MAILBOX`, and writes a new `gmail-token.json` (mode 0600, in
this directory, gitignored; `GMAIL_TOKEN_FILE` overrides the path). Seed the environment's token
secret from it, then delete it:

```bash
aws secretsmanager put-secret-value --secret-id "$TOKEN_SECRET" --secret-string file://gmail-token.json
```

```bash
rm gmail-token.json
```

Run it once per environment. An ERROR log with `GMAIL_INVALID_GRANT` means the grant was revoked
or lapsed: re-run consent and reseed. Other failures name only Google's error code.

## Build and test

```bash
npm run build -w gmail-refresher-function   # tsc + esbuild -> dist/handler.js
npm run test -w gmail-refresher-function    # vitest; fetch and the store are mocked
```

Google token egress is `src/oauth.ts`. The consent CLI's Gmail check goes through
`packages/receipt/src/lib/gmail.ts`.
