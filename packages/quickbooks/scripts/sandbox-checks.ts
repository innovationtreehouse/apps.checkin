// Live checks of what the closed-books gate relies on (docs/in-design/QB_CLOSED_BOOKS.md §2, §6).
// Sandbox only. Run it twice: once with the sandbox books not closed (the unset read), then after closing
// them the way finance does: Settings → Account and settings → Advanced → Close the books, a closing
// date before today, "Required password" (the closed-period refusal).
// Run: npm run sandbox-checks -w @checkin/quickbooks
// Needs QBO_TOKEN_FILE (from `npm run consent`) and QBO_ENVIRONMENT=sandbox. The test deposit goes
// into the bank account QBO_SANDBOX_DEPOSIT_ACCOUNT (default "Checking"), booked to the income account
// QBO_SANDBOX_INCOME_ACCOUNT (default "Services"), each named as the Chart of Accounts shows it.
// Creates up to two [checkin-test] Deposits in the sandbox per run.
import { QboRequestError, QuickBooksClient, appKeyOf, qboEnvFromEnv, qbKey, qboString, type TxnWrite } from "../src/client";
import type { QboPreferences } from "../src/types";
import { CREATE } from "../src/internal";
import { fileAccessTokenSource, loadTokens, tokenFileFromEnv } from "../src/local";

if (qboEnvFromEnv() !== "sandbox") throw new Error("sandbox-checks runs against the sandbox only");
const tokenFile = tokenFileFromEnv();
const saved = loadTokens(tokenFile);
if (!saved) throw new Error(`No QBO tokens at ${tokenFile}; run \`npm run consent -w @checkin/quickbooks\` first`);
const client = new QuickBooksClient(fileAccessTokenSource(tokenFile), { env: "sandbox", realmId: saved.realmId });
/** The id of the account named by `envName` (or `fallback`), which must have `type`. */
async function accountId(envName: string, fallback: string, type: string): Promise<string> {
  const name = process.env[envName] || fallback;
  const account = await client.accountNamed(name);
  if (!account) throw new Error(`No account named "${name}" in the sandbox; set ${envName} to one from the Chart of Accounts`);
  if (account.AccountType !== type) throw new Error(`"${name}" is a ${account.AccountType ?? "?"} account, not ${type}; set ${envName}`);
  console.log(`Using ${type} account "${name}" (id ${account.Id})`);
  return account.Id;
}
const bank = await accountId("QBO_SANDBOX_DEPOSIT_ACCOUNT", "Checking", "Bank");
const income = await accountId("QBO_SANDBOX_INCOME_ACCOUNT", "Services", "Income");
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
  report(true, "books not closed: bookCloseDate() reads null; close the books and run again for the 6210 check");
} else {
  report(closeDate < today, `BookCloseDate reads as ${closeDate}, before ${today}`);

  // 2. A create dated in the closed period is refused with fault 6210.
  try {
    const { Id } = await client[CREATE](deposit(closeDate), qbKey("sandbox", `closed-${Date.now()}`));
    report(false, `create dated ${closeDate} was accepted as Deposit ${Id}; is the closing mode "Required password"?`);
  } catch (e) {
    const codes = e instanceof QboRequestError ? e.codes : [];
    report(codes.includes("6210"), `create dated ${closeDate} refused with codes ${codes.join(",") || "none"} (${String(e)})`);
  }
}

// 3. The created-since read returns an entry the app just created, by its key.
const since = new Date(Date.now() - 60_000);
const key = qbKey("sandbox", `since-${Date.now()}`);
const { Id } = await client[CREATE](deposit(today), key);
const { entries, full } = await client.createdSince("Deposit", since);
const hits = entries.filter((d) => appKeyOf(d)?.split(" ").includes(key)).map((d) => d.Id);
report(hits.length === 1 && hits[0] === Id, `created-since finds Deposit ${Id} by key (hits: ${hits.join(",") || "none"}, full page: ${full})`);

// 4. Every entity the read covers accepts the query and answers oldest first, since each page starts at the last row's CreateTime.
for (const entity of ["Deposit", "Purchase", "Bill", "JournalEntry"] as const) {
  try {
    const read = await client.createdSince(entity, new Date("2000-01-01T00:00:00Z"));
    const times = read.entries.map((e) => Date.parse(e.MetaData?.CreateTime ?? ""));
    const ordered = times.every((t, i) => !Number.isNaN(t) && (i === 0 || times[i - 1] <= t));
    report(ordered, `created-since reads ${entity}: ${times.length} entries, oldest first: ${ordered}, full: ${read.full}`);
  } catch (e) {
    report(false, `created-since read of ${entity} failed (${String(e)})`);
  }
}

// 5. An id lookup returns every row. The default-page limit shows only with more than 100 Deposits in the sandbox.
const depositIds = (await client.createdSince("Deposit", new Date("2000-01-01T00:00:00Z"))).entries.map((d) => d.Id).slice(0, 1000);
const byId = await client.depositsByIds(depositIds);
const unbounded = await client.query<{ Id: string }>(`SELECT * FROM Deposit WHERE Id IN (${depositIds.map(qboString).join(", ")})`);
report(byId.length === depositIds.length, `id lookup returns ${byId.length} of ${depositIds.length} Deposits; with no MAXRESULTS, ${unbounded.length}`);
if (depositIds.length <= 100) console.log("NOTE  100 or fewer Deposits: this run does not exercise QuickBooks' default page size");

process.exit(failed ? 1 : 0);
