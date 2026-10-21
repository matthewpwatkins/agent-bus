import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { agentbusHome, syncthingHome, type Share } from "./config.js";
import { syncthingBinary } from "./syncthing.js";

function cliJsPath(): string {
  // dist/service.js -> dist/cli.js
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
}

function trySystemctl(args: string[]): boolean {
  const r = spawnSync("systemctl", args, { encoding: "utf8" });
  return r.status === 0;
}

function installUnit(name: string, content: string): { installed: boolean; unitPath: string } {
  const staging = path.join(agentbusHome(), "systemd");
  fs.mkdirSync(staging, { recursive: true });
  const staged = path.join(staging, name);
  fs.writeFileSync(staged, content);
  const target = path.join("/etc/systemd/system", name);
  const cp = spawnSync("install", ["-m", "644", staged, target], { encoding: "utf8" });
  if (cp.status !== 0) return { installed: false, unitPath: staged };
  trySystemctl(["daemon-reload"]);
  return { installed: true, unitPath: target };
}

/** systemd unit that runs Syncthing itself out of the agentbus home dir. */
export async function installSyncthingService(): Promise<string> {
  // Identity + hardened network profile BEFORE the daemon ever starts, so a
  // fresh install never makes stock Syncthing's many outbound connections.
  const { ensureIdentity, isRunning } = await import("./syncthing.js");
  const { configureNetwork, loadProfile } = await import("./network.js");
  ensureIdentity();
  if (!(await isRunning()) && !loadProfile()) {
    const p = await configureNetwork();
    process.stderr.write(
      `Network profile applied: discovery/NAT/reporting off, listen :${p.listenPort}` +
        (p.relay ? `, pinned relay ${p.relay}` : ", no relay (direct connections only)") +
        `.\n`,
    );
  }
  const unit = `[Unit]
Description=Syncthing (Agent Bus)
After=network.target

[Service]
ExecStart=${syncthingBinary()} serve --home=${syncthingHome()} --no-browser --no-restart
Restart=on-failure
RestartSec=5
TimeoutStopSec=10

[Install]
WantedBy=default.target
`;
  const { installed, unitPath } = installUnit("agentbus-syncthing.service", unit);
  if (installed) {
    trySystemctl(["enable", "--now", "agentbus-syncthing.service"]);
    return `Syncthing service installed and started (${unitPath}).`;
  }
  return `Could not write to /etc/systemd/system (no permission). Unit saved at ${unitPath} -- install it with: sudo install -m 644 ${unitPath} /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now agentbus-syncthing.service`;
}

export function startSyncthingService(): string {
  if (trySystemctl(["start", "agentbus-syncthing.service"])) return "Syncthing service started.";
  return "Could not start agentbus-syncthing.service via systemctl. Is it installed? Try `agentbus service install`, or start Syncthing manually: `syncthing serve --home=" + syncthingHome() + "`.";
}

/**
 * Set up everything on this machine that turns "a file synced into my inbox"
 * into "my agent wakes up":
 *  1. a systemd listener service (Syncthing Events API -> wake file),
 *  2. a Muse hook script in ~/hooks/scripts (the agent registers the hook
 *     itself -- this CLI only writes the script and prints the instruction),
 *  3. a printed fallback: an hourly reconciliation sweep for a cron.
 */
export function setupMessaging(share: Share): string {
  const lines: string[] = [];
  const listenerUnit = `[Unit]
Description=Agent Bus listener (${share.name})
After=agentbus-syncthing.service network.target

[Service]
Environment=AGENTBUS_HOME=${agentbusHome()}
ExecStart=${process.execPath} ${cliJsPath()} listen --share ${share.name}
Restart=always
RestartSec=5
TimeoutStopSec=10

[Install]
WantedBy=default.target
`;
  const unitName = `agentbus-listener-${share.name}.service`;
  const { installed, unitPath } = installUnit(unitName, listenerUnit);
  if (installed) {
    trySystemctl(["enable", "--now", unitName]);
    lines.push(`Listener service installed and started (${unitPath}).`);
  } else {
    lines.push(`Listener unit saved at ${unitPath} (could not install to /etc/systemd/system -- install it like the Syncthing unit in the docs).`);
  }

  // Muse hook script
  const hookDir = path.join(os.homedir(), "hooks", "scripts");
  fs.mkdirSync(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, `agentbus-${share.name}.sh`);
  const cliDir = path.dirname(cliJsPath());
  fs.writeFileSync(
    hookPath,
    `#!/usr/bin/env bash
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"
export AGENTBUS_HOME="${agentbusHome()}"
NEW="$(${process.execPath} ${cliDir}/cli.js check --share ${share.name} --mark-seen 2>/dev/null || true)"
if [ -n "$NEW" ]; then
  wake "new Agent Bus message(s) in share ${share.name}" "{\\"files\\": \\"$(echo "$NEW" | paste -sd, -)\\"}"
else
  silent "no new messages"
fi
`,
  );
  fs.chmodSync(hookPath, 0o755);
  lines.push(`Muse hook script written: ${hookPath}`);
  lines.push(
    `Ask your Muse agent to register it: hooks.add with id "agentbus-${share.name}", script_path "${hookPath}", poll interval 15 seconds, then dry-run and enable it. The hook prompt should tell the agent to run \`agentbus inbox --share ${share.name}\`, handle each message per docs/PROTOCOL.md and its user's sharing rules, ack/reply via \`agentbus ack|reply\`, and finish with \`agentbus process\`.`,
  );
  lines.push(
    `Fallback safety net (recommended regardless): ask your agent for an hourly silent cron that runs \`agentbus inbox --share ${share.name}\` and reconciles anything the event path missed.`,
  );
  return lines.join("\n");
}
