import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createManuscriptFiles } from '../manuscript-file.mjs';
import { buildManuscriptContext } from '../manuscript-context.mjs';
import { createWorkingCopyClient } from '../public/working-copy-client.js';

const snapshot = (text = 'Начало.') => ({ manuscript: { documentId: 'doc-1', title: 'Книга', revisionId: 'r1', tabs: [], sections: ['a','b'].map((id, order) => ({ sectionId: id, title: 'Глава '+id, hasHeading: true, label: id, tabId: 't', tabTitle: 'Книга', hash: id+'-'+text, body: text+id, order })) }, source: { tabs: [{ textStyle: { bold: true, italic: true }, image: 'kept' }], revisionId: 'r1' } });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tw-book-file-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, files: createManuscriptFiles(root) };
}
test('a real durable file survives reopen, retains source formatting, and a subset save keeps unseen chapters', t => {
  const { root, files } = fixture(t), source = snapshot();
  let copy = files.importDocument('book-1', 'doc-1', 0, source);
  copy = files.save('book-1','doc-1',copy.version,[{ ...copy.chapters[0], body: 'Правка.' }]);
  const reopened = createManuscriptFiles(root).read('book-1','doc-1');
  assert.equal(reopened.chapters[0].body, 'Правка.'); assert.equal(reopened.chapters[1].body,'Начало.b');
  assert.deepEqual(reopened.source, source.source);
  const names = readdirSync(join(root,'manuscripts'));
  assert.ok(names.some(n=>n.endsWith('.book.json'))); assert.ok(names.some(n=>n.endsWith('.previous')));
  assert.ok(!names.some(n=>n.endsWith('.tmp')));
  assert.equal(files.view(reopened).source, undefined);
  assert.throws(()=>files.save('book-1','doc-1',1,copy.chapters),{code:'working_copy_conflict'});
  assert.equal(files.read('book-1','doc-1').chapters[0].body,'Правка.');
  assert.equal(files.read('book-2','doc-1'),null);
  assert.throws(()=>files.read('../book','doc-1'));
});
test('refresh imports never overwrite dirty text and retain removed sections as missing; corrupt files are not replaced', t => {
  const {root,files}=fixture(t);
  let copy=files.importDocument('book-1','doc-1',0,snapshot());
  copy=files.save('book-1','doc-1',copy.version,[{...copy.chapters[0],body:'Авторская правка.'}]);
  const fresh=snapshot('Google изменён.'); fresh.manuscript.sections.pop();
  copy=files.importDocument('book-1','doc-1',copy.version,fresh);
  assert.equal(copy.chapters[0].body,'Авторская правка.'); assert.equal(copy.chapters[0].conflict,true); assert.equal(copy.chapters[1].missing,true);
  const path=join(root,'manuscripts',readdirSync(join(root,'manuscripts')).find(x=>x.endsWith('.book.json')));
  writeFileSync(path,'broken');
  assert.throws(()=>files.save('book-1','doc-1',copy.version,[])); assert.equal(readFileSync(path,'utf8'),'broken');
});
test('settled new chapter is archived without resending or losing its contents; reimport keeps archive', t => {
  const {files}=fixture(t); let copy=files.importDocument('book-1','doc-1',0,snapshot());
  const chapter={key:'new:n1',kind:'new',title:'Глава 3',body:'Новая.',baseTitle:'',baseBody:'',write:{operationId:'op1',state:'inflight'}};
  copy=files.save('book-1','doc-1',copy.version,[chapter]);
  copy=files.save('book-1','doc-1',copy.version,[],[{key:chapter.key,operationId:'op1'}]);
  assert.ok(!copy.chapters.some(x=>x.key===chapter.key)); assert.equal(copy.archive[0].body,'Новая.');
  copy=files.importDocument('book-1','doc-1',copy.version,snapshot()); assert.equal(copy.archive[0].body,'Новая.');
});
test('working client serializes typing across an in-flight save and stops after a lost reply', async () => {
  let version=1, release; const calls=[];
  const client=createWorkingCopyClient({api:async(path,{body})=>{
    if(path.endsWith('/read'))return {copy:{version}};
    calls.push(structuredClone(body));
    if(calls.length===1) await new Promise(resolve=>release=resolve);
    if(calls.length===3)throw new Error('reply lost');
    assert.equal(body.version,version); return {copy:{version:++version}};
  }});
  const scope={bookId:'b',documentId:'d'}; await client.read(scope);
  client.queue(scope,[{key:'a',body:'one'}]); client.queue(scope,[{key:'a',body:'two'},{key:'b',body:'three'}]);
  release(); await client.flush(scope);
  assert.equal(calls.length,2); assert.equal(calls[1].chapters[0].body,'two'); assert.equal(calls[1].version,2);
  client.queue(scope,[{key:'a',body:'four'}]); await assert.rejects(client.flush(scope),/reply lost/);
  client.queue(scope,[{key:'a',body:'five'}]); await assert.rejects(client.flush(scope)); assert.equal(calls.length,3,'no unguarded retry');
});
test('explicit recovery re-reads CAS, does not write on cancel, and refuses a concurrent change after approval', async () => {
  const scope={bookId:'book-1',documentId:'doc-1'},item={key:'a',kind:'section',title:'Глава',body:'Мой текст',baseBody:'База',baseTitle:'Глава'};
  let version=2, saves=0;
  const client=createWorkingCopyClient({api:async(path,{body})=>{
    if(path.endsWith('/read'))return {copy:{version,chapters:[{...item,body:'Текст другой вкладки'}]}};
    saves++;if(body.version!==version)throw new Error('CAS conflict');return {copy:{version:++version}};
  }});
  await client.read(scope);client.conflict(scope,'Lost reply');client.queue(scope,[item]);
  assert.equal(await client.recover(scope,()=>[item],async()=>false),false);assert.equal(saves,0);
  await assert.rejects(client.recover(scope,()=>[item],async()=>{version++;return true;}),/CAS conflict/);
  assert.equal(client.state(scope).status,'error');assert.equal(saves,1);
  const result=await client.recover(scope,()=>[item],async()=>true);
  assert.equal(result.chapters[0].body,'Мой текст');assert.equal(client.state(scope).status,'saved');assert.equal(saves,2);
});
test('multi-chapter context includes exact text and provenance in order and refuses duplicates, mixed documents, ambiguous selection and oversize', () => {
  const a={bookId:'b',documentId:'d',documentName:'Рукопись',title:'Первая',sectionId:'a',revisionId:'r',tabTitle:'t',edited:true,text:'А'.repeat(25000)};
  const b={...a,title:'Вторая',sectionId:'b',text:'Б'.repeat(25000)};
  const context=buildManuscriptContext([a,b]);
  assert.ok(context.includes(a.text));assert.ok(context.includes(b.text));assert.ok(context.indexOf(a.text)<context.indexOf(b.text));
  assert.throws(()=>buildManuscriptContext([a,a])); assert.throws(()=>buildManuscriptContext([a,{...b,documentId:'other'}]));
  assert.throws(()=>buildManuscriptContext([a,b],'А')); assert.throws(()=>buildManuscriptContext([{...a,text:'x'.repeat(120001)}]),{status:413});
  assert.throws(()=>buildManuscriptContext([a],'missing'),{status:409});
});
