import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');

test('the theme picker is not suppressed by other masthead menus that reuse its wrapper class', () => {
  const themes = read('themes.js'), tools = read('author-tools.js');
  // The author tools launcher is styled as a .theme-picker and is mounted in the same masthead.
  assert.match(tools, /theme-picker at-launcher/);
  // So the picker must detect itself by its own toggle id, never by the shared wrapper class.
  assert.match(themes, /host\.querySelector\('#theme-picker-toggle'\)/);
  assert.doesNotMatch(themes, /host\.querySelector\('\.theme-picker'\)/);
  assert.match(themes, /toggle\.id = 'theme-picker-toggle'/);
});
