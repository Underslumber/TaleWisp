// Stable across application versions; store navigation only, never manuscript text.
const KEY = 'talewisp.navigation.v1';
const VIEWS = new Set(['documents', 'notes', 'knowledge', 'google', 'settings', 'proposals', 'overview', 'storyart']);
const STORYART_SCREENS = new Set(['styles', 'style', 'character', 'create-style', 'generate', 'jobs', 'job']);
const storyArtId = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(v) ? v : null;
// StoryArt keeps the last screen and the selected style/job of the scope it was opened in; never prompts or drafts.
function normalizeStoryArt(value) {
  if (!value || typeof value !== 'object' || !STORYART_SCREENS.has(value.screen) || typeof value.scope !== 'string' || value.scope.length > 1024) return null;
  const route = { scope: value.scope, screen: value.screen, styleId: storyArtId(value.styleId), jobId: storyArtId(value.jobId) };
  if (route.screen === 'character') {
    route.characterId = storyArtId(value.characterId);
    route.category = ['identity', 'projections', 'wardrobe', 'accessories', 'scenes'].includes(value.category) ? value.category : 'identity';
    if (!route.styleId || !route.characterId) return null;
  }
  return route;
}
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
    storyArt: normalizeStoryArt(value.storyArt),
  };
}
export function readNavigation(storage) {
  try { return normalizeNavigation(JSON.parse(storage.getItem(KEY))); } catch { return null; }
}
export function writeNavigation(storage, value) {
  try { const normalized = normalizeNavigation(value); if (normalized) storage.setItem(KEY, JSON.stringify(normalized)); } catch { /* Storage may be disabled. Navigation still works. */ }
}
