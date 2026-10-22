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
