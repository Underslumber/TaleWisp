// Canonical UTF-16 text offsets. Formatting and reviewer annotations are distinct data.
export const FONT_FAMILIES = ['Georgia', 'Arial', 'Times New Roman', 'Verdana', 'monospace'];
const booleanMarks = new Set(['bold', 'italic', 'underline', 'strike']);
export const splitsSurrogate = (text,offset) => offset>0&&offset<text.length&&/[\uD800-\uDBFF]/.test(text[offset-1])&&/[\uDC00-\uDFFF]/.test(text[offset]);
export function cleanStyle(style) {
  const out = {};
  if (!style || typeof style !== 'object') return out;
  for (const key of booleanMarks) if (style[key] === true) out[key] = true;
  if (FONT_FAMILIES.includes(style.font)) out.font = style.font;
  if (Number.isInteger(style.size) && style.size >= 10 && style.size <= 72) out.size = style.size;
  for (const key of ['color', 'highlight']) if (typeof style[key] === 'string' && /^#[0-9a-f]{6}$/i.test(style[key])) out[key] = style[key].toLowerCase();
  return out;
}
export function normalizeRich(text, rich) {
  if (!rich) return { v: 1, ranges: [] };
  if (rich.v !== 1 || !Array.isArray(rich.ranges) || rich.ranges.length > 10000) throw new TypeError('Неверный формат оформления текста.');
  const ranges = rich.ranges.map(r => {
    if (!r || !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 || r.end <= r.start || r.end > text.length || splitsSurrogate(text,r.start) || splitsSurrogate(text,r.end)) throw new TypeError('Оформление выходит за границы текста или разрезает символ.');
    return { start: r.start, end: r.end, style: cleanStyle(r.style) };
  }).filter(r => Object.keys(r.style).length);
  return { v: 1, ranges };
}
export const richKey = rich => JSON.stringify(rich ?? { v: 1, ranges: [] });
export function styleAt(rich, offset) {
  return Object.assign({}, ...(rich?.ranges ?? []).filter(r => r.start <= offset && offset < r.end).map(r => r.style));
}
export function formatRange(text, rich, start, end, key, value) {
  rich = normalizeRich(text, rich);
  if (start < 0 || end > text.length || start >= end) return rich;
  const boundaries = [...new Set([0, text.length, start, end, ...rich.ranges.flatMap(r => [r.start, r.end])])].sort((a,b) => a-b);
  const ranges = [];
  for (let i=0;i<boundaries.length-1;i++) {
    const a=boundaries[i], b=boundaries[i+1], style=styleAt(rich,a);
    if (a >= start && b <= end) {
      if (key === 'clear') for (const k of Object.keys(style)) delete style[k];
      else if (value === null || value === false || value === '') delete style[key];
      else Object.assign(style, cleanStyle({ [key]: value }));
    }
    if (!Object.keys(style).length) continue;
    const last=ranges.at(-1);
    if(last && last.end===a && JSON.stringify(last.style)===JSON.stringify(style)) last.end=b;
    else ranges.push({start:a,end:b,style});
  }
  return {v:1,ranges};
}
export function replaceText(text, rich, start, end, replacement) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > text.length || typeof replacement !== 'string' || splitsSurrogate(text,start) || splitsSurrogate(text,end)) throw new TypeError('Неверные границы правки.');
  const old=normalizeRich(text,rich), delta=replacement.length-(end-start), ranges=[];
  for(const r of old.ranges) {
    if(r.start<start) ranges.push({...r,end:Math.min(r.end,start)});
    if(r.end>end) ranges.push({...r,start:Math.max(r.start,end)+delta,end:r.end+delta});
  }
  const inherited=styleAt(old,start<text.length?start:Math.max(0,start-1));
  if(replacement.length && Object.keys(inherited).length) ranges.push({start,end:start+replacement.length,style:inherited});
  return {text:text.slice(0,start)+replacement+text.slice(end),rich:{v:1,ranges:ranges.filter(r=>r.end>r.start)}};
}
function editScript(a, b, budget) {
  const n = a.length, m = b.length, max = n + m, off = max + 1;
  const v = new Int32Array(2 * max + 3), trace = [];
  let work = 0;
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1, y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; work++; }
      v[off + k] = x; work++;
      if (x >= n && y >= m) { trace.push(v.slice(off - d, off + d + 1)); return backtrackScript(trace, n, m); }
    }
    trace.push(v.slice(off - d, off + d + 1));
    if (work > budget) return null;
  }
  return null;
}
function backtrackScript(trace, n, m) {
  const ops = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1], at = k => prev[k + d - 1], k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1, prevX = at(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push('='); x--; y--; }
    ops.push(down ? '+' : '-');
    if (down) y--; else x--;
  }
  while (x > 0 && y > 0) { ops.push('='); x--; y--; }
  return ops.reverse();
}

// Character-level changes inside one paragraph as separate hunks, so every unchanged character between
// two edits stays in place with its own runs (bold, italic, links). Works on code points, so a UTF-16
// surrogate pair is never split. `exact: false` marks the coarse fallback for very large rewrites: one
// replacement between the common prefix and suffix; the planner allows it only when no formatting is lost.
function richHunks(before, after) {
  if (before === after) return { hunks: [], exact: true };
  const a = Array.from(before), b = Array.from(after);
  const offsets = list => { const out = [0]; for (const ch of list) out.push(out.at(-1) + ch.length); return out; };
  const ua = offsets(a), ub = offsets(b);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const midA = a.slice(pre, a.length - suf), midB = b.slice(pre, b.length - suf);
  let middle = !midA.length || !midB.length ? null : editScript(midA, midB, 2_000_000), exact = true;
  if (!middle) {
    exact = !midA.length || !midB.length;
    middle = [...Array(midA.length).fill('-'), ...Array(midB.length).fill('+')];
  }
  const hunks = [];
  let x = pre, y = pre, open = null;
  const close = () => { if (open) hunks.push({ pre: ua[open.x], deleteLength: ua[x] - ua[open.x], insert: after.slice(ub[open.y], ub[y]) }); open = null; };
  for (const op of middle) {
    if (op === '=') { close(); x++; y++; continue; }
    open ??= { x, y };
    if (op === '-') x++; else y++;
  }
  close();
  return { hunks, exact };
}

export function reconcileRich(before, after, rich) {
  const normalized=normalizeRich(before,rich);
  if(before===after||!normalized.ranges.length)return normalized;
  const {hunks,exact}=richHunks(before,after);
  if(!exact)throw new Error('Не удалось точно сохранить оформление при большой замене. Обновите редактор и повторите правку меньшими частями.');
  let state={text:before,rich:normalized};
  for(const h of [...hunks].reverse())state=replaceText(state.text,state.rich,h.pre,h.pre+h.deleteLength,h.insert);
  return state.rich;
}
export function makeTextTarget({ identity, text, start=0, end=text.length }) {
  if(typeof identity!=='string'||!identity||typeof text!=='string'||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>text.length)throw new TypeError('Неверный фрагмент.');
  return {identity,text,start,end,quote:text.slice(start,end)};
}
export function resolveReviewQuote(target,item) {
  if(item.start!==undefined||item.end!==undefined){if(Number.isSafeInteger(item.start)&&Number.isSafeInteger(item.end)&&item.start>=target.start&&item.end<=target.end&&item.end>=item.start&&!splitsSurrogate(target.text,item.start)&&!splitsSurrogate(target.text,item.end)&&target.text.slice(item.start,item.end)===item.quote)return {start:item.start,end:item.end};throw new TypeError('Границы замечания не совпадают с выделением.');}
  if(!item.quote)throw new TypeError('Для вставки укажите точную опорную цитату.');
  const found=[];let from=target.start;
  while(from<=target.end-item.quote.length){const at=target.text.indexOf(item.quote,from);if(at<0||at+item.quote.length>target.end)break;const end=at+item.quote.length;
    if((!item.prefix||target.text.slice(Math.max(0,at-item.prefix.length),at)===item.prefix)&&(!item.suffix||target.text.slice(end,end+item.suffix.length)===item.suffix))found.push({start:at,end});from=at+1;
  }
  if(found.length!==1)throw new TypeError(found.length?'Цитата неоднозначна: требуется контекст.':'Цитата не найдена в выбранном фрагменте.');
  return found[0];
}
export function validateReview(target, review) {
  if (!review || review.identity !== target.identity || !Array.isArray(review.items) || review.items.length>100) throw new TypeError('Ответ не относится к этому документу.');
  const ids=new Set();
  return review.items.map((item,i)=>{
    if(!['good','issue','proposal'].includes(item.kind)||typeof item.quote!=='string'||typeof item.comment!=='string'||item.comment.length>10000)throw new TypeError('Неверное замечание.');
    const {start,end}=resolveReviewQuote(target,item);
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<target.start||end>target.end||end<start||target.text.slice(start,end)!==item.quote)throw new TypeError('Замечание не совпадает с исходным фрагментом.');
    if(item.kind==='proposal' && (typeof item.replacement!=='string'||item.replacement.length>120000))throw new TypeError('Нет текста предложения.');
    const id=String(item.id??i);if(ids.has(id))throw new TypeError('Повтор номера замечания.');ids.add(id);
    return {id,kind:item.kind,start,end,quote:item.quote,comment:item.comment,replacement:item.kind==='proposal'?item.replacement:undefined,status:'pending'};
  });
}
export function applyReviewItem(text, rich, target, item) {
  if(text!==target.text)throw new Error('Текст изменился после запроса. Обновите разбор перед применением.');
  if(item.kind!=='proposal'||item.status!=='pending'||text.slice(item.start,item.end)!==item.quote)throw new Error('Это предложение уже обработано или устарело.');
  return replaceText(text,rich,item.start,item.end,item.replacement);
}
export function parseReviewMessage(text) {
  const match=String(text).match(/```talewisp-review\s*\n([\s\S]*?)\n```/);
  if(!match)return null;
  try{return JSON.parse(match[1]);}catch{return null;}
}
export function reviewChange(item) {
 if(item.kind!=='proposal')return item;
 const a=item.quote,b=item.replacement;let pre=0,oldEnd=a.length,newEnd=b.length;
 while(pre<oldEnd&&pre<newEnd&&a[pre]===b[pre])pre++;
 while(oldEnd>pre&&newEnd>pre&&a[oldEnd-1]===b[newEnd-1]){oldEnd--;newEnd--;}
 if(splitsSurrogate(a,pre)||splitsSurrogate(b,pre))pre--;
 if(splitsSurrogate(a,oldEnd))oldEnd++;
 if(splitsSurrogate(b,newEnd))newEnd++;
 return {...item,start:item.start+pre,end:item.start+oldEnd,replacement:b.slice(pre,newEnd)};
}
