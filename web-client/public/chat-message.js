const TECHNICAL_STATUS = /\b(?:PASS|FAIL|NOT_RUN|UNAVAILABLE)\b/;
const TECHNICAL_MARKERS = /```|\b(?:exit code|traceback|stack trace|stderr|stdout|jsonl|sha256|candidate fingerprint|test results?|checks?:|diagnostics?:|requestId|threadId|turnId|ARTIFACT_PATH|VISUAL_QA|AUTHOR_APPROVAL|SOL_GATE|turnLimit|toolCallId|operationId|artifactPath)\b|\b(?:roleplay|dispatch|runtime|artifact|review)\s*(?:receipt|status|result|gate|id|path)\s*[:=]|^\s*(?:\{\s*"|\[[\s\S]*\]\s*$)/im;
const TECHNICAL_HEADINGS = /(?:^|\n)\s*(?:#{1,4}\s*)?(?:Implementation|Changed files|Validation|Checks|Test output|Technical details|Diff|Реализация|Изменённые файлы|Проверки|Результаты тестов|Технические детали|Дифф)\s*(?:$|:)/im;
const SERVICE_ACKNOWLEDGEMENT = /^(?:(?:применяю навык|применяю|проверяю|выполняю проверку|сверяю|готово:|выполнено:|запускаю проверку|завершил проверку|выполню одну независимую проверку)(?=$|[\s:,.!?])|(?:starting|running|checking|completed|done)\s*:)/i;
const NON_PROSE_STATUS = /^(?:нужно уточнить(?=$|[\s.!?])|диалог (?:создан|восстановлен)(?=$|[\s.!?])|создал(?:а)? диалог(?=$|[\s.!?])|(?:I need to clarify|chat (?:created|restored)|conversation (?:created|restored))\b)/i;
const NARRATIVE_CUE = /^(?:она|он|они|девушка|мужчина|ребёнок|ребенок|девочка|мальчик|герой|героиня|the woman|the man|she|he|they)\s+|(?<![\p{L}\p{N}_])(?:шагнула|шагнул|остановилась|остановился|вздохнула|вздохнул|посмотрела|посмотрел|сказала|сказал|почувствовала|почувствовал|he|she|they)(?![\p{L}\p{N}_])/iu;

export function classifyAgentMessage(text) {
  const value = typeof text === 'string' ? text : '';
  const technical = TECHNICAL_STATUS.test(value) || TECHNICAL_MARKERS.test(value) || TECHNICAL_HEADINGS.test(value) || value.split(/\r?\n/,1)[0].trim().length<220&&SERVICE_ACKNOWLEDGEMENT.test(value.trim());
  const plain = value.replace(/```[\s\S]*?```/g,' ').replace(/`[^`]*`/g,' ').replace(/\r/g,'');
  const summary = technical && !SERVICE_ACKNOWLEDGEMENT.test(value.trim()) ? plain.split('\n').map(line=>line.trim()).filter(line=>line&&!/^#{1,6}\s/.test(line)&&!/^[-*+]\s/.test(line)&&!/\b(?:PASS|FAIL|NOT_RUN|UNAVAILABLE|exit code|traceback|stack trace|stderr|stdout|jsonl|sha256|candidate fingerprint|checks?:|diagnostics?:|requestId|threadId|turnId|ARTIFACT_PATH|VISUAL_QA|AUTHOR_APPROVAL|SOL_GATE|turnLimit)\b/i.test(line)&&!/[{}]|^\s*(?:\$|>)\s/.test(line)).slice(0,1).join(' ').slice(0,280) : '';
  const trimmed=value.trim();
  const proseLike=!NON_PROSE_STATUS.test(trimmed)&&NARRATIVE_CUE.test(trimmed);
  return { technical, insertableProse: trimmed.length > 0 && !technical && proseLike, summary };
}
