// Stable across application versions; store navigation only, never manuscript text.
const KEY = 'talewisp.navigation.v1';
const VIEWS = new Set(['documents', 'notes', 'knowledge', 'google', 'settings', 'proposals', 'overview']);
export function normalizeNavigation(value) {
  if (!value || !VIEWS.has(value.view)) return null;
  const string = v => typeof v === 'string' && v.length <= 4096 ? v : null;
  const current = value.current;
  return {
    view: value.view,
    editor: value.editor === true,
    current: current && ['document', 'note'].includes(current.kind) && string(current.id) && !current.id.startsWith('local-') ? { kind: current.kind, id: current.id } : null,
    knowledgeScope: value.knowledgeScope === 'unassigned' ? 'unassigned' : 'active',
    knowledgeSelectedConceptId: string(value.knowledgeSelectedConceptId),
    knowledgeSelectedPath: string(value.knowledgeSelectedPath),
    googleDocumentId: string(value.googleDocumentId),
    googleTabId: string(value.googleTabId),
    googleNativeOpen: ['google', 'documents'].includes(value.view) && value.googleNativeOpen === true,
  };
}
export function readNavigation(storage) {
  try { return normalizeNavigation(JSON.parse(storage.getItem(KEY))); } catch { return null; }
}
export function writeNavigation(storage, value) {
  try { const normalized = normalizeNavigation(value); if (normalized) storage.setItem(KEY, JSON.stringify(normalized)); } catch { /* Storage may be disabled. Navigation still works. */ }
}
