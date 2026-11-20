import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { scanText } from '../src/secrets.js';
import { createApp } from '../src/api.js';
import { makeEngine } from './helpers.js';

test('secret scanner finds common tokens', () => {
  const fake = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
  assert.ok(scanText(`key=${fake}`).length);
  assert.ok(scanText(`api_key = "${'a1b2c3d4'.repeat(3)}"`).length);
  assert.equal(scanText('You Can Win').length, 0);
});

test('API: localhost only, writes need the session token', async () => {
  const eng = makeEngine({ AKAW_PORT: '0' });
  const app = createApp(eng);
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // The app was built for port 0; patch the allowed host by rebuilding with the real port.
  server.close();
  const eng2 = makeEngine({ AKAW_PORT: String(port) });
  const app2 = createApp(eng2);
  const s2 = http.createServer(app2.handle);
  await new Promise((r) => s2.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.ok(Array.isArray(state.stages) && state.stages.length === 17);
    const noTok = await fetch(`${base}/api/cards`, { method: 'POST', body: '{}' });
    assert.equal(noTok.status, 403);
    const ok = await fetch(`${base}/api/cards`, { method: 'POST', headers: { 'x-akaw-token': app2.token, 'content-type': 'application/json' }, body: JSON.stringify({ title: 't', gameId: 'solitaire-cash', idea: 'Solitaire Cash klondike 30s' }) });
    assert.equal(ok.status, 200);
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.includes(app2.token));
    const evil = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: 'evil.example:80' } }, (res) => resolve(res.statusCode));
    });
    assert.equal(evil, 403);
  } finally {
    s2.close();
  }
});
