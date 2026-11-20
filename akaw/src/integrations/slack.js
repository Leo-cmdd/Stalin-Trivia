// Slack delivery post through an incoming webhook. Dry-run unless AKAW_ALLOW_WRITES=1.
export function configured(cfg) {
  return Boolean(cfg.slack.webhookUrl);
}

export async function post(cfg, text) {
  if (!configured(cfg)) throw new Error('Slack is not configured: set SLACK_WEBHOOK_URL in .env');
  const r = await fetch(cfg.slack.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`Slack ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return true;
}
