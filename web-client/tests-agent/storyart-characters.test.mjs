import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createStoryArtCharacters } from '../storyart-characters.mjs';
import { storyArtSafeFile, parseStoryArtCsv, storyArtImageType } from '../storyart-project.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ0kAAAAASUVORK5CYII=','base64');
async function fixture(t){
 const root=await fs.mkdtemp(path.join(tmpdir(),'character-gallery-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const put=async(rel,value)=>{const file=path.join(root,rel);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,value);return file;};
 const folder='TEST_GENERATIONS/01_APPROVED_CHARACTERS/CHAR_001_Герой';
 const other='TEST_GENERATIONS/01_APPROVED_CHARACTERS/CHAR_002_Другой';
 const face=folder+'/03_CHARACTER_REFERENCES/01_FACE/face.png',body=folder+'/03_CHARACTER_REFERENCES/02_BODY/front.png',base=folder+'/00_APPROVED_BASE/base.png';
 await put(folder+'/CHARACTER_PROFILE.yaml','character_id: CHAR_001\n');
 await put(other+'/CHARACTER_PROFILE.yaml','character_id: CHAR_002\n');
 const row=(id,name,dir,approved,faces='',bodies='')=>[id,name,'APPROVED',path.join(root,dir,'CHARACTER_PROFILE.yaml'),path.join(root,approved),faces?path.join(root,faces):'',bodies?path.join(root,bodies):''].join(',');
 await put('TEST_GENERATIONS/CHARACTER_REGISTRY.csv','character_id,name,status,profile_path,approved_base,face_references,body_references\n'+row('CHAR_001','Герой',folder,base,face,body)+'\n'+row('CHAR_002','Другой',other,other+'/00_APPROVED_BASE/base.png'));
 for(const rel of [base,face,body,folder+'/03_CHARACTER_REFERENCES/03_WARDROBE/coat.png',folder+'/03_CHARACTER_REFERENCES/04_ACCESSORIES/sword.png',folder+'/02_SCENES/story/scene.png',folder+'/02_SCENES/REJECTED/bad.png',other+'/02_SCENES/foreign.png'])await put(rel,Buffer.concat([png,Buffer.from(rel)]));
 const gallery=createStoryArtCharacters({projectPath:root,safeFile:storyArtSafeFile,parseCsv:parseStoryArtCsv,imageType:storyArtImageType});
 return {root,folder,other,put,gallery};
}
test('character gallery has five categories containing only registered approved images',async t=>{
 const f=await fixture(t),d=await f.gallery.detail('TEST','CHAR_001');
 assert.equal(d.styleId,'TEST');assert.equal(d.character.id,'CHAR_001');
 assert.deepEqual(d.categories.map(c=>c.id),['identity','projections','wardrobe','accessories','scenes']);
 assert.deepEqual(d.categories.map(c=>c.label),['Персонаж','Проекции','Одежда','Аксессуары','Готовые арты с ним (сцены)']);
 assert.deepEqual(d.categories.map(c=>c.assets.length),[2,1,0,0,0]);
 const assets=d.categories.flatMap(c=>c.assets);
 assert.ok(assets.every(a=>a.url.includes('characterId=CHAR_001')&&!a.url.includes('D%3A')));
 assert.ok(assets.every(a=>!a._relative));
 assert.ok(assets.every(a=>a.status==='APPROVED')); 
 assert.equal(d.categories[0].assets[0].status,'APPROVED');
 const image=await f.gallery.image('TEST','CHAR_001',d.categories[1].assets[0].id);assert.equal(image.mimeType,'image/png');assert.deepEqual(image.bytes,Buffer.concat([png,Buffer.from(f.folder+'/03_CHARACTER_REFERENCES/02_BODY/front.png')]));
 const foreign=await f.gallery.detail('TEST','CHAR_002');
 await assert.rejects(f.gallery.image('TEST','CHAR_002',assets[0].id));
 assert.equal(foreign.categories.find(c=>c.id==='scenes').assets.length,0);
 await assert.rejects(f.gallery.detail('TEST','CHAR_003'));
 await assert.rejects(f.gallery.detail('../TEST','CHAR_001'));
});
test('gallery rejects traversal and a character profile claiming another generation tree',async t=>{
 const f=await fixture(t);
 await f.put('TEST_GENERATIONS/CHARACTER_REGISTRY.csv','character_id,name,status,profile_path\nCHAR_001,Wrong,APPROVED,'+path.join(f.root,'OTHER_GENERATIONS/01_APPROVED_CHARACTERS/CHAR_001_X/CHARACTER_PROFILE.yaml'));
 await assert.rejects(f.gallery.detail('TEST','CHAR_001'));
 await assert.rejects(f.gallery.image('TEST','CHAR_001','../../outside'));
});
test('a manifest record for a different character does not become this character scene or receive approval',async t=>{
 const f=await fixture(t);const rel=f.folder+'/02_SCENES/story/scene.png';
 await f.put('TEST_GENERATIONS/GENERATION_MANIFEST.csv','generation_id,character_id,status,style_file,description\nGEN_1,CHAR_002,APPROVED_SCENE,'+path.join(f.root,rel)+',foreign\n');
 const d=await f.gallery.detail('TEST','CHAR_001');assert.equal(d.categories.find(c=>c.id==='scenes').assets.length,0);
});
test('empty categories stay present, while corrupt registry is an error',async t=>{
 const f=await fixture(t);await fs.rm(path.join(f.root,f.folder,'03_CHARACTER_REFERENCES/04_ACCESSORIES'),{recursive:true});
 assert.equal((await f.gallery.detail('TEST','CHAR_001')).categories.find(c=>c.id==='accessories').assets.length,0);
 await f.put('TEST_GENERATIONS/CHARACTER_REGISTRY.csv','character_id,name\nCHAR_001,"broken');
 await assert.rejects(f.gallery.detail('TEST','CHAR_001'));
});
test('a symlink under a character is never an image proxy',async t=>{
 const f=await fixture(t);const target=await f.put('outside.png',png);
 try{await fs.symlink(target,path.join(f.root,f.folder,'02_SCENES/link.png'));}catch(e){if(['EPERM','EACCES'].includes(e.code)){t.skip('symlink creation not permitted');return;}throw e;}
 try{const d=await f.gallery.detail('TEST','CHAR_001');assert.ok(!d.categories.flatMap(c=>c.assets).some(a=>a.name==='link.png'));}catch(e){assert.ok([403,409].includes(e.status));}
});

test('saved copies do not create duplicates, false statuses or misclassified projections', async t => {
 const f=await fixture(t);
 const base=f.folder+'/00_APPROVED_BASE/base.png';
 const face=f.folder+'/03_CHARACTER_REFERENCES/01_FACE/face.png';
 const body=f.folder+'/03_CHARACTER_REFERENCES/02_BODY/front.png';
 for(const [name,original] of [['assembly',base],['face',face],['front',body]]) {
   await f.put(f.folder+'/00_APPROVED_BASE/young/'+name+'.png',await fs.readFile(path.join(f.root,original)));
 }
 const d=await f.gallery.detail('TEST','CHAR_001');
 assert.deepEqual(d.categories.map(c=>c.assets.length),[2,1,0,0,0]);
 assert.ok(d.categories.flatMap(c=>c.assets).every(a=>a.status==='APPROVED'));
});

test('approved manifest copies deduplicate by actual bytes and retain canonical registry roles', async t => {
 const f=await fixture(t),body=f.folder+'/03_CHARACTER_REFERENCES/02_BODY/front.png';
 const copy=f.folder+'/00_APPROVED_BASE/young/duplicate.png';
 await f.put(copy,await fs.readFile(path.join(f.root,body)));
 await f.put('TEST_GENERATIONS/GENERATION_MANIFEST.csv','character_id,status,style_file,category\nCHAR_001,APPROVED_CHARACTER_BASE,'+path.join(f.root,copy)+',CHARACTER\n');
 const d=await f.gallery.detail('TEST','CHAR_001');
 assert.deepEqual(d.categories.map(c=>c.assets.length),[2,1,0,0,0]);
 const hiddenId=(await import('node:crypto')).createHash('sha256').update('TEST\0CHAR_001\0'+copy).digest('hex').slice(0,24);
 await assert.rejects(f.gallery.image('TEST','CHAR_001',hiddenId),{status:404});
});

test('only approved manifest assets are exposed; unknown, test, draft and rejected entries stay private', async t => {
 const f=await fixture(t),header='character_id,status,style_file,category\n',rows=[];
 for(const [i,status] of ['APPROVED_SCENE','TEST','DRAFT','STAGING','REJECTED','','SAVED_UNVERIFIED'].entries()) {
   const rel=f.folder+'/02_SCENES/entry'+i+'.png';
   await f.put(rel,Buffer.concat([png,Buffer.from(status)]));
   rows.push(['CHAR_001',status,path.join(f.root,rel),'SCENE'].join(','));
 }
 await f.put('TEST_GENERATIONS/GENERATION_MANIFEST.csv',header+rows.join('\n'));
 const d=await f.gallery.detail('TEST','CHAR_001');
 assert.deepEqual(d.categories.find(c=>c.id==='scenes').assets.map(a=>a.name),['entry0.png']);
 const {createHash}=await import('node:crypto');
 for(let i=1;i<7;i++) {
   const rel=f.folder+'/02_SCENES/entry'+i+'.png';
   const id=createHash('sha256').update('TEST\0CHAR_001\0'+rel).digest('hex').slice(0,24);
   await assert.rejects(f.gallery.image('TEST','CHAR_001',id),{status:404});
 }
});

test('unregistered directories are not scanned and missing registered files are omitted', async t => {
 const f=await fixture(t);
 await fs.rm(path.join(f.root,f.folder,'00_APPROVED_BASE/base.png'));
 const original=fs.readdir;
 fs.readdir=async()=>{throw new Error('directory enumeration forbidden');};
 try {
   const d=await f.gallery.detail('TEST','CHAR_001');
   assert.deepEqual(d.categories.map(c=>c.assets.length),[1,1,0,0,0]);
 } finally {fs.readdir=original;}
});

test('approved wardrobe, accessories, scenes and explicit variations remain visible', async t => {
 const f=await fixture(t),rows=[];
 for(const [folder,name,status,category] of [
  ['03_CHARACTER_REFERENCES/03_WARDROBE','coat','APPROVED_WARDROBE','WARDROBE'],
  ['03_CHARACTER_REFERENCES/04_ACCESSORIES','sword','APPROVED_ACCESSORY','ACCESSORY'],
  ['02_SCENES/story','scene','APPROVED_SCENE','SCENE'],
  ['01_VARIATIONS/registered','view','APPROVED','PROJECTION']
 ]) {
  const rel=f.folder+'/'+folder+'/'+name+'.png';
  await f.put(rel,Buffer.concat([png,Buffer.from(rel)]));
  rows.push(['CHAR_001',status,path.join(f.root,rel),category].join(','));
 }
 await f.put('TEST_GENERATIONS/GENERATION_MANIFEST.csv','character_id,status,style_file,category\n'+rows.join('\n'));
 const d=await f.gallery.detail('TEST','CHAR_001');
 assert.deepEqual(d.categories.map(c=>c.assets.length),[2,2,1,1,1]);
 for(const category of d.categories)for(const asset of category.assets) {
  assert.equal((await f.gallery.image('TEST','CHAR_001',asset.id)).mimeType,'image/png');
 }
});

test('same basename with different image bytes is preserved; status revocation takes effect immediately', async t => {
 const f=await fixture(t),rel=f.folder+'/02_SCENES/story/base.png';
 await f.put(rel,Buffer.concat([png,Buffer.from('different-image')]));
 const manifest='TEST_GENERATIONS/GENERATION_MANIFEST.csv';
 const row=status=>'character_id,status,style_file,category\nCHAR_001,'+status+','+path.join(f.root,rel)+',SCENE\n';
 await f.put(manifest,row('APPROVED_SCENE'));
 const before=await f.gallery.detail('TEST','CHAR_001');
 assert.equal(before.categories[0].assets.filter(a=>a.name==='base.png').length,1);
 const scene=before.categories[4].assets[0];assert.equal(scene.name,'base.png');
 await f.put(manifest,row('TEST'));
 const after=await f.gallery.detail('TEST','CHAR_001');
 assert.equal(after.categories[4].assets.length,0);
 await assert.rejects(f.gallery.image('TEST','CHAR_001',scene.id),{status:404});
});
