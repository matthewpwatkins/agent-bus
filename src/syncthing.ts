import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { binDir, syncthingHome } from "./config.js";
import { loadProfile, relayAddressFor } from "./network.js";

export function syncthingBinary(): string {
  const local = path.join(binDir(), "syncthing");
  if (fs.existsSync(local)) return local;
  return "syncthing"; // fall back to PATH
}

export function configXmlPath(home = syncthingHome()): string {
  return path.join(home, "config.xml");
}

interface StConfig {
  apiKey: string;
  address: string;
  deviceId: string;
}

/**
 * This machine's own device ID, from the Syncthing binary itself.
 * Do NOT guess it from config.xml: the first <device> element there is not
 * guaranteed to be the local device (real-world configs list peers first),
 * and using a peer's ID as your own silently breaks folder registration.
 */
export function ownDeviceId(home = syncthingHome()): string {
  const out = execFileSync(syncthingBinary(), ["device-id", "-H", home], { encoding: "utf8" });
  const id = out.trim().split("\n")[0];
  if (!/^[A-Z2-7-]{50,}$/.test(id)) throw new Error(`Unexpected device-id output: ${out}`);
  return id;
}

/** Parse the few fields we need out of Syncthing's config.xml (no XML dep). */
export function readStConfig(home = syncthingHome()): StConfig {
  const xml = fs.readFileSync(configXmlPath(home), "utf8");
  const apiKey = xml.match(/<apikey>([^<]+)<\/apikey>/)?.[1];
  const address = xml.match(/<gui[^>]*>[\s\S]*?<address>([^<]+)<\/address>/)?.[1] ?? "127.0.0.1:8384";
  if (!apiKey) throw new Error(`Could not parse apikey from ${configXmlPath(home)}`);
  return { apiKey, address, deviceId: ownDeviceId(home) };
}

/** Generate a Syncthing identity in our home dir if none exists yet. */
export function ensureIdentity(): void {
  const home = syncthingHome();
  if (fs.existsSync(configXmlPath(home))) return;
  fs.mkdirSync(home, { recursive: true });
  const res = spawnSync(syncthingBinary(), ["generate", `--home=${home}`], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`syncthing generate failed: ${res.stderr || res.stdout}`);
  }
}

export function myDeviceId(): string {
  ensureIdentity();
  return ownDeviceId();
}

export function syncthingVersion(): string | null {
  try {
    const out = execFileSync(syncthingBinary(), ["--version"], { encoding: "utf8" });
    return out.trim().split("\n")[0];
  } catch {
    return null;
  }
}

async function rest(
  cfg: StConfig,
  method: string,
  p: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`http://${cfg.address}${p}`, {
    method,
    headers: {
      "X-API-Key": cfg.apiKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** True if the Syncthing daemon for our home dir is answering its API. */
export async function isRunning(): Promise<boolean> {
  try {
    const cfg = readStConfig();
    const r = await rest(cfg, "GET", "/rest/system/ping");
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Register a peer device + a send-receive folder with the running daemon.
 * Uses the config REST API (GET the current config object, PUT the new
 * device/folder objects) so no daemon restart is needed.
 */
export async function addShareToSyncthing(opts: {
  folderId: string;
  folderPath: string;
  label: string;
  peerDeviceId?: string;
  peerName?: string;
}): Promise<{ applied: boolean; reason?: string }> {
  let cfg: StConfig;
  try {
    cfg = readStConfig();
  } catch {
    return { applied: false, reason: "no Syncthing config yet" };
  }
  try {
    const ping = await rest(cfg, "GET", "/rest/system/ping");
    if (!ping.ok) return { applied: false, reason: "Syncthing daemon not running" };

    const configRes = await rest(cfg, "GET", "/rest/config");
    const config = (await configRes.json()) as {
      devices: Array<Record<string, unknown>>;
      folders: Array<Record<string, unknown>>;
    };

    const deviceIds = new Set([cfg.deviceId]);
    if (opts.peerDeviceId) {
      deviceIds.add(opts.peerDeviceId);
      if (!config.devices.some((d) => d.deviceID === opts.peerDeviceId)) {
        const put = await rest(cfg, "PUT", `/rest/config/devices/${opts.peerDeviceId}`, {
          deviceID: opts.peerDeviceId,
          name: opts.peerName ?? "",
          addresses: relayAddressFor(loadProfile(), opts.peerDeviceId),
          compression: "metadata",
          introducer: false,
          paused: false,
        });
        if (!put.ok) return { applied: false, reason: `device PUT failed: HTTP ${put.status}` };
      }
    }

    if (!config.folders.some((f) => f.id === opts.folderId)) {
      const put = await rest(cfg, "PUT", `/rest/config/folders/${opts.folderId}`, {
        id: opts.folderId,
        label: opts.label,
        path: opts.folderPath,
        type: "sendreceive",
        devices: [...deviceIds].map((deviceID) => ({ deviceID, encryptionPassword: "" })),
        rescanIntervalS: 3600,
        fsWatcherEnabled: true,
        fsWatcherDelayS: 1,
        ignorePerms: false,
        autoNormalize: true,
        paused: false,
      });
      if (!put.ok) return { applied: false, reason: `folder PUT failed: HTTP ${put.status}` };
    }
    return { applied: true };
  } catch (e) {
    return { applied: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Subscribe to Syncthing's event stream (long-poll). Used by the listener. */
export async function pollEvents(
  cfg: StConfig,
  since: number,
  events: string[],
  timeoutMs = 60_000,
): Promise<Array<{ id: number; type: string; data: Record<string, unknown> }>> {
  const qs = new URLSearchParams({ since: String(since), events: events.join(","), timeout: String(Math.ceil(timeoutMs / 1000)) });
  const r = await fetch(`http://${cfg.address}/rest/events?${qs}`, {
    headers: { "X-API-Key": cfg.apiKey },
  });
  if (!r.ok) throw new Error(`events API: HTTP ${r.status}`);
  return (await r.json()) as Array<{ id: number; type: string; data: Record<string, unknown> }>;
}
