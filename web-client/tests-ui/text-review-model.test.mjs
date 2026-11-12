import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRich,formatRange,replaceText,styleAt,reconcileRich,makeTextTarget,validateReview,applyReviewItem,reviewChange} from '../public/text-review-model.js';
import {compactReviewRecords} from '../public/text-review-panel.js';
test('an expansion decorates only added text, keeping the unchanged anchor readable',()=>{
 const change=reviewChange({kind:'proposal',start:10,end:15,quote:'слово',replacement:'слово дальше'});
 assert.equal(change.start,15);assert.equal(change.end,15);assert.equal(change.replacement,' дальше');
 const emoji=reviewChange({kind:'proposal',start:0,end:2,quote:'😀',replacement:'😁'});assert.equal(emoji.start,0);assert.equal(emoji.end,2);
});
test('persisted reviews have bounded count and storage size and omit undo frames',()=>{
 const entries=Array.from({length:100},(_,i)=>[String(i),{target:{text:'я'.repeat(120000)},items:[],frames:[{large:'ignored'}]}]);
 const kept=compactReviewRecords(entries);assert.ok(kept.length<=12);assert.ok(JSON.stringify(kept).length<=600000);assert.equal(kept.at(-1)[0],'99');assert.ok(kept.every(([,r])=>!r.frames));
});
test('formatting overlaps preserve independent styles and clear only requested range',()=>{
 let r=formatRange('abcdef',null,0,5,'bold',true);
 r=formatRange('abcdef',r,2,6,'italic',true);
 assert.deepEqual(styleAt(r,3),{bold:true,italic:true});
 r=formatRange('abcdef',r,3,4,'clear',null);
 assert.deepEqual(styleAt(r,3),{});assert.equal(styleAt(r,2).bold,true);assert.equal(styleAt(r,5).italic,true);
});
test('insertions/deletions shift formatting without changing unicode/newlines',()=>{
 const text='А😀\nБ конец',r=formatRange(text,null,5,10,'underline',true);
 const changed=replaceText(text,r,0,1,'Начало');
 assert.equal(changed.text,'Начало😀\nБ конец');assert.equal(styleAt(changed.rich,10).underline,true);
 assert.deepEqual(reconcileRich(text,text,r),r);
});
test('unsafe styles and out of bounds ranges cannot enter rendering',()=>{
 assert.throws(()=>normalizeRich('a',{v:1,ranges:[{start:0,end:2,style:{bold:true}}]}));
 assert.deepEqual(normalizeRich('a',{v:1,ranges:[{start:0,end:1,style:{color:'url(evil)',font:'<script>',bold:true}}]}).ranges[0].style,{bold:true});
});
test('repeated quotes use exact offsets, changed text and other identities refuse application',()=>{
 const text='раз два раз',target=makeTextTarget({identity:'doc:1',text,start:8,end:11});
 const [item]=validateReview(target,{identity:'doc:1',items:[{kind:'proposal',start:8,end:11,quote:'раз',comment:'правка',replacement:'три'}]});
 assert.equal(applyReviewItem(text,null,target,item).text,'раз два три');
 assert.throws(()=>applyReviewItem('раз два раз!',null,target,item));
 assert.throws(()=>validateReview(target,{identity:'doc:2',items:[]}));
 assert.throws(()=>validateReview(target,{identity:'doc:1',items:[{...item,start:0,end:3}]}));
});
