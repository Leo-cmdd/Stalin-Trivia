# Capabilities: what the playable flow needs, and which tools can do it

Your handoffs describe a flow built inside environments with many connectors (Atlassian, Higgsfield,
Drive, Slack, Chrome, MCP servers). Akaw runs on its own, so each of those became a **slot** you
fill with whichever tool you use: Jira or Asana or Monday, Slack or Teams or Telegram, Higgsfield or
Google AI Studio or fal, and so on. n8n and Claude Code can sit behind any slot.

Legend: **Built** works in Akaw now · **Slot** Akaw has the plug, you choose and configure the tool ·
**Needed** not built yet, with the suggested route.

## 1. What Akaw covers now

| Area | In Akaw | Tools you can switch between |
| --- | --- | --- |
| Task intake, review comment, replies | **Built**: Jira, Asana, Monday | Linear, ClickUp, Trello, Wrike, Notion, GitHub Issues: through n8n until an adapter is added |
| Team messages (delivered, needs you, blocked, batch sealed) | **Built**: Slack, Teams, Telegram, Discord, Google Chat, any webhook | WhatsApp, email, SMS: webhook → n8n, Make or Zapier |
| Draft, build, QA, preview, export steps | **Slot**: by hand, shell command, Claude Code headless, n8n webhook, built-in capture | Your flow repo's npm scripts, Claude Code with your skills and MCP servers, n8n (self-hosted or a hosted one such as Utopaya) |
| New mechanic prototypes | **Slot**: Claude Code preset (own worktree, never merges) | Claude Code |
| AI stills | **Built** adapters: fal, Replicate, Google AI Studio. **Slot**: n8n, command, Claude Code | Flux, Recraft, Ideogram, Imagen / Gemini image, Higgsfield, Leonardo, GPT image, local ComfyUI |
| AI video (hero footage, hooks) | Same adapters and slots | Seedance, Kling, Veo, Hailuo, Runway, Luma, Higgsfield |
| Preview capture | **Built**: Playwright plays the build in portrait and landscape; FFmpeg makes mp4 + GIF | Playwright's Chromium or your Chrome |
| Video assembly and templates | **Slot** presets: FFmpeg cutdowns script, Remotion, nexrender + After Effects, Blender | – |
| Credit hook, guardrails, four yeses, audit, asset library (local, Drive, Box) | **Built** | – |
| Toolbox check | **Built**: Settings shows which of FFmpeg, Playwright, Chrome, Claude Code, n8n, Remotion, nexrender, aerender, Blender are on this machine | – |

## 2. Where each named tool plugs in

| Tool | Where it goes in Akaw | Good for |
| --- | --- | --- |
| **n8n** | Any step (`runner: n8n`), any generator (`provider: n8n`), chat (`provider: webhook`) | Higgsfield and other tools with no adapter, delivery uploads, ad-network uploads, sheet-driven batches, scheduled jobs |
| **Claude Code** | Any step (`runner: claude`), generator (`provider: claude` with your MCP config) | Briefer, Builder, playable-mechanic, MCP-driven generation. Runs `claude -p` with `--output-format json`, `--permission-mode`, `--allowedTools`, `--max-budget-usd`, `--mcp-config`; the prompt goes on stdin; its $ cost is recorded on the card |
| **FFmpeg** | Built into capture; `scripts/ffmpeg-cutdowns.sh` as a step command | mp4 / GIF previews, 15s / 30s / 59s cutdowns, posters, resize and localize batches, alpha webm, thumbnails |
| **Remotion** | Step command with `templates/remotion-props.json` filled from the spec | Code-driven preview videos, end cards, video variants from one template |
| **nexrender** | Step command with `templates/nexrender-job.json` filled from the spec | After Effects template renders (needs `aerender`, so a machine with AE) |
| **Higgsfield** | Generator through n8n or through Claude Code with the Higgsfield MCP | Hero clips and hooks; credits pass the credit hook first |
| **Google AI Studio** | Built `gemini` generator (images) | Stills. Veo video uses long-running jobs: route it through fal, Replicate or n8n |
| **Blender** | Step command (`blender -b file.blend --python …`) | The parametric, sheet-driven template renders from the studio plan |

## 3. Additional capabilities needed

### Priority 1: before the real flow runs end to end in Akaw

| # | Capability | Why | Suggested route |
| --- | --- | --- | --- |
| 1 | **The flow repo attached and its commands wired** | The Builder, the QA copy layer (`npm run playable:qa:all`), the exporter and the deploy live there | Attach `papaya-creative`; set `flowRepo` and the steps in `akaw.config.json` |
| 2 | **Per-network packaging** | Each network wants its own build: single file or zip, size cap, MRAID for in-app networks, and its own click-out call | Your exporter as the export step, plus a validation pass per network. Check each network's current spec; I have not verified them |
| 3 | **Play Now hosting and catalogue** | Reviewers open a stable link per creative and version, never a tunnel | Your internal share site, or Cloudflare Pages, S3 + CloudFront, Netlify. Akaw shows the deploy command and refuses tunnel links |
| 4 | **Delivery upload** | Exports and GIF go to the reserved folder, then the post | n8n on the export step (Drive, Box, Dropbox, SharePoint, S3, Frame.io). Akaw's Drive and Box adapters only read today |
| 5 | **Create subtasks and move status in the tracker** | The team flow opens one subtask per playable with its link, name and folder, and closes it at the end | Add create and transition to the tracker adapters (small), or do it in n8n |
| 6 | **Autoplay hook per core** | Capture and QA must play to the end card unattended, in portrait and landscape | A short script per core (`autoplayScript`) or an autoplay mode in each core |
| 7 | **Your approved data** | Prize figures, legal lines, network caps, rule owners, reviewers are empty on purpose | Fill them on the game pages and in Settings |
| 8 | **Secrets hygiene** | A token was pasted into a chat; the repos need scanning | Rotate it; ask an org admin to turn on GitHub secret scanning and push protection |

### Priority 2: to scale from 240 to 1,000 a month

| # | Capability | Why | Suggested route |
| --- | --- | --- | --- |
| 9 | **Video bundle flow** | Bundles need 3+ videos, banners and GIFs per concept; Akaw handles the playable lane only | A video card type on the same queue, gates and guardrails, with steps on Remotion, nexrender, Blender and FFmpeg |
| 10 | **Batch from a sheet** | Iterations and variations are rows: hook, background, CTA, end card | Google Sheets or Airtable → n8n → Akaw cards or render jobs; or a CSV import in Akaw |
| 11 | **Render workers beyond your Mac** | 1,000 a month is render time | Remotion on Lambda or Cloud Run, FFmpeg anywhere, nexrender on an AE machine, Blender on a GPU box; a hosted option like Utopaya once assessed |
| 12 | **Voice and music** | Hooks and videos need VO and licensed music | Generator slot with audio output: your internal voice service, ElevenLabs or Google TTS. Check licensing before using AI music |
| 13 | **Image utilities** | Transparent components make iterations cheap | Background removal and upscaling models on fal or Replicate; FFmpeg for alpha webm; Lottie from After Effects |
| 14 | **Localization** | Variations include languages | Translation (DeepL, Google, Claude) + native review + per-language legal lines; one card per language |
| 15 | **Ad network upload** | Hand-off to UA by API instead of by hand | Network APIs through n8n, or keep UA uploading |
| 16 | **Performance readout** | Results by concept and angle should shape the next spec and the lessons | Network reporting APIs or your MMP (AppsFlyer, Adjust, Singular) or BI, or CSV upload as Playable Ops did |
| 17 | **Scheduled sync** | A timer that reads the tracker and queues cards (offered in v2, off by default) | Small scheduler in Akaw, or n8n cron calling Akaw with a machine key |
| 18 | **Async callbacks** | Long renders should report back instead of holding a request open | Inbound callback endpoint with a shared secret |
| 19 | **Approve from chat** | Gate buttons in Slack or Teams | Needs a public callback URL with auth; keep the yeses in Akaw until then |
| 20 | **Team view and roles** | Akaw is single-operator on localhost | Look-only view behind Cloudflare Tunnel + Access (the Team Flow Dashboard proposal), or hosted Akaw with SSO and roles |
| 21 | **Cost report** | Show leadership what 240 vs 1,000 costs | The audit log already holds credits, $ and Claude Code cost per card; add a report page |
| 22 | **More library sources** | Assets also sit in Higgsfield, Miro, Dropbox, Frame.io, S3 | Adapters, or export to a folder and scan; video thumbnails with FFmpeg; mirror approved cards into `library/` by pull request |
| 23 | **Backups** | `data/` is the source of truth for cards and audit | Time Machine on the Mac, or a scheduled copy to Drive or S3 |

### Priority 3: later

- A Claude API Briefer for long free-form briefs (the rule-based one asks instead of guessing).
- Auto-tagging and similarity search over the library with a vision model.
- Concept-matrix planning (audience × motivation) feeding cards directly.
