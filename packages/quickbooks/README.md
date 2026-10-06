# @inventory/quickbooks

Read-only QuickBooks Online client. Used now to pull historical Purchases/Bills as
**ground truth** for the receipt-OCR bake-off and the vendor-alias bootstrap loop.
Later grows the write path for the `qb_pending` state-machine terminus.

No SDK dependency — OAuth2 is three `fetch` calls (authorize, code→token, refresh).

## One-time setup (you do this — OAuth consent can't be automated)

1. **Create a sandbox app** at <https://developer.intuit.com> → *Dashboard → Create an app → QuickBooks Online Accounting*.
2. In the app's **Keys & credentials** (Development), copy the **Client ID** and **Client Secret**.
3. Under **Redirect URIs**, add exactly: `http://localhost:8087/callback`
4. Export env vars (a sandbox company is created for you automatically):

   ```bash
   export QBO_CLIENT_ID=...
   export QBO_CLIENT_SECRET=...
   export QBO_ENVIRONMENT=sandbox        # switch to "production" later
   # QBO_REDIRECT_URI defaults to http://localhost:8087/callback
   ```

5. Run consent — opens a URL, you sign in and authorize; tokens land in `.qbo-tokens.json` (gitignored):

   ```bash
   npm run consent -w @inventory/quickbooks
   ```

## Pull ground truth

```bash
npm run pull -w @inventory/quickbooks -- 2024-01-01
```

Writes `.ground-truth.json` (normalized `GroundTruthRecord[]`) and prints a shape report:
row count, distinct vendors, and how many totals collide — the real collision count for the
amount-anchored vendor join.

## Notes

- `realmId` (company id) is captured automatically from the consent redirect.
- Refresh tokens **rotate** on every refresh; the client re-saves them, so don't hand-edit the token file.
- Access token lives ~1h and auto-refreshes; refresh token ~100 days.
- Going to production: switch `QBO_ENVIRONMENT=production`, re-run consent against the real company.
