import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, join, sep, basename } from 'node:path';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const worldError = (message, status = 400) => Object.assign(new Error(message), { status });
const metadata = text => Object.fromEntries((text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '').split(/\r?\n/).flatMap(line => {
  const match = line.match(/^([\w-]+):\s*(.*?)\s*$/); return match ? [[match[1], match[2].replace(/^['"]|['"]$/g, '')]] : [];
}));
function readSource(root, name) {
  if (typeof name !== 'string' || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) throw worldError('Недопустимый источник.');
  const path = resolve(root, name); if (!path.startsWith(root + sep)) throw worldError('Источник за пределами серии.');
  let cursor = root;
  for (const part of name.split('/')) { cursor = join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) throw worldError('Ссылки не импортируются.'); }
  if (!realpathSync(path).startsWith(root + sep) || !lstatSync(path).isFile() || lstatSync(path).size > 2_000_000) throw worldError('Источник недоступен или слишком велик.');
  const bytes = readFileSync(path), text = bytes.toString('utf8'), meta = metadata(text);
  return { id: meta.id || 'source_' + hash(name).slice(0, 16), path: name, title: meta.title || text.match(/^#\s+(.+)$/m)?.[1] || basename(name, '.md'),
    sha256: hash(bytes), status: meta.status || 'source', recordKind: meta.record_kind || 'note', scope: meta.scope || null,
    validFrom: meta.valid_from || null, validUntil: meta.valid_until || null, text,
    links: [...text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g)].map(m => ({ target: m[1], label: m[2] || null })) };
}
// This function has no write capability. Source statuses and unknown times are preserved verbatim.
export function importLivingWorld(seriesRoot, { sourcePaths = [] } = {}) {
  if (!seriesRoot) throw worldError('Выберите серию с локальной базой знаний.', 409);
  const root = realpathSync(seriesRoot), names = []; let bytes = 0;
  function walk(dir, depth) {
    if (depth > 8) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        const size = lstatSync(path).size;
        if (size > 2_000_000) throw worldError('Источник превышает 2 МБ: ' + relative(root, path), 413);
        bytes += size; if (names.length >= 2000 || bytes > 32_000_000) throw worldError('Импорт превышает ограничение; выберите ограниченную серию.', 413);
        names.push(relative(root, path).split(sep).join('/'));
      }
    }
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isSymbolicLink() && entry.isDirectory() && /^(?:02 |03 |04 |05 )/.test(entry.name)) walk(join(root, entry.name), 0);
  }
  if (!Array.isArray(sourcePaths) || sourcePaths.length > 32) throw worldError('Выберите до 32 дополнительных первоисточников.');
  for (const path of sourcePaths) { readSource(root, path); if (!names.includes(path)) names.push(path); }
  const sources = names.sort().map(name => readSource(root, name));
  if (!sources.length) throw worldError('У серии нет доступных записей мира. Импорт не подменяется демонстрационным миром.', 409);
  return { version: 1, name: basename(root), fingerprint: hash(sources.map(s => [s.path, s.sha256])), sources,
    entities: sources.filter(s => s.recordKind === 'entity').map(s => ({ id: s.id, title: s.title, sourcePath: s.path, status: s.status, validFrom: s.validFrom, validUntil: s.validUntil })),
    gaps: ['Сведения из источников не становятся автоматически знаниями персонажей.', 'Неизвестные расстояния, даты и положения не заполняются из defaults WorldX.', 'Прозаические правила сохранены как источники. Неподдержанные механики не исполняются автоматически.'],
    readOnlySources: true };
}
export function sourceFragment(snapshot, path, fragmentId) {
  const source = snapshot.sources.find(s => s.path === path); if (!source) throw worldError('Источник отсутствует в снимке.');
  const marker = '## ' + fragmentId, start = source.text.indexOf(marker);
  if (start < 0) throw worldError('Фрагмент не найден: ' + fragmentId);
  const end = source.text.indexOf('\n## ', start + marker.length);
  const text = source.text.slice(start + marker.length, end < 0 ? undefined : end).trim();
  return { text, source: { path, fragmentId, sha256: source.sha256 }, kind: 'entry_memory', certainty: 'source' };
}
export function validateStaging(value) {
  const data = structuredClone(value);
  const id = v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
  if (!data || !Array.isArray(data.locations) || !data.locations.length || data.locations.length > 200 || !Array.isArray(data.characters) || !data.characters.length || data.characters.length > 40 || !Array.isArray(data.edges)) throw worldError('Нужны места, персонажи и переходы.');
  const locations = new Set(), actors = new Set();
  for (const loc of data.locations) {
    if (!id(loc.id) || loc.id === 'main_area' || locations.has(loc.id) || typeof loc.name !== 'string' || !loc.name.trim() || !Number.isFinite(loc.x) || !Number.isFinite(loc.y)) throw worldError('Недопустимое или повторное место.'); locations.add(loc.id);
    if (!Array.isArray(loc.objects)) loc.objects = [];
  }
  for (const actor of data.characters) {
    if (!id(actor.id) || actors.has(actor.id) || !locations.has(actor.location) || !['hero', 'npc'].includes(actor.role) || typeof actor.name !== 'string' || !actor.name.trim() || typeof actor.goal !== 'string' || !actor.goal.trim()) throw worldError('Проверьте персонажей, их цели и начальные места.'); actors.add(actor.id);
    actor.knowledge ??= []; actor.plan ??= [];
    if (!Array.isArray(actor.knowledge) || actor.knowledge.some(k => !k || typeof k.text !== 'string' || !k.source && k.kind !== 'approved_staging')) throw worldError('Начальные знания требуют источника или явной постановки.');
  }
  const edgeIds = new Set();
  for (const edge of data.edges) {
    if (!id(edge.id) || edgeIds.has(edge.id) || !locations.has(edge.from) || !locations.has(edge.to) || edge.from === edge.to || !Number.isInteger(edge.ticks) || edge.ticks < 1 || edge.ticks > 10000 || !edge.provenance) throw worldError('Переходу нужны отдельные места, длительность и происхождение.'); edgeIds.add(edge.id);
  }
  if (!actors.has(data.heroId) || !Number.isInteger(data.tickMinutes) || data.tickMinutes < 1 || data.tickMinutes > 60) throw worldError('Выберите героя и шаг времени.');
  data.mode = 'manual'; data.autonomousHero = false; data.modelLimit = 0;
  data.scheduled ??= []; data.objects ??= []; data.rules ??= [];
  return data;
}
