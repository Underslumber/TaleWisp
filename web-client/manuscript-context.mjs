export const MAX_MANUSCRIPT_CONTEXT = 120_000;
const invalid = message => Object.assign(new Error(message), { status: 400 });
export function buildManuscriptContext(chapters, selectedText = '') {
  if (!Array.isArray(chapters) || !chapters.length || chapters.length > 40) throw invalid('Выберите от одной до 40 глав для агента.');
  if (selectedText && chapters.length !== 1) throw invalid('Выделение можно передать только с одной главой. Снимите выделение для работы с несколькими главами.');
  const seen = new Set(), first = chapters[0];
  const blocks = chapters.map((chapter, i) => {
    if (chapter.bookId !== first.bookId || chapter.documentId !== first.documentId || seen.has(chapter.sectionId)) throw invalid('Главы должны относиться к одной рукописи и не повторяться.');
    seen.add(chapter.sectionId);
    const text = selectedText || chapter.text;
    if (selectedText && !chapter.text.includes(selectedText)) throw Object.assign(invalid('Выделение не относится к выбранной главе.'), { status: 409 });
    if (!text.trim()) throw invalid('Выбранная глава пуста — агенту нечего передать.');
    return `CHAPTER ${i + 1} METADATA: ${JSON.stringify({ title: chapter.title, sectionId: chapter.sectionId, revisionId: chapter.revisionId, tabTitle: chapter.tabTitle, edited: chapter.edited, selection: !!selectedText })}\nTEXT (${text.length} UTF-16 units):\n${text}\nEND CHAPTER ${i + 1}`;
  });
  const context = `READ-ONLY MANUSCRIPT CONTEXT\n${JSON.stringify({ bookId: first.bookId, documentId: first.documentId, documentName: first.documentName, chapterCount: chapters.length })}\nAuthor reviews and applies changes. Do not write to Google from this context.\n\n` + blocks.join('\n\n');
  if (context.length > MAX_MANUSCRIPT_CONTEXT) throw Object.assign(invalid('Выбранные главы превышают 120 000 знаков контекста. Выберите меньше глав или выделите фрагмент одной главы.'), { status: 413, code: 'chapter_context_too_large' });
  return context;
}
