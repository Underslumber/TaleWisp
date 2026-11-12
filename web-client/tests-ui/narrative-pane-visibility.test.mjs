import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression for "Tools > Каркас is blank": the portalled #narrative-pane kept `pane-hidden`, and the unlayered
// `display:flex !important` lost to `@layer states { .pane-hidden { display:none !important } }` because layered
// important declarations beat unlayered ones. This test resolves `display` with the real cascade rules
// (origin/importance -> layer order -> specificity -> source order) over every stylesheet index.html loads.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/index.html');
const sheetNames = [...html.matchAll(/<link rel="stylesheet" href="\/([^"?]+)(?:\?[^"]*)?">/g)].map(m => m[1]);

function splitTop(text, sep) {
  const parts = []; let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (c === '(' || c === '[') depth++; else if (c === ')' || c === ']') depth--; else if (c === sep && !depth) { parts.push(text.slice(start, i)); start = i + 1; } }
  parts.push(text.slice(start)); return parts.map(x => x.trim()).filter(Boolean);
}
function parseSheets(sheets) {
  const layers = [], rules = []; let order = 0;
  const declare = name => { if (!layers.includes(name)) layers.push(name); };
  const walk = (css, ctx) => {
    let i = 0;
    while (i < css.length) {
      let j = i; while (j < css.length && !'{;}'.includes(css[j])) j++;
      if (j >= css.length) break;
      const prelude = css.slice(i, j).trim();
      if (css[j] !== '{') { if (css[j] === ';' && prelude.startsWith('@layer')) prelude.slice(6).split(',').map(x => x.trim()).filter(Boolean).forEach(declare); i = j + 1; continue; }
      let depth = 1, k = j + 1; while (k < css.length && depth) { if (css[k] === '{') depth++; else if (css[k] === '}') depth--; k++; }
      const inner = css.slice(j + 1, k - 1);
      if (prelude.startsWith('@layer')) { const name = prelude.slice(6).trim(); declare(name); walk(inner, { ...ctx, layer: name }); }
      else if (prelude.startsWith('@media')) walk(inner, { ...ctx, media: [...ctx.media, prelude.slice(6).trim()] });
      else if (prelude.startsWith('@')) { /* @container/@supports/@keyframes: conditions unknown here; none touch pane visibility */ }
      else {
        const decls = inner.replace(/\{[^{}]*\}/g, '');
        for (const m of decls.matchAll(/(?:^|;)\s*display\s*:\s*([^;!]+?)\s*(!\s*important)?\s*(?=;|$)/g))
          for (const selector of splitTop(prelude, ',')) rules.push({ selector, value: m[1].trim(), important: !!m[2], layer: ctx.layer, media: ctx.media, order: order++ });
      }
      i = k;
    }
  };
  for (const css of sheets) walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), { layer: null, media: [] });
  return { layers, rules };
}
const SIMPLE = /^([a-z][a-z0-9-]*)?((?:[.#][\w-]+|:not\([.#][\w-]+\))*)$/i;
function compound(text) {
  const m = SIMPLE.exec(text); if (!m) return null;
  const parts = { tag: m[1]?.toLowerCase() ?? null, classes: [], ids: [], not: [] };
  for (const [, neg, kind, name] of m[2].matchAll(/(:not\()?([.#])([\w-]+)\)?/g)) (neg ? parts.not : kind === '.' ? parts.classes : parts.ids).push(kind + name);
  return parts;
}
function parseSelector(selector) {
  const tokens = selector.replace(/\s*>\s*/g, ' > ').trim().split(/\s+/), compounds = [], combinators = [];
  for (const token of tokens) { if (token === '>') { combinators[compounds.length - 1] = '>'; continue; } if (compounds.length > combinators.length) combinators.push(' '); const c = compound(token); if (!c) return null; compounds.push(c); }
  for (let i = 0; i < compounds.length - 1; i++) combinators[i] ??= ' ';
  return { compounds, combinators, specificity: compounds.reduce((sum, c) => [sum[0] + c.ids.length, sum[1] + c.classes.length + c.not.length, sum[2] + (c.tag ? 1 : 0)], [0, 0, 0]) };
}
const has = (el, simple) => simple[0] === '.' ? el.classes.includes(simple.slice(1)) : el.id === simple.slice(1);
const matchCompound = (c, el) => !!el && (!c.tag || c.tag === el.tag) && c.classes.every(x => has(el, x)) && c.ids.every(x => has(el, x)) && c.not.every(x => !has(el, x));
function matches(parsed, chain, idx = parsed.compounds.length - 1, pos = 0) {
  if (!matchCompound(parsed.compounds[idx], chain[pos])) return false;
  if (idx === 0) return true;
  if (parsed.combinators[idx - 1] === '>') return matches(parsed, chain, idx - 1, pos + 1);
  for (let p = pos + 1; p < chain.length; p++) if (matches(parsed, chain, idx - 1, p)) return true;
  return false;
}
function mediaApplies(query, width) {
  const parts = query.split(/\s+and\s+/);
  return parts.every(part => { const m = /^\((min|max)-width:\s*(\d+)px\)$/.exec(part.trim()); return !!m && (m[1] === 'min' ? width >= +m[2] : width <= +m[2]); });
}
function computedDisplay({ layers, rules }, chain, width) {
  const L = layers.length, rank = rule => [rule.important ? 1 : 0, rule.important ? (rule.layer === null ? 0 : L - layers.indexOf(rule.layer)) : (rule.layer === null ? L : layers.indexOf(rule.layer)), ...rule.parsed.specificity, rule.order];
  const winners = rules.filter(rule => rule.media.every(q => mediaApplies(q, width))).map(rule => ({ ...rule, parsed: parseSelector(rule.selector) })).filter(rule => rule.parsed && matches(rule.parsed, chain));
  winners.sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; });
  return winners[0]?.value ?? 'block';
}
const el = (tag, id, classes) => ({ tag, id, classes: classes.split(/\s+/).filter(Boolean) });
const shell = [el('div', 'app-shell', 'app-shell'), el('body', '', ''), el('html', '', '')];
const homeChain = classes => [el('aside', 'narrative-pane', classes), el('div', '', 'workspace-grid'), el('main', '', 'stage'), ...shell];
const desktopChain = (classes, pane = 'narrative-pane', id = 'narrative-pane') => [el('aside', id, `${pane} ${classes}`), el('div', 'desktop-tool-content', 'desktop-tool-content'), el('aside', 'desktop-inspector', 'desktop-inspector active'), el('div', '', 'workspace-grid'), ...shell];
const dialogChain = (classes, pane = 'narrative-pane', id = 'narrative-pane') => [el('aside', id, `${pane} ${classes}`), el('div', 'tool-content', 'tool-content'), el('dialog', 'workspace-dialog', 'workspace-dialog'), el('body', '', ''), el('html', '', '')];
const cascade = parseSheets(sheetNames.map(name => read('../public/' + name)));

test('every stylesheet of the shell is parsed and styles.css fixes the layer order before narrative.css', () => {
  assert.ok(sheetNames.indexOf('styles.css') >= 0 && sheetNames.indexOf('styles.css') < sheetNames.indexOf('narrative.css'));
  assert.deepEqual(cascade.layers.slice(0, 10), ['tokens', 'base', 'primitives', 'shell', 'deck', 'workspace', 'panels', 'views', 'overlays', 'states'], 'narrative.css must not change the global layer order');
  const paneRules = cascade.rules.filter(rule => /narrative-pane|pane-hidden|portal-active/.test(rule.selector));
  assert.ok(paneRules.length >= 3);
  for (const rule of paneRules) assert.ok(parseSelector(rule.selector), 'the simulator understands every pane visibility selector: ' + rule.selector);
  for (const rule of paneRules.filter(rule => rule.important)) assert.notEqual(rule.layer, null, 'no unlayered !important display rule for panes (it always loses to @layer states): ' + rule.selector);
});

test('the portalled framework pane is visible in the desktop inspector and in the narrow tools dialog', () => {
  const portalled = 'pane-hidden portal-active';
  assert.equal(computedDisplay(cascade, desktopChain(portalled), 1440), 'flex');
  assert.equal(computedDisplay(cascade, dialogChain(portalled), 390), 'flex');
  assert.equal(computedDisplay(cascade, dialogChain(portalled), 1440), 'flex', 'narrow layout on a wide screen (dialog) too');
  // The same cascade shows the agent pane — the simulator agrees with panes that already work in the browser.
  assert.equal(computedDisplay(cascade, desktopChain(portalled, 'assistant-pane spread-pane', 'agent-pane'), 1440), 'flex');
  assert.equal(computedDisplay(cascade, dialogChain(portalled, 'assistant-pane spread-pane', 'agent-pane'), 390), 'flex');
});

test('the framework pane stays hidden at home and in any slot without the portal lifecycle', () => {
  for (const width of [390, 1440]) {
    assert.equal(computedDisplay(cascade, homeChain('narrative-pane pane-hidden'), width), 'none');
    assert.equal(computedDisplay(cascade, homeChain('narrative-pane pane-hidden hidden'), width), 'none', 'restorePortal() state');
    assert.equal(computedDisplay(cascade, homeChain('narrative-pane portal-active'), width), 'none', 'never exposed in the grid');
    assert.equal(computedDisplay(cascade, desktopChain('pane-hidden'), width), 'none', 'not portalled by app.js -> stays hidden');
  }
});

test('the simulator reproduces the original defect (unlayered !important loses to layered !important)', () => {
  const broken = read('../public/narrative.css').replace(/@layer states \{([\s\S]*?)\n\}/, '$1').replace(/\.narrative-pane\.portal-active/g, '.narrative-pane');
  const before = parseSheets(sheetNames.map(name => name === 'narrative.css' ? broken : read('../public/' + name)));
  assert.equal(computedDisplay(before, desktopChain('pane-hidden portal-active'), 1440), 'none');
});

test('app.js portal lifecycle adds portal-active when showing a tool and removes it on restore', () => {
  const app = read('../public/app.js');
  assert.match(app, /else if \(tool === 'narrative'\) \{ panel = \$\('#narrative-pane'\);/);
  assert.match(app, /panel\.classList\.remove\('hidden'\); panel\.classList\.add\('portal-active'\); slot\.replaceChildren\(panel\);/);
  assert.match(app, /panel\.classList\.add\('hidden'\); panel\.classList\.remove\('portal-active'\);/);
});
