// Synthetic HOST contract for fixture runners only. Never a production model tokenizer/window claim.
export async function fixturePreflight(request) {
  if (!['fixture','fixture-model'].includes(request.model)) throw new Error('Fixture preflight cannot validate a real model');
  return {verified:true,model:request.model,threadId:request.threadId,promptHash:request.promptHash,tokenizer:'fixture-byte-tokenizer-v1',includesHiddenContext:true,contextWindow:1_000_000,inputTokens:Buffer.byteLength(request.prompt+request.developerInstructions,'utf8'),hiddenTokens:2000};
}
