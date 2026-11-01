import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeResponse {
  writeHead(status: number): FakeResponse;
  end(body?: string): FakeResponse;
}
type RequestHandler = (req: { url: string }, res: FakeResponse) => Promise<void>;

const mocks = vi.hoisted(() => ({
  onRequest: undefined as RequestHandler | undefined,
  listen: vi.fn(),
  authUrl: vi.fn((clientId: string, redirectUri: string, mailbox: string, state: string) => `consent-url?state=${state}`),
  exchangeCode: vi.fn(),
  listRecent: vi.fn(),
}));

vi.mock("node:http", () => ({
  createServer: (handler: RequestHandler) => {
    mocks.onRequest = handler;
    return { listen: mocks.listen, close: vi.fn() };
  },
}));
vi.mock("../src/oauth", () => ({ authUrl: mocks.authUrl, exchangeCode: mocks.exchangeCode }));
vi.mock("@checkin/receipt/gmail", () => ({ createGmailReader: () => ({ listRecent: mocks.listRecent }) }));

let dir: string;
let tokenFile: string;
let exit: ReturnType<typeof vi.fn>;

/** Sends one browser redirect to the CLI and returns the status it answered with. */
async function redirect(query: string): Promise<number> {
  let status = 0;
  const res: FakeResponse = {
    writeHead(s) {
      status = s;
      return res;
    },
    end: () => res,
  };
  if (!mocks.onRequest) throw new Error("the CLI created no server");
  await mocks.onRequest({ url: `/callback?${query}` }, res);
  vi.runAllTimers();
  return status;
}

/** Loads the CLI and reads the state it put in the printed consent URL. */
async function startConsent(): Promise<string> {
  await import("./consent");
  mocks.listen.mock.calls[0][1]();
  return mocks.authUrl.mock.calls[0][3];
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.onRequest = undefined;
  mocks.exchangeCode.mockResolvedValue({ accessToken: "fake-access", refreshToken: "fake-refresh" });
  mocks.listRecent.mockResolvedValue([]);
  exit = vi.fn();
  vi.spyOn(process, "exit").mockImplementation(exit as unknown as typeof process.exit);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), "gmail-consent-"));
  tokenFile = join(dir, "token.json");
  vi.stubEnv("GMAIL_CLIENT_ID", "fake-id");
  vi.stubEnv("GMAIL_CLIENT_SECRET", "fake-secret");
  vi.stubEnv("GMAIL_MAILBOX", "mailbox");
  vi.stubEnv("GMAIL_TOKEN_FILE", tokenFile);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("consent CLI", () => {
  it.each(["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_MAILBOX"])("refuses to start without %s", async (name) => {
    vi.stubEnv(name, "");
    await expect(import("./consent")).rejects.toThrow(/must be set/);
    expect(mocks.listen).not.toHaveBeenCalled();
  });

  it("refuses to start when the token file exists, leaving the file and the code alone", async () => {
    writeFileSync(tokenFile, "existing");
    await expect(import("./consent")).rejects.toThrow(/already exists/);
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(readFileSync(tokenFile, "utf8")).toBe("existing");
  });

  it("aborts on a wrong state without exchanging the code", async () => {
    await startConsent();
    expect(await redirect("state=wrong&code=fake-code")).toBe(400);
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(existsSync(tokenFile)).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("aborts on a missing code", async () => {
    const state = await startConsent();
    expect(await redirect(`state=${state}`)).toBe(400);
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exchanges the code and writes a 0600 token file when the state matches", async () => {
    const state = await startConsent();
    expect(await redirect(`state=${state}&code=fake-code`)).toBe(200);
    expect(mocks.exchangeCode).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(tokenFile, "utf8"))).toEqual({ refreshToken: "fake-refresh", mailbox: "mailbox" });
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
