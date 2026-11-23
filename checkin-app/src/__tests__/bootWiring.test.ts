/**
 * @jest-environment node
 *
 * Runs the boot wiring in instrumentation.ts with a deployed instance's environment and checks
 * that every library port is bound to a real adapter: not left unset, and not one of the
 * library's own `inert*` defaults. Each library's port list is its config type, so a port added
 * there fails tsc here until it is listed as a port or a setting.
 */
import Anthropic from "@anthropic-ai/sdk";
import { catalogReader } from "@/lib/catalog/reader";
import { catalogEventsSince } from "@/lib/components/host";
import { getConfigHealth } from "@/lib/configHealth";
import { tryBuildQuickBooks } from "@/lib/quickbooks/client";
import { expenseSink } from "@/lib/workflowMapping/configure";
import * as bulkDonation from "@checkin/bulk-donation";
import * as expense from "@checkin/expense";
import * as catalog from "@checkin/global-catalog";
import * as income from "@checkin/income";
import * as localInventory from "@checkin/local-inventory";
import * as receipt from "@checkin/receipt";
import * as workflowMapping from "@checkin/workflow-mapping";
import libraries from "../../libraries.json";
import { register } from "../instrumentation";

jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@aws-sdk/client-lambda", () => ({ LambdaClient: jest.fn(), InvokeCommand: jest.fn() }));
jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
  NoSuchKey: class NoSuchKey extends Error {},
}));
jest.mock("@checkin/quickbooks", () => ({ ...jest.requireActual("@checkin/quickbooks"), QuickBooksClient: jest.fn() }));
jest.mock("@checkin/global-catalog", () => {
  const actual = jest.requireActual("@checkin/global-catalog");
  return { ...actual, configureCatalog: jest.fn(actual.configureCatalog) };
});
jest.mock("@checkin/local-inventory", () => {
  const actual = jest.requireActual("@checkin/local-inventory");
  return { ...actual, configureLocalInventory: jest.fn(actual.configureLocalInventory) };
});
jest.mock("@checkin/bulk-donation", () => {
  const actual = jest.requireActual("@checkin/bulk-donation");
  return { ...actual, configureBulkDonation: jest.fn(actual.configureBulkDonation) };
});
jest.mock("@checkin/expense", () => {
  const actual = jest.requireActual("@checkin/expense");
  return { ...actual, configureExpense: jest.fn(actual.configureExpense) };
});
jest.mock("@checkin/workflow-mapping", () => {
  const actual = jest.requireActual("@checkin/workflow-mapping");
  return { ...actual, configureWorkflowMapping: jest.fn(actual.configureWorkflowMapping) };
});
jest.mock("@checkin/income", () => {
  const actual = jest.requireActual("@checkin/income");
  return { ...actual, configureIncome: jest.fn(actual.configureIncome) };
});
jest.mock("@checkin/receipt", () => {
  const actual = jest.requireActual("@checkin/receipt");
  return { ...actual, configureReceipt: jest.fn(actual.configureReceipt) };
});

/** A deployed prod instance's environment, every value a fake. */
const DEPLOYED_ENV = {
  NEXT_RUNTIME: "nodejs",
  CHECKIN_ENV: "prod",
  NEXTAUTH_URL: "https://checkin.example.org",
  QBO_REALM_ID: "1234567890",
  QBO_ENVIRONMENT: "production",
  QBO_REFRESHER_FN: "qbo-refresher",
  GMAIL_REFRESHER_FN: "gmail-refresher",
  RECEIPT_MAILBOX_ADDRESS: "receipts@example.org",
  ANTHROPIC_API_KEY: "sk-ant-test",
  DATABASE_URL: "postgresql://app:secret@db.example.org:5432/checkin",
  SHOPIFY_READ_DB: "shopify_read",
  RECEIPT_FILES_S3_BUCKET: "receipt-files",
  INCOME_MIRROR_NEWEST_WINS: "true",
};

type Kind = "port" | "setting";
type Decided<C> = Record<keyof C, Kind>;

const CATALOG: Decided<catalog.CatalogRuntimeConfig> = { auth: "port", org: "port", orgEventConsumers: "port" };
const LOCAL_INVENTORY: Decided<localInventory.InventoryRuntimeConfig> = { auth: "port", org: "port", catalogEventSource: "port", catalog: "port" };
const BULK_DONATION: Decided<bulkDonation.BulkDonationConfig> = {
  auth: "port",
  org: "port",
  onFailure: "port",
  owners: "port",
  catalog: "port",
  inventory: "port",
  inKindQb: "port",
  deposits: "port",
  inKind: "port",
  capital: "port",
  quickBooksAccounts: "port",
  partAccounts: "port",
};
const EXPENSE: Decided<expense.ExpenseConfig> = {
  org: "port",
  onFailure: "port",
  budgetOwners: "port",
  signoff: "port",
  catalog: "port",
  catalogEvents: "port",
  people: "port",
  quickbooks: "port",
  outbound: "port",
  outcomeMail: "port",
};
const EXPENSE_QUICKBOOKS: Decided<expense.QuickBooksPorts> = { reader: "port", refs: "port", vendors: "port", accounts: "port", posting: "port" };
const WORKFLOW_MAPPING: Decided<workflowMapping.WorkflowRuntimeConfig> = {
  auth: "port",
  org: "port",
  catalogReader: "port",
  catalogSubmissions: "port",
  expenseSink: "port",
  donationSink: "port",
  inventorySink: "port",
  catalogEventSource: "port",
};
const INCOME: Decided<income.IncomeConfig> = {
  auth: "port",
  org: "port",
  onFailure: "port",
  mirror: "port",
  deposits: "port",
  owners: "port",
  classes: "port",
  savedClasses: "port",
  booksMap: "port",
  quickBooksAccounts: "port",
  posting: "port",
  alerts: "port",
  windowDays: "setting",
  dateGraceDays: "setting",
  reconcileFrom: "setting",
};
const RECEIPT: Decided<receipt.ReceiptConfig> = {
  auth: "port",
  org: "port",
  receiptSink: "port",
  donorSink: "port",
  reimbursementStatus: "port",
  submitterConfirmations: "port",
  purchaseOutcomes: "port",
  households: "port",
  personIds: "port",
  ocr: "port",
  people: "port",
  personNames: "port",
  reimbursees: "port",
  alerts: "port",
  mailbox: "port",
  rawMailRetentionDays: "setting",
  replies: "port",
  outcomeMail: "port",
  limits: "setting",
  fileStore: "port",
};

/** The library's own inert adapters, which a bound port must not be. */
function inertsOf(lib: object): Set<unknown> {
  return new Set(Object.entries(lib).flatMap(([name, value]) => (name.startsWith("inert") ? [value] : [])));
}

/** The ports in `decided` the host left unset or bound to an inert adapter, as "key" or "key.sub". */
function unsetPorts(config: object | undefined, decided: Record<string, Kind>, inerts: Set<unknown>, prefix = ""): string[] {
  return Object.entries(decided).flatMap(([key, kind]) => {
    if (kind !== "port") return [];
    const value: unknown = config === undefined ? undefined : Reflect.get(config, key);
    return value === undefined || inerts.has(value) ? [`${prefix}${key}`] : [];
  });
}

/** The config the host last passed to a library's configure call. */
function lastConfig<C>(configure: (config: C) => void): C | undefined {
  return jest.mocked(configure).mock.calls.at(-1)?.[0];
}

/** Ports whose adapter is bound but reaches nothing: OCR without a key builds no client, file storage without a bucket refuses. */
async function deadAdapters(): Promise<string[]> {
  const config = lastConfig(receipt.configureReceipt);
  const dead: string[] = [];
  if (jest.mocked(Anthropic).mock.calls.length === 0) dead.push("@checkin/receipt ocr");
  const stored = await config?.fileStore?.put("boot-wiring-probe", new Uint8Array([1]), "00").then(
    () => true,
    () => false,
  );
  if (!stored) dead.push("@checkin/receipt fileStore");
  return dead;
}

/** Each library's package, the configure call the host makes, and its unset ports in that call. */
const LIBRARIES: { pkg: string; calls: () => number; unset: () => string[] }[] = [
  library("@checkin/global-catalog", catalog.configureCatalog, (c) => unsetPorts(c, CATALOG, inertsOf(catalog))),
  library("@checkin/local-inventory", localInventory.configureLocalInventory, (c) => unsetPorts(c, LOCAL_INVENTORY, inertsOf(localInventory))),
  library("@checkin/bulk-donation", bulkDonation.configureBulkDonation, (c) => unsetPorts(c, BULK_DONATION, inertsOf(bulkDonation))),
  library("@checkin/expense", expense.configureExpense, (c) => [
    ...unsetPorts(c, EXPENSE, inertsOf(expense)),
    ...unsetPorts(c?.quickbooks, EXPENSE_QUICKBOOKS, inertsOf(expense), "quickbooks."),
  ]),
  library("@checkin/workflow-mapping", workflowMapping.configureWorkflowMapping, (c) => unsetPorts(c, WORKFLOW_MAPPING, inertsOf(workflowMapping))),
  library("@checkin/income", income.configureIncome, (c) => unsetPorts(c, INCOME, inertsOf(income))),
  library("@checkin/receipt", receipt.configureReceipt, (c) => unsetPorts(c, RECEIPT, inertsOf(receipt))),
];

function library<C>(pkg: string, configure: (config: C) => void, unset: (config: C | undefined) => string[]) {
  return { pkg, calls: () => jest.mocked(configure).mock.calls.length, unset: () => unset(lastConfig(configure)) };
}

/** Every unbound port across the libraries, as "<package> <port>". */
async function unboundPorts(): Promise<string[]> {
  const unset = LIBRARIES.flatMap(({ pkg, unset }) => unset().map((port) => `${pkg} ${port}`));
  return [...unset, ...(await deadAdapters())].sort();
}

/** The System Status rows that fail: config health plus the QuickBooks connection. */
function failingStatusRows(): string[] {
  const failing = getConfigHealth().filter((check) => !check.ok).map((check) => check.id);
  return tryBuildQuickBooks().ok ? failing : [...failing, "quickbooks-connection"];
}

/** Runs the boot wiring with the deployed environment, less one variable if named. */
async function boot(without?: string): Promise<string[]> {
  process.env = { ...ORIGINAL_ENV, ...DEPLOYED_ENV };
  if (without) delete process.env[without];
  jest.clearAllMocks();
  const errors = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    await register();
    return errors.mock.calls.map((args) => args.join(" "));
  } finally {
    errors.mockRestore();
  }
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("boot wiring with a deployed instance's environment", () => {
  it("configures each library in libraries.json once", async () => {
    await boot();
    expect(LIBRARIES.map((l) => l.pkg).sort()).toEqual(libraries.map((l) => l.package).sort());
    expect(LIBRARIES.map((l) => l.calls())).toEqual(LIBRARIES.map(() => 1));
  });

  it("binds every port to a real adapter", async () => {
    expect(await boot()).toEqual([]);
    expect(await unboundPorts()).toEqual([]);
    expect(jest.mocked(Anthropic)).toHaveBeenCalledWith(expect.objectContaining({ apiKey: DEPLOYED_ENV.ANTHROPIC_API_KEY }));
  });

  it("binds local inventory's catalog reads and replay to the shared catalog reader and event source", async () => {
    await boot();
    const config = lastConfig(localInventory.configureLocalInventory);
    expect(config?.catalog).toEqual({ getActiveItem: catalogReader.getActiveItem, searchItems: catalogReader.searchItems });
    expect(config?.catalogEventSource?.eventsSince).toBe(catalogEventsSince);
  });

  it("binds workflow mapping's crossings to expense intake, donations and the shared catalog", async () => {
    await boot();
    const config = lastConfig(workflowMapping.configureWorkflowMapping);
    expect(config?.catalogReader).toMatchObject(catalogReader);
    expect(config?.catalogReader?.getOrgProvisionalItem).toEqual(expect.any(Function));
    expect(config?.catalogEventSource?.eventsSince).toBe(catalogEventsSince);
    expect(config?.expenseSink).toBe(expenseSink);
    expect(config?.donationSink?.ingestInKind).toBe(bulkDonation.ingestInKind);
  });

  it("shows no failing System Status row for the variables below", async () => {
    await boot();
    const rows = failingStatusRows();
    expect(REQUIRED.map((r) => r.statusRow).filter((row) => rows.includes(row))).toEqual([]);
  });
});

/** Each variable a deployed instance needs, the ports that go unbound without it, and the System Status row that says so. */
const REQUIRED: { name: keyof typeof DEPLOYED_ENV; unbinds: string[]; statusRow: string; logs?: string }[] = [
  {
    name: "QBO_REALM_ID",
    unbinds: [
      "@checkin/bulk-donation deposits",
      "@checkin/bulk-donation inKindQb",
      "@checkin/income classes",
      "@checkin/income deposits",
      "@checkin/income posting",
    ],
    statusRow: "quickbooks-connection",
  },
  {
    name: "QBO_ENVIRONMENT",
    unbinds: ["@checkin/income posting"],
    statusRow: "quickbooks-connection",
    logs: "QuickBooks is off: CHECKIN_ENV=prod must use the production QuickBooks API",
  },
  {
    name: "QBO_REFRESHER_FN",
    unbinds: ["@checkin/income posting"],
    statusRow: "quickbooks-connection",
    logs: "QuickBooks is off: no token source (set QBO_REFRESHER_FN)",
  },
  { name: "GMAIL_REFRESHER_FN", unbinds: ["@checkin/receipt mailbox"], statusRow: "receipt-mailbox" },
  { name: "RECEIPT_MAILBOX_ADDRESS", unbinds: ["@checkin/receipt mailbox"], statusRow: "receipt-mailbox" },
  { name: "ANTHROPIC_API_KEY", unbinds: ["@checkin/receipt ocr"], statusRow: "receipt-ocr" },
  { name: "SHOPIFY_READ_DB", unbinds: ["@checkin/income mirror"], statusRow: "s-read-mirror" },
  { name: "RECEIPT_FILES_S3_BUCKET", unbinds: ["@checkin/receipt fileStore"], statusRow: "receipt-files-s3" },
];

describe.each(REQUIRED)("boot wiring without $name", ({ name, unbinds, statusRow, logs }) => {
  it("leaves exactly its ports unbound and logs only why", async () => {
    expect(await boot(name)).toEqual(logs ? [logs] : []);
    expect(await unboundPorts()).toEqual([...unbinds].sort());
  });

  it(`fails the ${statusRow} System Status row`, async () => {
    await boot(name);
    expect(failingStatusRows()).toContain(statusRow);
  });
});
