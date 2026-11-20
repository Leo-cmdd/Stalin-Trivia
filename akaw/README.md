# Akaw

A local playable-ads flow generator with one dashboard to control it. It runs on your Mac,
keeps state in a local folder, and connects to Jira, Slack, Google Drive, Box and your existing
playable flow through keys in `.env` that never leave the server process.

```
cd akaw
cp .env.example .env      # optional: works without any keys (dry-run)
npm start                 # → http://localhost:4747
npm test                  # 25 tests, no dependencies to install
```

Node 20 or newer. There is no `npm install`: Akaw has zero dependencies.

## What it does

| Screen | What you do there |
| --- | --- |
| **Board** | The 17-step flow as four rows, the queue (P0 feedback fix, P1 close out, P2 new variant, P3 new mechanic), **Run queue** (3 cards at a time, each until it needs you, never past a gate), **Seal batch** and **I ran the deploy**. |
| **Card drawer** | Everything about one card: what it needs from you right now, the Scene Spec, guardrail results, your four yeses, credits, QA, export receipt, log, send back. |
| **Start a playable** | Type the idea, pick the game and a kit from the library. The spec and guardrails update as you type. Blocked text cannot start. |
| **Library** | Paste local folder paths, Drive or Box links. Files become proposed cards, deduped by checksum, creative IDs read from `GAME_BUCKET_NNNNN (Name)` folders. Index (default) or hold. Promote to Library with an approver. Re-scan flags what moved or vanished. |
| **Clients & games** | Tiles per client and game (assets, active rules, open cards, last scan). Game profile: approved prize figures, legal lines, win line, cores, codes, palette, fonts, badges, reviewers. |
| **Onboard a game** | Five steps: client and game, paste links, review cards, keep or drop the closest game's rules, reviewers and prize figures. |
| **Guardrails** | Rules by layer (team, client, channel, game, creative). A lower layer can only add; loosening is an exception on one card with approver and date. Test copy against the rules. Adopt or reject lessons. |
| **Audit** | Every yes, credit quote, credit refusal, scan, command run and post, with who and when. |
| **Settings** | Operator name, $ per credit, run-queue size, networks with routes and size caps, connection status. |

## The flow

`Jira card → Prep → Brief → Draft → **Concept lock** → Art → Build → QA → Batch link → **Deploy** → **Link review** → Post to Jira → Reviewers → Triage → **Close** → Exports → Done`

- **Concept lock**: judged on a real draft. Extra ticks for near miss, versus, misleading cut or a new mechanic, and for needs-sign-off rules. One credit ceiling if art is needed.
- **Art**: the credit hook refuses any spend over the ceiling.
- **QA**: reads the built bundle's copy (visible text and JS strings, ignoring code names), runs every guardrail, scans for keys, checks legal lines word for word if the game has them on file, checks size against each network cap, then runs your flow's QA command if set.
- **Deploy**: per batch. Akaw shows the command; you run it and type `DEPLOYED`.
- **Link review**: the exact Jira comment, which must carry the Play Now link. Preview and tunnel addresses are refused.
- **Reviewers → Triage**: replies are read from Jira (or recorded by hand). All approved opens Close. All notes send the card back as a P0 at the front of the queue. Mixed waits for you.
- **Close**: RT is only possible when the card title says RT. Exports list 15s, 30s and 59s for every network on the route, with a fingerprint receipt; then Slack.

## Connecting the real systems

All keys go in `.env` (gitignored). The dashboard only ever sees "configured" or "off".

| Connection | Keys | Without it |
| --- | --- | --- |
| Jira (sync, replies, comments) | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_JQL` | Cards start from **Start a playable**; replies are recorded by hand. |
| Slack (delivery post) | `SLACK_WEBHOOK_URL` | The post is logged as a dry-run. |
| Google Drive (library scan) | `GOOGLE_DRIVE_TOKEN` or `GOOGLE_DRIVE_API_KEY` | Scan local or mounted folders. |
| Box (library scan) | `BOX_TOKEN` | Same. |
| Your flow's agents | `AKAW_FLOW_REPO`, `AKAW_CMD_DRAFT`, `AKAW_CMD_BUILD`, `AKAW_CMD_QA`, `AKAW_CMD_EXPORT`, `AKAW_CMD_DEPLOY` | Draft and build are attached by hand (a link, a local path). |

**Writes are off by default.** Jira comments and Slack posts only go out when `AKAW_ALLOW_WRITES=1`.
Until then every outbound write is recorded in the audit log with the exact text it would have sent.

### Flow commands

Each command runs in `AKAW_FLOW_REPO` with `{spec}`, `{card}` and `{out}` substituted (also as
`AKAW_SPEC`, `AKAW_CARD`, `AKAW_OUT`). The spec file holds the card, the Scene Spec and the game
profile. If the command writes `{out}/result.json` with any of `draftUrl`, `screenshots`, `buildPath`,
`playLink`, Akaw attaches them. A non-zero exit blocks the card with the output on the card.
The child process gets none of Akaw's keys.

## Safety

- Listens on `127.0.0.1` only and refuses any other `Host` header.
- Every write call needs a per-session token embedded in the page, so other websites cannot drive it.
- `.env` values are never sent to the browser, never passed to flow commands, and scrubbed from command output.
- `npm run scan:secrets` scans this folder (or a path you pass) and exits 1 on a finding.
- Akaw never runs the production deploy.

## Data

Everything lives in `./data` (or `AKAW_DATA_DIR`): one JSON file per collection plus `audit.jsonl`.
Back it up by copying the folder. `npm run reset` moves it aside (never deletes it) so the next
start begins from `./seed`.

The seed holds the clients, games and rules stated in the handoff docs. Prize figures, legal lines,
network caps, reviewers and rule owners are left empty on purpose: fill them with real data.

See [docs/PLAN.md](docs/PLAN.md) for what is built, what needs your data, and what is next.
