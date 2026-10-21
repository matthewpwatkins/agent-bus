#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import {
  agentbusHome,
  getShare,
  loadRegistry,
  stateDir,
} from "./config.js";
import { installSyncthing } from "./install.js";
import { drainWake, listen } from "./listen.js";
import {
  findMessage,
  inboxDir,
  listInbox,
  processMessage,
  pruneProcessed,
  sendMessage,
} from "./messages.js";
import { installSyncthingService, setupMessaging, startSyncthingService } from "./service.js";
import { createShare, inviteText, joinShare, writeHeartbeat } from "./share.js";
import { isRunning, myDeviceId, syncthingVersion } from "./syncthing.js";

const HELP = `agentbus -- a store-and-forward message bus between personal AI agents

Usage:
  agentbus install-syncthing [--version X.Y.Z] [--force]
  agentbus service install|start            Manage the Syncthing systemd service
  agentbus configure-network [--relay relay://host:port] [--listen-port N]
                                             Apply the hardened network profile (daemon must be stopped)
  agentbus id                                Print this machine's Syncthing device ID
  agentbus status                            Syncthing + shares overview

  agentbus share create --name <slug> --me <name> --peer <name> [--peer-device-id ID]
  agentbus share join --name <slug> --me <name> --peer <name> --folder-id ID --peer-device-id ID
  agentbus share invite <name>               Print the invite block to send your partner
  agentbus share sync <name>                 (Re)register a share with the running Syncthing
  agentbus share list

  agentbus setup-messaging --share <name>    Listener service + Muse hook script
  agentbus listen --share <name>             Run the event listener in the foreground
  agentbus check --share <name> [--mark-seen] Print filenames of unseen inbox messages
  agentbus sweep --share <name>              Reconcile: clear seen-state for vanished files

  agentbus send --share <name> [--type request|response|note|handoff|ack]
                [--thread ID] [--urgent] [--requires-action] (--body TEXT | --body-file F | -)
  agentbus inbox --share <name>              List unprocessed messages (oldest first)
  agentbus read --share <name> <id|file>     Print one message
  agentbus ack --share <name> <id> [--body TEXT]
  agentbus reply --share <name> <id> --body TEXT
  agentbus process --share <name> <id|file>  Move a handled message to processed/
  agentbus heartbeat --share <name>          Refresh my heartbeat file on the share
  agentbus prune --share <name> [--days 90]  Delete old processed messages

Environment:
  AGENTBUS_HOME           Data root (default ~/.agentbus)
  AGENTBUS_SYNCTHING_HOME Syncthing config dir (default $AGENTBUS_HOME/syncthing)
`;

function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags.set(a.slice(2), argv[++i]);
      else flags.set(a.slice(2), true);
    } else positional.push(a);
  }
  return { positional, flags };
}

function need(flags: Map<string, string | true>, name: string): string {
  const v = flags.get(name);
  if (typeof v !== "string" || !v) throw new Error(`Missing required --${name}`);
  return v;
}

function opt(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function seenPath(shareName: string): string {
  return path.join(stateDir(), `${shareName}.seen.json`);
}

function loadSeen(shareName: string): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(seenPath(shareName), "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

function saveSeen(shareName: string, seen: Set<string>): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(seenPath(shareName), JSON.stringify([...seen]) + "\n");
}

async function readBody(flags: Map<string, string | true>): Promise<string> {
  const body = opt(flags, "body");
  if (body) return body;
  const file = opt(flags, "body-file");
  if (file) return fs.readFileSync(file, "utf8");
  // stdin
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }
  const { positional, flags } = parseArgs([sub, ...rest].filter(Boolean) as string[]);

  switch (cmd) {
    case "install-syncthing": {
      process.stdout.write((await installSyncthing({ version: opt(flags, "version"), force: flags.has("force") })) + "\n");
      return;
    }
    case "service": {
      if (sub === "install") process.stdout.write((await installSyncthingService()) + "\n");
      else if (sub === "start") process.stdout.write(startSyncthingService() + "\n");
      else throw new Error("Usage: agentbus service install|start");
      return;
    }
    case "configure-network": {
      const { configureNetwork } = await import("./network.js");
      const { isRunning } = await import("./syncthing.js");
      if (await isRunning()) throw new Error("Syncthing is running. Stop it first (its config is rewritten on exit): systemctl stop agentbus-syncthing.service");
      const p = await configureNetwork({ relay: opt(flags, "relay"), listenPort: opt(flags, "listen-port") ? Number(opt(flags, "listen-port")) : undefined });
      process.stdout.write(`Network profile applied: discovery/NAT/reporting off, listen :${p.listenPort}, relay ${p.relay ?? "(none)"}.\n`);
      return;
    }
    case "id": {
      process.stdout.write(myDeviceId() + "\n");
      return;
    }
    case "status": {
      const ver = syncthingVersion() ?? "(not installed)";
      const running = await isRunning().catch(() => false);
      const reg = loadRegistry();
      process.stdout.write(
        `Syncthing: ${ver}, daemon ${running ? "running" : "not running"}\n` +
          `AGENTBUS_HOME: ${agentbusHome()}\n` +
          `Device ID: ${running || fs.existsSync(path.join(agentbusHome(), "syncthing", "config.xml")) ? safeId() : "(no identity yet)"}\n` +
          `Shares: ${reg.shares.map((s) => `${s.name} (${s.me}<->${s.peer}, ${s.folderId})`).join(", ") || "none"}\n`,
      );
      return;
    }
    case "share": {
      if (sub === "create") {
        const share = await createShare({
          name: need(flags, "name"),
          me: need(flags, "me"),
          peer: need(flags, "peer"),
          peerDeviceId: opt(flags, "peer-device-id"),
          folderPath: opt(flags, "path"),
        });
        process.stdout.write(`Share "${share.name}" created at ${share.folderPath} (folder ${share.folderId}).\n\n` + inviteText(share) + "\n");
      } else if (sub === "join") {
        const share = await joinShare({
          name: need(flags, "name"),
          me: need(flags, "me"),
          peer: need(flags, "peer"),
          folderId: need(flags, "folder-id"),
          peerDeviceId: need(flags, "peer-device-id"),
          folderPath: opt(flags, "path"),
        });
        process.stdout.write(`Joined share "${share.name}" at ${share.folderPath}. Run: agentbus setup-messaging --share ${share.name}\n`);
      } else if (sub === "invite") {
        process.stdout.write(inviteText(getShare(positional[1] ?? need(flags, "name"))) + "\n");
      } else if (sub === "sync") {
        const share = getShare(positional[1] ?? need(flags, "name"));
        const { addShareToSyncthing } = await import("./syncthing.js");
        const r = await addShareToSyncthing({
          folderId: share.folderId,
          folderPath: share.folderPath,
          label: `agent-bus ${share.name}`,
          peerDeviceId: share.peerDeviceId,
          peerName: share.peer,
        });
        process.stdout.write(r.applied ? `Share "${share.name}" registered with Syncthing.\n` : `Not applied: ${r.reason}\n`);
      } else if (sub === "list") {
        const reg = loadRegistry();
        for (const s of reg.shares) {
          process.stdout.write(`${s.name}\t${s.me}<->${s.peer}\t${s.folderId}\t${s.folderPath}\n`);
        }
        if (!reg.shares.length) process.stdout.write("No shares yet.\n");
      } else {
        throw new Error("Usage: agentbus share create|join|invite|sync|list ...");
      }
      return;
    }
    case "setup-messaging": {
      process.stdout.write(setupMessaging(getShare(need(flags, "share"))) + "\n");
      return;
    }
    case "listen": {
      await listen(getShare(need(flags, "share")));
      return;
    }
    case "check": {
      const share = getShare(need(flags, "share"));
      drainWake(share.name); // the wake file is a hint; the inbox is the truth
      const seen = loadSeen(share.name);
      const fresh = listInbox(share).filter((m) => !seen.has(m.meta.id));
      if (flags.has("mark-seen")) {
        for (const m of fresh) seen.add(m.meta.id);
        saveSeen(share.name, seen);
      }
      for (const m of fresh) process.stdout.write(m.fileName + "\n");
      return;
    }
    case "sweep": {
      const share = getShare(need(flags, "share"));
      const present = new Set(listInbox(share).map((m) => m.meta.id));
      const seen = loadSeen(share.name);
      for (const id of [...seen]) if (!present.has(id)) seen.delete(id);
      saveSeen(share.name, seen);
      process.stdout.write(`Seen-state reconciled: ${seen.size} seen, ${present.size} unprocessed in inbox.\n`);
      return;
    }
    case "send": {
      const share = getShare(need(flags, "share"));
      const body = await readBody(flags);
      if (!body.trim()) throw new Error("Empty message body.");
      const { filePath, meta } = sendMessage(share, {
        type: (opt(flags, "type") as never) ?? "note",
        body,
        thread: opt(flags, "thread"),
        priority: flags.has("urgent") ? "urgent" : "normal",
        requiresAction: flags.has("requires-action"),
        expires: opt(flags, "expires"),
      });
      writeHeartbeat(share);
      process.stdout.write(`Sent ${meta.id} -> inbox-${share.peer} (${filePath})\n`);
      return;
    }
    case "inbox": {
      const share = getShare(need(flags, "share"));
      const msgs = listInbox(share);
      if (!msgs.length) process.stdout.write("Inbox empty.\n");
      for (const m of msgs) {
        process.stdout.write(`${m.meta.sent}\t${m.meta.from}\t${m.meta.type}${m.meta.requiresAction ? "\tACTION" : ""}\t${m.meta.id}\t${m.body.split("\n")[0].slice(0, 80)}\n`);
      }
      return;
    }
    case "read": {
      const share = getShare(need(flags, "share"));
      const m = findMessage(share, positional[0]);
      process.stdout.write(`--- ${m.meta.id} (${m.meta.type}, from ${m.meta.from}, ${m.meta.sent}) ---\n${m.body}\n`);
      return;
    }
    case "ack": {
      const share = getShare(need(flags, "share"));
      const orig = findMessage(share, positional[0]);
      const { meta } = sendMessage(share, {
        type: "ack",
        thread: orig.meta.thread,
        body: opt(flags, "body") ?? `Ack: received and handled ${orig.meta.id}.`,
      });
      process.stdout.write(`Ack sent (${meta.id}) for ${orig.meta.id}.\n`);
      return;
    }
    case "reply": {
      const share = getShare(need(flags, "share"));
      const orig = findMessage(share, positional[0]);
      const body = await readBody(flags);
      const { meta } = sendMessage(share, {
        type: "response",
        thread: orig.meta.thread,
        body: `Re: ${orig.meta.id}\n\n${body}`,
      });
      process.stdout.write(`Reply sent (${meta.id}) in thread ${orig.meta.thread}.\n`);
      return;
    }
    case "process": {
      const share = getShare(need(flags, "share"));
      const dest = processMessage(share, positional[0]);
      process.stdout.write(`Processed -> ${dest}\n`);
      return;
    }
    case "heartbeat": {
      const share = getShare(need(flags, "share"));
      writeHeartbeat(share);
      process.stdout.write(`Heartbeat updated for ${share.me} on share ${share.name}.\n`);
      return;
    }
    case "prune": {
      const share = getShare(need(flags, "share"));
      const days = Number(opt(flags, "days") ?? 90);
      process.stdout.write(`Pruned ${pruneProcessed(share, days)} processed message(s) older than ${days} days.\n`);
      return;
    }
    default:
      throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

function safeId(): string {
  try {
    return myDeviceId();
  } catch {
    return "(unknown)";
  }
}

main().catch((e) => {
  process.stderr.write(`agentbus: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
