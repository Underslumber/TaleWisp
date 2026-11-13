import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');

test('overview navigator moves the main view on pointer input', () => {
  const map = read('concept-map.js'), css = read('concept-map.css');
  assert.match(map, /overview\.addEventListener\('pointerdown'/);
  assert.match(map, /overview\.getScreenCTM\(\)/);
  assert.match(map, /ctm\.inverse\(\)/);
  assert.match(map, /setView\(\{ x: point\.x - mapView\.width \/ 2, y: point\.y - mapView\.height \/ 2/);
  assert.match(map, /overview\.addEventListener\('pointerdown', event => \{ event\.stopPropagation\(\)/);
  const rule = css.match(/\.cm-map-overview \{[^}]*\}/)[0];
  assert.doesNotMatch(rule, /pointer-events:\s*none/);
  assert.match(rule, /cursor:\s*pointer/);
});

test('edge legend is built for related and mention edges and hidden on phones', () => {
  const map = read('concept-map.js'), css = read('concept-map.css');
  assert.match(map, /\(model\.related \|\| model\.mentions\) && model\.selected\) \{\s*const legend = make\('div', 'cm-map-legend'\)/);
  for (const label of ['Иерархия', 'Связь', 'Упоминание']) assert.ok(map.includes(`legendRow('${label}'`), label);
  assert.match(map, /if \(model\.related\) legendRow\('Связь'/);
  assert.match(map, /if \(model\.mentions\) legendRow\('Упоминание'/);
  assert.match(css, /@media \(max-width:520px\) \{ \.cm-map-legend \{ display:none; \} \}/);
});
