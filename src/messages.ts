import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Share } from "./config.js";

export type MessageType = "request" | "response" | "note" | "handoff" | "ack";

export interface MessageMeta {
  id: string;
  from: string;
  to: string;
  sent: string; // ISO 8601
  type: MessageType;
  thread: string;
  priority: "normal" | "urgent";
  requiresAction: boolean;
  expires?: string;
}

export interface ParsedMessage {
  meta: MessageMeta;
  body: string;
  fileName: string;
  filePath: string;
}

/**
 * Filename format: `YYYYMMDD-HHMMSSZ-<sender>-<slug>.md`
 * The UTC timestamp prefix makes lexical sort == chronological order on both
 * machines, regardless of either agent's local timezone.
 */
export function messageFileName(date: Date, sender: string, slug: string): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  const rand = crypto.randomBytes(2).toString("hex");
  return `${stamp}-${sender}-${slug}-${rand}.md`;
}

export function composeMessage(
  meta: Omit<MessageMeta, "id" | "sent"> & { sent?: string },
  body: string,
  now = new Date(),
): { fileName: string; content: string; meta: MessageMeta } {
  const slug =
    body
      .split("\n")[0]
      ?.replace(/^#+\s*/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "message";
  const fileName = messageFileName(now, meta.from, slug);
  const full: MessageMeta = {
    ...meta,
    sent: meta.sent ?? now.toISOString(),
    id: fileName.replace(/\.md$/, ""),
  };
  const lines = [
    "---",
    `id: ${full.id}`,
    `from: ${full.from}`,
    `to: ${full.to}`,
    `sent: ${full.sent}`,
    `type: ${full.type}`,
    `thread: ${full.thread}`,
    `priority: ${full.priority}`,
    `requires_action: ${full.requiresAction}`,
  ];
  if (full.expires) lines.push(`expires: ${full.expires}`);
  lines.push("---", "", body.trim(), "");
  return { fileName, content: lines.join("\n"), meta: full };
}

/** Minimal frontmatter parser -- messages only ever contain the fields above. */
export function parseMessage(filePath: string): ParsedMessage {
  const raw = fs.readFileSync(filePath, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) throw new Error(`${filePath}: missing frontmatter`);
  const fields = new Map<string, string>();
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const get = (k: string) => fields.get(k) ?? "";
  const meta: MessageMeta = {
    id: get("id"),
    from: get("from"),
    to: get("to"),
    sent: get("sent"),
    type: (get("type") || "note") as MessageType,
    thread: get("thread"),
    priority: get("priority") === "urgent" ? "urgent" : "normal",
    requiresAction: get("requires_action") === "true",
    expires: get("expires") || undefined,
  };
  return {
    meta,
    body: raw.slice(m[0].length).trim(),
    fileName: path.basename(filePath),
    filePath,
  };
}

export function inboxDir(share: Share, who: "me" | "peer"): string {
  const name = who === "me" ? share.me : share.peer;
  return path.join(share.folderPath, `inbox-${name}`);
}

export function processedDir(share: Share): string {
  return path.join(inboxDir(share, "me"), "processed");
}

/** Unprocessed messages in my inbox, oldest first. Ignores processed/ and dotfiles. */
export function listInbox(share: Share): ParsedMessage[] {
  const dir = inboxDir(share, "me");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("."))
    .sort()
    .map((f) => parseMessage(path.join(dir, f)));
}

export function findMessage(share: Share, idOrFile: string): ParsedMessage {
  const msgs = listInbox(share);
  const hit =
    msgs.find((m) => m.meta.id === idOrFile) ??
    msgs.find((m) => m.fileName === idOrFile) ??
    msgs.find((m) => m.meta.id.includes(idOrFile));
  if (!hit) throw new Error(`No unprocessed message matching "${idOrFile}" in inbox-${share.me}.`);
  return hit;
}

/** Write a new message from me into the peer's inbox. Returns the file path. */
export function sendMessage(
  share: Share,
  opts: {
    type?: MessageType;
    body: string;
    thread?: string;
    priority?: "normal" | "urgent";
    requiresAction?: boolean;
    expires?: string;
  },
): { filePath: string; meta: MessageMeta } {
  const dir = inboxDir(share, "peer");
  fs.mkdirSync(dir, { recursive: true });
  const { fileName, content, meta } = composeMessage(
    {
      from: share.me,
      to: share.peer,
      type: opts.type ?? "note",
      thread: opts.thread ?? "new",
      priority: opts.priority ?? "normal",
      requiresAction: opts.requiresAction ?? false,
      expires: opts.expires,
    },
    opts.body,
  );
  if (meta.thread === "new") {
    // A new thread is rooted at its own message id.
    const withThread = content.replace(/^thread: new$/m, `thread: ${meta.id}`);
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, withThread);
    return { filePath, meta: { ...meta, thread: meta.id } };
  }
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content);
  return { filePath, meta };
}

/**
 * Mark a message handled: move it (name and content unchanged) into my
 * inbox's processed/ subfolder. Only the receiving agent ever does this --
 * the sender never touches a file it sent.
 */
export function processMessage(share: Share, idOrFile: string): string {
  const msg = findMessage(share, idOrFile);
  const dest = processedDir(share);
  fs.mkdirSync(dest, { recursive: true });
  const destPath = path.join(dest, msg.fileName);
  fs.renameSync(msg.filePath, destPath);
  return destPath;
}

/** Prune processed messages older than `days`. Returns how many were removed. */
export function pruneProcessed(share: Share, days = 90): number {
  const dir = processedDir(share);
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).mtimeMs < cutoff) {
      fs.unlinkSync(p);
      n++;
    }
  }
  return n;
}
