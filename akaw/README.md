# Akaw

A local playable-ads flow generator with one dashboard to control it. It runs on your Mac,
keeps state in a local folder, and plugs into whatever tools your team uses: Jira, Asana or Monday
for tasks; Slack, Teams, Telegram, Discord or Google Chat for messages; fal, Replicate, Google AI
Studio, Higgsfield (through n8n or Claude Code) for art; FFmpeg, Remotion, nexrender and Blender for
renders; n8n and Claude Code behind any step.

```
cd akaw
npm start                                   # → http://localhost:4747, works with no keys (dry-run)
cp .env.example .env                        # keys, when you connect things
cp akaw.config.example.json akaw.config.json  # which tools you use
npm test                                    # 35 tests, no dependencies to install
```

Node 20 or newer. There is no `npm install`. Preview capture also needs Playwright
(`npm i -D playwright && npx playwright install chromium`, or `playwright-core` with your Chrome)
and FFmpeg (`brew install ffmpeg`).

## What it does

| Screen | What you do there |
| --- | --- |
| **Board** | The 17-step flow as four rows, the queue (P0 feedback fix, P1 close out, P2 new variant, P3 new mechanic), **Run queue** (3 cards at a time, each until it needs you, never past a gate), **Sync tracker**, **Seal batch**, **I ran the deploy**. |
| **Card drawer** | What the card needs from you now, the Scene Spec, guardrail results, your four yeses, art generation inside the credit ceiling, QA, preview GIFs, export receipt, log, send back. |
| **Start a playable** | Type the idea, pick the game and a kit. Spec and guardrails update as you type. Blocked text cannot start. |
| **Library** | Paste local folder paths, Drive or Box links. Files become cards, deduped by checksum, creative IDs read from `GAME_BUCKET_NNNNN (Name)` folders. Index or hold, promote with an approver, retire, re-scan. Generated art lands here too, with what made it. |
| **Clients & games** / **Onboard a game** | Game profiles (approved prize figures, legal lines, win line, cores, codes, palette, fonts, badges, reviewers) and a five-step onboarding. |
| **Guardrails** | Rules by layer (team, client, channel, game, creative). A lower layer can only add; loosening is an exception on one card with approver and date. Test copy. Adopt lessons. |
| **Audit** | Every yes, credit quote and refusal, generation, step run, scan and post, with who and when. |
| **Settings** | Operator, $ per credit, networks and caps, and which tracker, chat targets, step runners and generators are set, plus the **Toolbox** check of this machine. |

## The flow

`Task card → Prep → Brief → Draft → **Concept lock** → Art → Build → QA → Batch link → **Deploy** → **Link review** → Post to task → Reviewers → Triage → **Close** → Exports → Done`

- **Concept lock**: judged on a real draft. Extra ticks for near miss, versus, misleading cut or a new mechanic, and for needs-sign-off rules. One credit ceiling if art is needed.
- **Art**: generate with any configured generator; the credit hook checks the estimate against the ceiling before the call, records the actual cost after, and files the output in the library with its prompt and tool.
- **QA**: reads the built bundle's copy, runs every guardrail, scans for keys, checks legal lines word for word, checks size per network cap, then runs your QA step.
- **Deploy**: per batch. Akaw shows the command; you run it and type `DEPLOYED`.
- **Link review**: the exact comment, carrying the Play Now link. Tunnel and preview addresses are refused.
- **Reviewers → Triage**: replies read from the tracker or recorded by hand. All approved opens Close; all notes send the card back as P0; mixed waits for you.
- **Close → Exports**: RT only when the title says RT. Preview capture (mp4 + GIF, portrait and landscape), your export step, a fingerprinted receipt for 15s / 30s / 59s per network, then the chat post.

## Choosing tools: `akaw.config.json`

Non-secret choices live in `akaw.config.json` (gitignored); `akaw.config.example.json` shows every option.

| Slot | Options |
| --- | --- |
| `tracker` | `jira` (JQL), `asana` (project), `monday` (board, status / priority / date columns) |
| `chat` | any number of `slack`, `teams`, `telegram`, `discord`, `googlechat`, `webhook`, each with the events it wants: `delivered`, `needs-you`, `blocked`, `batch-sealed` |
| `steps.draft / build / qa / preview / export` | `manual`, `command`, `claude` (Claude Code headless), `n8n`, and `capture` for preview |
| `steps.deploy` | the command Akaw shows at the deploy gate; never run by Akaw |
| `generators` | `fal`, `replicate`, `gemini` (Google AI Studio), `n8n`, `command`, `claude` (e.g. with your Higgsfield MCP), each with a price per output for the credit hook |
| `tools` | paths for Remotion project, aerender, Blender, Chrome, n8n URL (for the Toolbox check) |

Templates in `templates/` (nexrender job, Remotion props) are filled from the spec before a step
runs. `scripts/ffmpeg-cutdowns.sh` makes 15s / 30s / 59s cutdowns, a poster and a GIF from a master
video. `prompts/` holds the Claude Code prompts for the draft and new-mechanic steps.

Older setups that only used `AKAW_CMD_*` and `JIRA_*` in `.env` keep working.

**Writes are off by default.** Task comments and chat posts only go out with `AKAW_ALLOW_WRITES=1`.
Until then each one is recorded in the audit log with the exact text it would have sent.

## Safety

- Listens on `127.0.0.1` only and refuses any other `Host` header.
- Every write call needs a per-session token embedded in the page.
- `.env` values never reach the browser, the flow steps (commands, Claude Code, n8n) or the logs.
- `npm run scan:secrets` scans this folder (or a path you pass) and exits 1 on a finding.
- Akaw never runs the production deploy.

## Data

Everything lives in `./data` (or `AKAW_DATA_DIR`): one JSON file per collection, `audit.jsonl`,
`runs/` (step outputs, previews, generated art) and `held/`. Back it up by copying the folder.
`npm run reset` moves it aside so the next start begins from `./seed`.

The seed holds the clients, games and rules stated in the handoff docs. Prize figures, legal lines,
network caps, reviewers and rule owners are empty on purpose: fill them with real data.

- [docs/PLAN.md](docs/PLAN.md): what is built, what needs your data, how to go live.
- [docs/CAPABILITIES.md](docs/CAPABILITIES.md): every capability the flow needs, which tools can do it, and what is still to build.
