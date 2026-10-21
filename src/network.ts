import * as fs from "node:fs";
import * as path from "node:path";
import { agentbusHome, syncthingHome } from "./config.js";
import { configXmlPath } from "./syncthing.js";

/**
 * The hardened network profile.
 *
 * Stock Syncthing is chatty: global discovery servers, a pool of dozens of
 * public relays, STUN servers, update checks, crash reporting. Agent Bus
 * turns all of that off and pins exactly ONE relay, chosen once at setup.
 * Resulting egress after install: GitHub (one-time binary download) and the
 * single pinned relay. Peer rendezvous happens through that relay because
 * each peer device's address is set to it explicitly (never "dynamic").
 */

export interface NetworkProfile {
  relay: string | null; // e.g. "relay://203.0.113.10:22067"
  listenPort: number;
  appliedAt: string;
}

function profilePath(): string {
  return path.join(agentbusHome(), "network.json");
}

export function loadProfile(): NetworkProfile | null {
  try {
    return JSON.parse(fs.readFileSync(profilePath(), "utf8")) as NetworkProfile;
  } catch {
    return null;
  }
}

export function saveProfile(p: NetworkProfile): void {
  fs.mkdirSync(agentbusHome(), { recursive: true });
  fs.writeFileSync(profilePath(), JSON.stringify(p, null, 2) + "\n");
}

/** Fetch the public relay pool list (URLs include each relay's own device ID). */
async function fetchRelayPool(): Promise<string[]> {
  try {
    const res = await fetch("https://relays.syncthing.net/endpoint", {
      headers: { "User-Agent": "agent-bus" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { relays?: Array<{ url?: string }> };
    return (data.relays ?? [])
      .map((r) => r.url)
      .filter((u): u is string => typeof u === "string" && u.startsWith("relay://"));
  } catch {
    return [];
  }
}

/** Pick one relay from the public pool, once. Called a single time at setup. */
export async function pickRelay(): Promise<string | null> {
  const urls = await fetchRelayPool();
  if (!urls.length) return null;
  // Keep the full URL, including ?id=<relay's device ID>: Syncthing verifies
  // that ID when dialing the relay for a peer session (see relayAddressFor).
  return urls[Math.floor(Math.random() * urls.length)];
}

/** Split a relay URL into its base (relay://host:port) and the relay's device ID, if present. */
export function parseRelay(relay: string): { base: string; id: string | null } {
  const [rawBase, qs] = relay.split("?");
  const base = rawBase.replace(/\/+$/, "");
  const id = qs ? new URLSearchParams(qs).get("id") : null;
  return { base, id };
}

/**
 * Ensure a relay URL carries the relay server's own device ID (?id=...).
 * If it doesn't, look the relay up in the public pool by host:port.
 * Returns the URL unchanged when the ID can't be determined.
 */
export async function normalizeRelay(relay: string): Promise<string> {
  const { base, id } = parseRelay(relay);
  if (id) return relay;
  const pool = await fetchRelayPool();
  const match = pool.find((u) => parseRelay(u).base === base && parseRelay(u).id);
  return match ?? relay;
}

function setTag(xml: string, tag: string, value: string): string {
  const re = new RegExp(`<${tag}>[^<]*</${tag}>`);
  if (re.test(xml)) return xml.replace(re, `<${tag}>${value}</${tag}>`);
  // Insert before </options> if the tag is missing.
  return xml.replace(/<\/options>/, `        <${tag}>${value}</${tag}>\n    </options>`);
}

/**
 * Rewrite the <options> block of a Syncthing config.xml (pure function, so it
 * is unit-testable). Only the global options are touched: listen addresses
 * and the announce/NAT/reporting switches.
 */
export function applyProfileToXml(xml: string, profile: NetworkProfile): string {
  const listen = [
    `        <listenAddress>tcp://0.0.0.0:${profile.listenPort}</listenAddress>`,
    ...(profile.relay ? [`        <listenAddress>${profile.relay}</listenAddress>`] : []),
  ].join("\n");

  // Replace the whole listenAddress run inside <options>...</options>.
  xml = xml.replace(
    /(<options>)([\s\S]*?)(<\/options>)/,
    (_m, open: string, inner: string, close: string) => {
      const withoutListen = inner.replace(/[ \t]*<listenAddress>[^<]*<\/listenAddress>\n?/g, "");
      return `${open}\n${listen}\n${withoutListen}${close}`;
    },
  );

  const settings: Record<string, string> = {
    globalAnnounceEnabled: "false",
    localAnnounceEnabled: "false",
    natEnabled: "false",
    crashReportingEnabled: "false",
    autoUpgradeIntervalH: "0",
    urAccepted: "-1", // decline usage reporting -> no reporting endpoint contact
    relaysEnabled: profile.relay ? "true" : "false",
    stunKeepaliveStartS: "0",
  };
  for (const [tag, value] of Object.entries(settings)) xml = setTag(xml, tag, value);
  return xml;
}

/**
 * The explicit address used to reach ANY peer through the pinned relay.
 *
 * Relay-protocol semantics (learned the hard way, 2026-10-20): the ?id= in a
 * relay address is the RELAY SERVER's device ID, not the peer's -- Syncthing
 * verifies it against the relay it actually dials ("relay id does not
 * match") and finds the target peer from the device entry the address
 * belongs to. Addressing it with the peer's device ID (v0.1's behavior)
 * makes every outbound session dial fail.
 */
export function relayAddressFor(profile: NetworkProfile | null, _peerDeviceId: string): string[] {
  if (!profile?.relay) return ["dynamic"];
  const { base, id } = parseRelay(profile.relay);
  return [id ? `${base}/?id=${id}` : base];
}

/**
 * Apply the profile to this install's config.xml.
 * The daemon must NOT be running (it would overwrite config on exit).
 */
export async function configureNetwork(opts: { relay?: string; listenPort?: number } = {}): Promise<NetworkProfile> {
  const existing = loadProfile();
  const chosen = opts.relay ?? existing?.relay ?? (await pickRelay());
  const relay = chosen ? await normalizeRelay(chosen) : null;
  const profile: NetworkProfile = {
    relay,
    listenPort: opts.listenPort ?? existing?.listenPort ?? 22000,
    appliedAt: new Date().toISOString(),
  };
  const home = syncthingHome();
  const p = configXmlPath(home);
  if (!fs.existsSync(p)) {
    throw new Error("No Syncthing config yet. Run `agentbus id` once to generate an identity, stop Syncthing if it is running, then re-run configure-network.");
  }
  const xml = fs.readFileSync(p, "utf8");
  const bak = p + ".bak-agentbus";
  if (!fs.existsSync(bak)) fs.copyFileSync(p, bak);
  fs.writeFileSync(p, applyProfileToXml(xml, profile));
  saveProfile(profile);
  return profile;
}
