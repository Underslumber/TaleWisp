import Phaser from 'phaser';
import { CharacterSprite } from '../../vendor/worldx/client/src/objects/CharacterSprite';
import { CameraController } from '../../vendor/worldx/client/src/systems/CameraController';
import { createCharacterDisplayMetrics } from '../../vendor/worldx/client/src/config/game-config';
import { EventBus } from '../../vendor/worldx/client/src/EventBus';

// The original WorldX scene components, fed exclusively by TaleWisp's filtered snapshots.
// Landscape and avatar costumes are decorative staging, never authoritative world facts.
type Snapshot = any;
const WIDTH = 1720, HEIGHT = 1080;
const color = (s: string) => parseInt(s.replace('#', ''), 16);

export function createWorldStage(host: HTMLElement, overlay: HTMLElement, onSelect: (kind: string, id: string) => void) {
 let pending: Snapshot, ready = false, scene: LivingScene, stopped = false;
 class LivingScene extends Phaser.Scene {
  cameraControl!: CameraController;
  actors = new Map<string, CharacterSprite>();
  labels: Phaser.GameObjects.GameObject[] = [];
  terrain!: Phaser.GameObjects.Image;
  signature = ''; snapshot: Snapshot; selected = ''; followed = ''; seen = new Set<string>();
  constructor() { super('TaleWispWorld'); }
  create() {
   scene = this; ready = true; this.cameras.main.setBackgroundColor('#172d28');
   this.cameraControl = new CameraController(this, WIDTH, HEIGHT, { x: WIDTH / 2, y: HEIGHT / 2 });
   EventBus.instance.emit('camera_zoom_fit');
   if (pending) this.apply(pending, true);
  }
  point(location: any) {
   const locations = this.snapshot.locations, xs = locations.map((l: any) => l.x), ys = locations.map((l: any) => l.y);
   const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
   return { x: 230 + (location.x - minX) / Math.max(620, maxX - minX) * 1230,
    y: 340 + (location.y - minY) / Math.max(210, maxY - minY) * 430 };
  }
  location(id: string) { return this.snapshot.locations.find((l: any) => l.id === id); }
  paintLandscape() {
   const canvas = document.createElement('canvas'); canvas.width = WIDTH; canvas.height = HEIGHT;
   const c = canvas.getContext('2d')!; c.imageSmoothingEnabled = false;
   let seed = 14421; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
   const grass = ['#496c45','#526f47','#58774b','#5d7c4d','#466843','#617b4c'];
   c.fillStyle = '#506e44'; c.fillRect(0,0,WIDTH,HEIGHT);
   for(let y=0;y<HEIGHT;y+=8)for(let x=0;x<WIDTH;x+=8){c.fillStyle=grass[Math.floor(rnd()*grass.length)];c.globalAlpha=.38;c.fillRect(x,y,8,8);}c.globalAlpha=1;
   const points = this.snapshot.locations.map((l: any) => ({...this.point(l),id:l.id}));
   const lines = this.snapshot.edges.map((e: any) => ({a:points.find((p: any)=>p.id===e.from),b:points.find((p: any)=>p.id===e.to),open:e.open})).filter((e: any)=>e.a&&e.b);
   const distance=(x:number,y:number,a:any,b:any)=>{const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy||1)));return Math.hypot(x-a.x-t*dx,y-a.y-t*dy);};
   for(const p of points){c.fillStyle='#6d8051';c.beginPath();c.ellipse(p.x,p.y,150,105,0,0,7);c.fill();}
   c.lineCap='round';
   for(const e of lines){for(const [width,shade] of [[80,'#405c39'],[65,'#8c7950'],[53,'#b39a62'],[40,'#c7ad75']] as const){c.strokeStyle=shade;c.lineWidth=width;c.beginPath();c.moveTo(e.a.x,e.a.y);c.lineTo(e.b.x,e.b.y);c.stroke();}
    c.strokeStyle='#dfc48a';c.lineWidth=3;c.setLineDash([18,24]);c.beginPath();c.moveTo(e.a.x,e.a.y-11);c.lineTo(e.b.x,e.b.y-11);c.stroke();c.setLineDash([]);
   }
   // Small stones and tufts; visual texture has no simulation effect.
   for(let i=0;i<2400;i++){const x=rnd()*WIDTH,y=rnd()*HEIGHT,path=lines.some((e:any)=>distance(x,y,e.a,e.b)<23);c.fillStyle=path?'#9c865c':rnd()>.4?'#7e9356':'#314f36';c.globalAlpha=.5;c.fillRect(x,y,2+rnd()*5,path?2:3+rnd()*6);}c.globalAlpha=1;
   const trees:any[]=[];
   for(let i=0;i<235;i++){const x=24+rnd()*(WIDTH-48),y=35+rnd()*(HEIGHT-65);if(lines.some((e:any)=>distance(x,y,e.a,e.b)<95)||points.some((p:any)=>Math.hypot(x-p.x,y-p.y)<145))continue;trees.push({x,y,size:42+rnd()*33});}
   trees.sort((a,b)=>a.y-b.y);
   for(const t of trees){const{x,y,size:s}=t;c.fillStyle='#172f2d65';c.beginPath();c.ellipse(x+15,y+25,s*.85,s*.37,-.1,0,7);c.fill();
    c.fillStyle='#3d352b';c.fillRect(x-7,y-12,15,44);c.fillStyle='#71533b';c.fillRect(x-3,y-7,5,33);
    const radius=s*.94;
    for(let py=-radius;py<=radius;py+=7)for(let px=-radius;px<=radius;px+=7){
      const edge=(px*px/(radius*radius)+py*py/(radius*radius*.85));if(edge>1+(rnd()-.5)*.14)continue;
      const bright=(-px-py)/(radius*2),patch=rnd();
      c.fillStyle=edge>.84?'#293f31':bright>.4?(patch>.3?'#8a9e52':'#6e8946'):bright>-.15?(patch>.4?'#617f42':'#52713e'):(patch>.6?'#49673a':'#365637');
      c.fillRect(Math.round((x+px)/7)*7,Math.round((y+py-s*.4)/7)*7,8,8);
    }
    for(let j=0;j<16;j++){const px=x+(rnd()-.5)*s*1.25,py=y-s*.5+(rnd()-.5)*s;c.fillStyle=rnd()>.5?'#9ca55b':'#78924a';c.globalAlpha=.6;c.fillRect(Math.round(px/7)*7,Math.round(py/7)*7,14,7);c.globalAlpha=1;}

   }
   // Warm late-day light; an illustrated setting, not a calendar assertion.
   const light=c.createLinearGradient(0,0,WIDTH,HEIGHT);light.addColorStop(0,'#f3b66b20');light.addColorStop(.65,'#172d2c05');light.addColorStop(1,'#17253865');c.fillStyle=light;c.fillRect(0,0,WIDTH,HEIGHT);
   const key='talewisp-landscape';if(this.terrain)this.terrain.destroy();if(this.textures.exists(key))this.textures.remove(key);this.textures.addCanvas(key,canvas);this.terrain=this.add.image(0,0,key).setOrigin(0).setDepth(-100);
   for(const label of this.labels)label.destroy();this.labels=[];
   for(const loc of this.snapshot.locations){const p=this.point(loc);
    const text=this.add.text(p.x,p.y+75,loc.name,{fontFamily:'Georgia',fontSize:'24px',color:'#fff1cb',stroke:'#213329',strokeThickness:6,padding:{x:9,y:6}}).setOrigin(.5).setDepth(3000).setInteractive({useHandCursor:true});text.on('pointerup',()=>onSelect('location',loc.id));this.labels.push(text);
    const area=this.add.zone(p.x,p.y,160,120).setInteractive({useHandCursor:true});area.on('pointerup',()=>onSelect('location',loc.id));this.labels.push(area);
   }
   for(const e of lines){if(!e.open){const g=this.add.graphics().setDepth(3100);g.lineStyle(7,0xbd544a);g.lineBetween((e.a.x+e.b.x)/2-20,(e.a.y+e.b.y)/2-20,(e.a.x+e.b.x)/2+20,(e.a.y+e.b.y)/2+20);g.lineBetween((e.a.x+e.b.x)/2+20,(e.a.y+e.b.y)/2-20,(e.a.x+e.b.x)/2-20,(e.a.y+e.b.y)/2+20);this.labels.push(g);}}
  }
  makeAvatar(id:string,hero:boolean,index:number) {
   if(this.textures.exists(id))return;
   const sheet=document.createElement('canvas');sheet.width=170*6;sheet.height=204*5;const c=sheet.getContext('2d')!;
   const coat=hero?'#d0a455':['#677f9b','#986f53','#8c8e64'][index%3];
   for(let row=0;row<5;row++)for(let frame=0;frame<6;frame++){const x=frame*170+85,y=row*204+160,walk=frame%2?4:-4;
    c.fillStyle='#202a2d';c.fillRect(x-22,y-8+walk,16,30);c.fillRect(x+6,y-8-walk,16,30);
    c.fillStyle='#584a38';c.fillRect(x-25,y+15+walk,21,9);c.fillRect(x+4,y+15-walk,21,9);
    c.fillStyle='#343e36';c.fillRect(x-29,y-68,58,70);c.fillStyle=coat;c.fillRect(x-23,y-63,46,58);c.fillStyle='#e4c693';c.fillRect(x-18,y-93,36,31);
    c.fillStyle='#504333';c.fillRect(x-22,y-103,44,20);c.fillRect(x-25,y-89,9,16);c.fillStyle='#c3b58a';c.fillRect(x+17,y-62,14,49);c.fillStyle='#6c553a';c.fillRect(x+20,y-56,11,38);
    c.fillStyle='#c2a479';c.fillRect(x-32,y-52,10,33);c.fillStyle='#dbc28d';c.fillRect(x-15,y-61,10,49);
    if(row!==3){c.fillStyle='#343c36';c.fillRect(x-10,y-79,5,5);c.fillRect(x+7,y-79,5,5);}
   }
   const atlas=this.textures.addCanvas(id,sheet);
   if(!atlas)throw new Error('Не удалось создать текстуру игровой фигурки.');
   this.textures.addSpriteSheet(id,atlas,{frameWidth:170,frameHeight:204});
  }
  apply(next:Snapshot,first=false) {
   const reset=first||!this.snapshot||this.snapshot.branchId!==next.branchId||this.snapshot.view!==next.view||this.snapshot.actorId!==next.actorId||this.snapshot.replay!==next.replay||next.elapsed<this.snapshot.elapsed;
   if(reset){for(const a of this.actors.values())a.destroy();this.actors.clear();this.seen.clear();this.followed='';}
   this.snapshot=next;
   const signature=JSON.stringify([next.branchId,next.view,next.actorId,next.locations,next.edges]);if(signature!==this.signature){this.signature=signature;this.paintLandscape();}
   for(const[id,a]of this.actors)if(!next.actors.some((x:any)=>x.id===id)){a.destroy();this.actors.delete(id);}
   const count=new Map();
   next.actors.forEach((a:any,index:number)=>{
    let avatar=this.actors.get(a.id);const trip=next.travels[a.id];let loc=this.location(a.location),point=loc?this.point(loc):null;
    if(trip){const from=this.location(trip.from),to=this.location(trip.to);if(from&&to){const p=this.point(from),q=this.point(to),base=trip.baseProgress||0,t=trip.status==='blocked'?trip.progress:base+(1-base)*Math.max(0,Math.min(1,(next.elapsed-trip.departedAt)/Math.max(1,trip.arrivesAt-trip.departedAt)));point={x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t};}}
    else if(point){const n=count.get(loc.id)||0;count.set(loc.id,n+1);point.x+=n*150-60;point.y+=n%2*90;}
    if(!point)return;
    if(!avatar){this.makeAvatar(a.id,a.id===next.heroId,index);avatar=new CharacterSprite(this,point.x,point.y,{characterId:a.id,name:a.name,color:0xe8c575,displayMetrics:createCharacterDisplayMetrics(1600,900),overlayRoot:overlay});avatar.enableClick(id=>onSelect('actor',id));this.actors.set(a.id,avatar);}
    else if(!reset&&Math.hypot(point.x-avatar.x,point.y-avatar.y)>1){avatar.stopMoving();avatar.walkAlongPath([point]);}
    else{avatar.x=point.x;avatar.y=point.y;}
    avatar.setActionLabel(trip?(trip.status==='blocked'?'Переход закрыт':'В пути'):a.id===next.heroId?'Герой':null);
    avatar.setDepth(Math.floor(point.y));
   });
   if(reset){const hero=this.actors.get(next.actorId)||this.actors.get(next.heroId);if(hero){this.cameras.main.centerOn(hero.x,hero.y);this.cameras.main.setZoom(.9);}}
   for(const event of next.events.slice(-15)){if(this.seen.has(event.id))continue;this.seen.add(event.id);if(event.tick===next.elapsed&&event.type==='speech'&&event.actorId){const avatar=this.actors.get(event.actorId);if(avatar){const colon=event.text.indexOf(':');avatar.showBubble(event.text.slice(colon+1).trim(),8000);}}}
   host.dataset.revision=String(next.revision);host.dataset.elapsed=String(next.elapsed);host.dataset.branch=next.branchId;host.dataset.view=next.view;
  }
  update(){this.cameraControl?.update();for(const a of this.actors.values()){a.syncOverlayZoom(this.cameras.main.zoom);a.setDepth(Math.floor(a.y));}}
 }
 const game=new Phaser.Game({type:Phaser.CANVAS,parent:host,width:host.clientWidth||900,height:host.clientHeight||600,backgroundColor:'#263c32',render:{antialias:false,pixelArt:true},input:{keyboard:false},scene:[LivingScene],scale:{mode:Phaser.Scale.NONE}});
 const resize=new ResizeObserver(()=>{if(host.clientWidth&&host.clientHeight)game.scale.resize(host.clientWidth,host.clientHeight);});resize.observe(host);
 return { update(snapshot:Snapshot){pending=snapshot;if(ready)scene.apply(snapshot);},
  camera(action:string,id?:string){if(!ready)return;if(action==='follow'){const actor=scene.actors.get(id||scene.snapshot.heroId);if(actor){scene.cameraControl.followCharacter(actor);scene.followed=actor.characterId;}}else{scene.cameraControl.stopFollowing();EventBus.instance.emit('camera_zoom_'+action);}},
  destroy(){if(stopped)return;stopped=true;resize.disconnect();EventBus.instance.removeAllListeners();game.destroy(true);overlay.replaceChildren();}
 };
}
