import * as fs from "node:fs";
import * as path from "node:path";
import { stateDir, type Share } from "./config.js";
import { inboxDir } from "./messages.js";
import { pollEvents, readStConfig } from "./syncthing.js";

export function wakeFilePath(shareName: string): string {
  return path.join(stateDir(), `${shareName}.wake`);
}

export function listenerStatePath(shareName: string): string {
  return path.join(stateDir(), `${shareName}.listener.json`);
}

function appendWake(share: Share, fileName: string): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.appendFileSync(wakeFilePath(share.name), fileName + "\n");
}

/**
 * Long-running listener: subscribes to Syncthing's Events API (a long-poll
 * the daemon answers the instant a file finishes syncing) and appends the
 * names of newly arrived inbox files to a local wake file. A cheap checker
 * (the Muse hook template in templates/, or `agentbus check`) reads the
 * wake file -- that is the only polling in the system, and it polls a local
 * flag, not the network.
 */
export async function listen(share: Share): Promise<void> {
  const cfg = readStConfig();
  const inbox = inboxDir(share, "me");
  let since = 0;
  try {
    const s = JSON.parse(fs.readFileSync(listenerStatePath(share.name), "utf8")) as { since: number };
    since = s.since ?? 0;
  } catch {
    /* first run */
  }
  process.stderr.write(`agentbus listener: watching folder ${share.folderId} inbox ${inbox}\n`);
  for (;;) {
    try {
      // ItemFinished = a remote file finished pulling (the normal arrival
      // path). LocalChangeDetected = a file dropped into the folder locally
      // (manual drops, tests). Handle both shapes.
      const events = await pollEvents(cfg, since, ["ItemFinished", "LocalChangeDetected"]);
      for (const ev of events) {
        since = Math.max(since, ev.id);
        const folder = String(ev.data.folder ?? "");
        const item = String(ev.data.item ?? ev.data.path ?? "");
        const type = String(ev.data.type ?? "");
        if (folder !== share.folderId || type !== "file") continue;
        if (!item.startsWith(`inbox-${share.me}/`) || item.includes("/processed/")) continue;
        if (!item.endsWith(".md")) continue;
        appendWake(share, path.basename(item));
        process.stderr.write(`agentbus listener: new message ${item}\n`);
      }
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(listenerStatePath(share.name), JSON.stringify({ since }) + "\n");
    } catch (e) {
      process.stderr.write(`agentbus listener: ${e instanceof Error ? e.message : String(e)}; retrying in 5s\n`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/** Drain the wake file: returns pending filenames and clears it. */
export function drainWake(shareName: string): string[] {
  const p = wakeFilePath(shareName);
  if (!fs.existsSync(p)) return [];
  const names = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  fs.unlinkSync(p);
  return [...new Set(names)];
}
