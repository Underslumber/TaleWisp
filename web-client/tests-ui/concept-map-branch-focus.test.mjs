import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');

test('node labels get a halo so outline strokes never cut the text', () => {
  const css = read('concept-map.css');
  assert.match(css, /\.cm-map-node \.cm-map-label \{[^}]*paint-order:\s*stroke;[^}]*stroke-width:\s*5px;[^}]*stroke-linejoin:\s*round/);
  assert.match(css, /\.cm-map-core \.cm-map-label[^{]*\{[^}]*stroke:\s*var\(--branch-soft\)/);
  assert.match(read('concept-map.js'), /--branch-soft', look\.coreFill/);
});

test('hovering or focusing a node lights its branch', () => {
  const map = read('concept-map.js');
  assert.match(map, /'data-node-id': node\.id/);
  assert.match(map, /setAttribute\('data-source', edge\.source\)/);
  for (const name of ['pointerenter', 'pointerleave', 'focusin', 'focusout']) assert.ok(map.includes(`'${name}'`), name);
  assert.match(map, /classList\.toggle\('has-focus'/);
  assert.match(map, /classList\.toggle\('is-lit'/);
});

test('everything outside the lit branch is dimmed, without motion when reduced', () => {
  const css = read('concept-map.css');
  assert.match(css, /\.cm-map\.has-focus \.cm-map-node:not\(\.is-lit\), \.cm-map\.has-focus \.cm-map-edges > \*:not\(\.is-lit\) \{ opacity:\s*\.22;\s*transition:\s*opacity \.15s;/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{[^}]*transition:\s*none/);
});
