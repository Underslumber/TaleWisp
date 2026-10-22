export const NATIVE_CONSULTATION_TOOL=Object.freeze({
  name:'talewisp_native_consult',type:'function',
  description:'Use the installed native Gemini adapter for one explicitly requested consultation or a concrete consequential uncertainty. It receives only this bounded packet, uses saved native authentication and the adapter credit/model guards, and has no API-key or paid fallback. Never pass a whole vault or excluded private style material. A failed call is terminal for this parent turn; do not retry or substitute a provider.',
  inputSchema:{type:'object',properties:{reason:{type:'string',minLength:10,maxLength:2000},mode:{type:'string',enum:['requirements','analyze','review']},task:{type:'string',minLength:1,maxLength:64000},requirements:{type:'string',maxLength:64000},input:{type:'string',maxLength:256000}},required:['reason','mode','task','requirements','input'],additionalProperties:false}
});
export function nativeConsultationArguments(args){
  const fields=['reason','mode','task','requirements','input'];
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).sort().join(',')!==fields.sort().join(','))throw new Error('Native consultation accepts only a bounded packet, never file paths or provider settings.');
  if(fields.some(key=>typeof args[key]!=='string')||args.reason.trim().length<10||args.reason.length>2000)throw new Error('State the explicit request or concrete uncertainty for this consultation.');
  if(!['requirements','analyze','review'].includes(args.mode))throw new Error('Native consultation mode is invalid.');
  return {mode:args.mode,task:args.task,requirements:args.requirements,input:args.input};
}
