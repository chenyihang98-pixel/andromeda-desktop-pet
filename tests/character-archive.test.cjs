'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {createCharacterArchive,readCharacterArchive}=require('../src/services/character-archive.cjs');
async function fixture(){const {characterPackFromAtlas}=await import('../src/shared/character.mjs');return{pack:characterPackFromAtlas(JSON.parse(await fs.readFile('assets/manifest.json','utf8'))),image:await fs.readFile('assets/andromeda.png')};}
test('portable ZIP round trip preserves checked artwork and semantic metadata',async()=>{
  const {pack,image}=await fixture();const result=await createCharacterArchive({pack},{originalImage:image});
  const restored=await readCharacterArchive(result.archive);assert.deepEqual(restored.pack,result.pack);assert.deepEqual(restored.image,image);
  assert.equal(restored.pack.atlas.image,'atlas.png');assert.equal(restored.pack.sha256,'8007f0c1c212ec2c950a92af4c8648d6eab66b61e7d998b702e452b3e7b1040d');
});
test('ZIP export rejects remote, mismatched and unknown content',async()=>{
  const {pack,image}=await fixture();await assert.rejects(createCharacterArchive({pack,imageDataURL:'https://example.test/asset.png'}));
  await assert.rejects(createCharacterArchive({pack,script:'bad'},{originalImage:image}));
  const modified=structuredClone(pack);modified.atlas.width*=2;modified.atlas.cellWidth*=2;
  await assert.rejects(createCharacterArchive({pack:modified},{originalImage:image}),/尺寸/);
});
test('ZIP reader rejects corrupted, truncated, traversal and compressed entries',async()=>{
  const {pack,image}=await fixture();const {archive}=await createCharacterArchive({pack},{originalImage:image});
  const crc=Buffer.from(archive);crc[100]^=1;await assert.rejects(readCharacterArchive(crc),/校验/);
  const traversal=Buffer.from(archive);traversal.write('../evil.json',30);await assert.rejects(readCharacterArchive(traversal),/不支持/);
  const compressed=Buffer.from(archive);compressed.writeUInt16LE(8,8);await assert.rejects(readCharacterArchive(compressed),/ZIP/);
  await assert.rejects(readCharacterArchive(archive.subarray(0,-1)));await assert.rejects(readCharacterArchive(Buffer.alloc(22)));
});
test('ZIP central directory cannot reinterpret validated local entries',async()=>{
  const {pack,image}=await fixture();const {archive}=await createCharacterArchive({pack},{originalImage:image});
  const central=archive.readUInt32LE(archive.length-6),end=archive.length-22;
  const edits=[
    bytes=>bytes.write('../evil_.json',central+46),
    bytes=>bytes.writeUInt32LE(1,central+42),
    bytes=>bytes.writeUInt32LE(0,central+16),
    bytes=>bytes.writeUInt32LE(1,central+20),
    bytes=>bytes.writeUInt16LE(8,central+10),
    bytes=>bytes.writeUInt16LE(0,central+8),
    bytes=>bytes.writeUInt16LE(1,central+30),
    bytes=>bytes.writeUInt16LE(1,central+32),
    bytes=>bytes.writeUInt16LE(1,central+34),
    bytes=>bytes.writeUInt32LE(0xa1ff0000,central+38),
    bytes=>bytes.writeUInt16LE(1,end+4),
    bytes=>bytes.writeUInt16LE(1,end+6),
    bytes=>bytes.writeUInt16LE(2,end+8),
    bytes=>bytes.writeUInt16LE(1,end+20),
    bytes=>bytes.writeUInt32LE(0,central),
  ];
  for(const edit of edits){const bytes=Buffer.from(archive);edit(bytes);await assert.rejects(readCharacterArchive(bytes),/目录/);}
});
test('ZIP import verifies recorded image SHA-256 independently from ZIP checksums',async()=>{
  const {pack,image}=await fixture();const {archive}=await createCharacterArchive({pack},{originalImage:image});
  const bytes=Buffer.from(archive),central=bytes.readUInt32LE(bytes.length-6),begin=30+bytes.readUInt16LE(26),size=bytes.readUInt32LE(18);
  const manifest=JSON.parse(bytes.subarray(begin,begin+size));const digestOffset=bytes.indexOf(manifest.sha256,begin);
  bytes.write('0'.repeat(64),digestOffset);
  let checksum=0xffffffff;
  for(const byte of bytes.subarray(begin,begin+size)){checksum^=byte;for(let i=0;i<8;i++)checksum=(checksum&1)?0xedb88320^(checksum>>>1):checksum>>>1;}
  checksum=(checksum^0xffffffff)>>>0;bytes.writeUInt32LE(checksum,14);bytes.writeUInt32LE(checksum,central+16);
  await assert.rejects(readCharacterArchive(bytes),/哈希校验/);
});
function densePack(pack, nameLength=0){
  pack.atlas.columns=64;pack.atlas.cellWidth=pack.atlas.width/64;pack.atlas.rows=1;pack.atlas.cellHeight=pack.atlas.height;
  pack.neutral={row:0,column:0};delete pack.lookDirections;
  const names=Array.from({length:128},(_,index)=>('a'+index).padEnd(nameLength,'x'));
  pack.actions={idle:names[0]};pack.animations=Object.fromEntries(names.map(name=>[name,{row:0,frameCount:64,durationsMs:Array(64).fill(60000)}]));
  return pack;
}
test('large legal action tables export a bounded compact manifest that the importer accepts',async()=>{
  const {pack,image}=await fixture();densePack(pack);
  assert.ok(Buffer.byteLength(JSON.stringify(pack,null,2))>65536);
  const result=await createCharacterArchive({pack},{originalImage:image});
  assert.ok(result.archive.readUInt32LE(18)<=65536);
  assert.deepEqual((await readCharacterArchive(result.archive)).pack,result.pack);
});
test('metadata limit uses final normalized UTF-8 bytes and accepts the exact byte boundary',async()=>{
  const {pack,image}=await fixture();densePack(pack,48);
  pack.description='汉'.repeat(1000);pack.source.author='汉'.repeat(200);pack.source.license='汉'.repeat(200);pack.source.reference='汉'.repeat(500);
  assert.ok(JSON.stringify(pack).length<65536);
  assert.ok(Buffer.byteLength(JSON.stringify(pack))>65536);
  await assert.rejects(createCharacterArchive({pack},{originalImage:image}),/64 KiB/);
  // Keep the metadata shape fixed and fill within the validated description bound.
  pack.source.author='作者';pack.source.license='许可';pack.source.reference='汉'.repeat(300);
  pack.description='x';
  const base=await createCharacterArchive({pack},{originalImage:image});
  const currentBytes=base.archive.readUInt32LE(18);
  const missing=65536-currentBytes;
  assert.ok(missing>0&&missing<=2997);
  const full=Math.floor(missing/3),remainder=missing%3;
  pack.description='x'+'汉'.repeat(full)+'x'.repeat(remainder);
  const boundary=await createCharacterArchive({pack},{originalImage:image});assert.equal(boundary.archive.readUInt32LE(18),65536);
  assert.deepEqual((await readCharacterArchive(boundary.archive)).pack,boundary.pack);
  pack.description+='x';await assert.rejects(createCharacterArchive({pack},{originalImage:image}),/64 KiB/);
});
