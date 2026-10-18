// Live checks of what the closed-books gate relies on (docs/in-design/QB_CLOSED_BOOKS.md §2, §6).
// Sandbox only. Run it twice: once with the sandbox books not closed (the unset read), then after closing
// them the way finance does: Settings → Account and settings → Advanced → Close the books, a closing
// date before today, "Required password" (the closed-period refusal).
// Run: npm run sandbox-checks -w @checkin/quickbooks
// Needs QBO_TOKEN_FILE (from `npm run consent`), QBO_ENVIRONMENT=sandbox,
// QBO_SANDBOX_DEPOSIT_ACCOUNT_ID (a bank account) and QBO_SANDBOX_INCOME_ACCOUNT_ID (an income account).
// Creates up to two [checkin-test] Deposits in the sandbox per run.
import { QboRequestError, QuickBooksClient, appKeyOf, qboEnvFromEnv, qbKey, type TxnWrite } from "../src/client";
import type { QboPreferences } from "../src/types";
import { CREATE } from "../src/internal";
import { fileAccessTokenSource, loadTokens, tokenFileFromEnv } from "../src/local";

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
};

if (qboEnvFromEnv() !== "sandbox") throw new Error("sandbox-checks runs against the sandbox only");
const tokenFile = tokenFileFromEnv();
const saved = loadTokens(tokenFile);
if (!saved) throw new Error(`No QBO tokens at ${tokenFile}; run \`npm run consent -w @checkin/quickbooks\` first`);
const client = new QuickBooksClient(fileAccessTokenSource(tokenFile), { env: "sandbox", realmId: saved.realmId });
const bank = need("QBO_SANDBOX_DEPOSIT_ACCOUNT_ID");
const income = need("QBO_SANDBOX_INCOME_ACCOUNT_ID");
const deposit = (txnDate: string): TxnWrite => ({
  entity: "Deposit",
  fields: { txnDate, depositToAccountId: bank, lines: [{ amountCents: 1_00, accountId: income }], memo: "closed-books sandbox check" },
});

let failed = false;
const report = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failed = true;
};

// 1. Preferences reads as a one-row array, and BookCloseDate is a date or, with the books open, unset.
const rows = await client.query<QboPreferences>("SELECT * FROM Preferences");
const raw = rows[0]?.AccountingInfoPrefs?.BookCloseDate;
report(rows.length === 1, `Preferences reads as ${rows.length} row(s); raw BookCloseDate is ${JSON.stringify(raw) ?? "absent"}`);
const closeDate = await client.bookCloseDate();
const today = new Date().toISOString().slice(0, 10);

if (closeDate === null) {
  report(true, "books not closed: bookCloseDate() reads null; close the books and run again for the 6200 check");
} else {
  report(closeDate < today, `BookCloseDate reads as ${closeDate}, before ${today}`);

  // 2. A create dated in the closed period is refused with fault 6200.
  try {
    const { Id } = await client[CREATE](deposit(closeDate), qbKey("sandbox", `closed-${Date.now()}`));
    report(false, `create dated ${closeDate} was accepted as Deposit ${Id}; is the closing mode "Required password"?`);
  } catch (e) {
    const codes = e instanceof QboRequestError ? e.codes : [];
    report(codes.includes("6200"), `create dated ${closeDate} refused with codes ${codes.join(",") || "none"} (${String(e)})`);
  }
}

// 3. The created-since read returns an entry the app just created, by its key.
const since = new Date(Date.now() - 60_000);
const key = qbKey("sandbox", `since-${Date.now()}`);
const { Id } = await client[CREATE](deposit(today), key);
const { entries, full } = await client.createdSince("Deposit", since);
const hits = entries.filter((d) => appKeyOf(d)?.split(" ").includes(key)).map((d) => d.Id);
report(hits.length === 1 && hits[0] === Id, `created-since finds Deposit ${Id} by key (hits: ${hits.join(",") || "none"}, full page: ${full})`);

process.exit(failed ? 1 : 0);
