import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConceptGraph } from './concept-graph.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const idFor = value => sha(value).slice(0, 24);
const googleDocsIdFromOrigin = value => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || url.username || url.password || url.port || url.search || url.hash) return null;
    const match = url.pathname.match(/^\/document\/d\/([A-Za-z0-9_-]{1,256})\/edit\/?$/);
    return match?.[1] ?? null;
  } catch { return null; }
};
const jsonStringEnd = (source, start) => {
  for (let index=start+1; index<source.length; index++) {
    if (source[index]==='\\') { index++; continue; }
    if (source[index]==='"') return index+1;
  }
  return -1;
};
const jsonValueEnd = (source, start) => {
  const first=source[start];
  if(first==='"')return jsonStringEnd(source,start);
  if(first==='{'||first==='[') {
    const stack=[first==='{'?'}':']'];let inString=false;
    for(let index=start+1;index<source.length;index++) {
      const char=source[index];
      if(inString) {if(char==='\\')index++;else if(char==='"')inString=false;continue;}
      if(char==='"')inString=true;
      else if(char==='{')stack.push('}');else if(char==='[')stack.push(']');
      else if(char==='}'||char===']') {if(stack.pop()!==char)return -1;if(!stack.length)return index+1;}
    }
    return -1;
  }
  let index=start;while(index<source.length&&source[index]!==','&&source[index]!=='}')index++;
  return index>start?index:-1;
};
const boundedTopLevelJson = (source, wanted) => {
  const result={};let index=source.indexOf('{');if(index<0)return result;index++;
  while(index<source.length) {
    while(/\s/.test(source[index]||''))index++;
    if(source[index]==='}')break;
    if(source[index]!== '"')break;
    const keyEnd=jsonStringEnd(source,index);if(keyEnd<0)break;
    let key;try{key=JSON.parse(source.slice(index,keyEnd));}catch{break;}
    index=keyEnd;while(/\s/.test(source[index]||''))index++;
    if(source[index++]!==':')break;
    while(/\s/.test(source[index]||''))index++;
    const valueEnd=jsonValueEnd(source,index);if(valueEnd<0)break;
    if(wanted.has(key))try{result[key]=JSON.parse(source.slice(index,valueEnd));}catch{}
    if(wanted.has('book_id')&&wanted.has('metadata')&&wanted.has('provenance')&&result.book_id!==undefined&&result.metadata!==undefined&&result.provenance!==undefined)break;
    index=valueEnd;while(/\s/.test(source[index]||''))index++;
    if(source[index]!==',')break;index++;
  }
  return result;
};
const corpusBindings = seriesPath => {
  const root=join(seriesPath,'00 Источники'),rows=[]; if(!existsSync(root)||lstatSync(root).isSymbolicLink())return rows;
  for(const entry of readdirSync(root,{withFileTypes:true}).slice(0,1000)) {
    if(!entry.isFile()||entry.isSymbolicLink()||!entry.name.endsWith('.json'))continue;
    const fd=openSync(join(root,entry.name),'r'),buffer=Buffer.alloc(16384);let header;
    try {header=buffer.subarray(0,readSync(fd,buffer,0,buffer.length,0)).toString('utf8');} finally {closeSync(fd);}
    const metadata=boundedTopLevelJson(header,new Set(['book_id','metadata','provenance']));
    if(typeof metadata.book_id==='string'&&typeof metadata.metadata?.title==='string') {
      const nestedOrigin=metadata.metadata.provenance?.origin,legacyOrigin=metadata.provenance?.origin;
      const hasLegacy=metadata.provenance?.origin!==undefined;
      const originConflict=hasLegacy&&nestedOrigin!==undefined&&legacyOrigin!==nestedOrigin;
      const origin=nestedOrigin!==undefined?nestedOrigin:(hasLegacy?legacyOrigin:undefined);
      rows.push({id:metadata.book_id,title:metadata.metadata.title,googleDocumentId:originConflict?null:googleDocsIdFromOrigin(origin)});
    }
  }
  return rows;
};
const titleFor = (text, fallback) => text.match(/^\s*#\s+(.+)$/m)?.[1]?.trim() || fallback.replace(/\.(?:md|markdown|txt)$/i, '').split(/[\\/]/).at(-1);
const storyTextPath = path => {
  const parts=String(path).replace(/\\/g,'/').split('/'), extension=extname(path).toLowerCase();
  if(!['.md','.markdown','.txt'].includes(extension))return false;
  if(parts.some(part=>part.startsWith('.')||/^(?:config(?:uration)?|credentials?|secrets?|internal|служебное|node_modules)$/i.test(part)))return false;
  return true;
};
const safePath = (root, rel, mustExist = true) => {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\')) throw Object.assign(new Error('A safe relative path is required.'), { status: 400 });
  const parts = rel.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw Object.assign(new Error('Path traversal is not allowed.'), { status: 400 });
  const target = resolve(root, ...parts);
  if (target !== root && !target.startsWith(root + sep)) throw Object.assign(new Error('Path is outside the active series.'), { status: 400 });
  let cursor = root;
  for (const part of parts) { cursor = join(cursor, part); if (existsSync(cursor) && (lstatSync(cursor).isSymbolicLink() || (lstatSync(cursor).isJunction?.()))) throw Object.assign(new Error('Symbolic links are not allowed.'), { status: 400 }); }
  if (mustExist && !existsSync(target)) throw Object.assign(new Error('File not found.'), { status: 404 });
  return target;
};
const markdownFiles = (root, max = 5000) => {
  const found = [];
  const walk = (dir, depth = 0) => {
    if (depth > 12 || found.length >= max) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'ru'))) {
      if (entry.name.startsWith('.') || ['node_modules', '.git', '.talewisp'].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && ['.md','.markdown','.txt'].includes(extname(entry.name).toLowerCase())) found.push(full);
      if (found.length >= max) break;
    }
  };
  if (existsSync(root) && lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink()) walk(root);
  return found;
};
const frontmatter = text => {
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  const values = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/); if (!pair) continue;
    let value = pair[2]; if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[pair[1]] = value;
  }
  return { values, body: m ? text.slice(m[0].length) : text };
};
const plain = text => text.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*/,'').replace(/<[^>]*>/g,' ').replace(/!?(\[([^\]]*)\])\([^)]*\)/g,'$2').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,(_,target,alias)=>alias||target.split(/[\\/#^]/).at(-1).replace(/\.(?:md|markdown|txt)$/i,'')).replace(/[`*_>#~-]+/g,' ').replace(/\s+/g,' ').trim();
const countWords = text => (plain(text).match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu) || []).length;
const chapterBody = text => text.replace(/^#{1,6}\s*(?:t\.\d+\s*\/\s*Tab\s*\d+|[A-Z0-9-]+-C\d+-P\d+)\s*\r?\n/gm,'');
const TOOL_UI = {
  talewisp_model_selection:['Выбрать модель и усилие','Проверить модель и уровень рассуждений перед запуском субагента.'],
  talewisp_build_series_base:['Создать базу серии','Подготовить и проверить базу серии по предоставленным источникам.'],
  talewisp_select_vault:['Выбрать хранилище','Выбрать локальное хранилище TaleWisp для текущей сессии.'],
  talewisp_project_status:['Состояние проекта','Показать активное хранилище, типы файлов, подтверждённый канон и предложения.'],
  talewisp_onboarding_status:['Настройка автора и серии','Проверить подготовку автора, стиля, серии и книги.'],
  talewisp_list_files:['Список файлов','Найти файлы серии по типу или папке.'],
  talewisp_read_file:['Прочитать файл','Прочитать текстовый файл из активного хранилища.'],
  talewisp_search:['Поиск по хранилищу','Найти точные текстовые совпадения и показать фрагменты источников.'],
  talewisp_compare_style_edit:['Сравнить правки текста','Сопоставить исходный и авторский варианты без сохранения текста.'],
  talewisp_scene_context:['Контекст сцены','Прочитать сцену и ограниченный контекст связанных записей.'],
  talewisp_save_proposal:['Сохранить предложение','Сохранить авторское предложение как ожидающий проверки материал.'],
  talewisp_apply_proposal:['Применить предложение','Применить сохранённое предложение после явного подтверждения автора.'],
  talewisp_storyart_bind_character:['Связать персонажа с StoryArt','Проверить и записать привязку персонажа к визуальной идентичности StoryArt.'],
  talewisp_storyart_resolve_character:['Найти визуальную идентичность','Разрешить подтверждённую привязку персонажа StoryArt.'],
  talewisp_storyart_stage_art:['Добавить иллюстрацию на проверку','Сохранить иллюстрацию StoryArt как отдельного кандидата для проверки.'],
  talewisp_storyart_confirm_art:['Подтвердить иллюстрацию','Подтвердить иллюстрацию по требуемым записям согласования и QA.'],
  talewisp_storyart_list_art:['Список иллюстраций','Показать зарегистрированные иллюстрации StoryArt.'],
  talewisp_storyart_validate:['Проверить связи StoryArt','Проверить записи жизненного цикла и контрольные суммы подтверждённых изображений.'],
  talewisp_storyart_context:['Иллюстрации для записи','Найти подтверждённые иллюстрации, связанные с указанным источником TaleWisp.'],
  talewisp_continuity_impact:['Влияние изменений на связность','Показать устаревшие источники и зависимые утверждения для указанных контрактов связности.'],
  talewisp_continuity_gaps:['Пробелы связности','Сформировать список противоречий, недостающих данных и неразрешённых ссылок по указанным контрактам.'],
  talewisp_prepare_continuity_extraction:['Подготовить извлечение связности','Прочитать ограниченный набор источников для извлечения фактов и независимой проверки.'],
  talewisp_stage_continuity_extraction:['Сохранить извлечение на проверку','Проверить кандидата и отзыв, затем сохранить авторское предложение по данным связности.'],
  talewisp_continuity_check:['Проверить записи связности','Провести детерминированную проверку указанных записей, связанных с источниками.'],
  talewisp_knowledge_at_scene:['Знания персонажа в сцене','Показать отдельно знания персонажа и доступную читателю информацию в начале сцены.'],
  talewisp_roleplay_readiness:["Готовность ролевой сцены", "Проверить исходные сведения о мире, герое и сцене."],
  talewisp_roleplay_probes:["Вопросы о герое", "Показать необязательные вопросы для исследования мотивов."],
  talewisp_roleplay_start:["Начать ролевую ветку", "Подготовить отдельную неканоническую ветку после проверки готовности."],
  talewisp_roleplay_status:["Состояние ролевой ветки", "Показать текущую фазу и ревизию ветки."],
  talewisp_roleplay_packet:["Контекст ролевого участника", "Подготовить отдельный контекст ведущего, героя или оформителя."],
  talewisp_roleplay_turn:["Следующий шаг ролевой сцены", "Подготовить действие, последствие или принятие скелета на проверку."],
  talewisp_web_google_list:["Найти документы Google Docs", "Найти доступные документы по названию."],
  talewisp_web_google_direct_edit:["Прямая правка в Google Docs", "Подготовить явно запрошенную замену с точным сравнением до применения."],
  talewisp_web_google_insert:["Вставить новый текст в Google Docs", "Подготовить новый текст и точное место вставки на проверку."],
  talewisp_web_google_create_note:["Создать документ заметок", "Подготовить отдельную черновую заметку со ссылкой на источник."],
  talewisp_web_google_reply:["Ответить в комментарии Google Docs", "Подготовить ответ в существующей ветке комментариев."],
  talewisp_web_sheets_list:["Найти таблицу Google Sheets", "Найти связанную таблицу для авторского индекса."],
  talewisp_web_sheets_read:["Прочитать диапазон таблицы", "Прочитать ограниченный диапазон связанного индекса."],
  talewisp_web_sheets_update:["Обновить индекс в Google Sheets", "Подготовить точные изменения ячеек с проверкой прежних значений."],
  talewisp_web_google_read:['Прочитать документ Google Docs','Прочитать документ, вкладки, ревизию, комментарии и ожидающие операции.'],
  talewisp_web_google_suggest:['Предложить правку в Google Docs','Поставить нативное предложение правки на проверку автора.'],
  talewisp_web_google_comment:['Добавить комментарий в Google Docs','Поставить привязанный к фрагменту комментарий на проверку автора.'],
  talewisp_google_capabilities:['Возможности Google Docs','Показать доступные режимы работы с Google Docs и их ограничения.'],
  talewisp_google_normalize_document:['Подготовить структуру документа','Нормализовать вкладки, таблицы, стили, списки и комментарии документа.'],
  talewisp_google_plan_edit:['Подготовить план правки','Подготовить точный план нативного предложения или явно запрошенной прямой правки.'],
  talewisp_google_revalidate_edit:['Перепроверить план правки','Сверить план с полной актуальной версией документа и комментариями.'],
  talewisp_google_linked_context:['Найти связанный контекст','Отобрать предоставленные строки и заметки по персонажам, событиям и состояниям.'],
};
const TOOL_VERBS={read:'Прочитать',search:'Найти',find:'Найти',get:'Получить',list:'Показать',create:'Создать',update:'Обновить',save:'Сохранить',prepare:'Подготовить',stage:'Подготовить',apply:'Применить',check:'Проверить',validate:'Проверить',compare:'Сравнить',resolve:'Найти',select:'Выбрать',review:'Проверить'};
const TOOL_NOUNS={card:'карточку',cards:'карточки',file:'файл',files:'файлы',note:'заметку',notes:'заметки',source:'источник',chapter:'главу',character:'персонажа',scene:'сцену',series:'серию',book:'книгу',document:'документ',proposal:'предложение',style:'стиль',event:'событие',entity:'сущность',timeline:'хронологию',glossary:'глоссарий'};
const toolFallback = name => {const words=String(name).replace(/^talewisp_(?:web_)?/,'').split(/[_\s]+/).filter(Boolean);return [TOOL_VERBS[words[0]]||'Операция TaleWisp',...words.slice(1).map(word=>TOOL_NOUNS[word]||'')].filter(Boolean).join(' ');};
const safeMarkdown = text => text.replace(/<[^>]*>/g,'').replace(/\[([^\]]+)\]\(([^)]*)\)/g,(_,label,target)=>{const value=target.trim();if(value.startsWith('//'))return label;const scheme=value.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);if(scheme&&!/^(?:https?|mailto)$/i.test(scheme[1]))return label;return '['+label+']('+target+')';});
const diffText = (before, after) => {
  const a = String(before ?? '').split('\n'), b = String(after ?? '').split('\n'), out = ['--- before', '+++ after'];
  if (a.length + b.length > 400) return `${out.join('\n')}\n@@ full replacement (${a.length} → ${b.length} lines) @@`;
  const max = Math.max(a.length, b.length); for (let i = 0; i < max; i++) { if (a[i] === b[i]) out.push(` ${a[i] ?? ''}`); else { if (a[i] !== undefined) out.push(`-${a[i]}`); if (b[i] !== undefined) out.push(`+${b[i]}`); } }
  return out.join('\n');
};

// Read-only scan of the vault hierarchy. IDs are hashes of catalog-relative paths.
export function scanVaultCatalog(catalogRoot) {
    const authorsRoot = join(catalogRoot, '00 Автор');
    const authors = [];
    if (existsSync(authorsRoot)) for (const authorEntry of readdirSync(authorsRoot, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name,'ru'))) {
      if (!authorEntry.isDirectory() || authorEntry.isSymbolicLink() || authorEntry.name.startsWith('.')) continue;
      const authorPath = join(authorsRoot, authorEntry.name), authorMetaPath = join(authorPath, 'Автор.md');
      let authorName = authorEntry.name; if (existsSync(authorMetaPath)) { const { values, body } = frontmatter(readFileSync(authorMetaPath, 'utf8')); authorName = values.title || titleFor(body, authorEntry.name); }
      const series = [];
      for (const seriesEntry of readdirSync(authorPath, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name,'ru'))) {
        if (!seriesEntry.isDirectory() || seriesEntry.isSymbolicLink() || seriesEntry.name.startsWith('.')) continue;
        const seriesPath = join(authorPath, seriesEntry.name), passportPath = join(seriesPath, '00 Паспорт серии.md');
        const passportDir = join(seriesPath, '00 Паспорт');
        if (!existsSync(passportPath) && !existsSync(passportDir)) continue;
        let seriesName = seriesEntry.name;
        const metaCandidate = existsSync(passportPath) ? passportPath : markdownFiles(passportDir, 2)[0];
        if (metaCandidate) { const { values, body } = frontmatter(readFileSync(metaCandidate, 'utf8')); seriesName = values.title || titleFor(body, seriesEntry.name); }
        const books = [];
        const bindings=corpusBindings(seriesPath);
        const booksRoot = join(seriesPath, '01 Книги');
        if (existsSync(booksRoot)) for (const bookEntry of readdirSync(booksRoot, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name,'ru'))) {
          if (!bookEntry.isDirectory() || bookEntry.isSymbolicLink() || bookEntry.name.startsWith('.')) continue;
          const bookPath = join(booksRoot, bookEntry.name), bookFiles = markdownFiles(bookPath, 20);
          if (!bookFiles.length) continue;
          const primary = bookFiles.find(file => basename(file, '.md') === bookEntry.name) || bookFiles[0];
          let bookName = bookEntry.name; const { values, body } = frontmatter(readFileSync(primary, 'utf8')); bookName = values.title || titleFor(body, bookEntry.name);
          const matched=bindings.filter(row=>row.title===bookEntry.name||row.title===bookName);
          const explicitLogicalId=values.book_id||values.bookId||values.book;
          const logicalBinding=explicitLogicalId
            ? bindings.filter(row=>String(row.id)===String(explicitLogicalId))
            : matched;
          const bookId=String(explicitLogicalId||(matched.length===1?matched[0].id:null)||values.id||bookName);
          const googleDocumentId=logicalBinding.length===1?logicalBinding[0].googleDocumentId:null;
          books.push({ id: idFor(relative(catalogRoot, bookPath).replaceAll('\\','/')), logicalId:bookId, name: bookName, path: bookPath, primary, googleDocumentId: googleDocumentId || undefined });
        }
        series.push({ id: idFor(relative(catalogRoot, seriesPath).replaceAll('\\','/')), name: seriesName, path: seriesPath, books });
      }
      if (series.length) authors.push({ id: idFor(relative(catalogRoot, authorPath).replaceAll('\\','/')), name: authorName, path: authorPath, series });
    }
    return authors;
}

const projectError = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const EMPTY_PROJECT = { revision: 0, entities: [], attachments: [], aliases: [] };
// A Google Doc that the vault already associates with a book becomes that book's implicit companion file.
export const implicitAttachmentId = bookId => 'gdoc-' + idFor('implicit-google|' + bookId);
export const parseGoogleDocumentId = value => {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (/^[A-Za-z0-9_-]{10,256}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || url.username || url.password || url.port) return null;
    return url.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,256})(?:\/|$)/)?.[1] ?? null;
  } catch { return null; }
};

// Effective project = read-only vault scan + app-owned overlay (renames, relinks, logical entities, companion files).
export function buildProjectCatalog({ catalogRoot, scan, snapshot = EMPTY_PROJECT }) {
  const rel = path => path ? relative(catalogRoot, path).replaceAll('\\', '/') : null;
  const override = new Map(snapshot.entities.map(row => [row.kind + ':' + row.id, row]));
  const aliasByLegacy = new Map(snapshot.aliases.map(row => [row.legacyBookId, row]));
  const authors = [], series = [], books = [], authorsById = new Map(), seriesById = new Map(), booksById = new Map(), vaultBooksById = new Map();
  const logical = kind => snapshot.entities.filter(row => row.kind === kind && row.origin === 'logical');
  for (const author of scan) {
    const o = override.get('author:' + author.id);
    const row = { id: author.id, origin: 'vault', name: o?.name || author.name, vaultName: author.name, path: author.path, relPath: rel(author.path), series: [] };
    authors.push(row); authorsById.set(row.id, row);
  }
  for (const e of logical('author')) if (!authorsById.has(e.id)) { const row = { id: e.id, origin: 'logical', name: e.name || 'Автор без имени', vaultName: null, path: null, relPath: null, series: [] }; authors.push(row); authorsById.set(row.id, row); }
  for (const author of scan) for (const item of author.series) {
    const o = override.get('series:' + item.id);
    const row = { id: item.id, origin: 'vault', name: o?.name || item.name, vaultName: item.name, authorId: o?.parentId && authorsById.has(o.parentId) ? o.parentId : author.id, vaultAuthorId: author.id, path: item.path, relPath: rel(item.path), books: [] };
    series.push(row); seriesById.set(row.id, row);
  }
  for (const e of logical('series')) if (!seriesById.has(e.id) && authorsById.has(e.parentId)) { const row = { id: e.id, origin: 'logical', name: e.name || 'Серия без названия', vaultName: null, authorId: e.parentId, vaultAuthorId: null, path: null, relPath: null, books: [] }; series.push(row); seriesById.set(row.id, row); }
  for (const author of scan) for (const item of author.series) for (const book of item.books) {
    vaultBooksById.set(book.id, { ...book, seriesId: item.id, authorId: author.id });
    if (aliasByLegacy.has(book.id)) continue; // absorbed by an explicit, author-confirmed migration
    const o = override.get('book:' + book.id);
    if (o?.origin === 'logical') continue;
    const row = { id: book.id, origin: 'vault', name: o?.name || book.name, vaultName: book.name, seriesId: o?.parentId && seriesById.has(o.parentId) ? o.parentId : item.id, vaultSeriesId: item.id, logicalId: book.logicalId, path: book.path, relPath: rel(book.path), googleDocumentId: book.googleDocumentId ?? null, attachments: [], archived: [] };
    books.push(row); booksById.set(row.id, row);
  }
  for (const e of logical('book')) if (!booksById.has(e.id) && seriesById.has(e.parentId)) { const row = { id: e.id, origin: 'logical', name: e.name || 'Книга без названия', vaultName: null, seriesId: e.parentId, vaultSeriesId: null, logicalId: e.id, path: null, relPath: null, googleDocumentId: null, attachments: [], archived: [] }; books.push(row); booksById.set(row.id, row); }
  for (const row of series) authorsById.get(row.authorId)?.series.push(row);
  for (const row of books) seriesById.get(row.seriesId)?.books.push(row);
  const stored = new Map(snapshot.attachments.map(row => [row.id, row])), attachments = [];
  for (const book of books) if (book.origin === 'vault' && book.googleDocumentId && !stored.has(implicitAttachmentId(book.id))) {
    attachments.push({ id: implicitAttachmentId(book.id), bookId: book.id, kind: 'google-doc', name: book.vaultName, defaultName: book.vaultName, displayName: null, googleDocumentId: book.googleDocumentId, sourceRef: null, sourceFull: null, legacyBookId: book.id, origin: 'implicit', archivedAt: null, version: 0 });
  }
  for (const row of snapshot.attachments) {
    const legacy = row.legacyBookId ? vaultBooksById.get(row.legacyBookId) : null;
    const defaultName = row.kind === 'vault-file' ? basename(String(row.sourceRef || ''), extname(String(row.sourceRef || ''))) : row.kind === 'google-doc' && row.origin === 'author' ? 'Документ Google Docs' : (legacy?.name || 'Связанный файл');
    const sourceFull = row.kind === 'vault-book' ? (legacy?.primary ?? null) : row.kind === 'vault-file' && row.sourceRef ? resolve(catalogRoot, ...String(row.sourceRef).split('/')) : null;
    attachments.push({ ...row, name: row.displayName || defaultName, defaultName, sourceFull, sourceRef: row.kind === 'vault-book' ? (legacy ? rel(legacy.path) : row.sourceRef) : row.sourceRef });
  }
  const attachmentsById = new Map(), unlinked = [];
  for (const item of attachments) {
    attachmentsById.set(item.id, item);
    const book = booksById.get(item.bookId);
    if (!book) unlinked.push(item); else if (item.archivedAt) book.archived.push(item); else book.attachments.push(item);
  }
  return { revision: snapshot.revision, authors, series, books, authorsById, seriesById, booksById, attachments, attachmentsById, aliasByLegacy, vaultBooksById, unlinked };
}

// ---- Explicit, author-confirmed migration: several legacy "books" (really sources) → one book with companion files.
const MIGRATION_KEYS = ['authorId', 'authorName', 'seriesId', 'seriesName', 'bookName', 'preferredStableBookId'];
export const migrationMapHash = map => sha(JSON.stringify({ ...Object.fromEntries(MIGRATION_KEYS.map(key => [key, map?.[key] ?? null])), sourceBooks: (map?.sourceBooks ?? []).map(row => [row?.id ?? null, row?.name ?? null, row?.googleDocumentId ?? null]) }));
const migrationAttachmentId = (hash, sourceId) => 'att-' + idFor('migration|' + hash + '|' + sourceId);

export function planBookMigration({ map, store, catalogRoot }) {
  const errors = [], warnings = [];
  if (!store?.project) throw projectError(503, 'Project storage is unavailable.');
  const text = value => typeof value === 'string' && value.trim() ? value : null;
  for (const key of MIGRATION_KEYS) if (!text(map?.[key])) errors.push(`Карта миграции: поле ${key} обязательно.`);
  const sources = Array.isArray(map?.sourceBooks) ? map.sourceBooks : [];
  if (!sources.length) errors.push('Карта миграции: список sourceBooks пуст.');
  const ids = sources.map(row => row?.id);
  if (ids.some(id => !text(id)) || new Set(ids).size !== ids.length) errors.push('Карта миграции: ID исходных книг должны быть непустыми и уникальными.');
  if (map?.preferredStableBookId && !ids.includes(map.preferredStableBookId)) errors.push('preferredStableBookId должен быть одним из sourceBooks.');
  if (map?.initialSelection && (map.initialSelection.authorId !== map.authorId || map.initialSelection.seriesId !== map.seriesId || map.initialSelection.bookId !== map.preferredStableBookId)) errors.push('initialSelection не совпадает с автором, серией и книгой карты.');
  const hash = migrationMapHash(map), snapshot = store.project.snapshot();
  const existing = store.project.activeMigration(hash);
  if (existing) return { status: 'already-applied', migrationId: existing.id, mapHash: hash, revision: snapshot.revision, errors: [], warnings: [] };
  const scan = scanVaultCatalog(catalogRoot), eff = buildProjectCatalog({ catalogRoot, scan, snapshot });
  const author = scan.find(row => row.id === map?.authorId), series = author?.series.find(row => row.id === map?.seriesId);
  if (!author) errors.push(`Автор ${map?.authorId} не найден в хранилище.`);
  else if (author.name !== map.authorName && eff.authorsById.get(author.id)?.name !== map.authorName) errors.push(`Имя автора не совпадает: в хранилище «${author.name}», в карте «${map.authorName}».`);
  if (author && !series) errors.push(`Серия ${map?.seriesId} не найдена у автора ${map?.authorId}.`);
  else if (series && series.name !== map.seriesName && eff.seriesById.get(series.id)?.name !== map.seriesName) errors.push(`Название серии не совпадает: в хранилище «${series.name}», в карте «${map.seriesName}».`);
  if (series && eff.seriesById.get(series.id)?.authorId !== map.authorId) errors.push('Серия уже перепривязана к другому автору в настройках проекта; миграция не выполняется.');
  if (snapshot.entities.some(row => row.kind === 'book' && row.id === map?.preferredStableBookId && row.origin === 'logical')) errors.push('Книга с preferredStableBookId уже существует как самостоятельная.');
  const removedOverrides = [], attachments = [], moves = [];
  for (const source of sources) {
    const scanned = series?.books.find(row => row.id === source?.id);
    if (!scanned) { errors.push(`Исходная книга ${source?.id} не найдена в серии ${map?.seriesId}.`); continue; }
    if (scanned.name !== source.name) errors.push(`Название ${source.id} не совпадает: в хранилище «${scanned.name}», в карте «${source.name}».`);
    if ((scanned.googleDocumentId ?? null) !== (source.googleDocumentId ?? null)) errors.push(`Google Docs ID для ${source.id} не совпадает с привязкой хранилища.`);
    if (eff.aliasByLegacy.has(source.id)) errors.push(`${source.id} уже перенесена другой миграцией.`);
    const o = snapshot.entities.find(row => row.kind === 'book' && row.id === source.id);
    if (o?.parentId && o.parentId !== map.seriesId) errors.push(`${source.id} перепривязана к другой серии в настройках; миграция не выполняется.`);
    if (o && source.id === map.preferredStableBookId) removedOverrides.push(o);
    else if (o) warnings.push(`Переименование ${source.id} в настройках будет заменено именем сопутствующего файла.`);
    if (snapshot.attachments.some(row => row.bookId === source.id || (row.legacyBookId === source.id && row.origin !== 'migration'))) errors.push(`У ${source.id} уже есть сопутствующие файлы из настроек; сначала перенесите их вручную.`);
    attachments.push({ id: migrationAttachmentId(hash, source.id), legacyBookId: source.id, name: source.name, googleDocumentId: source.googleDocumentId ?? null, path: relative(catalogRoot, scanned.path).replaceAll('\\', '/') });
    if (source.id !== map.preferredStableBookId) moves.push({ from: [map.authorId, map.seriesId, source.id], to: [map.authorId, map.seriesId, map.preferredStableBookId], counts: store.project.countScope([map.authorId, map.seriesId, source.id]) });
  }
  let currentSelection = null; try { currentSelection = JSON.parse(store.getSetting('workspace.selection') || 'null'); } catch {}
  const target = { authorId: map?.authorId, seriesId: map?.seriesId, bookId: map?.preferredStableBookId };
  const selectionFollows = !!currentSelection && currentSelection.authorId === map?.authorId && currentSelection.seriesId === map?.seriesId && ids.includes(currentSelection.bookId);
  const selection = { before: currentSelection, after: selectionFollows || !currentSelection ? target : currentSelection, setInitial: !currentSelection && !!map?.initialSelection };
  return { status: errors.length ? 'invalid' : 'ready', mapHash: hash, revision: snapshot.revision, book: { id: map?.preferredStableBookId, name: map?.bookName, authorId: map?.authorId, seriesId: map?.seriesId, keptScope: store.project.countScope([map?.authorId ?? null, map?.seriesId ?? null, map?.preferredStableBookId ?? null]) }, attachments, aliases: ids, moves, removedOverrides, selection, vaultWrites: 0, errors, warnings };
}

export function applyBookMigration({ map, store, catalogRoot }) {
  const plan = planBookMigration({ map, store, catalogRoot });
  if (plan.status === 'already-applied') return plan;
  if (plan.status !== 'ready') throw Object.assign(projectError(400, 'Миграция не прошла проверку: ' + plan.errors.join(' ')), { plan });
  const migrationId = randomUUID();
  const committed = store.project.commit({ expectedRevision: plan.revision, action: 'migration.apply', payload: { migrationId, mapHash: plan.mapHash }, write: ({ changeId, putEntity, putAttachment, moveScope, db }) => {
    for (const id of plan.aliases) if (db.prepare('SELECT 1 FROM project_aliases WHERE legacy_book_id=?').get(id)) throw projectError(409, `${id} уже перенесена.`);
    for (const row of plan.removedOverrides) db.prepare('DELETE FROM project_entities WHERE kind=? AND id=?').run(row.kind, row.id);
    putEntity({ kind: 'book', id: plan.book.id, origin: 'logical', name: plan.book.name, parentId: plan.book.seriesId, migrationId });
    const timestamp = new Date().toISOString();
    for (const item of plan.attachments) {
      putAttachment({ id: item.id, bookId: plan.book.id, kind: 'vault-book', displayName: item.name, googleDocumentId: item.googleDocumentId, sourceRef: item.path, legacyBookId: item.legacyBookId, origin: 'migration', migrationId });
      db.prepare('INSERT INTO project_aliases(legacy_book_id,legacy_author_id,legacy_series_id,book_id,migration_id,created_at) VALUES(?,?,?,?,?,?)').run(item.legacyBookId, plan.book.authorId, plan.book.seriesId, plan.book.id, migrationId, timestamp);
    }
    const moved = plan.moves.map(move => ({ from: move.from, to: move.to, counts: moveScope(move.from, move.to, changeId, migrationId) }));
    if (plan.selection.setInitial) {
      db.prepare("INSERT INTO settings(key,value) VALUES('workspace.selection',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(plan.selection.after));
      db.prepare('INSERT INTO project_moves(migration_id,change_id,table_name,row_ids,before,after,created_at) VALUES(?,?,?,?,?,?,?)').run(migrationId, changeId, 'selection-initial', '[]', 'null', JSON.stringify(plan.selection.after), timestamp);
    }
    const summary = { mapHash: plan.mapHash, book: plan.book, attachments: plan.attachments.map(item => item.id), aliases: plan.aliases, moved, removedOverrides: plan.removedOverrides, selection: plan.selection, revisionBefore: plan.revision, revisionAfter: plan.revision + 1 };
    db.prepare('INSERT INTO project_migrations(id,map_hash,applied_at,summary) VALUES(?,?,?,?)').run(migrationId, plan.mapHash, timestamp, JSON.stringify(summary));
    return moved;
  } });
  return { ...plan, status: 'applied', migrationId, revision: committed.revision, moved: committed.result };
}

export function rollbackBookMigration({ store, migrationId }) {
  const migration = store?.project?.migrationById(migrationId);
  if (!migration) throw projectError(404, 'Миграция не найдена.');
  if (migration.rolledBackAt) return { status: 'already-rolled-back', migrationId };
  const revision = store.project.revision();
  if (revision !== migration.summary.revisionAfter) throw projectError(409, 'После миграции были другие изменения настроек проекта; откат возможен только из резервной копии.');
  store.project.commit({ expectedRevision: revision, action: 'migration.rollback', payload: { migrationId }, write: ({ db }) => {
    store.project.undoMoves(migrationId);
    if (db.prepare("SELECT 1 FROM project_moves WHERE migration_id=? AND table_name='selection-initial'").get(migrationId)) {
      const current = db.prepare("SELECT value FROM settings WHERE key='workspace.selection'").get()?.value;
      if (current === JSON.stringify(migration.summary.selection.after)) db.prepare("DELETE FROM settings WHERE key='workspace.selection'").run();
    }
    db.prepare('DELETE FROM project_aliases WHERE migration_id=?').run(migrationId);
    db.prepare('DELETE FROM project_attachments WHERE migration_id=?').run(migrationId);
    db.prepare("DELETE FROM project_entities WHERE migration_id=? AND kind='book' AND origin='logical'").run(migrationId);
    for (const row of migration.summary.removedOverrides ?? []) db.prepare('INSERT INTO project_entities(kind,id,origin,name,parent_id,version,created_at,updated_at,migration_id) VALUES(?,?,?,?,?,?,?,?,NULL)').run(row.kind, row.id, row.origin, row.name, row.parentId, row.version, row.createdAt, row.updatedAt);
    db.prepare('UPDATE project_migrations SET rolled_back_at=? WHERE id=?').run(new Date().toISOString(), migrationId);
  } });
  return { status: 'rolled-back', migrationId };
}

export function createWorkspaceService({ catalogVaultPath, initialVaultPath, store, dataDir, isAgentRunning, isAgentBusy, onSelect, onDetach, actionApplier, toolsProvider }) {
  const catalogRoot = resolve(catalogVaultPath ?? process.env.TALEWISP_CATALOG_VAULT ?? fileURLToPath(new URL('../vault', import.meta.url)));
  const proposalDir = resolve(dataDir, 'workspace-backups'); mkdirSync(proposalDir, { recursive: true, mode: 0o700 });
  const scanCatalog = () => scanVaultCatalog(catalogRoot);
  const effective = () => buildProjectCatalog({ catalogRoot, scan: scanCatalog(), snapshot: store.project?.snapshot() ?? EMPTY_PROJECT });
  const resolveIds = (ids, eff) => {
    if (!ids?.authorId || !ids?.seriesId) return null;
    const series = eff.seriesById.get(ids.seriesId);
    if (ids.bookId == null) return series && series.authorId === ids.authorId && !series.books.length ? { author: eff.authorsById.get(series.authorId), series, book: null } : null;
    const direct = eff.booksById.get(ids.bookId);
    if (direct && direct.seriesId === ids.seriesId && eff.seriesById.get(direct.seriesId)?.authorId === ids.authorId) return { author: eff.authorsById.get(ids.authorId), series: eff.seriesById.get(direct.seriesId), book: direct };
    // Strict alias: a legacy book ID resolves only together with its own legacy author and series.
    const alias = eff.aliasByLegacy.get(ids.bookId), target = alias && eff.booksById.get(alias.bookId);
    if (target && alias.legacyAuthorId === ids.authorId && alias.legacySeriesId === ids.seriesId) { const targetSeries = eff.seriesById.get(target.seriesId); return { author: eff.authorsById.get(targetSeries.authorId), series: targetSeries, book: target }; }
    return null;
  };
  const findSelection = (ids, eff = effective()) => {
    const found = resolveIds(ids, eff); if (!found?.author) return null;
    const { author, series, book } = found, root = series.origin === 'vault' ? series.path : null;
    const attachments = book?.attachments ?? [];
    const legacyBooks = attachments.filter(item => item.kind === 'vault-book').map(item => eff.vaultBooksById.get(item.legacyBookId)).filter(Boolean);
    const touched = !!book && (book.origin === 'logical' || attachments.some(item => item.origin !== 'implicit') || book.archived.length > 0 || eff.revision > 0 && (series.authorId !== series.vaultAuthorId || book.seriesId !== book.vaultSeriesId));
    const fingerprint = touched ? { book: book.id, series: series.id, author: author.id, root: series.relPath, attachments: attachments.map(item => [item.id, item.kind, item.googleDocumentId ?? null, item.sourceRef ?? null]) } : null;
    // Effective display names enter the revision whenever any of them is an overlay rename, so the agent context follows renames.
    const renamed = author.name !== author.vaultName || series.name !== series.vaultName || !!book && book.name !== book.vaultName;
    const names = renamed ? [author.name, series.name, book?.name ?? null] : null;
    return { authorId: author.id, authorName: author.name, seriesId: series.id, seriesName: series.name, bookId: book?.id ?? null, logicalBookId: book?.logicalId ?? null, bookName: book?.name ?? null, authorPath: author.path, seriesPath: root, bookPath: book?.path ?? null,
      bookPaths: [book?.path, ...legacyBooks.map(row => row.path)].filter(Boolean), noteLogicalIds: new Set([book?.logicalId, ...legacyBooks.map(row => row.logicalId)].filter(Boolean).map(String)), attachments, fingerprint, names };
  };
  let active = findSelection(JSON.parse(store.getSetting('workspace.selection') || 'null'));
  if (!active && initialVaultPath) {
    const candidate = resolve(initialVaultPath), eff = effective();
    for (const series of eff.series) if (series.path === candidate && series.books[0]) active=findSelection({authorId:series.authorId,seriesId:series.id,bookId:series.books[0].id},eff);
  }
  const selection = () => active ? { authorId:active.authorId,seriesId:active.seriesId,bookId:active.bookId } : null;
  const selectionData = () => active ? { authorId:active.authorId, authorName:active.authorName, seriesId:active.seriesId, seriesName:active.seriesName, bookId:active.bookId, bookName:active.bookName } : null;
  const revision = () => sha(JSON.stringify({ selection: selection(), series: active?.seriesPath || '', files: active?.seriesPath ? markdownFiles(active.seriesPath).map(file => { const st = lstatSync(file); return [relative(active.seriesPath,file).replaceAll('\\','/'),st.size,st.mtimeMs]; }) : [], ...(active?.fingerprint ? { project: active.fingerprint } : {}), ...(active?.names ? { names: active.names } : {}) }));
  const sourceFiles = () => active?.seriesPath ? markdownFiles(active.seriesPath) : [];
  const matchLink = (target, allFiles, root=active?.seriesPath??catalogRoot, sourcePath='') => {
    const raw=String(target).replace(/\\/g,'/').split('#')[0].split('^')[0], vaultRelative=raw.startsWith('/'), normalized=raw.replace(/\.(?:md|markdown|txt)$/i,'').replace(/^\//,'');
    if(normalized.includes('\0'))return {status:'unsafe',candidates:[]};
    if(sourcePath&&!vaultRelative){const current=resolve(root,dirname(sourcePath),raw.replace(/^\//,''));const candidate=extname(current)?current:`${current}.md`;if(candidate!==root&&!candidate.startsWith(root+sep))return {status:'unsafe',candidates:[]};if(allFiles.includes(candidate))return {status:'resolved',path:relative(root,candidate).replaceAll('\\','/'),fullPath:candidate};}
    if(normalized.split('/').includes('..'))return {status:'unsafe',candidates:[]};
    const exact = allFiles.filter(file => relative(root,file).replaceAll('\\','/').replace(/\.md$/i,'') === normalized);
    const candidates = exact.length ? exact : allFiles.filter(file => { const rel=relative(root,file).replaceAll('\\','/').replace(/\.md$/i,'');return rel===normalized || rel.endsWith('/'+normalized) || basename(rel)===basename(normalized); });
    return candidates.length === 1 ? { status:'resolved', path:relative(root,candidates[0]).replaceAll('\\','/'), fullPath:candidates[0] } : { status:candidates.length ? 'ambiguous' : 'missing', candidates:candidates.slice(0,20).map(file=>relative(root,file).replaceAll('\\','/')) };
  };
  const linkRows = (text, allFiles, root=active?.seriesPath??catalogRoot, sourcePath='') => {
    const rows=[]; const re=/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)]+)\)|(?<!\!)\[(?!\[)([^\]]+)\](?!\()/g; let m;
    while ((m=re.exec(text))) { const target=m[1]??m[4]??m[5]; if (/^(?:https?:|mailto:)/i.test(target)) { rows.push({target,label:m[2]??m[3]??m[5]??target,status:'external',path:null}); continue; } if (/^[A-Za-z][A-Za-z0-9+.-]*:/i.test(target)) { rows.push({target,label:m[2]??m[3]??m[5]??target,status:'unsafe',path:null}); continue; } const found=matchLink(target,allFiles,root,sourcePath); const actual=found.path?allFiles.find(file=>relative(root,file).replaceAll('\\','/')===found.path):null; const actualTitle=actual?frontmatter(readFileSync(actual,'utf8')).values.title||titleFor(readFileSync(actual,'utf8'),actual):null; rows.push({target,label:actualTitle||m[2]||m[3]||m[5]||target,status:found.status,path:found.path??null,candidates:found.candidates}); }
    return rows;
  };
  const filesByPath = () => sourceFiles().map(fullPath => ({ fullPath, path:relative(active.seriesPath,fullPath).replaceAll('\\','/'), text:readFileSync(fullPath,'utf8') }));
  const legacyFiles=()=>markdownFiles(catalogRoot).filter(file=>!relative(catalogRoot,file).replaceAll('\\','/').startsWith('00 Автор/'));
  const cards = ({ type = '', q = '', scope='' } = {}) => {
    const root=scope==='unassigned'?catalogRoot:active?.seriesPath;
    if (!root) return { cards:[],truncated:false,indexedCount:0 };
    const all=scope==='unassigned'?legacyFiles().map(fullPath=>({fullPath,path:relative(root,fullPath).replaceAll('\\','/'),text:readFileSync(fullPath,'utf8')})):filesByPath(), needle=String(q).toLocaleLowerCase('ru'), selected=all.filter(file=>{
      const fm=frontmatter(file.text), t=String(fm.values.type||'note');
      return (!type || t===type) && (!needle || `${file.path} ${fm.values.title||''} ${plain(fm.body)}`.toLocaleLowerCase('ru').includes(needle));
    });
    const limit=250, result=selected.slice(0,limit).map(file=>{ const fm=frontmatter(file.text),visibleBody=fm.values.record_kind==='source-chapter'?chapterBody(fm.body):fm.body;return {path:file.path,title:fm.values.title||(fm.values.record_kind==='source-chapter'?'Исходный текст':titleFor(fm.body,file.path)),type:fm.values.type||'note',excerpt:plain(visibleBody).slice(0,360),status:fm.values.status||fm.values.canon_status||'unmarked',linksCount:linkRows(fm.body,all.map(item=>item.fullPath),root,file.path).length}; });
    return {cards:result,truncated:selected.length>limit||all.length>=5000,indexedCount:all.length,matchedCount:selected.length,scanLimit:5000};
  };
  const card = (path,scope='') => {
    const root=scope==='unassigned'?catalogRoot:active?.seriesPath;if(!root)throw Object.assign(new Error('Select an author, series and book first.'),{status:409});
    const target=safePath(root,path), text=readFileSync(target,'utf8'), fm=frontmatter(text), all=(scope==='unassigned'?legacyFiles().map(fullPath=>({fullPath,path:relative(root,fullPath).replaceAll('\\','/'),text:readFileSync(fullPath,'utf8')})):filesByPath()), from=relative(root,target).replaceAll('\\','/'), links=linkRows(fm.body,all.map(item=>item.fullPath),root,from);
    const backlinks=all.filter(file=>file.path!==from&&linkRows(file.text,all.map(item=>item.fullPath),root,file.path).some(link=>link.status==='resolved'&&link.path===from)).map(file=>({path:file.path,title:frontmatter(file.text).values.title||titleFor(file.text,file.path)})).slice(0,100);
    return {path:from,title:fm.values.title||(fm.values.record_kind==='source-chapter'?'Исходный текст':titleFor(fm.body,from)),type:fm.values.type||'note',body:safeMarkdown(fm.values.record_kind==='source-chapter'?chapterBody(fm.body):fm.body),revision:sha(text),metadata:fm.values,links,backlinks,truncated:backlinks.length>=100};
  };
  const graph = ({ scope = 'active' } = {}) => {
    const unassigned = scope === 'unassigned';
    const root = unassigned ? catalogRoot : active?.seriesPath;
    if (!root) return { mode:'concepts',rootId:null,nodes:[],edges:[],scope:'active',selection:null,truncated:false,totalNodes:0,diagnostics:{status:'outline-missing'} };
    if (active && !unassigned) return loadConceptGraph({dataDir,seriesId:selection().seriesId,root,safePath,selection:{...active, ...selection()}});
    if (unassigned) return loadConceptGraph({dataDir,seriesId:null,root,safePath,selection:null,scope:'unassigned'});

  };
  // Companion files are listed with the book; they are never the book itself.
  const shortAttachment = item => ({ id:item.id, name:item.name, kind:item.kind, ...(item.googleDocumentId?{googleDocumentId:item.googleDocumentId}:{}) });
  const catalogFrom = eff => ({ authors:eff.authors.map(author=>({id:author.id,name:author.name,series:author.series.map(series=>({id:series.id,name:series.name,books:series.books.map(book=>({id:book.id,name:book.name,attachments:book.attachments.map(shortAttachment)}))}))})), active:selection(), revision:revision(), projectRevision:eff.revision, agentContext:{...agentContext}, unassigned:{id:'unassigned',name:'Legacy / unassigned',cardCount:legacyFiles().length} });
  const catalog = () => catalogFrom(effective());
  // The agent/sources context is "ready" only after onSelect confirmed the current selection.
  // A failed switch detaches it (fail closed) until a later selection succeeds.
  let agentContext = { status: 'ready', error: null };
  const detachContext = error => { agentContext = { status: 'detached', error: String(error?.message || error || 'Агент не переключился на выбранную книгу.') }; try { onDetach?.(); } catch {} };
  const switchContext = async () => {
    // A logical book or series without a vault knowledge base passes vaultPath:null; no previous vault is reused.
    await onSelect?.({vaultPath:active?.seriesPath??null,selection:selectionData(),revision:revision()});
    agentContext = { status: 'ready', error: null };
  };
  const select = async ids => {
    if (isAgentRunning?.()||isAgentBusy?.()) throw Object.assign(new Error('Workspace cannot change during an active agent turn.'),{status:409});
    const candidate=findSelection(ids); if (!candidate) throw Object.assign(new Error('Selection does not match the workspace catalog.'),{status:400});
    const previous=active; active=candidate;
    try { await switchContext(); store.setSetting('workspace.selection',JSON.stringify(selection())); }
    catch(error) { active=previous; detachContext(error); throw error; }
    return catalog();
  };
  const scopeFilter = row => !!active && row.authorId===active.authorId && row.seriesId===active.seriesId && row.bookId===active.bookId;
  let currentToolsProvider=toolsProvider;
  const overview = async () => {
    const all=sourceFiles(); let manuscripts=[],sceneAnalyses=[];
    if(active){
      const corpus=all.map(file=>({file,fm:frontmatter(readFileSync(file,'utf8'))}));
      const chapters=corpus.filter(item=>item.fm.values.record_kind==='source-chapter'&&(!active.logicalBookId||String(item.fm.values.book_id||'')===active.logicalBookId));
      for(const {file,fm} of chapters){const rel=relative(active.seriesPath,file).replaceAll('\\','/');manuscripts.push({path:rel,title:fm.values.title||'Исходный текст',type:'source-chapter',words:countWords(chapterBody(fm.body)),status:fm.values.status||'source'});}
      sceneAnalyses=corpus.filter(item=>item.fm.values.record_kind==='scene-analysis'&&String(item.fm.values.book_id||item.fm.values.book||'')===active.logicalBookId).map(({file,fm})=>{const rel=relative(active.seriesPath,file).replaceAll('\\','/');return {path:rel,title:fm.values.title||titleFor(fm.body,rel),type:'scene-analysis',status:fm.values.status||'analysis'};});
    }
    const boundDocs=store.listDocuments({scope:'all'}).filter(scopeFilter), boundNotes=store.listNotes({scope:'all'}).filter(scopeFilter);
    const words=boundDocs.reduce((sum,row)=>sum+countWords(row.text||''),0), targetWords=boundDocs.reduce((sum,row)=>sum+(Number(row.targetWords)||0),0), completedCount=boundDocs.filter(row=>row.status==='completed').length;
    const styleFiles=active?all.map(file=>({file,rel:relative(active.seriesPath,file).replaceAll('\\','/'),fm:frontmatter(readFileSync(file,'utf8'))})):[];
    const lexicalRules=active?all.filter(file=>/лексический словарь/i.test(file)).map(file=>relative(active.seriesPath,file).replaceAll('\\','/')):[];
    const exclusionReason='Авторский стиль исключён из работы по прямому указанию автора.';
    const excluded=styleFiles.some(x=>(x.rel==='00 Паспорт серии.md'||x.rel.startsWith('00 Паспорт/'))&&x.fm.body.includes(exclusionReason));
    const confirmedStyle=styleFiles.filter(x=>{
      const meta=x.fm.values, state=meta.setup_status||meta.confirmation||meta.status||meta.canon_status||'';
      return /^(?:confirmed|approved|author-confirmed)$/i.test(state)
        && /^(?:style-profile|author-profile|style_profile|author_profile)$/i.test(meta.type||meta.record_kind||'')
        && !/лексический словарь|lexicon|lexical/i.test(x.rel+' '+(meta.profile_kind||'')+' '+(meta.record_kind||''));
    });
    const vaultNotes=all.map(file=>({file,fm:frontmatter(readFileSync(file,'utf8'))})).filter(x=>x.fm.values.record_kind!=='source-chapter'&&!/^(?:app-note|application-note)$/i.test(x.fm.values.record_kind||'')&&(!x.fm.values.type||/note|замет/i.test(x.fm.values.type)));
    const scopedVaultNotes=vaultNotes.filter(x=>{const rel=relative(active.seriesPath,x.file).replaceAll('\\','/'),binding=x.fm.values.book_id||x.fm.values.book;return (!rel.startsWith('01 Книги/')||active.bookPaths.some(path=>x.file.startsWith(path+sep)))&&(!binding||active.noteLogicalIds.has(String(binding)));});
    const noteRows=[...scopedVaultNotes.map(x=>({id:null,title:x.fm.values.title||titleFor(x.fm.body,x.file),type:'vault-note',status:x.fm.values.status||'unmarked',path:relative(active.seriesPath,x.file).replaceAll('\\','/')})),...boundNotes.map(row=>({id:row.id,title:row.title,type:'note',status:row.status||'draft'}))];
    const rawTools=await currentToolsProvider?.()??[];
    const capabilities=rawTools.map(tool=>{const name=tool.name||tool.title||'unknown',annotations=tool.annotations||{},mode=annotations.readOnlyHint===true?'read':'proposal',[title,description]=TOOL_UI[name]||[toolFallback(name),'Выполнить действие TaleWisp в активном рабочем пространстве.'];return {...tool,name,title,mode,description};});
    return {active:selectionData(),attachments:active?active.attachments.map(item=>publicAttachment(item,active.seriesPath)):[],manuscripts,sceneAnalyses,sourceWords:manuscripts.reduce((sum,item)=>sum+item.words,0),notes:noteRows,progress:{words,targetWords,draftCount:boundDocs.length,completedCount},style:{available:!excluded&&confirmedStyle.length>0,excluded,exclusionReason:excluded?exclusionReason:null,paths:confirmedStyle.map(x=>x.rel),lexicalRules},capabilities};
  };
  const proposalView = row => row && JSON.parse(row.payload);
  const ownsProposal = row => !!active&&row?.authorId===active.authorId&&row?.seriesId===active.seriesId&&row?.bookId===active.bookId;
  const proposal = id => {const row=proposalView(store.getWorkspaceProposal(id));if(row&&!ownsProposal(row))throw Object.assign(new Error('Proposal belongs to another workspace.'),{status:404});return row;};
  const prepareProposal = payload => {
    if (!active) throw Object.assign(new Error('Select an active series first.'),{status:409});
    if (!payload || (payload.path!==null&&typeof payload.path!=='string') || typeof payload.text!=='string') throw Object.assign(new Error('Proposal requires exact text and either a relative path or local draft scope.'),{status:400});
    if(payload.path!==null&&!storyTextPath(payload.path))throw Object.assign(new Error('Canonical proposals may target only visible story text files (.md, .markdown, .txt).'),{status:400});
    if(payload.path!==null&&!active.seriesPath)throw Object.assign(new Error('This book is not linked to a series knowledge base; only local drafts can be proposed.'),{status:409});
    const localDraft=payload.path===null, target=localDraft?null:safePath(active.seriesPath,payload.path,false), exists=target?existsSync(target):false; if (exists && !lstatSync(target).isFile()) throw Object.assign(new Error('Proposal target must be a regular file.'),{status:400});
    const before=exists?readFileSync(target,'utf8'):null, baseRevision=exists?sha(before):null;
    if (payload.baseRevision!==undefined && payload.baseRevision!==baseRevision) throw Object.assign(new Error('Source revision changed before proposal preparation.'),{status:409});
    if(payload.workspaceRevision!==undefined&&payload.workspaceRevision!==revision())throw Object.assign(new Error('Workspace changed before proposal preparation.'),{status:409});
    const row={id:randomUUID(),authorId:active.authorId,seriesId:active.seriesId,bookId:active.bookId,title:String(payload.title||(localDraft?'Proposed draft':basename(payload.path,'.md'))),path:payload.path,state:'pending',summary:String(payload.summary||'Review the exact proposed change.'),createdAt:new Date().toISOString(),before,after:payload.text,diff:diffText(before??'',payload.text),baseRevision,workspaceRevision:revision(),tool:null,arguments:null,localDraft};
    store.saveWorkspaceProposal(row);return row;
  };
  const listProposals = () => store.listWorkspaceProposals().map(proposalView).filter(ownsProposal).map(({id,title,path,tool,state,summary,createdAt})=>({id,title,path,tool,state,summary,createdAt}));
  const applyProposal = id => {
    if(isAgentRunning?.())throw Object.assign(new Error('Proposal cannot be applied during an active agent turn.'),{status:409});
    const row=proposal(id);if(!row)throw Object.assign(new Error('Proposal not found.'),{status:404});if(row.state==='applied')return row;if(row.state!=='pending')throw Object.assign(new Error('Proposal is no longer pending.'),{status:409});
    if(!active||row.workspaceRevision!==revision())throw Object.assign(new Error('Workspace changed since proposal preparation.'),{status:409});
    if(row.localDraft){const doc=store.createDocument({title:row.title,text:row.after,authorId:active.authorId,seriesId:active.seriesId,bookId:active.bookId,status:'draft'});row.state='applied';row.appliedAt=new Date().toISOString();row.documentId=doc.id;store.saveWorkspaceProposal(row);return row;}
    if(!active.seriesPath)throw Object.assign(new Error('This book is not linked to a series knowledge base.'),{status:409});
    const target=safePath(active.seriesPath,row.path,false), exists=existsSync(target), current=exists?readFileSync(target,'utf8'):null;
    if ((row.baseRevision===null && exists) || (row.baseRevision!==null && (!exists || sha(current)!==row.baseRevision))) throw Object.assign(new Error('Source changed since proposal preparation.'),{status:409});
    if(exists){const backup=join(proposalDir,`${row.id}.before`);writeFileSync(backup,current,{encoding:'utf8',flag:'wx',mode:0o600});row.backupCreated=true;}
    mkdirSync(dirname(target),{recursive:true}); const temp=join(dirname(target),`.${basename(target)}.${row.id}.tmp`);writeFileSync(temp,row.after,{encoding:'utf8',flag:'wx',mode:0o600});renameSync(temp,target);
    row.state='applied';row.appliedAt=new Date().toISOString();row.resultRevision=sha(row.after);store.saveWorkspaceProposal(row);return row;
  };
  const rejectProposal = id => {const row=proposal(id);if(!row)throw Object.assign(new Error('Proposal not found.'),{status:404});if(row.state==='applied')throw Object.assign(new Error('Applied proposal cannot be rejected.'),{status:409});row.state='rejected';row.rejectedAt=new Date().toISOString();store.saveWorkspaceProposal(row);return row;};
  const queueAction = ({tool,arguments:args,summary,workspaceRevision}) => {if(typeof tool!=='string'||!tool||!args||typeof args!=='object')throw Object.assign(new Error('A concrete tool action is required.'),{status:400});if(!active)throw Object.assign(new Error('Select an active workspace first.'),{status:409});if(workspaceRevision!==undefined&&workspaceRevision!==revision())throw Object.assign(new Error('Workspace changed before action preparation.'),{status:409});const row={id:randomUUID(),authorId:active.authorId,seriesId:active.seriesId,bookId:active.bookId,title:tool,state:'pending',summary:String(summary||`Review ${tool} action.`),createdAt:new Date().toISOString(),before:null,after:null,diff:null,baseRevision:null,workspaceRevision:revision(),tool,arguments:args};store.saveWorkspaceProposal(row);return row;};
  let currentActionApplier=actionApplier;
  const setActionApplier=fn=>{if(typeof fn!=='function')throw new TypeError('Action applier must be a function.');currentActionApplier=fn;};
  let actionLock=false;
  const applyAction=async id=>{if(actionLock)throw Object.assign(new Error('Another plugin action is executing.'),{status:409});const row=proposal(id);if(!row)throw Object.assign(new Error('Proposal not found.'),{status:404});if(!row.tool)throw Object.assign(new Error('Proposal is not a plugin action.'),{status:400});if(row.state==='applied')return row;if(row.state!=='pending')throw Object.assign(new Error('Proposal is no longer pending.'),{status:409});if(row.workspaceRevision!==revision())throw Object.assign(new Error('Workspace changed since action preparation.'),{status:409});if(!currentActionApplier)throw Object.assign(new Error('Plugin action application is unavailable.'),{status:503});if(isAgentRunning?.())throw Object.assign(new Error('Plugin action cannot be applied during an active agent turn.'),{status:409});actionLock=true;try{row.state='executing';row.executionId=randomUUID();row.executionStartedAt=new Date().toISOString();store.saveWorkspaceProposal(row);const result=await currentActionApplier(row);if(result?.isError)throw Object.assign(new Error(result.content?.map?.(x=>x.text).filter(Boolean).join('\n')||'Plugin reported an action error.'),{status:502});row.state='applied';row.appliedAt=new Date().toISOString();row.result=result;store.saveWorkspaceProposal(row);return row;}catch(error){row.state='needs_review';row.error=String(error?.message||error);row.needsReviewAt=new Date().toISOString();store.saveWorkspaceProposal(row);throw error;}finally{actionLock=false;}};
  for(const raw of store.listWorkspaceProposals()){const row=proposalView(raw);if(row?.state==='executing'){row.state='needs_review';row.error='The application stopped while the plugin action was executing.';row.needsReviewAt=new Date().toISOString();store.saveWorkspaceProposal(row);}}
  // ---- Project settings: names and links of authors, series, books and companion files.
  const busy = () => !!(isAgentBusy ? isAgentBusy() : isAgentRunning?.());
  const badRequest = message => projectError(400, message, 'project_invalid');
  const cleanName = (value, label) => {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw badRequest(`${label}: укажите название обычным текстом.`);
    const name = value.replace(/\s+/g, ' ').trim();
    if (!name || name.length > 200) throw badRequest(`${label}: название должно содержать от 1 до 200 символов.`);
    return name;
  };
  const newId = () => randomUUID().replaceAll('-', '').slice(0, 24);
  const sameTuple = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  function publicAttachment(item, root = null) {
    const inside = !!root && !!item.sourceFull && (item.sourceFull === root || item.sourceFull.startsWith(root + sep)) && existsSync(item.sourceFull);
    return { id:item.id, name:item.name, defaultName:item.defaultName, kind:item.kind, bookId:item.bookId, origin:item.origin, googleDocumentId:item.googleDocumentId ?? null, path:item.sourceRef ?? null, sourcePath:inside ? relative(root, item.sourceFull).replaceAll('\\', '/') : null, sourceAvailable:(item.kind === 'vault-file' || item.kind === 'vault-book') && !!item.sourceFull && existsSync(item.sourceFull), archivedAt:item.archivedAt ?? null };
  }
  // Read-only view of one known companion file by attachment ID, wherever its book now lives.
  // Only the catalogued source of a working (not archived) link is read; nothing enters the knowledge base or manuscript.
  const attachmentSource = id => {
    const eff = effective(), item = typeof id === 'string' ? eff.attachmentsById.get(id) : null;
    if (!item || item.archivedAt || !eff.booksById.has(item.bookId)) throw projectError(404, 'Связанный файл не найден.');
    const missing = () => projectError(404, 'У этого связанного файла нет доступного исходника в хранилище.');
    if ((item.kind !== 'vault-file' && item.kind !== 'vault-book') || !item.sourceFull) throw missing();
    const rel = relative(catalogRoot, item.sourceFull).replaceAll('\\', '/');
    if (!storyTextPath(rel)) throw missing();
    let target; try { target = safePath(catalogRoot, rel); } catch { throw missing(); }
    if (!lstatSync(target).isFile()) throw missing();
    const text = readFileSync(target, 'utf8'), fm = frontmatter(text), chapter = fm.values.record_kind === 'source-chapter';
    return { attachmentId: item.id, path: rel, title: fm.values.title || item.name, type: fm.values.type || 'note', body: safeMarkdown(chapter ? chapterBody(fm.body) : fm.body), revision: sha(text), metadata: fm.values, links: [], backlinks: [], readOnly: true };
  };
  const projectView = (eff = effective()) => {
    const current = selection(), rootOf = book => { const series = eff.seriesById.get(book?.seriesId); return series?.origin === 'vault' ? series.path : null; };
    const place = item => { const book = eff.booksById.get(item.bookId), series = book && eff.seriesById.get(book.seriesId); return { bookName: book?.name ?? null, seriesId: series?.id ?? null, seriesName: series?.name ?? null }; };
    return {
      revision: eff.revision, agentBusy: busy(), active: current, agentContext: { ...agentContext },
      authors: eff.authors.map(author => ({ id: author.id, name: author.name, vaultName: author.vaultName, origin: author.origin, path: author.relPath, seriesIds: author.series.map(row => row.id) })),
      series: eff.series.map(series => ({ id: series.id, name: series.name, vaultName: series.vaultName, origin: series.origin, authorId: series.authorId, path: series.relPath, hasKnowledgeBase: series.origin === 'vault', bookIds: series.books.map(row => row.id) })),
      books: eff.books.map(book => ({ id: book.id, name: book.name, vaultName: book.vaultName, origin: book.origin, seriesId: book.seriesId, path: book.relPath, attachmentCount: book.attachments.length, archivedCount: book.archived.length, active: current?.bookId === book.id })),
      attachments: eff.books.flatMap(book => book.attachments.map(item => ({ ...publicAttachment(item, rootOf(book)), ...place(item) }))),
      archived: eff.books.flatMap(book => book.archived.map(item => ({ ...publicAttachment(item, rootOf(book)), ...place(item) }))),
      unlinked: eff.unlinked.map(item => publicAttachment(item)),
    };
  };
  const projectSources = bookId => {
    const eff = effective(), book = eff.booksById.get(bookId), series = book && eff.seriesById.get(book.seriesId);
    if (!book) throw projectError(404, 'Книга не найдена.');
    if (series.origin !== 'vault') return { bookId, files: [], truncated: false, reason: 'У серии нет базы знаний в хранилище.' };
    const files = markdownFiles(series.path, 2001).map(file => relative(series.path, file).replaceAll('\\', '/')).filter(storyTextPath);
    return { bookId, files: files.slice(0, 2000), truncated: files.length > 2000 };
  };
  const tupleOf = (eff, book, seriesOverride, authorOverride) => {
    const series = seriesOverride ?? eff.seriesById.get(book.seriesId);
    return [authorOverride ?? series.authorId, series.id, book.id];
  };
  const mutate = async (body, action, plan) => {
    if (!store.project) throw projectError(503, 'Хранилище настроек проекта недоступно.');
    if (!body || typeof body !== 'object') throw badRequest('Нужен JSON-объект изменений.');
    if (busy()) throw projectError(409, 'Агент сейчас работает. Дождитесь завершения ответа или остановите его, затем меняйте настройки проекта.', 'agent_busy');
    if (!Number.isSafeInteger(body.expectedRevision)) throw badRequest('Нужна текущая ревизия настроек проекта (expectedRevision).');
    const eff = effective();
    if (eff.revision !== body.expectedRevision) throw projectError(409, 'Настройки проекта изменились в другом окне. Обновите экран и повторите.', 'project_conflict');
    const { moves = [], reselect = null, write, summary = {} } = plan(eff); // validation throws here, before any write
    const activeTuple = active ? [active.authorId, active.seriesId, active.bookId] : null;
    const affectsActive = moves.some(move => sameTuple(move.from, activeTuple)) || sameTuple(reselect?.from, activeTuple);
    if (affectsActive && body.confirmActive !== true) throw projectError(409, 'Изменение затрагивает открытую книгу. Сохраните черновики и подтвердите переключение.', 'active_confirmation_required');
    const previousSelection = JSON.stringify(selection()), previousRevision = active ? revision() : null;
    const committed = store.project.commit({ expectedRevision: body.expectedRevision, action, payload: summary, write: ctx => {
      if (activeTuple) ctx.db.prepare("INSERT INTO settings(key,value) VALUES('workspace.selection',?) ON CONFLICT(key) DO NOTHING").run(JSON.stringify(selection()));
      const moved = moves.map(move => ({ from: move.from, to: move.to, counts: ctx.moveScope(move.from, move.to, ctx.changeId) }));
      if (reselect && sameTuple(reselect.from, activeTuple)) ctx.db.prepare("UPDATE settings SET value=? WHERE key='workspace.selection'").run(JSON.stringify({ authorId: reselect.to[0], seriesId: reselect.to[1], bookId: reselect.to[2] }));
      return { moved, created: write?.(ctx) ?? null };
    } });
    let warning = null, activeChanged = false;
    if (active) {
      const next = findSelection(JSON.parse(store.getSetting('workspace.selection') || 'null'));
      if (next) active = next;
      activeChanged = JSON.stringify(selection()) !== previousSelection;
      if (!next) { warning = 'Открытая книга больше не найдена в каталоге; выберите книгу заново.'; detachContext(warning); }
      else if (activeChanged || revision() !== previousRevision) {
        try { await switchContext(); }
        catch (error) { warning = 'Настройки сохранены, но агент и источники не переключились: ' + (error?.message || error) + ' Агент отключён от книги, пока вы не выберете её заново.'; detachContext(warning); }
      }
    }
    const finalEff = effective();
    return { project: projectView(finalEff), catalog: catalogFrom(finalEff), activeChanged, moved: committed.result.moved, created: committed.result.created, warning, agentContext: { ...agentContext } };
  };
  const requireAuthor = (eff, id) => { const row = typeof id === 'string' && eff.authorsById.get(id); if (!row) throw badRequest('Автор не найден в каталоге проекта.'); return row; };
  const requireSeries = (eff, id) => { const row = typeof id === 'string' && eff.seriesById.get(id); if (!row) throw badRequest('Серия не найдена в каталоге проекта.'); return row; };
  const requireBook = (eff, id) => { const row = typeof id === 'string' && eff.booksById.get(id); if (!row) throw badRequest('Книга не найдена в каталоге проекта.'); return row; };
  const onlyKeys = (body, keys) => { const extra = Object.keys(body || {}).filter(key => !['expectedRevision', 'confirmActive', ...keys].includes(key)); if (extra.length) throw badRequest('Неизвестные поля: ' + extra.join(', ')); };
  const attachmentInput = (eff, book, body) => {
    const hasGoogle = body.googleDocument !== undefined, hasSource = body.sourcePath !== undefined;
    if (hasGoogle === hasSource) throw badRequest('Укажите либо ссылку/ID Google Docs, либо файл из базы серии.');
    const linked = [...book.attachments, ...book.archived];
    if (hasGoogle) {
      const googleDocumentId = parseGoogleDocumentId(body.googleDocument);
      if (!googleDocumentId) throw badRequest('Это не ссылка на документ Google Docs и не его ID.');
      const twin = linked.find(item => item.googleDocumentId === googleDocumentId);
      if (twin) throw projectError(409, twin.archivedAt ? 'Этот документ уже связан с книгой и лежит в архиве — восстановите его.' : 'Этот документ уже связан с этой книгой.', 'attachment_exists');
      return { kind: 'google-doc', googleDocumentId, sourceRef: null };
    }
    const series = eff.seriesById.get(book.seriesId);
    if (series.origin !== 'vault') throw badRequest('У серии этой книги нет базы знаний в хранилище; прикрепите документ Google Docs.');
    const target = safePath(series.path, body.sourcePath);
    if (!lstatSync(target).isFile() || !storyTextPath(body.sourcePath)) throw badRequest('Можно прикрепить только видимый текстовый файл серии (.md, .markdown, .txt).');
    const sourceRef = relative(catalogRoot, target).replaceAll('\\', '/');
    const twin = linked.find(item => item.sourceRef === sourceRef && item.kind === 'vault-file');
    if (twin) throw projectError(409, twin.archivedAt ? 'Этот файл уже связан с книгой и лежит в архиве — восстановите его.' : 'Этот файл уже связан с этой книгой.', 'attachment_exists');
    return { kind: 'vault-file', googleDocumentId: null, sourceRef };
  };
  const storedAttachment = (item, changes) => ({ id: item.id, bookId: item.bookId, kind: item.kind, displayName: item.displayName ?? null, googleDocumentId: item.googleDocumentId ?? null, sourceRef: item.kind === 'vault-book' ? item.sourceRef : item.sourceRef ?? null, legacyBookId: item.legacyBookId ?? null, origin: item.origin, archivedAt: item.archivedAt ?? null, ...changes });
  const requireAttachment = (eff, id) => { const row = typeof id === 'string' && eff.attachmentsById.get(id); if (!row) throw projectError(404, 'Связанный файл не найден.'); return row; };

  const projectApi = {
    view: () => projectView(),
    sources: projectSources,
    attachmentSource,
    createAuthor: body => mutate(body, 'author.create', () => {
      onlyKeys(body, ['name']); const name = cleanName(body.name, 'Автор'), id = newId();
      return { summary: { id, name }, write: ({ putEntity }) => { putEntity({ kind: 'author', id, origin: 'logical', name }); return { kind: 'author', id }; } };
    }),
    createSeries: body => mutate(body, 'series.create', eff => {
      onlyKeys(body, ['name', 'authorId']); const name = cleanName(body.name, 'Серия'), author = requireAuthor(eff, body.authorId), id = newId();
      return { summary: { id, name, authorId: author.id }, write: ({ putEntity }) => { putEntity({ kind: 'series', id, origin: 'logical', name, parentId: author.id }); return { kind: 'series', id }; } };
    }),
    createBook: body => mutate(body, 'book.create', eff => {
      onlyKeys(body, ['name', 'seriesId', 'googleDocument']); const name = cleanName(body.name, 'Книга'), series = requireSeries(eff, body.seriesId), id = newId();
      let googleDocumentId = null;
      if (body.googleDocument !== undefined && body.googleDocument !== '') { googleDocumentId = parseGoogleDocumentId(body.googleDocument); if (!googleDocumentId) throw badRequest('Это не ссылка на документ Google Docs и не его ID.'); }
      // A book created inside the open empty series only becomes the selection; series-scope rows keep bookId null.
      const reselect = active && active.seriesId === series.id && active.bookId === null ? { from: [series.authorId, series.id, null], to: [series.authorId, series.id, id] } : null;
      return { reselect, summary: { id, name, seriesId: series.id, googleDocumentId }, write: ({ putEntity, putAttachment }) => {
        putEntity({ kind: 'book', id, origin: 'logical', name, parentId: series.id });
        if (googleDocumentId) putAttachment({ id: 'att-' + newId(), bookId: id, kind: 'google-doc', googleDocumentId, origin: 'author' });
        return { kind: 'book', id };
      } };
    }),
    updateAuthor: (id, body) => mutate(body, 'author.update', eff => {
      onlyKeys(body, ['name']); const author = requireAuthor(eff, id), name = cleanName(body.name, 'Автор');
      if (name === author.name) throw badRequest('Изменений нет.');
      return { summary: { id, name }, write: ({ putEntity }) => putEntity({ kind: 'author', id, origin: author.origin, name: author.origin === 'vault' && name === author.vaultName ? null : name }) };
    }),
    updateSeries: (id, body) => mutate(body, 'series.update', eff => {
      onlyKeys(body, ['name', 'authorId']); const series = requireSeries(eff, id);
      const name = body.name === undefined ? series.name : cleanName(body.name, 'Серия'), author = body.authorId === undefined ? eff.authorsById.get(series.authorId) : requireAuthor(eff, body.authorId);
      if (name === series.name && author.id === series.authorId) throw badRequest('Изменений нет.');
      const moves = author.id === series.authorId ? [] : [...series.books.map(book => ({ from: [series.authorId, series.id, book.id], to: [author.id, series.id, book.id] })), { from: [series.authorId, series.id, null], to: [author.id, series.id, null] }];
      return { moves, summary: { id, name, authorId: author.id }, write: ({ putEntity }) => putEntity({ kind: 'series', id, origin: series.origin, name: series.origin === 'vault' && name === series.vaultName ? null : name, parentId: series.origin === 'vault' && author.id === series.vaultAuthorId ? null : author.id }) };
    }),
    updateBook: (id, body) => mutate(body, 'book.update', eff => {
      onlyKeys(body, ['name', 'seriesId']); const book = requireBook(eff, id);
      const name = body.name === undefined ? book.name : cleanName(body.name, 'Книга'), series = body.seriesId === undefined ? eff.seriesById.get(book.seriesId) : requireSeries(eff, body.seriesId);
      if (name === book.name && series.id === book.seriesId) throw badRequest('Изменений нет.');
      const moves = series.id === book.seriesId ? [] : [{ from: tupleOf(eff, book), to: tupleOf(eff, book, series) }];
      return { moves, summary: { id, name, seriesId: series.id }, write: ({ putEntity }) => putEntity({ kind: 'book', id, origin: book.origin, name: book.origin === 'vault' && name === book.vaultName ? null : name, parentId: book.origin === 'vault' && series.id === book.vaultSeriesId ? null : series.id }) };
    }),
    attach: body => mutate(body, 'attachment.create', eff => {
      onlyKeys(body, ['bookId', 'googleDocument', 'sourcePath', 'name']); const book = requireBook(eff, body.bookId);
      const input = attachmentInput(eff, book, body), displayName = body.name === undefined || body.name === '' ? null : cleanName(body.name, 'Связанный файл'), id = 'att-' + newId();
      return { summary: { id, bookId: book.id, kind: input.kind }, write: ({ putAttachment }) => { putAttachment({ id, bookId: book.id, displayName, origin: 'author', ...input }); return { kind: 'attachment', id }; } };
    }),
    updateAttachment: (id, body) => mutate(body, 'attachment.update', eff => {
      onlyKeys(body, ['name', 'bookId']); const item = requireAttachment(eff, id);
      const book = body.bookId === undefined ? eff.booksById.get(item.bookId) : requireBook(eff, body.bookId);
      if (!book) throw badRequest('Выберите книгу для этого файла.');
      const displayName = body.name === undefined ? item.displayName ?? null : body.name === '' ? null : cleanName(body.name, 'Связанный файл');
      const finalName = displayName === item.defaultName ? null : displayName;
      if (finalName === (item.displayName ?? null) && book.id === item.bookId) throw badRequest('Изменений нет.');
      if (book.id !== item.bookId && [...book.attachments, ...book.archived].some(other => other.id !== item.id && other.kind === item.kind && (item.googleDocumentId ? other.googleDocumentId === item.googleDocumentId : other.sourceRef === item.sourceRef))) throw projectError(409, 'У выбранной книги уже есть этот файл.', 'attachment_exists');
      return { summary: { id, bookId: book.id, name: finalName }, write: ({ putAttachment }) => putAttachment(storedAttachment(item, { bookId: book.id, displayName: finalName })) };
    }),
    // Archive hides one link only: Google Drive, vault files and other books' links stay untouched.
    archiveAttachment: (id, body) => mutate(body, 'attachment.archive', eff => {
      onlyKeys(body, []); const item = requireAttachment(eff, id);
      if (item.archivedAt) throw projectError(409, 'Файл уже в архиве.', 'already_archived');
      return { summary: { id }, write: ({ putAttachment }) => putAttachment(storedAttachment(item, { archivedAt: new Date().toISOString() })) };
    }),
    restoreAttachment: (id, body) => mutate(body, 'attachment.restore', eff => {
      onlyKeys(body, []); const item = requireAttachment(eff, id);
      if (!item.archivedAt) throw projectError(409, 'Файл не в архиве.', 'not_archived');
      if (!eff.booksById.has(item.bookId)) throw badRequest('Книга этого файла больше не найдена; сначала привяжите файл к книге.');
      return { summary: { id }, write: ({ putAttachment }) => putAttachment(storedAttachment(item, { archivedAt: null })) };
    }),
  };
  // Import publishing matches the vault folder names, which are independent from display renames.
  const locateVaultSeries = (authorName, seriesName) => {
    const eff = effective(), series = eff.series.find(row => row.origin === 'vault' && row.vaultName === seriesName && eff.authorsById.get(row.vaultAuthorId)?.vaultName === authorName);
    return series ? { authorId: series.authorId, seriesId: series.id, bookId: series.books[0]?.id ?? null } : null;
  };
  // Delegation history of the open scope: the live log plus full logs of scopes merged into it by relinks/migration.
  const delegationHistory = () => {
    if (!active) return { scopeKey: null, current: [], moved: [] };
    const key = JSON.stringify([active.authorId, active.seriesId, active.bookId]);
    let current = []; try { const rows = JSON.parse(store.getSetting('agent.delegations.' + key) || '[]'); current = Array.isArray(rows) ? rows : []; } catch {}
    return { scopeKey: key, current, moved: store.project?.movedDelegationHistory?.(key) ?? [] };
  };
  return {catalog,select,overview,agentContext:()=>({...agentContext}),delegationHistory,cards,card,graph,root:()=>active?.seriesPath??null,selection:selectionData,revision,prepareProposal,listProposals,proposal,applyProposal,applyAction,rejectProposal,queueAction,setActionApplier,setToolsProvider:fn=>{currentToolsProvider=fn;},scopeFilter,project:projectApi,locateVaultSeries};
}
