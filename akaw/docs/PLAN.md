# Akaw: plan and status

Built from two handoffs: *Creative studio scale-up* (6 Nov) and *Playable flow: handoff and asset
library plan* (14 Nov). Akaw is the engine and the frontend that the second doc proposes, plus the
operator console for the 17-step flow. The flow's own agents (Briefer, Builder, Art, QA layer,
exporter) live in the flow repo, which was not available here; Akaw calls them through step runners
(command, Claude Code headless, n8n). Every outside system is a swappable provider; the full list of
capabilities and tool options is in [CAPABILITIES.md](CAPABILITIES.md).

## What is needed, and where it stands

| # | Piece | Status |
| --- | --- | --- |
| 1 | Operator board: 17 steps, queue tiers, Run queue (3 at a time), stops before publishing | **Built** |
| 2 | Four yeses: concept lock, deploy (per batch, you run it), link review, close | **Built** |
| 3 | Triage: notes loop back as P0, mixed replies wait for you | **Built** |
| 4 | Text to spec: fields resolved, asked (never guessed), to confirm, flagged | **Built** (rule-based Briefer) |
| 5 | Guardrails: four layers, add-only, exceptions with approver and date, 11 check kinds | **Built**, 17 seed rules |
| 6 | Credit hook: one ceiling at concept lock, spend refused over it, $ rate optional | **Built** |
| 7 | QA: copy layer on the built bundle, secrets, legal lines, size caps, your QA step | **Built** |
| 8 | Exports: preview capture (mp4 + GIF, portrait + landscape), 15s / 30s / 59s per network, fingerprint receipt, chat post | **Built** (receipt plans the files; the files come from your export step) |
| 9 | Asset library: scan, classify, dedupe by checksum, creative IDs from folder names, index or hold, promote, retire, re-scan | **Built** for local folders; Drive and Box adapters written, **untested on real links** |
| 10 | Clients and games, game profile, onboarding wizard | **Built** |
| 11 | Task trackers: Jira, Asana, Monday (preview sync, import, read replies, post the exact comment) | **Built**, tested against mocks, **untested against your accounts** |
| 12 | Chat: Slack, Teams, Telegram, Discord, Google Chat, webhook; per-target events | **Built**, tested against mocks |
| 13 | Step runners: by hand, command, Claude Code headless, n8n, built-in capture | **Built**; capture tested for real (Playwright + FFmpeg); Claude Code tested with a stand-in binary |
| 14 | Art generators: fal, Replicate, Google AI Studio, n8n, command, Claude Code; credit hook before every call | **Built**, tested against mocks |
| 15 | Toolbox check (FFmpeg, Playwright, Chrome, Claude Code, n8n, Remotion, nexrender, aerender, Blender) | **Built** |
| 16 | Audit log of every yes, quote, refusal, generation, step run, scan and post | **Built** |
| 17 | Everything in CAPABILITIES.md section 3 | Not built; listed there with routes |

## To go live today (about an hour)

1. `cd akaw && npm start`, open http://localhost:4747. Settings: type your name (every yes is recorded under it).
2. **Your data, per game** (Clients & games → game): approved prize figures, exact legal lines, folder codes
   (the `SC` in `SC_UA_00042`), cores and their brief words, reviewers. Nothing was invented, so these are empty.
3. **Settings → Networks**: each network, its routes (UA, RT) and its size cap in MB from the network spec.
4. **Guardrails**: confirm or change the 8 rules marked *to confirm*, and set an owner on each.
5. **Library**: scan the folder (or Drive link) for the next game you will onboard. Accept, then promote
   the items a build needs to Library with the approver.
6. **Pick your tools**: copy `akaw.config.example.json` to `akaw.config.json` and keep the tracker, chat
   targets, step runners and generators you use. Put their keys in `.env`. Restart; Settings shows each
   one as configured or off, and the Toolbox shows what is installed.
7. **Tracker**: press **Sync (preview)** on the board. Import only after the preview looks right.
8. **Flow repo** (when attached): set `flowRepo` and the draft, build, QA and export steps (command,
   Claude Code or n8n) and the deploy command. Until then, attach the draft link and build path by hand.
9. **Generators**: set `costPerOutput` for each, so the credit hook can quote before every call.
10. Run one real playable end to end with writes off. Then set `AKAW_ALLOW_WRITES=1`.

## Decisions taken by default (change any)

| Decision (from the handoff) | Default in Akaw |
| --- | --- |
| Default for scanned assets | Index only; hold only what a build needs |
| Where the index lives | Local JSON files in `./data`, with the audit log beside them |
| Where the engine runs | Your Mac (builds and renders need it today) |
| Writes to the tracker and chat | Off until `AKAW_ALLOW_WRITES=1` |
| Tracker when none is chosen | None; Jira if its keys are in `.env` (backward compatible) |
| $-priced generators | Converted to credits with the $ per credit rate in Settings |
| Rules with unknown scope ("You Can Win", round length, PayPal toast) | Placed at client Papaya, marked *to confirm* |
| Lesson: headline and CTA over the gameplay | Candidate, not adopted |

## Still open (needs you)

- Attach or point to the flow repo, so the draft, build, QA and export steps can be wired.
- Which tracker, chat and generators to use first, and their keys.
- Approved prize figures and legal lines per game.
- Network list and size caps.
- Owners for every rule; scope for the rules marked *to confirm*.
- Whether the Mahjong Cash and Cash Arcade cores exist, and their brief words.
- Rotate the token that was pasted into a chat (named in the flow handoff) before connecting anything.
