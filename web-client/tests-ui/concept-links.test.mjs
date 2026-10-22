import test from 'node:test';
import assert from 'node:assert/strict';
import {createConceptMatcher,withConceptMentions,resolveConceptReference} from '../public/concept-links.js';
const nodes = [{id:'mana',title:'Мана',kind:'concept'},{id:'domain',title:'Домен',kind:'concept'},{id:'mana-domain',title:'Домен маны',kind:'concept'}];
test('wiki names and unique relative source bindings navigate concepts without guessing shared sources',()=>{
 const linked=[...nodes,{id:'lineage',title:'Родословная',aliases:[{title:'Родословные'}],sourceRefs:[{path:'Analysis/Lineage.md'}]}];
 assert.deepEqual(resolveConceptReference({target:'../Analysis/Lineage.md',label:'Правила родословной'},linked,'Entities/One.md'),['lineage']);
 assert.deepEqual(resolveConceptReference({target:'file',label:'Родословные'},linked),['lineage']);
 assert.deepEqual(resolveConceptReference({target:'../Analysis/Lineage.md',label:'Источник'},[...linked,{id:'other',title:'Other',sourceRefs:[{path:'Analysis/Lineage.md'}]}],'Entities/One.md'),[]);
 assert.deepEqual(resolveConceptReference({target:'../../outside.md',label:'Источник'},linked,'Entities/One.md'),[]);
});
test('an educational spell alias stays searchable without equating natural lightning with that spell',()=>{
 const example={id:'example',title:'Молния (пример заклинания)',aliases:[{title:'Молния',searchOnly:true}],kind:'concept'};
 assert.deepEqual(createConceptMatcher([example])('Его встроенная молния остаётся отдельным механизмом.'),[]);
 assert.deepEqual(resolveConceptReference({target:'Молния',label:'Молния'},[example]),[]);
 assert.equal(createConceptMatcher([example])('Молния (пример заклинания)')[0].id,'example');
 assert.equal(withConceptMentions({nodes:[example,{id:'hero',title:'Герой',definition:'Его встроенная молния.'}],edges:[]}).edges.length,0);
});
test('term navigation preserves literal offsets, inflections and longest terms',()=>{
 const text='Мана, домен маны и доменом. Манат не термин.';
 const result=createConceptMatcher(nodes)(text);
 assert.deepEqual(result.map(m=>[m.id,text.slice(m.start,m.end)]),[['mana','Мана'],['mana-domain','домен маны'],['domain','доменом']]);
});
test('ambiguous names and self references are not guessed',()=>{
 const match=createConceptMatcher([...nodes,{id:'another',title:'Мана',kind:'concept'}]);
 const found=match('Мана и домен','domain'); assert.equal(found.length,1); assert.equal(found[0].id,null); assert.deepEqual(found[0].ids,['mana','another']);
});
test('mention edges retain source identity and never become containment',()=>{
 const graph=withConceptMentions({nodes:[...nodes,{id:'spell',kind:'concept',title:'Заклинание',definitions:[{text:'Мана внутри домена.',sourceTitle:'Основа',version:'B08'}]}],edges:[]});
 assert.equal(graph.edges.length,2);
 assert.ok(graph.edges.every(e=>e.kind==='related'&&e.source==='spell'&&e.label==='Упоминается в пояснении'&&e.version==='B08'));
});
