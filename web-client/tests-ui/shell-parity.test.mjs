import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/index.html');
const app = read('../public/app.js');
const css = read('../public/styles.css') + read('../public/modules-skin.css');

// IDs created at runtime by app.js or its modules, not by the static shell.
const RUNTIME_IDS = new Set(['dialog-alternate']);

test('every element ID used by app.js exists in the new shell', () => {
  const used = new Set([...app.matchAll(/\$\('#([A-Za-z0-9-]+)/g)].map(m => m[1]));
  const declared = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const missing = [...used].filter(id => !declared.has(id) && !RUNTIME_IDS.has(id));
  assert.deepEqual(missing, []);
});

test('the shell declares each ID once', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});

test('the shell uses only local resources and no inline styles or scripts (CSP style-src/script-src self)', () => {
  assert.doesNotMatch(html, /<style[\s>]/);
  assert.doesNotMatch(html, /\sstyle="/);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc="\/)/);
  assert.doesNotMatch(html + css, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
});

test('the logo is the original asset, used unmodified', () => {
  assert.match(html, /src="\/assets\/talewisp-logo\.png"/);
  assert.match(css, /url\("\/assets\/talewisp-logo\.png"\)/);
});

test('the card rail replaces the visible selects and is wired to the existing selection flow', () => {
  assert.match(html, /<div class="workspace-selectors" hidden>/);
  assert.match(html, /id="deck-toggle"[^>]*aria-controls="deck-body"/);
  assert.match(app, /import \{ createDeck \} from '\.\/deck\.js';/);
  const commit = app.slice(app.indexOf('  async function commitWorkspaceSelection(ids) {'), app.indexOf('  function openUnassignedKnowledge() {'));
  assert.match(commit, /await selectWorkspace\(\);/);
  assert.match(commit, /state\.agent\?\.running/);
});

test('reduced motion has an explicit fallback', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(read('../public/deck.js'), /prefers-reduced-motion: reduce/);
});
