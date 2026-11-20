# Akaw: plan and status

Built from two handoffs: *Creative studio scale-up* (6 Nov) and *Playable flow: handoff and asset
library plan* (14 Nov). Akaw is the engine and the frontend that the second doc proposes, plus the
operator console for the 17-step flow. The flow's own agents (Briefer, Builder, Art, QA layer,
exporter) live in the flow repo, which was not available here; Akaw calls them through commands.

## What is needed, and where it stands

| # | Piece | Status |
| --- | --- | --- |
| 1 | Operator board: 17 steps, queue tiers, Run queue (3 at a time), stops before publishing | **Built** |
| 2 | Four yeses: concept lock, deploy (per batch, you run it), link review, close | **Built** |
| 3 | Triage: notes loop back as P0, mixed replies wait for you | **Built** |
| 4 | Text to spec: fields resolved, asked (never guessed), to confirm, flagged | **Built** (rule-based Briefer) |
| 5 | Guardrails: four layers, add-only, exceptions with approver and date, 11 check kinds | **Built**, 17 seed rules |
| 6 | Credit hook: one ceiling at concept lock, spend refused over it, $ rate optional | **Built** |
| 7 | QA: copy layer on the built bundle, secrets, legal lines, size caps, flow QA command | **Built** |
| 8 | Exports: 15s, 30s, 59s per network on the route, fingerprint receipt, Slack post | **Built** (plan + receipt; files come from your export command) |
| 9 | Asset library: scan, classify, dedupe by checksum, creative IDs from folder names, index or hold, promote, retire, re-scan | **Built** for local folders; Drive and Box adapters written, **untested on real links** |
| 10 | Clients and games, game profile, onboarding wizard | **Built** |
| 11 | Jira: preview sync, import, read replies, post the exact comment | **Built**, **untested against your Jira** |
| 12 | Audit log of every yes, quote, scan, command and post | **Built** |
| 13 | Higgsfield and Miro adapters | Not built (scan an export folder instead) |
| 14 | Drive delivery of exports | Not built (export command or by hand) |
| 15 | Holding Drive or Box files (copy into storage) | Not built (local files only) |
| 16 | LLM Briefer for free-form briefs | Not built; the rule-based one asks instead of guessing |

## To go live today (about an hour)

1. `cd akaw && npm start`, open http://localhost:4747. Settings: type your name (every yes is recorded under it).
2. **Your data, per game** (Clients & games → game): approved prize figures, exact legal lines, folder codes
   (the `SC` in `SC_UA_00042`), cores and their brief words, reviewers. Nothing was invented, so these are empty.
3. **Settings → Networks**: each network, its routes (UA, RT) and its size cap in MB from the network spec.
4. **Guardrails**: confirm or change the 8 rules marked *to confirm*, and set an owner on each.
5. **Library**: scan the folder (or Drive link) for the next game you will onboard. Accept, then promote
   the items a build needs to Library with the approver.
6. **Jira** (when ready): put `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` and your playable `JIRA_JQL`
   in `.env`, restart, press **Sync Jira (preview)**. Import only after the preview looks right.
7. **Flow repo** (when attached): set `AKAW_FLOW_REPO` and the draft, build, QA, export and deploy
   commands. Until then, attach the draft link and build path by hand on each card.
8. Run one real playable end to end with writes off. Then set `AKAW_ALLOW_WRITES=1`.

## Decisions taken by default (change any)

| Decision (from the handoff) | Default in Akaw |
| --- | --- |
| Default for scanned assets | Index only; hold only what a build needs |
| Where the index lives | Local JSON files in `./data`, with the audit log beside them |
| Where the engine runs | Your Mac (builds and renders need it today) |
| Writes to Jira and Slack | Off until `AKAW_ALLOW_WRITES=1` |
| Rules with unknown scope ("You Can Win", round length, PayPal toast) | Placed at client Papaya, marked *to confirm* |
| Lesson: headline and CTA over the gameplay | Candidate, not adopted |

## Still open (needs you)

- Attach or point to the flow repo, so the draft, build, QA and export commands can be wired.
- Approved prize figures and legal lines per game.
- Network list and size caps.
- Owners for every rule; scope for the rules marked *to confirm*.
- Whether the Mahjong Cash and Cash Arcade cores exist, and their brief words.
- Rotate the token that was pasted into a chat (named in the flow handoff) before connecting anything.
