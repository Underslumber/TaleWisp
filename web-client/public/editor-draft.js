export function ensureEditableDocument(state, { title, text }, localId) {
  if (state.current) {
    const current = state.drafts.get(state.current.kind + ':' + state.current.id);
    if (current) return { draft: current, created: false };
  }
  const draft = {
    id: null,
    title,
    text,
    version: 0,
    savedTitle: '',
    savedText: '',
    dirty: true,
    documentId: null
  };
  const key = 'document:' + localId;
  state.drafts.set(key, draft);
  state.current = { kind: 'document', id: localId };
  state.view = 'documents';
  return { draft, created: true };
}
