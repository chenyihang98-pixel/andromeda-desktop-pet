'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createCharacterStore}=require('../src/services/character-store.cjs'),{createCharacterArchive}=require('../src/services/character-archive.cjs');
test('custom character install persists, failed validation preserves it, and clear restores builtin mode',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'andromeda-character-'));
  t.after(async()=>{if(path.dirname(directory)===os.tmpdir()&&path.basename(directory).startsWith('andromeda-character-'))await fs.rm(directory,{recursive:true,force:true});});
  const {characterPackFromAtlas}=await import('../src/shared/character.mjs');
  const pack=characterPackFromAtlas(JSON.parse(await fs.readFile('assets/manifest.json','utf8'))),image=await fs.readFile('assets/andromeda.png');
  const {archive}=await createCharacterArchive({pack},{originalImage:image});let valid=true,validated=0;
  const store=createCharacterStore(directory,{validateImage:()=>{validated++;if(!valid)throw new Error('decode failed');}});
  assert.equal(await store.load(),null);const installed=await store.install(archive);assert.equal(installed.pack.id,pack.id);assert.match(installed.imageDataURL,/^data:image\/png;base64,/);assert.equal(validated,1);
  valid=false;await assert.rejects(store.install(archive),/decode failed/);assert.equal(store.snapshot().pack.id,pack.id);assert.deepEqual(await fs.readFile(path.join(directory,'custom-character.zip')),archive);
  const second=createCharacterStore(directory);assert.equal((await second.load()).pack.id,pack.id);await second.clear();assert.equal(second.snapshot(),null);assert.equal(await store.load(),null);
});

test('the import intent queues before its file read so a later clear remains the final durable choice',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'andromeda-character-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('andromeda-character-'));await fs.rm(directory,{recursive:true,force:true});});
  const {characterPackFromAtlas}=await import('../src/shared/character.mjs');
  const pack=characterPackFromAtlas(JSON.parse(await fs.readFile('assets/manifest.json','utf8')));
  const {archive}=await createCharacterArchive({pack},{originalImage:await fs.readFile('assets/andromeda.png')});
  const store=createCharacterStore(directory);let release,entered,cleared=false;
  const gate=new Promise(resolve=>{release=resolve;}),arrived=new Promise(resolve=>{entered=resolve;});
  const installing=store.installFrom(async()=>{entered();await gate;return archive;});
  const clearing=store.clear().then(value=>{cleared=true;return value;});
  await arrived;assert.equal(cleared,false);release();
  const result=await installing;assert.equal(result.cancelled,false);assert.equal(result.character.pack.id,pack.id);
  assert.equal(await clearing,null);assert.equal(store.snapshot(),null);
  await assert.rejects(fs.stat(path.join(directory,'custom-character.zip')),{code:'ENOENT'});
  assert.deepEqual(await fs.readdir(directory),[]);
});

test('cancelled and failed imports do not poison the ordered character operation queue',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'andromeda-character-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('andromeda-character-'));await fs.rm(directory,{recursive:true,force:true});});
  const {characterPackFromAtlas}=await import('../src/shared/character.mjs');
  const pack=characterPackFromAtlas(JSON.parse(await fs.readFile('assets/manifest.json','utf8')));
  const {archive}=await createCharacterArchive({pack},{originalImage:await fs.readFile('assets/andromeda.png')});
  const store=createCharacterStore(directory);await store.install(archive);
  const cancelled=await store.installFrom(async()=>null);
  assert.equal(cancelled.cancelled,true);assert.equal(cancelled.character.pack.id,pack.id);
  const failure=store.installFrom(async()=>{throw new Error('file read failed');});
  const rejected=assert.rejects(failure,/file read failed/),clearing=store.clear(),installing=store.installFrom(async()=>archive);
  await rejected;assert.equal(await clearing,null);assert.equal((await installing).cancelled,false);
  assert.equal(store.snapshot().pack.id,pack.id);
  assert.equal((await createCharacterStore(directory).load()).pack.id,pack.id);
  assert.deepEqual(await fs.readdir(directory),['custom-character.zip']);
});
