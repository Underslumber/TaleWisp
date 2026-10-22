/** Stable history binding shared by the app server and agent runtime. */
export const scopeKey = selection => JSON.stringify([
  selection?.authorId ?? null,
  selection?.seriesId ?? null,
  selection?.bookId ?? null,
]);
