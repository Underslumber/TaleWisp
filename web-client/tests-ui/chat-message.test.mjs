import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAgentMessage } from '../public/chat-message.js';

test('ordinary assistant prose remains readable and eligible for insertion', () => {
  assert.deepEqual(classifyAgentMessage('Она остановилась у двери. За окном шумел дождь.'), { technical: false, insertableProse: true, summary: '' });
});

test('technical reports and code review output are collapsed and cannot be inserted', () => {
  for (const text of [
    'Checks: PASS\nTests: 42 passed',
    '## Changed files\n- public/app.js',
    '```diff\n+ return true;\n```',
    '{"candidateSha256":"abc","status":"PASS"}'
  ]) { const result=classifyAgentMessage(text); assert.equal(result.technical,true,text);assert.equal(result.insertableProse,false,text); }
});

test('StoryArt transport/status service messages stay collapsed and preserve their useful summary', () => {
  const first='Применяю навык coordinate-talewisp-storyart: создам один отдельный StoryArt-чат с вашим brief, затем один раз прочитаю статус. Частные источники читать не буду.';
  const second='Отдельный StoryArt-чат создан; готовность PNG пока не подтверждена.\n\n• requestId: web-neutral-leaf-20261015-01\n• threadId: 01a13fb7-3c95-7620-84c9-9f0a47b73a3a\n\nЕдинственное чтение статуса завершилось ошибкой транспорта: turnLimit: Too big: expected number to be <=10. Повторный вызов не выполнял.\n\nARTIFACT_PATH и VISUAL_QA пока не получены. Одобрение автора не выдавалось; запрошено AUTHOR_APPROVAL:PENDING. Частные источники не читал, канон не менял.';
  const a=classifyAgentMessage(first),b=classifyAgentMessage(second);
  assert.equal(a.technical,true);assert.equal(a.insertableProse,false);
  assert.equal(a.summary,'');
  assert.equal(b.technical,true);assert.equal(b.insertableProse,false);
  assert.match(b.summary,/готовность PNG пока не подтверждена/);
  assert.equal(b.summary,'Отдельный StoryArt-чат создан; готовность PNG пока не подтверждена.');
  assert.equal(classifyAgentMessage('Выполню одну независимую проверку и сообщу только результат.').insertableProse,false);
});

test('Russian narrative verbs and ordinary English words retain prose insertion',()=>{
  for(const text of ['Анна шагнула вперёд.','She let the moment pass.','Running down the alley, she stopped.']){
    const result=classifyAgentMessage(text);assert.equal(result.technical,false,text);assert.equal(result.insertableProse,true,text);
  }
});

test('technical output keeps a short human-readable summary beside collapsed details', () => {
  const result=classifyAgentMessage('I found one blocking issue in the result.\n\nChecks: PASS\n```diff\n-bug\n```');
  assert.equal(result.technical,true);
  assert.equal(result.insertableProse,false);
  assert.equal(result.summary,'I found one blocking issue in the result.');
});

test('empty messages cannot be inserted', () => {
  assert.deepEqual(classifyAgentMessage('  \n'), { technical: false, insertableProse: false, summary: '' });
});

test('short planning and chat-status replies are not offered as manuscript prose', () => {
  for(const text of ['Нужно уточнить имя героя.','Диалог создан.','Да. Нужно уточнить имя героя. Диалог создан.'])assert.equal(classifyAgentMessage(text).insertableProse,false,text);
  assert.equal(classifyAgentMessage('Она остановилась у двери.').insertableProse,true);
});
