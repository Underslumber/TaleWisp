import {makeTextTarget,validateReview,applyReviewItem,parseReviewMessage} from './text-review-model.js';
export const TEXT_TASKS={review:'Отревьюй выбранный текст. Укажи существенные замечания с привязкой к фрагментам.',expand:'Предложи дополнение выбранного текста, сохранив смысл, голос и события.',correct:'Предложи исправления орфографии, пунктуации и грамматики, сохранив авторский смысл.',assess:'Отметь удачные и неудачные места. Объясни конкретно, что работает и что требует внимания.',custom:''};
export function compactReviewRecords(entries){
 const result=[];let size=2;
 for(const [id,value] of [...entries].reverse()){
  const {frames,...record}=value,entry=[id,record],length=JSON.stringify(entry).length+1;
  if(result.length>=12||size+length>600000)continue;
  result.unshift(entry);size+=length;
 }
 return result;
}
export function createTextReviewPanel({document,storage,notify,getEditor,getTitle=()=>'',getLocked=()=>[],onPrompt,container}) {
 const requests=new Map(),processed=new Set();
 const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
 const chip=node('div');chip.className='text-context-chip';chip.hidden=true;const composer=container.querySelector('#chat-form');if(composer)composer.before(chip);else container.prepend(chip);
 const cards=node('section');cards.className='text-review-list';cards.setAttribute('aria-label','Замечания к тексту');const cardHost=()=>container.querySelector('#chat-messages')??container;cardHost().append(cards);
 let pending=null;
 // Undo frames are session-only, like the editor history; persist the current review without duplicating whole books.
 let evictionWarned=false;
 function stash(){try{if(!storage)throw Error('storage');const bounded=compactReviewRecords(requests);storage.setItem('talewisp.textReviews.v1',JSON.stringify(bounded));if(bounded.length<requests.size&&!evictionWarned){evictionWarned=true;notify('После перезагрузки останутся только последние разборы. Более ранние пока доступны в этой вкладке.',true);}}catch{notify('Замечания доступны в этой вкладке; сохранить их в браузере не удалось.',true);}}
 try{for(const [id,r] of JSON.parse(storage?.getItem('talewisp.textReviews.v1')||'[]')){if(typeof id==='string'&&r?.target&&typeof r.target.text==='string'&&r.target.text.length<=2000000&&Array.isArray(r.items)&&r.items.length<=100){makeTextTarget(r.target);if(r.items.some(i=>!['good','issue','proposal'].includes(i.kind)||!['pending','accepted','rejected','stale'].includes(i.status)||typeof i.comment!=='string'||typeof i.quote!=='string'||!Number.isSafeInteger(i.start)||!Number.isSafeInteger(i.end)||i.start<0||i.end<i.start||i.end>2000000||i.kind==='proposal'&&typeof i.replacement!=='string'))continue;for(const i of r.items)if(i.status==='pending'&&r.target.text.slice(i.start,i.end)!==i.quote)i.status='stale';delete r.frames;requests.set(id,r);if(r.state==='received')processed.add(id);}}}catch{}
 function showTarget(target){chip.hidden=false;chip.replaceChildren(node('strong',getTitle()),node('div',`${target.start!==0||target.end!==target.text.length?'Выделенный фрагмент':'Весь текст'} · ${target.end-target.start} знаков\n${target.quote.slice(0,160)}${target.quote.length>160?'…':''}`));const clear=node('button','Сбросить привязку');clear.type='button';clear.addEventListener('click',()=>{pending=null;chip.hidden=true;});chip.append(clear);}
 function choose(action){const ed=getEditor();if(!ed)return notify('Откройте редактируемый текст.',true);const current=ed.get();const sel=current.selection;pending={identity:current.identity,text:current.text,start:sel.start===sel.end?0:sel.start,end:sel.start===sel.end?current.text.length:sel.end};showTarget(makeTextTarget(pending));onPrompt(TEXT_TASKS[action]??'');}
 function stage(identity,text,selection){
   if(pending&&(pending.identity!==identity||pending.text!==text))throw new Error('Текст или документ изменился после выбора поручения. Выберите фрагмент заново.');
   const chosen=pending??{identity,text,start:selection.start===selection.end?0:selection.start,end:selection.start===selection.end?text.length:selection.end};
   const target=makeTextTarget(chosen);if(text.length>120000)throw new Error('Для разбора откройте главу короче 120 000 знаков.');
   const id=document.defaultView.crypto.randomUUID();requests.set(id,{target,items:[],state:'sent'});stash();showTarget(target);
   return {id,identity,start:target.start,end:target.end};
 }
 function sent(){pending=null;}
 function render(){
   if(cards.parentNode!==cardHost())cardHost().append(cards);
   cards.replaceChildren();const ed=getEditor();if(!ed)return;
   const current=ed.get(),marks=[];
   for(const [id,review] of requests){if(review.target.identity!==current.identity)continue;
     if(review.target.text!==current.text&&review.frames){const frame=review.frames.findLast(f=>f.target.text===current.text);if(frame){review.target=structuredClone(frame.target);review.items=structuredClone(frame.items);stash();}}
     const stale=review.target.text!==current.text;
     for(const item of review.items??[]){
       const card=node('article');card.className='text-review-card';
       card.append(node('strong',({good:'Удачное место',issue:'Требует внимания',proposal:'Предложение'})[item.kind]),node('blockquote',item.quote||'Вставка'),node('p',item.comment));
       if(item.kind==='proposal'){const replacement=node('pre',item.replacement||'Удалить фрагмент');card.append(replacement);}
       const status=node('p',item.status==='accepted'?'Принято':item.status==='rejected'?'Отклонено':stale||item.status==='stale'?'Текст изменился · требуется новый разбор':'Ожидает решения');status.className='text-review-status';card.append(status);
       const actions=node('div');actions.className='text-review-actions';
       const button=(label,fn,disabled=false)=>{const b=node('button',label);b.type='button';b.disabled=disabled;b.addEventListener('click',fn);actions.append(b);};
       button('Показать в тексте',()=>ed.select(item.start,item.end),stale);
       if(item.kind==='proposal')button('Принять',()=>{
         try{
           const live=getEditor();if(!live||live.get().identity!==review.target.identity)throw Error('Открыт другой документ.');const now=live.get();
           for(const locked of getLocked()){if(!locked.text)continue;let from=0;while(from<now.text.length){const at=now.text.indexOf(locked.text,from);if(at<0)break;if(item.start<at+locked.text.length&&item.end>at)throw Error('Предложение затрагивает защищённый фрагмент: '+locked.reason);from=at+1;}}
           const next=applyReviewItem(now.text,now.rich,review.target,item),delta=item.replacement.length-(item.end-item.start);
           const before={target:structuredClone(review.target),items:structuredClone(review.items)};
           if(!live.replaceAll(next.text,next.rich))throw Error('Текст доступен только для чтения.');
           for(const other of review.items){if(other===item){other.status='accepted';continue;}if(other.status!=='pending')continue;if(other.start>=item.end){other.start+=delta;other.end+=delta;}else if(other.end>item.start)other.status='stale';}
           review.target=makeTextTarget({...review.target,text:next.text,end:review.target.end+delta});
           review.frames??=[];if(!review.frames.some(f=>f.target.text===before.target.text))review.frames.push(before);review.frames.push({target:structuredClone(review.target),items:structuredClone(review.items)});
           stash();render();
         }catch(e){notify(e.message,true);}
       },stale||item.status!=='pending');
       button(item.kind==='proposal'?'Отклонить':'Скрыть',()=>{item.status='rejected';stash();render();},item.status!=='pending');card.append(actions);cards.append(card);
       if(!stale&&item.status==='pending')marks.push(item);
     }
   }
   ed.mark(marks);
 }
 function consume(messages){let received=false;for(const m of messages){if(m.role!=='assistant')continue;const parsed=parseReviewMessage(m.text);if(!parsed||processed.has(parsed.requestId))continue;const record=requests.get(parsed.requestId);if(!record)continue;try{record.items=validateReview(record.target,parsed);record.state='received';processed.add(parsed.requestId);received=true;stash();}catch(e){processed.add(parsed.requestId);notify('Разбор не привязан к тексту: '+e.message,true);}}render();return received;}
 return {choose,stage,sent,consume,render,hasPending:()=>!!pending,rekey(before,after){if(pending?.identity===before)pending.identity=after;},clear(){pending=null;chip.hidden=true;},failed(id){requests.delete(id);stash();}};
}
