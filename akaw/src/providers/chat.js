// Chat targets: where delivery and "needs you" messages go. Each target subscribes to events.
import { request } from './http.js';

export const CHAT_EVENTS = ['delivered', 'needs-you', 'blocked', 'batch-sealed'];

const webhookPost = (envKey, shape) => ({
  secretEnv: envKey,
  configured: (t, env) => Boolean(env[t.secretEnv || envKey]),
  post: (t, env, text, ctx) => request(env[t.secretEnv || envKey], { method: 'POST', body: shape(text, ctx, t) }),
});

export const CHATS = {
  slack: { name: 'Slack', ...webhookPost('SLACK_WEBHOOK_URL', (text) => ({ text })) },
  teams: {
    name: 'Microsoft Teams',
    // Works with Teams Workflows "post to a channel when a webhook request is received".
    ...webhookPost('TEAMS_WEBHOOK_URL', (text) => ({
      type: 'message',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text, wrap: true }] } }],
    })),
  },
  discord: { name: 'Discord', ...webhookPost('DISCORD_WEBHOOK_URL', (text) => ({ content: text.slice(0, 1900) })) },
  googlechat: { name: 'Google Chat', ...webhookPost('GOOGLE_CHAT_WEBHOOK_URL', (text) => ({ text })) },
  webhook: {
    name: 'Webhook (n8n, Make, Zapier)',
    ...webhookPost('CHAT_WEBHOOK_URL', (text, ctx) => ({ source: 'akaw', event: ctx.event, text, card: ctx.card || null })),
  },
  telegram: {
    name: 'Telegram',
    secretEnv: 'TELEGRAM_BOT_TOKEN',
    configured: (t, env) => Boolean(env[t.secretEnv || 'TELEGRAM_BOT_TOKEN'] && t.chatId),
    post: (t, env, text) => request(`${t.baseUrl || 'https://api.telegram.org'}/bot${env[t.secretEnv || 'TELEGRAM_BOT_TOKEN']}/sendMessage`, {
      method: 'POST', body: { chat_id: t.chatId, text: text.slice(0, 4000), disable_web_page_preview: true },
    }),
  },
};

export function chat(t) {
  const p = CHATS[t?.provider];
  if (!p) throw new Error(`Unknown chat provider "${t?.provider}". Use ${Object.keys(CHATS).join(', ')}.`);
  return p;
}
