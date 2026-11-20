import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEngine, tmpDir } from './helpers.js';
import { classify, parseCreativeFolder } from '../src/library.js';

test('classify by name and type', () => {
  assert.equal(classify('SC_logo_v2.png').kind, 'logo');
  assert.equal(classify('endcard_final.mp4').kind, 'end card');
  assert.equal(classify('Green MAT.psd').kind, 'project file');
  assert.equal(classify('bgm_loop.wav').kind, 'music');
  assert.equal(classify('gameplay_capture.mov').kind, 'gameplay render');
  assert.equal(classify('bg_snow.png').kind, 'background');
  assert.equal(classify('char_rabbit_v2.png').kind, 'character');
});

test('creative folders are read off the name', () => {
  assert.deepEqual(parseCreativeFolder('Art/MMC_UA_00017 (DragonBrain)/renders'), { gameCode: 'MMC', bucket: 'UA', creativeId: 'MMC_UA_00017', creativeName: 'DragonBrain' });
  assert.equal(parseCreativeFolder('Misc/old stuff'), null);
});

test('scan a local folder: dedupe by checksum, accept, promote, re-scan flags what vanished', async () => {
  const { library } = makeEngine();
  const root = tmpDir('akaw-assets-');
  const a = path.join(root, 'SC_UA_00001 (Winter)');
  const b = path.join(root, 'SC_UA_00002 (Spring)');
  fs.mkdirSync(a); fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'logo.png'), 'LOGO');
  fs.writeFileSync(path.join(b, 'logo copy.png'), 'LOGO'); // duplicate bytes
  fs.writeFileSync(path.join(b, 'endcard.mp4'), 'EC');
  const scan = await library.scan({ sources: [root], gameId: 'solitaire-cash' }, 'op');
  assert.equal(scan.stats.files, 3);
  assert.equal(scan.stats.unique, 2);
  assert.equal(scan.stats.duplicates, 1);
  const created = await library.accept(scan.id, { folders: scan.groups.map((g) => g.folder) }, 'op');
  assert.equal(created.length, 2);
  assert.ok(created.every((x) => x.level === 'Project' && x.status === 'candidate'));
  await assert.rejects(() => library.accept(scan.id, { folders: [], level: 'Locked' }, 'op'), /Locked/);
  const ec = created.find((x) => x.kind === 'end card');
  assert.throws(() => library.promote(ec.id, {}, 'op'), /approved/);
  library.promote(ec.id, { by: 'Lead' }, 'op');
  assert.equal(ec.level, 'Library');
  await library.hold(ec);
  assert.ok(ec.held.key.startsWith('sha256-'));
  fs.rmSync(path.join(b, 'endcard.mp4'));
  const re = await library.rescan(scan.id, 'op');
  assert.deepEqual(re.gone, [ec.id]);
  assert.equal(ec.source.gone, true);
});

test('unknown and unbuilt sources fail with a clear message', async () => {
  const { library } = makeEngine();
  const s = await library.scan({ sources: ['https://higgsfield.ai/project/1', 'https://example.com/x'] }, 'op');
  assert.equal(s.errors.length, 2);
  assert.match(s.errors[0].error, /not built yet/);
});
