import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');

test('closed node outlines keep a wobble ceiling whatever --cm-sketch a style asks for', () => {
  const map = read('concept-map.js'), themes = read('themes.css');
  // Styles may push the hand-drawn factor well above 1 (manuscript, wasteland).
  const factors = [...themes.matchAll(/--cm-sketch:\s*([\d.]+)/g)].map(match => Number(match[1]));
  assert.ok(Math.max(...factors) > 2);
  // Edges and rails scale freely, but outlines and echo arcs sit behind the label and must be capped.
  assert.match(map, /const rc = \(value, cap\) => Math\.min\(rr\(value\), cap\)/);
  assert.match(map, /roughness: rc\(options\.roughness, d \? 2\.4 : 1\.7\), bowing: rc\(options\.bowing \?\? 0, 1\)/);
  assert.equal([...map.matchAll(/cm-map-contour-echo/g)].length, 2);
  assert.equal([...map.matchAll(/roughness: rc\([\d.]+, [\d.]+\), stroke: [^}]*disableMultiStroke: true/g)].length, 2);
});

test('echo arcs are drawn only around elliptical nodes', () => {
  // The echo is an elliptical arc; around plates, chamfers or rectangles it cuts across the node and its label.
  const map = read('concept-map.js');
  assert.equal([...map.matchAll(/if \(look\.echo && look\.node === 'ellipse'\)/g)].length, 2);
  assert.doesNotMatch(map, /if \(look\.echo\) \{/);
});
