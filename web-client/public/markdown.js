const safeHref = value => {
  const href = String(value || '').trim();
  if (!href || /^(?:javascript|data|vbscript|https?):/i.test(href) || href.startsWith('//') || /(^|[\\/])\.\.(?:[\\/]|$)/.test(href)) return null;
  return href;
};

function appendInline(parent, source, links, onLink, onUnresolved) {
  // The wiki token closes only at the first `]]`; a single `]` inside a
  // folder or title is ordinary target text (for example `Book [2026]`).
  const pattern = /(`+)([\s\S]*?)\1|\[\[([\s\S]*?)\]\]|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let cursor = 0, match;
  while ((match = pattern.exec(source))) {
    parent.append(document.createTextNode(source.slice(cursor, match.index)));
    if (match[1] !== undefined) {
      let code = match[2].replace(/\\\|/g, '|').replace(/\n/g, ' ');
      if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
      const element = document.createElement('code'); element.textContent = code; parent.append(element);
    } else if (match[3] !== undefined || match[4] !== undefined) {
      const rawTarget = match[3] ?? match[5], parts = match[3] !== undefined ? rawTarget.split('|') : null;
      const target = (parts ? parts[0] : match[5]).trim(), explicitLabel = parts?.length > 1 && parts.slice(1).join('|').trim();
      const anchor = target.includes('#') ? target.slice(target.indexOf('#') + 1) : '';
      const pathTarget = target.includes('#') ? target.slice(0, target.indexOf('#')) : target;
      const link = links.find(item => item.target === target) || links.find(item => item.target === pathTarget || item.path === pathTarget || item.path === target);
      const label = match[3] !== undefined ? (explicitLabel || link?.label || target) : match[4];
      const a = document.createElement('button'); a.type = 'button'; a.className = 'knowledge-inline-link'; a.textContent = label;
      a.dataset.wikiTarget = target;
      if (link?.status === 'ambiguous') { a.title = 'Ссылка неоднозначна: выберите одну из найденных записей'; a.classList.add('ambiguous'); if (onUnresolved) a.addEventListener('click', () => onUnresolved({ target, label, anchor })); else a.disabled = true; }
      else if (link?.path && onLink) a.addEventListener('click', () => onLink({ ...link, target, label, anchor }));
      else if (!link?.status && safeHref(target) && onUnresolved) a.addEventListener('click', () => onUnresolved({ target, label, anchor }));
      else { a.disabled = true; a.title = link?.status === 'unsafe' ? 'Небезопасная ссылка' : 'Связанная запись не найдена'; }
      parent.append(a);
    } else if (match[6] !== undefined) { const strong = document.createElement('strong'); strong.textContent = match[6]; parent.append(strong); }
    else { const em = document.createElement('em'); em.textContent = match[7]; parent.append(em); }
    cursor = pattern.lastIndex;
  }
  parent.append(document.createTextNode(source.slice(cursor)));
}

function splitTableRow(line) {
  const source = line.trim();
  let cells = [], value = '', codeTicks = 0, wiki = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '`' && !wiki && (i === 0 || source[i - 1] !== '\\')) {
      let end = i + 1; while (source[end] === '`') end += 1;
      const count = end - i;
      if (!codeTicks) codeTicks = count; else if (codeTicks === count) codeTicks = 0;
      value += source.slice(i, end); i = end - 1; continue;
    }
    if (!codeTicks && source.slice(i, i + 2) === '[[') { wiki = true; value += '[['; i += 1; continue; }
    if (!codeTicks && wiki && source.slice(i, i + 2) === ']]') { wiki = false; value += ']]'; i += 1; continue; }
    if (char === '|' && !codeTicks && !wiki) {
      if (i > 0 && source[i - 1] === '\\') { value = value.slice(0, -1) + '|'; continue; }
      cells.push(value.trim()); value = ''; continue;
    }
    value += char;
  }
  cells.push(value.trim());
  if (source.startsWith('|')) cells.shift();
  if (source.endsWith('|') && source[source.length - 2] !== '\\') cells.pop();
  return cells;
}

function isTableSeparator(line, width) {
  const cells = splitTableRow(line);
  return cells.length === width && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

export function renderSafeMarkdown(container, markdown, links = [], onLink, onUnresolved) {
  container.replaceChildren();
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  let paragraph = [], list = null;
  const flushParagraph = () => { if (!paragraph.length) return; const p = document.createElement('p'); appendInline(p, paragraph.join(' '), links, onLink, onUnresolved); container.append(p); paragraph = []; };
  const closeList = () => { if (list) container.append(list); list = null; };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = /^\s*(`{3,}|~{3,})([^`]*)$/.exec(line);
    if (fence) {
      flushParagraph(); closeList();
      const content = [], marker = fence[1][0], length = fence[1].length;
      while (++index < lines.length) {
        const closing = lines[index].trim();
        if (closing.length >= length && [...closing].every(char => char === marker)) break;
        content.push(lines[index]);
      }
      const pre = document.createElement('pre'), code = document.createElement('code');
      code.textContent = content.join('\n'); pre.append(code); container.append(pre); continue;
    }
    const tableHeaders = splitTableRow(line);
    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1], tableHeaders.length) && tableHeaders.length > 0) {
      flushParagraph(); closeList();
      const table = document.createElement('table'), thead = document.createElement('thead'), headerRow = document.createElement('tr');
      for (const value of tableHeaders) { const cell = document.createElement('th'); appendInline(cell, value, links, onLink, onUnresolved); headerRow.append(cell); }
      thead.append(headerRow); table.append(thead);
      const tbody = document.createElement('tbody');
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const values = splitTableRow(lines[index]);
        if (values.length !== tableHeaders.length) break;
        const row = document.createElement('tr');
        for (const value of values) { const cell = document.createElement('td'); appendInline(cell, value, links, onLink, onUnresolved); row.append(cell); }
        tbody.append(row); index += 1;
      }
      index -= 1;
      table.append(tbody); container.append(table); continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    const item = /^\s*([-*+]|\d+\.)\s+(.+)$/.exec(line);
    const listTag = item && /^\d/.test(item[1]) ? 'ol' : 'ul';
    if (heading) { flushParagraph(); closeList(); const h = document.createElement('h' + heading[1].length); appendInline(h, heading[2], links, onLink, onUnresolved); container.append(h); }
    else if (item) { flushParagraph(); if (list && list.tagName.toLowerCase() !== listTag) closeList(); if (!list) list = document.createElement(listTag); const li = document.createElement('li'); appendInline(li, item[2], links, onLink, onUnresolved); list.append(li); }
    else if (!line.trim()) { flushParagraph(); closeList(); }
    else { closeList(); paragraph.push(line.trim()); }
  }
  flushParagraph(); closeList();
}

export { safeHref };
