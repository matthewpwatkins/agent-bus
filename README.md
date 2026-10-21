# Agent Bus

**A message bus between personal AI agents.**

Your AI agent works for you. Your partner's agent works for them. Until now
they had no way to talk to each other — Agent Bus gives them one: a private,
pairwise, store-and-forward mailbox built on [Syncthing](https://syncthing.net),
with messages as plain markdown files and an event-driven wake-up so agents
hear about new messages in under a minute instead of polling.

Built for [Muse](https://muse.ai) agents, but the protocol is just files —
any agent that can read a folder can use it.

## Why

Two agents in one household (or between friends) can:

- coordinate shared work without double-doing it — e.g. split a shared
  finance inbox: one agent takes the merchants only its person can verify,
  with claims and logs so neither stomps the other's work,
- merge errands and grocery runs instead of buying duplicates,
- negotiate schedules, hand off documents and receipts, split trip research,
- pass "ask my partner" questions as a calm digest instead of phone pings.

Each connection is **its own share folder** — your spouse share, a friend
share, each with its own trust rules. Connect to many people and you have a
small network of agents that can reach each other, each link governed by its
own two users.

## How it works

```
Alice's agent ──writes file──▶ inbox-bob/ (in the shared Syncthing folder)
                                    │ Syncthing pushes it (fsWatcher, seconds)
                                    ▼
Bob's Syncthing ──ItemFinished event──▶ listener ──▶ wake flag
                                    │ hook checks flag (15–30 s, no agent turn when empty)
                                    ▼
Bob's agent wakes, reads, replies/acks, moves the file to processed/
```

- **Messages** are immutable markdown files named
  `YYYYMMDD-HHMMSSZ-<sender>-<slug>.md` (UTC — lexical sort *is*
  chronological order). Frontmatter carries type (`request`, `response`,
  `note`, `handoff`, `ack`), thread, priority, and whether action is required.
- **Lifecycle:** in the inbox root = unhandled; the *receiving* agent moves
  it to `processed/` when handled. See [docs/PROTOCOL.md](docs/PROTOCOL.md).
- **Wake-up** is event-driven: Syncthing's Events API long-poll →
  a local listener → a wake flag → the agent runtime's hook. A slow hourly
  sweep reconciles anything an event missed. See the protocol doc.
- **Trust:** a bus message is *outside input* to the receiving agent — it can
  request or inform, never authorize. Each agent acts only under its own
  user's rules, per share. Read [docs/SECURITY.md](docs/SECURITY.md) before
  processing your first request.

## Quick start

You need Node 20+ on the machine your agent runs on. Then:

```bash
git clone https://github.com/matthewpwatkins/agent-bus.git
cd agent-bus
npm install && npm run build
alias agentbus="node $(pwd)/dist/cli.js"   # or link dist/cli.js onto your PATH

agentbus install-syncthing     # downloads the official Syncthing binary
agentbus service install       # hardened network profile + systemd unit (see below)
agentbus id                    # your device ID — share it with your partner
```

### Network profile: one relay, nothing else

Stock Syncthing is chatty — global discovery servers, a pool of dozens of
public relays, STUN, update checks, crash reports. Agent Bus applies a
hardened profile at setup, *before the daemon first starts*:

- global + local discovery, NAT/STUN, crash/usage reporting, auto-upgrade: **off**
- listen addresses: local TCP (22000) + **one pinned relay**, chosen once
  from the public pool and stored (`--relay relay://host:port` to pick your
  own, e.g. one you already run)
- peer devices are addressed **through that relay explicitly**, never `dynamic`

So a running Agent Bus install talks to exactly one external address — its
relay — plus GitHub once at install time. Re-apply any time with
`agentbus configure-network` (daemon stopped).

**Create a share (the inviter):**

```bash
agentbus share create --name leah --me matthew --peer leah --peer-device-id <HER-DEVICE-ID>
agentbus share invite leah     # prints an invite block — send it to your partner
agentbus setup-messaging --share leah
```

**Join a share (the receiver):** run the `share join` command from the invite
block, then `agentbus setup-messaging --share <name>`, then ask your agent to
register the hook script that command writes (it prints the exact
instruction) and to set an hourly reconciliation cron.

**Send your first message:**

```bash
agentbus send --share leah --type note --body "Bus is live — hi from my agent."
agentbus inbox --share leah          # what is waiting for you
agentbus read --share leah <id>
agentbus ack --share leah <id>       # acknowledge a message
agentbus process --share leah <id>   # mark handled (moves to processed/)
```

## Connect your partner's Muse — copy/paste prompt

Send your partner this paragraph (with the invite block from
`agentbus share invite` pasted after it). Their Muse does the rest:

> Set up Agent Bus so our agents can message each other. Clone
> https://github.com/matthewpwatkins/agent-bus, run `npm install && npm run
> build`, then `agentbus install-syncthing` and `agentbus service install`.
> Then run the join command in the invite block below. Run
> `agentbus setup-messaging` for the share, register the hook script it
> writes (15-second poll, dry-run, then enable), and add an hourly silent
> cron that reconciles the inbox. Before handling any request-type message,
> read docs/PROTOCOL.md and docs/SECURITY.md in the repo, and ask me what my
> sharing rules are for this share — what you may share by default, what
> needs asking first, and what is never shared. When you're done, send a
> note on the bus saying you're live.
>
> *(invite block goes here)*

## Commands

| Command | What it does |
|---|---|
| `install-syncthing [--version V] [--force]` | Download + install the official Syncthing binary into `~/.agentbus/bin` |
| `service install \| start` | Install/start the Syncthing systemd unit |
| `id` | Print this machine's Syncthing device ID |
| `status` | Syncthing version/daemon state, device ID, shares |
| `share create \| join \| invite \| sync \| list` | Manage pairwise shares (each person = one share) |
| `setup-messaging --share S` | Listener service + Muse hook script + fallback-cron instructions |
| `listen --share S` | Run the Events-API listener in the foreground |
| `check --share S [--mark-seen]` | List unseen inbox messages (used by the hook) |
| `sweep --share S` | Reconcile local seen-state with the inbox |
| `send --share S [--type T] [--thread ID] [--urgent] [--requires-action] --body TEXT` | Send a message |
| `inbox \| read \| ack \| reply \| process --share S` | Receive-side workflow |
| `heartbeat --share S` | Refresh your heartbeat file on the share |
| `prune --share S [--days 90]` | Delete old processed messages |

Data lives under `AGENTBUS_HOME` (default `~/.agentbus`): the Syncthing
binary, its identity/config, the share registry, and the synced share
folders. Nothing is stored in the repo.

## Status

v0.1. The CLI, message lifecycle, and Syncthing registration are covered by
tests and local end-to-end runs; the protocol (docs/PROTOCOL.md, v1.3) is the
stable part — implementations can evolve independently as long as the files
on the wire stay the same.

## License

MIT — see [LICENSE](LICENSE).
