import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { binDir } from "./config.js";
import { syncthingVersion } from "./syncthing.js";

function assetName(version: string): string {
  const platform = os.platform();
  const archMap: Record<string, string> = { x64: "amd64", arm64: "arm64", arm: "arm" };
  const arch = archMap[os.arch()] ?? os.arch();
  const osMap: Record<string, string> = { linux: "linux", darwin: "macos", freebsd: "freebsd" };
  const osName = osMap[platform];
  if (!osName) throw new Error(`Unsupported platform: ${platform}`);
  return `syncthing-${osName}-${arch}-v${version}`;
}

/**
 * Download the official Syncthing release binary and install it into
 * <agentbus home>/bin. Idempotent: skips if a binary is already there
 * unless `force` is set.
 */
export async function installSyncthing(opts: { version?: string; force?: boolean } = {}): Promise<string> {
  const dest = path.join(binDir(), "syncthing");
  if (fs.existsSync(dest) && !opts.force) {
    return `Syncthing already installed: ${syncthingVersion()} at ${dest}`;
  }
  let version = opts.version;
  if (!version) {
    const rel = await fetch("https://api.github.com/repos/syncthing/syncthing/releases/latest", {
      headers: { "User-Agent": "agent-bus" },
    });
    if (!rel.ok) throw new Error(`Could not query latest Syncthing release: HTTP ${rel.status}`);
    const json = (await rel.json()) as { tag_name: string };
    version = json.tag_name.replace(/^v/, "");
  }
  const name = assetName(version);
  const url = `https://github.com/syncthing/syncthing/releases/download/v${version}/${name}.tar.gz`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentbus-st-"));
  const tarball = path.join(tmp, `${name}.tar.gz`);
  const res = await fetch(url, { headers: { "User-Agent": "agent-bus" } });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  execFileSync("tar", ["-xzf", tarball, "-C", tmp]);
  const binary = path.join(tmp, name, "syncthing");
  if (!fs.existsSync(binary)) throw new Error(`Release archive did not contain ${name}/syncthing`);
  fs.mkdirSync(binDir(), { recursive: true });
  fs.copyFileSync(binary, dest);
  fs.chmodSync(dest, 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
  return `Installed ${syncthingVersion()} at ${dest}`;
}
