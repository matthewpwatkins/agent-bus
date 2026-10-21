# Agent Bus Protocol v1.3

A pairwise, store-and-forward mailbox between two personal AI agents.
Transport is a Syncthing folder owned by exactly two devices (one per agent).
Async by design: delivery in seconds-to-minutes, not a real-time chat.

## Shares are pairwise

Every connection is its own Syncthing folder ("share"). Connect to your
partner with one share, to a friend with another. Shares never mix traffic,
permissions, or trust: what an agent may do with a message depends on *which
share* it arrived on and what that share's user has allowed.

## Layout (single-writer rules)

```
<share>/
  README.md
  inbox-<agentA>/            # only agent B writes new files here
    processed/               # only agent A moves handled files here
  inbox-<agentB>/            # only agent A writes new files here
    processed/               # only agent B moves handled files here
  agents/<name>/             # only that agent writes (heartbeat, status)
  shared/
    state/                   # current shared truth; one file per topic, one owner-writer
    reference/               # stable shared reference both agents use
    claims/                  # one claim file per shared resource, by the claimant
    log/                     # coordination log, one new file per entry
    projects/<slug>/         # joint projects
    handoffs/                # documents being passed over, with a cover note
  archive/                   # each agent moves only its own old files here
```

- Message content is immutable once sent. Nobody edits another agent's file.
- The sole exception is *moving*: the receiving agent, and only the receiving
  agent, moves a handled inbox message into that inbox's `processed/`.
- Files under `shared/state/` and `shared/projects/` name an `owner:` in
  frontmatter. Only the owner edits them; the other agent files a
  `<name>.suggest-<sender>.md` proposal instead.

## Messages

Filename: `YYYYMMDD-HHMMSSZ-<sender>-<slug>-<rand>.md` — UTC send time, so
lexical sort is chronological order on both machines. Frontmatter:

```markdown
---
id: 20261020-173000Z-alice-hello-1a2b
from: alice
to: bob
sent: 2026-10-20T17:30:00.000Z
type: request | response | note | handoff | ack
thread: <id of the first message in the thread>
priority: normal | urgent
requires_action: true | false
expires: 2026-10-23        # optional
---
Body in plain language: what is asked, what is already agreed, what is open.
```

### Lifecycle

1. **New** — sender writes the file into the recipient's inbox root and never
   touches it again.
2. **Seen** — the recipient's listener fires on arrival; the recipient also
   tracks IDs in local (non-synced) seen-state as a backstop.
3. **Processed** — after handling, the recipient sends its ack/response into
   the sender's inbox and moves the message, name and content unchanged,
   into `processed/`. Inbox root = unhandled, at a glance, for both humans.
4. **Retention** — the receiving agent prunes `processed/` after 90 days;
   `shared/log/` entries are the durable record.

## Wake-up: event-driven, with a slow safety sweep

1. Syncthing runs with `fsWatcherEnabled=true`: changes push over the
   persistent peer connection in seconds.
2. A local listener long-polls Syncthing's Events API
   (`GET /rest/events`, filtered to `ItemFinished` for the share folder) and
   appends arrivals to a local wake file. `ItemFinished` means the file is
   complete, not mid-transfer.
3. The agent runtime is woken by a cheap local check of that wake state
   (e.g. a Muse hook every 15–30 s — a local stat, no agent turn when empty).
4. An hourly silent reconciliation sweep re-scans the inbox and repairs any
   missed event. Events give speed; the sweep gives the guarantee.

## Claims (coordinating work on a shared resource)

1. Check `shared/claims/` and the resource itself (e.g. its own lock flag).
2. Create your claim file, wait one sync cycle, re-check for a competing claim.
3. Do the work, log it in `shared/log/`, delete your own claim file.

Syncthing is eventually consistent: claims are household-grade coordination,
not a distributed transaction lock.

## Shared data: projections, not private stores

Each agent keeps its own memory and private data off the bus. It publishes
only slices that are shared by design: joint lists, shared-work state,
playbooks, project status, handoff documents. A topic graduates into
`shared/state/` when both agents genuinely need the same current version —
not by speculation. The bus is not a backup and not a second vault.
