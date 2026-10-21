import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Share } from "../src/config.js";
import {
  listInbox,
  messageFileName,
  processMessage,
  sendMessage,
} from "../src/messages.js";
import { createShareLayout } from "../src/share.js";

function testShare(): { share: Share; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbus-test-"));
  const share: Share = {
    name: "test",
    folderId: "agentbus-test-000000",
    folderPath: root,
    me: "alice",
    peer: "bob",
    createdAt: new Date().toISOString(),
  };
  createShareLayout(share);
  return { share, root };
}

test("filenames sort chronologically", () => {
  const a = messageFileName(new Date("2026-01-01T00:00:00Z"), "alice", "x");
  const b = messageFileName(new Date("2026-01-01T00:00:01Z"), "alice", "x");
  assert.ok(a < b, `${a} < ${b}`);
  assert.match(a, /^\d{8}-\d{6}Z-alice-x-[0-9a-f]{4}\.md$/);
});

test("send -> inbox -> process roundtrip", () => {
  const { share } = testShare();
  // Alice sends to Bob: file lands in inbox-bob.
  const { meta } = sendMessage(share, { body: "Hello Bob, please review the bill.", type: "request", requiresAction: true });
  assert.equal(meta.thread, meta.id); // new thread rooted at itself
  assert.ok(fs.existsSync(path.join(share.folderPath, "inbox-bob", `${meta.id}.md`)));

  // Bob's view of the same folder: swap me/peer.
  const bobView: Share = { ...share, me: "bob", peer: "alice" };
  const inbox = listInbox(bobView);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].meta.from, "alice");
  assert.equal(inbox[0].meta.requiresAction, true);
  assert.match(inbox[0].body, /Hello Bob/);

  // Bob processes it: moves to inbox-bob/processed, inbox empties.
  processMessage(bobView, meta.id);
  assert.equal(listInbox(bobView).length, 0);
  assert.ok(fs.existsSync(path.join(share.folderPath, "inbox-bob", "processed", `${meta.id}.md`)));
});
