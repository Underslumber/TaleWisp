// Server-side anchors for stage-closure evidence. An anchor is always created against the saved text
// (working manuscript file or local draft in the store), never against browser text.
import { createHash } from 'node:crypto';
import { anchorContext, evidenceTone, locateAnchor, occurrences, validRange, NarrativeError, FIELD_LIMITS } from './public/narrative-model.js';

export const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

// Exact selection -> anchor. The quote must equal the saved text at [start,end); offsets are UTF-16 and may not
// split a surrogate pair.
export function createAnchor(source, { start, end, quote }) {
  if (!validRange(source, start, end)) throw new NarrativeError('Выделение выходит за границы сохранённого текста или разрезает символ.', 'evidence_range', 400);
  if (typeof quote !== 'string' || !quote || quote.length > FIELD_LIMITS.quote) throw new NarrativeError('Фрагмент пуст или длиннее 4000 знаков.', 'evidence_range', 400);
  if (source.slice(start, end) !== quote) throw new NarrativeError('Выделение не совпадает с сохранённым текстом. Сначала сохраните главу и выделите фрагмент заново.', 'evidence_mismatch', 409);
  return { quote, start, end, ...anchorContext(source, start, end) };
}

// Agent/proposal quotes carry no offsets: a unique exact quote (optionally disambiguated by prefix/suffix) is
// resolved deterministically; repeats without context are refused.
export function resolveQuote(source, { quote, prefix = '', suffix = '' }) {
  if (typeof quote !== 'string' || !quote.trim() || quote.length > FIELD_LIMITS.quote) throw new NarrativeError('Цитата пуста или слишком длинная.', 'quote_invalid', 400);
  if (typeof prefix !== 'string' || typeof suffix !== 'string' || prefix.length > 400 || suffix.length > 400) throw new NarrativeError('Окружение цитаты указано неверно.', 'quote_invalid', 400);
  const hits = occurrences(source, prefix + quote + suffix, 3).map(at => at + prefix.length);
  if (!hits.length) throw new NarrativeError('Цитата не найдена дословно в зафиксированном тексте главы.', 'quote_not_found', 409);
  if (hits.length > 1) throw new NarrativeError('Цитата встречается в главе несколько раз; укажите prefix или suffix.', 'quote_ambiguous', 409);
  return createAnchor(source, { start: hits[0], end: hits[0] + quote.length, quote });
}

// Current state of one evidence anchor against the current saved text of its chapter binding.
export function assessEvidence(evidence, source, { strict = false } = {}) {
  const identities = new Set([source?.identity, ...(source?.aliases ?? [])].filter(Boolean));
  if (!source || typeof source.text !== 'string' || !identities.has(evidence.sourceIdentity)) {
    return { location: 'lost', tone: 'lost', reason: !source || source.status === 'planned' ? 'Глава больше не связана с текстом.' : identities.has(evidence.sourceIdentity) ? 'Сохранённый текст главы недоступен.' : 'Привязка главы сменилась; фрагмент относится к прежнему тексту.' };
  }
  const located = locateAnchor(source.text, source.hash, evidence);
  // A binding that needs the author's confirmation (index-based chapter ids, renamed) cannot prove anything.
  const bindingOk = source.status === 'bound' || source.status === 'missing';
  const tone = source.status === 'verify' ? 'review' : evidenceTone(located.location, { strict, bindingOk });
  const reason = source.status === 'verify' ? 'Сопоставление главы требует подтверждения автора.'
    : { exact: 'Фрагмент совпадает с текстом, по которому принято решение.', intact: 'Глава правилась вне фрагмента; прежнее решение автора не перепроверено.', shifted: 'Фрагмент однозначно найден на новом месте; прежнее решение автора не перепроверено.', ambiguous: 'Фрагмент встречается несколько раз; автоматический выбор запрещён.', window_changed: 'Цитата или её окружение изменились; нужна проверка.', lost: 'Фрагмент не найден в тексте главы.' }[located.location];
  return { ...located, tone, reason };
}
