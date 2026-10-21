import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** One pairwise share. Each person you connect with gets their own share. */
export interface Share {
  /** Local slug, e.g. "leah". Also used in the default folder path. */
  name: string;
  /** Syncthing folder ID. Must be identical on both sides. */
  folderId: string;
  /** Absolute path of the synced folder on this machine. */
  folderPath: string;
  /** This agent's short name on this share, e.g. "matthew". Lowercase, [a-z0-9-]. */
  me: string;
  /** The other agent's short name on this share, e.g. "leah". */
  peer: string;
  /** The other Syncthing device's ID, if known yet. */
  peerDeviceId?: string;
  createdAt: string;
}

export interface Registry {
  shares: Share[];
}

export function agentbusHome(): string {
  return (
    process.env.AGENTBUS_HOME ??
    path.join(os.homedir(), ".agentbus")
  );
}

export function binDir(): string {
  return path.join(agentbusHome(), "bin");
}

/** Where this install keeps its Syncthing identity/config (self-contained). */
export function syncthingHome(): string {
  return (
    process.env.AGENTBUS_SYNCTHING_HOME ??
    path.join(agentbusHome(), "syncthing")
  );
}

export function stateDir(): string {
  return path.join(agentbusHome(), "state");
}

export function registryPath(): string {
  return path.join(agentbusHome(), "shares.json");
}

export function loadRegistry(): Registry {
  const p = registryPath();
  if (!fs.existsSync(p)) return { shares: [] };
  return JSON.parse(fs.readFileSync(p, "utf8")) as Registry;
}

export function saveRegistry(reg: Registry): void {
  fs.mkdirSync(agentbusHome(), { recursive: true });
  const tmp = registryPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n");
  fs.renameSync(tmp, registryPath());
}

export function getShare(name: string): Share {
  const reg = loadRegistry();
  const share = reg.shares.find((s) => s.name === name);
  if (!share) {
    throw new Error(
      `No share named "${name}". Run \`agentbus share list\` to see shares, or create one with \`agentbus share create\`.`,
    );
  }
  return share;
}

export function upsertShare(share: Share): void {
  const reg = loadRegistry();
  const i = reg.shares.findIndex((s) => s.name === share.name);
  if (i >= 0) reg.shares[i] = share;
  else reg.shares.push(share);
  saveRegistry(reg);
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!s) throw new Error(`Name "${name}" does not reduce to a usable slug.`);
  return s;
}

export function assertAgentName(name: string, what: string): string {
  const s = slugify(name);
  if (s !== name) {
    throw new Error(
      `${what} must be a lowercase slug ([a-z0-9-]); got "${name}", suggest "${s}".`,
    );
  }
  return s;
}
