import * as local from './local.js';
import * as drive from './drive.js';
import * as box from './box.js';

const NOT_BUILT = {
  higgsfield: /higgsfield\.ai/,
  miro: /miro\.com/,
};

export async function listSource(link, cfg, opts = {}) {
  const l = String(link).trim();
  if (local.canHandle(l)) return local.list(l, opts);
  if (drive.canHandle(l)) return drive.list(l, cfg.drive, opts);
  if (box.canHandle(l)) return box.list(l, cfg.box, opts);
  for (const [name, re] of Object.entries(NOT_BUILT)) {
    if (re.test(l)) throw new Error(`The ${name} adapter is not built yet. Export the assets to a Drive folder or a local folder and scan that.`);
  }
  throw new Error('Unknown source. Use a local folder path, a Google Drive link or a Box folder link.');
}

export { local, drive, box };
