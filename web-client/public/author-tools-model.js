// Pure helpers for the author tools: no DOM, no network.
const NUMBER = new Intl.NumberFormat('ru-RU');
export const formatNumber = value => NUMBER.format(Number(value) || 0);
const plural = (n, one, few, many) => { const value = Math.abs(Number(n) || 0), a = value % 10, b = value % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };
export const pluralWords = count => `${formatNumber(count)} ${plural(count, 'слово', 'слова', 'слов')}`;
export const streakLabel = days => plural(days, 'день подряд', 'дня подряд', 'дней подряд');

/** Paragraph diff by longest common subsequence: [{ type: 'same' | 'removed' | 'added', text }]. */
export function diffParagraphs(before, after) {
  const a = String(before).split('\n'), b = String(after).split('\n');
  let head = 0; while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0; while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const left = a.slice(head, a.length - tail), right = b.slice(head, b.length - tail), rows = a.slice(0, head).map(text => ({ type: 'same', text }));
  if (left.length * right.length > 4_000_000) { rows.push(...left.map(text => ({ type: 'removed', text })), ...right.map(text => ({ type: 'added', text }))); }
  else {
    const width = right.length + 1, table = new Uint32Array((left.length + 1) * width);
    for (let i = left.length - 1; i >= 0; i -= 1) for (let j = right.length - 1; j >= 0; j -= 1) table[i * width + j] = left[i] === right[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0, j = 0;
    while (i < left.length && j < right.length) {
      if (left[i] === right[j]) { rows.push({ type: 'same', text: left[i] }); i += 1; j += 1; }
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { rows.push({ type: 'removed', text: left[i] }); i += 1; }
      else { rows.push({ type: 'added', text: right[j] }); j += 1; }
    }
    for (; i < left.length; i += 1) rows.push({ type: 'removed', text: left[i] });
    for (; j < right.length; j += 1) rows.push({ type: 'added', text: right[j] });
  }
  rows.push(...a.slice(a.length - tail).map(text => ({ type: 'same', text })));
  return rows.filter(row => row.type === 'same' || row.text.trim());
}

const LETTER = /[\p{L}\p{N}]/u;
const stemOf = word => { const lower = word.toLocaleLowerCase('ru'); return lower.length >= 5 ? lower.slice(0, lower.length - (lower.length >= 7 ? 2 : 1)) : lower; };
/**
 * Finds a known name that covers `offset` in `line`. Russian case endings are tolerated: every word of a name
 * may differ from the text in its last one or two letters ("Марта" matches "Марты", "Мартой").
 * Returns { entity, start, end } or null. Longer names win.
 */
export function findEntityAt(line, offset, entities) {
  if (typeof line !== 'string' || !Array.isArray(entities) || offset < 0 || offset > line.length) return null;
  const words = []; const pattern = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) words.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  const at = words.findIndex(word => word.start <= offset && offset <= word.end);
  if (at < 0) return null;
  const same = (nameWord, textWord) => { const a = nameWord.toLocaleLowerCase('ru'), b = textWord.toLocaleLowerCase('ru'); if (a === b) return true; const stem = stemOf(nameWord); return b.startsWith(stem) && b.length - stem.length <= 4 && Math.abs(b.length - a.length) <= 2; };
  let best = null;
  for (const entity of entities) {
    const parts = String(entity?.name ?? '').split(/\s+/).filter(part => LETTER.test(part));
    if (!parts.length || parts.length > 6) continue;
    for (let first = Math.max(0, at - parts.length + 1); first <= at; first += 1) {
      if (first + parts.length > words.length) break;
      if (!parts.every((part, index) => same(part, words[first + index].text))) continue;
      // A one-word name must start with a capital letter in the text, otherwise common nouns light up everywhere.
      if (parts.length === 1 && words[first].text[0] !== words[first].text[0].toLocaleUpperCase('ru')) continue;
      const candidate = { entity, start: words[first].start, end: words[first + parts.length - 1].end };
      if (!best || candidate.end - candidate.start > best.end - best.start) best = candidate;
    }
  }
  return best;
}
