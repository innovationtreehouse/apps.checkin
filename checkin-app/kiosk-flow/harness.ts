/**
 * Drives the real kiosk image for the kiosk flow tier. Everything runs in the app
 * container: the kiosk shares its network, so the kiosk's localhost proxy is
 * reachable here, and its /data is the volume mounted at /kiosk-data.
 */
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";

const CONTAINER = "kiosk-flow";
const DATA = "/kiosk-data";
const KIOSK_UID = 1000;
const KIOSK_PORT = 8083;
const SERVER_PORT = 4000;
const LINK_PORT = 4100;
export const KIOSK = `http://localhost:${KIOSK_PORT}`;

export type Image = "kiosk-flow:new" | "kiosk-flow:old";

function dockerApi<T = unknown>(method: string, apiPath: string, body?: unknown): Promise<{ status: number; json: T }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { socketPath: "/var/run/docker.sock", method, path: apiPath, headers: { "content-type": "application/json" } },
            (res) => {
                let text = "";
                res.on("data", (chunk) => { text += chunk; });
                res.on("end", () => {
                    if ((res.statusCode ?? 500) >= 400 && res.statusCode !== 404) {
                        reject(new Error(`docker ${method} ${apiPath}: ${res.statusCode} ${text}`));
                        return;
                    }
                    const isJson = res.headers["content-type"]?.includes("json");
                    resolve({ status: res.statusCode ?? 500, json: (isJson && text ? JSON.parse(text) : text) as T });
                });
            },
        );
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

export async function waitFor<T>(what: string, probe: () => Promise<T | false | null | undefined>, timeoutMs = 150_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const seen = await probe().catch(() => null);
        if (seen) return seen;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 500));
    }
}

const sockets = new Set<net.Socket>();
const link = net.createServer((inbound) => {
    const outbound = net.connect(SERVER_PORT, "localhost");
    for (const socket of [inbound, outbound]) {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
    }
    inbound.pipe(outbound).pipe(inbound);
});

/** The kiosk reaches the server only through this forwarder, so closing it is the outage. */
export function linkUp(): Promise<void> {
    return link.listening ? Promise.resolve() : new Promise((resolve) => link.listen(LINK_PORT, () => resolve()));
}
export function linkDown(): Promise<void> {
    if (!link.listening) return Promise.resolve();
    return new Promise((resolve) => {
        link.close(() => resolve());
        for (const socket of sockets) socket.destroy();
    });
}

function chownToKiosk(file: string): void {
    fs.chownSync(file, KIOSK_UID, KIOSK_UID);
}

/** An empty /data, as a new door would have, holding only the key, config and fake scanner. */
export function resetData(): void {
    fs.chownSync(DATA, KIOSK_UID, KIOSK_UID);
    for (const entry of fs.readdirSync(DATA)) fs.rmSync(path.join(DATA, entry), { recursive: true });
    fs.writeFileSync(`${DATA}/client.key`, Buffer.from(process.env.KIOSK_SIGNING_SEED ?? "", "hex"), { mode: 0o600 });
    fs.writeFileSync(`${DATA}/config.json`, JSON.stringify({
        backend_url: `http://localhost:${LINK_PORT}`,
        private_key_path: "./client.key",
        usb_device: "Fake scanner",
        listen_port: KIOSK_PORT,
        attendance_path: "/api/attendance",
    }));
    fs.copyFileSync(path.join(__dirname, "fake-evdev/evdev.py"), `${DATA}/evdev.py`);
    for (const file of ["client.key", "config.json", "evdev.py"]) chownToKiosk(`${DATA}/${file}`);
}

async function isHealthy(): Promise<boolean> {
    return (await fetch(`${KIOSK}/local-health`)).ok;
}

export const kioskHealthy = (): Promise<boolean> => isHealthy().catch(() => false);

/** Runs the image with the production flags that still apply away from the Pi. */
export async function startKiosk(image: Image): Promise<void> {
    await removeKiosk();
    const self = await dockerApi<{ Mounts: { Destination: string; Name: string }[] }>("GET", `/containers/${os.hostname()}/json`);
    const volume = self.json.Mounts.find((m) => m.Destination === DATA)?.Name;
    const created = await dockerApi<{ Id: string }>("POST", `/containers/create?name=${CONTAINER}`, {
        Image: image,
        Env: ["PYTHONPATH=/data"],
        // Plain logs, without the stream framing a non-TTY container adds.
        Tty: true,
        HostConfig: {
            NetworkMode: `container:${os.hostname()}`,
            ReadonlyRootfs: true,
            Tmpfs: { "/tmp": "" },
            CapDrop: ["ALL"],
            Binds: [`${volume}:/data`],
        },
    });
    await dockerApi("POST", `/containers/${created.json.Id}/start`);
    await waitFor(`${image} to report healthy`, isHealthy, 60_000);
}

/** A power cut: no shutdown runs. */
export async function killAndRestartKiosk(): Promise<void> {
    await dockerApi("POST", `/containers/${CONTAINER}/kill?signal=KILL`);
    await dockerApi("POST", `/containers/${CONTAINER}/start`);
    await waitFor("the kiosk to report healthy after a kill", isHealthy, 60_000);
}

/** The swap the host updater does: a clean stop, using the image's stop signal. */
export async function stopKiosk(): Promise<void> {
    await dockerApi("POST", `/containers/${CONTAINER}/stop?t=10`);
}

export async function removeKiosk(): Promise<void> {
    // The container goes with its logs, which are the only record of what the kiosk did.
    const logs = await dockerApi<string>("GET", `/containers/${CONTAINER}/logs?stdout=1&stderr=1`);
    if (logs.status === 200) console.log(logs.json);
    await dockerApi("DELETE", `/containers/${CONTAINER}?force=true`);
}

export function badge(personId: number): void {
    fs.writeFileSync(`${DATA}/badges`, `${personId}\n`);
}

/** Past the kiosk's filter, which treats two reads of one badge within 3 s as one scan. */
export const afterRepeatFilter = (): Promise<void> => new Promise((r) => setTimeout(r, 3_200));

/** Who the kiosk itself shows inside. Offline, this is its own view. */
export async function kioskShows(): Promise<number[]> {
    const res = await fetch(`${KIOSK}/api/attendance`);
    // The proxy rests the board's roster with a 204 while the building is known empty.
    if (res.status === 204) return [];
    const body = await res.json() as { attendance: { participant: { id: number } }[] };
    return body.attendance.map((v) => v.participant.id).sort((a, b) => a - b);
}

export interface Banners { text: () => string; stop: () => void; }

/** Follows the banners the kiosk pushes to its screen. */
export async function watchBanners(): Promise<Banners> {
    const abort = new AbortController();
    const res = await fetch(`${KIOSK}/events`, { signal: abort.signal });
    let text = "";
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    void (async () => {
        for (;;) {
            const chunk = await reader?.read();
            if (!chunk || chunk.done) return;
            text += decoder.decode(chunk.value);
        }
    })().catch(() => undefined);
    // The kiosk subscribes this stream before it sends the first status event.
    await waitFor("the kiosk's event stream", async () => text.includes("event: status"), 10_000);
    return { text: () => text, stop: () => abort.abort() };
}
