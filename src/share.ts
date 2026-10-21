import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  agentbusHome,
  assertAgentName,
  slugify,
  upsertShare,
  type Share,
} from "./config.js";
import { addShareToSyncthing, myDeviceId } from "./syncthing.js";

export const PROTOCOL_VERSION = "1.3";

export function defaultFolderPath(name: string): string {
  return path.join(agentbusHome(), "shares", name);
}

/** The directory tree every share starts with. See docs/PROTOCOL.md. */
export function createShareLayout(share: Share): void {
  const root = share.folderPath;
  const dirs = [
    `inbox-${share.me}`,
    `inbox-${share.me}/processed`,
    `inbox-${share.peer}`,
    `inbox-${share.peer}/processed`,
    `agents/${share.me}`,
    `agents/${share.peer}`,
    "shared/state",
    "shared/reference",
    "shared/claims",
    "shared/log",
    "shared/projects",
    "shared/handoffs",
    "archive",
  ];
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });

  const readme = path.join(root, "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      `# Agent Bus share: ${share.me} <-> ${share.peer}\n\n` +
        `Protocol v${PROTOCOL_VERSION}. Messages are markdown files in \`inbox-<name>/\`.\n` +
        `A file in an inbox root is unhandled; the receiving agent moves it to \`processed/\` when handled.\n` +
        `Full protocol: https://github.com/matthewpwatkins/agent-bus/blob/main/docs/PROTOCOL.md\n`,
    );
  }
  writeHeartbeat(share);
}

export function writeHeartbeat(share: Share): void {
  const dir = path.join(share.folderPath, "agents", share.me);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "heartbeat.md"),
    `---\nagent: ${share.me}\nprotocol: ${PROTOCOL_VERSION}\nlast_seen: ${new Date().toISOString()}\n---\n\nOnline via Agent Bus.\n`,
  );
}

export async function createShare(opts: {
  name: string;
  me: string;
  peer: string;
  peerDeviceId?: string;
  folderPath?: string;
}): Promise<Share> {
  const name = slugify(opts.name);
  const me = assertAgentName(opts.me, "--me");
  const peer = assertAgentName(opts.peer, "--peer");
  const suffix = crypto.randomBytes(3).toString("hex");
  const share: Share = {
    name,
    folderId: `agentbus-${name}-${suffix}`,
    folderPath: opts.folderPath ?? defaultFolderPath(name),
    me,
    peer,
    peerDeviceId: opts.peerDeviceId,
    createdAt: new Date().toISOString(),
  };
  createShareLayout(share);
  upsertShare(share);
  const st = await addShareToSyncthing({
    folderId: share.folderId,
    folderPath: share.folderPath,
    label: `agent-bus ${name}`,
    peerDeviceId: share.peerDeviceId,
    peerName: peer,
  });
  if (!st.applied) {
    process.stderr.write(
      `note: share created on disk but not yet registered with Syncthing (${st.reason}). ` +
        `Start Syncthing (\`agentbus service start\`) and re-run \`agentbus share sync ${name}\`.\n`,
    );
  }
  return share;
}

export async function joinShare(opts: {
  name: string;
  me: string;
  peer: string;
  folderId: string;
  peerDeviceId: string;
  folderPath?: string;
}): Promise<Share> {
  const share: Share = {
    name: slugify(opts.name),
    folderId: opts.folderId,
    folderPath: opts.folderPath ?? defaultFolderPath(opts.name),
    me: assertAgentName(opts.me, "--me"),
    peer: assertAgentName(opts.peer, "--peer"),
    peerDeviceId: opts.peerDeviceId,
    createdAt: new Date().toISOString(),
  };
  createShareLayout(share);
  upsertShare(share);
  const st = await addShareToSyncthing({
    folderId: share.folderId,
    folderPath: share.folderPath,
    label: `agent-bus ${share.name}`,
    peerDeviceId: share.peerDeviceId,
    peerName: share.peer,
  });
  if (!st.applied) {
    process.stderr.write(
      `note: share joined on disk but not yet registered with Syncthing (${st.reason}). ` +
        `Start Syncthing (\`agentbus service start\`) and re-run \`agentbus share sync ${share.name}\`.\n`,
    );
  }
  return share;
}

/** The block you send to the other person/agent so they can join your share. */
export function inviteText(share: Share): string {
  let deviceId = "(run `agentbus id` on the creator's machine)";
  try {
    deviceId = myDeviceId();
  } catch {
    /* identity not generated yet */
  }
  return [
    `--- Agent Bus invite: ${share.name} ---`,
    `Share name:    ${share.name}`,
    `Folder ID:     ${share.folderId}`,
    `Creator device ID: ${deviceId}`,
    `You are:       ${share.peer}   (creator is: ${share.me})`,
    ``,
    `Join command (after cloning + building the repo, see README):`,
    `  agentbus share join --name ${share.name} --me ${share.peer} --peer ${share.me} \\`,
    `    --folder-id ${share.folderId} --peer-device-id ${deviceId}`,
    `Then: agentbus setup-messaging --share ${share.name}`,
    `--- end invite ---`,
  ].join("\n");
}
