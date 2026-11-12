import {EditorState,EditorView,Decoration,WidgetType,StateField,StateEffect,Compartment,Transaction,keymap,drawSelection,history,historyKeymap,defaultKeymap,undo,redo,invertedEffects} from './vendor/codemirror.js';
import {FONT_FAMILIES,normalizeRich,formatRange,styleAt,richKey,reviewChange} from './text-review-model.js';
import {stageField,setStageMarks,setStageLayer,stageDecorations} from './narrative-layer.js';

const setRich=StateEffect.define(),setMarks=StateEffect.define();
const richField=StateField.define({
 create:()=>({v:1,ranges:[]}),
 update(value,tr){
   if(tr.docChanged)value={v:1,ranges:value.ranges.map(r=>({...r,start:tr.changes.mapPos(r.start,-1),end:tr.changes.mapPos(r.end,1)})).filter(r=>r.end>r.start)};
   for(const e of tr.effects)if(e.is(setRich))value=e.value;
   return value;
 }
});
const marksField=StateField.define({create:()=>[],update(value,tr){if(tr.docChanged)value=[];for(const e of tr.effects)if(e.is(setMarks))value=e.value;return value;}});
class Addition extends WidgetType {
 constructor(text){super();this.text=text;}
 eq(other){return this.text===other.text;}
 toDOM(view){const span=view.dom.ownerDocument.createElement('span');span.className='review-addition';span.textContent=this.text;span.setAttribute('aria-label','Предложенная вставка: '+this.text);return span;}
}
function decorationData(state){
 const rich=state.field(richField),marks=state.field(marksField).map(reviewChange),length=state.doc.length;
 const points=[...new Set([0,length,...rich.ranges.flatMap(r=>[r.start,r.end]),...marks.flatMap(r=>[r.start,r.end])])].filter(x=>x>=0&&x<=length).sort((a,b)=>a-b),list=[],rules=new Set();
 for(let i=0;i<points.length-1;i++){
   const a=points[i],b=points[i+1],s=styleAt(rich,a),css=[];
   if(s.bold)css.push('font-weight:700');if(s.italic)css.push('font-style:italic');
   const lines=[s.underline?'underline':'',s.strike?'line-through':''].filter(Boolean);
   const mark=marks.find(r=>r.start<=a&&r.end>=b&&r.status==='pending');
   if(mark?.kind==='proposal'&&!lines.includes('line-through'))lines.push('line-through');
   if(lines.length)css.push('text-decoration:'+lines.join(' '));
   if(s.font)css.push('font-family:'+s.font);if(s.size)css.push('font-size:'+s.size+'px');if(s.color)css.push('color:'+s.color);if(s.highlight)css.push('background-color:'+s.highlight);
   const cls='tw-rich-'+JSON.stringify({...s,proposal:mark?.kind==='proposal'}).replace(/[^a-zA-Z0-9]/g,'-');
   if(css.length)rules.add('.'+cls+'{'+css.join(';')+'}');
   if(css.length||mark)list.push(Decoration.mark({attributes:mark?{title:mark.comment}:{},class:cls+(mark?' review-mark review-mark-'+mark.kind:'')}).range(a,b));
 }
 for(const mark of marks)if(mark.kind==='proposal'&&mark.status==='pending'&&mark.replacement&&mark.end<=length)list.push(Decoration.widget({widget:new Addition(mark.replacement),side:1}).range(mark.end));
 return {decorations:Decoration.set(list,true),css:[...rules].join('\n')};
}
export function createRichTextEditor({textarea,onChange,onSelection,onTask,onStageMarker}) {
 const document=textarea.ownerDocument,node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
 const root=node('section');root.className='text-workbench';
 const nonce=document.querySelector('meta[name="tw-style-nonce"]')?.content??'';
 const styleSheet=node('style');if(nonce)styleSheet.nonce=nonce;document.head.append(styleSheet);
 const updateStyles=()=>{const css=decorationData(view.state).css;if(styleSheet.textContent!==css)styleSheet.textContent=css;};
 const toolbar=node('div');toolbar.className='text-format-toolbar';toolbar.setAttribute('role','toolbar');toolbar.setAttribute('aria-label','Оформление текста');
 const tasks=node('div');tasks.className='text-task-toolbar';const hint=node('span','Весь открытый текст');hint.className='text-target-hint';
 const surface=node('div');surface.className='rich-writing-surface';let identity='',readonly=false,loading=false,view;const editability=new Compartment();
 // Narrative stage marks are kept per text identity so a reload of the same text restores them; they are never part of get().
 const stageMarks=new Map();let stageVisible=true;
 const applyStageMarks=()=>{view.dispatch({effects:[setStageMarks.of(structuredClone(stageMarks.get(identity)??[])),setStageLayer.of(stageVisible)],annotations:Transaction.addToHistory.of(false)});};
 const recovery=node('button','Оформление повреждено · скачать исходные данные');recovery.type='button';recovery.hidden=true;let recoveryData=null;
 recovery.addEventListener('click',()=>{if(!recoveryData)return;const url=URL.createObjectURL(new Blob([JSON.stringify(recoveryData)],{type:'application/json'}));const a=node('a');a.href=url;a.download='text-formatting-recovery.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
 function get(){const range=view.state.selection.main;return {text:view.state.doc.toString(),rich:structuredClone(view.state.field(richField)),selection:{start:range.from,end:range.to},identity};}
 function capture(){const current=get();textarea.setSelectionRange(current.selection.start,current.selection.end);hint.textContent=current.selection.start!==current.selection.end?`Фрагмент · ${current.selection.end-current.selection.start} знаков`:'Весь открытый текст';for(const b of toolbar.querySelectorAll('[data-mark]'))b.setAttribute('aria-pressed',String(!!styleAt(current.rich,current.selection.start)[b.dataset.mark]));return current.selection;}
 const changes=EditorView.updateListener.of(update=>{
   if(loading)return;
   updateStyles();
   const changed=update.docChanged||update.transactions.some(tr=>tr.effects.some(e=>e.is(setRich)));
   if(changed){const current=get();textarea.value=current.text;textarea.setSelectionRange(current.selection.start,current.selection.end);onChange?.({text:current.text,rich:current.rich});}
   if(changed||update.selectionSet){capture();onSelection?.();}
 });
 const extension=()=>[
   EditorState.lineSeparator.of('\n'),richField,marksField,stageField,
   EditorView.decorations.compute([richField,marksField],state=>decorationData(state).decorations),EditorView.cspNonce.of(nonce),
   EditorView.decorations.compute([stageField,richField],state=>{const rich=state.field(richField);return stageDecorations(state,pos=>!!styleAt(rich,pos).highlight);}),
   editability.of([EditorState.readOnly.of(readonly),EditorView.editable.of(!readonly)]),
   EditorView.contentAttributes.of({'aria-label':textarea.getAttribute('aria-label')||'Текст документа',spellcheck:'true'}),
   EditorView.lineWrapping,drawSelection(),history(),
   invertedEffects.of(tr=>tr.docChanged||tr.effects.some(e=>e.is(setRich))?[setRich.of(tr.startState.field(richField))]:[]),
   keymap.of([{key:'Mod-b',run:()=>toggle('bold')},{key:'Mod-i',run:()=>toggle('italic')},{key:'Mod-u',run:()=>toggle('underline')},{key:'Mod-Shift-x',run:()=>toggle('strike')},...historyKeymap,...defaultKeymap]),changes,
   EditorView.theme({'&':{fontSize:'18px',backgroundColor:'transparent'},'.cm-content':{fontFamily:'Georgia, serif',lineHeight:'1.8',minHeight:'350px',padding:'12px 0'},'.cm-scroller':{overflow:'visible'},'&.cm-focused':{outline:'none'},'.cm-line':{padding:'0'},'.cm-cursor':{borderLeftColor:'currentColor'},'.cm-selectionBackground':{backgroundColor:'#6a7a8955'},'&.cm-focused .cm-selectionBackground':{backgroundColor:'#6a7a8977'}})
 ];
 function format(key,val){if(readonly)return;const current=get();if(current.selection.start===current.selection.end){hint.textContent='Для оформления выделите текст';return;}view.dispatch({effects:setRich.of(formatRange(current.text,current.rich,current.selection.start,current.selection.end,key,val)),annotations:Transaction.userEvent.of('format')});view.focus();}
 function toggle(key){format(key,!styleAt(view.state.field(richField),view.state.selection.main.from)[key]);return true;}
 function button(label,title,fn){const b=node('button',label);b.type='button';b.title=title;b.setAttribute('aria-label',title);b.addEventListener('mousedown',e=>e.preventDefault());b.addEventListener('click',fn);toolbar.append(b);return b;}
 for(const [key,label,title] of [['bold','Ж','Жирный'],['italic','К','Курсив'],['underline','Ч','Подчеркнуть'],['strike','З','Зачеркнуть']])button(label,title,()=>toggle(key)).dataset.mark=key;
 const font=node('select');font.setAttribute('aria-label','Шрифт');for(const name of FONT_FAMILIES){const o=node('option',name);o.value=name;font.append(o);}font.addEventListener('change',()=>format('font',font.value));toolbar.append(font);
 const size=node('select');size.setAttribute('aria-label','Размер шрифта');for(const n of [12,14,16,18,20,24,28,32,40,48]){const o=node('option',String(n));o.value=n;size.append(o);}size.value='18';size.addEventListener('change',()=>format('size',Number(size.value)));toolbar.append(size);
 for(const [key,label,initial] of [['color','Цвет текста','#d9d6cf'],['highlight','Цвет выделения','#80702d']]){const wrap=node('label',label),input=node('input');input.type='color';input.value=initial;input.setAttribute('aria-label',label);input.addEventListener('change',()=>format(key,input.value));wrap.append(input);toolbar.append(wrap);}
 button('Очистить','Убрать оформление выделения',()=>format('clear',null));button('↶','Отменить',()=>{undo(view);view.focus();});button('↷','Повторить',()=>{redo(view);view.focus();});
 for(const [action,label] of [['review','Ревью'],['expand','Дополнить'],['correct','Исправить ошибки'],['assess','Удачные и слабые места'],['custom','Поручение…']]){const b=node('button',label);b.type='button';b.addEventListener('mousedown',e=>e.preventDefault());b.addEventListener('click',()=>onTask?.(action,get()));tasks.append(b);}
 tasks.append(hint);root.append(toolbar,tasks,recovery,surface);textarea.before(root);textarea.hidden=true;
 root.addEventListener('tw-stage-marker',event=>onStageMarker?.({ids:event.detail?.ids??[],identity}));
 view=new EditorView({parent:surface,state:EditorState.create({doc:textarea.value,extensions:extension()})});
 updateStyles();
 return {root,surface,get,capture,focus:()=>view.focus(),
   rekey(key){identity=key;},
   load(text,formatting,key='',readOnly=false){
     let rich;try{rich=normalizeRich(text,formatting);recoveryData=null;recovery.hidden=true;}catch{rich={v:1,ranges:[]};recoveryData={text,rich:formatting};recovery.hidden=false;readOnly=true;}
     const current=get(),reset=key!==identity,modeChange=readonly!==!!readOnly;
     identity=key;readonly=!!readOnly;for(const el of toolbar.querySelectorAll('button,input,select'))el.disabled=readonly;
     loading=true;
     try{if(reset){view.setState(EditorState.create({doc:text,extensions:extension()}));view.dispatch({effects:setRich.of(rich),annotations:Transaction.addToHistory.of(false)});applyStageMarks();}
     else if(current.text!==text||richKey(current.rich)!==richKey(rich)){view.dispatch({...(current.text!==text?{changes:{from:0,to:view.state.doc.length,insert:text},selection:{anchor:Math.min(current.selection.start,text.length),head:Math.min(current.selection.end,text.length)}}:{}),effects:setRich.of(rich),annotations:Transaction.addToHistory.of(false)});}if(modeChange&&!reset)view.dispatch({effects:editability.reconfigure([EditorState.readOnly.of(readonly),EditorView.editable.of(!readonly)])});}
     finally{loading=false;}updateStyles();textarea.value=text;textarea.readOnly=readonly;capture();
   },
   replaceAll(text,formatting){if(readonly)return false;view.dispatch({changes:{from:0,to:view.state.doc.length,insert:text},effects:setRich.of(normalizeRich(text,formatting)),annotations:Transaction.userEvent.of('input.proposal')});return true;},
   setReadOnly(value){readonly=!!value;view.dispatch({effects:editability.reconfigure([EditorState.readOnly.of(readonly),EditorView.editable.of(!readonly)])});for(const el of toolbar.querySelectorAll('button,input,select'))el.disabled=readonly;},
   mark(items){const existing=view.state.field(marksField);if(JSON.stringify(existing)!==JSON.stringify(items))view.dispatch({effects:setMarks.of(structuredClone(items)),annotations:Transaction.addToHistory.of(false)});},
   select(start,end){if(start<0||end>view.state.doc.length)return;view.dispatch({selection:{anchor:start,head:end},scrollIntoView:true});view.focus();},
   // Marks for one text identity (offsets of the saved text). The layer toggle is independent from formatting and review marks.
   setStageMarks(key,marks,{visible=stageVisible}={}){stageMarks.set(key,structuredClone(marks??[]));stageVisible=!!visible;if(key===identity)applyStageMarks();else view.dispatch({effects:setStageLayer.of(stageVisible),annotations:Transaction.addToHistory.of(false)});},
   stageMarks(){return structuredClone(view.state.field(stageField).marks);},
   destroy(){view.destroy();root.remove();styleSheet.remove();textarea.hidden=false;}
 };
}
